import { notifyUnauthorized } from './authInvalidation';

export class HttpResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

export function isUnauthorizedResponseError(error: unknown): boolean {
  return error instanceof HttpResponseError && error.status === 401;
}

export function stringifyErrorDetail(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const messages = value
      .map(item => stringifyErrorDetail(item))
      .filter((item): item is string => Boolean(item));
    return messages.length ? messages.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const direct = stringifyErrorDetail(record.msg ?? record.message ?? record.error);
    if (direct) return direct;

    const nested = stringifyErrorDetail(record.detail);
    if (nested) return nested;

    const fieldMessages = Object.entries(record)
      .filter(([key]) => !['loc', 'type', 'input', 'ctx'].includes(key))
      .map(([, item]) => stringifyErrorDetail(item))
      .filter((item): item is string => Boolean(item));
    if (fieldMessages.length) return fieldMessages.join('\n');

    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== '{}' ? serialized : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function readResponseData(res: Response): Promise<unknown> {
  const response = res as Response & {
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  if (typeof response.text === 'function') {
    try {
      const raw = await response.text();
      if (!raw.trim()) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    } catch {
      return null;
    }
  }

  // Lightweight test doubles and a few legacy fetch shims expose json() only.
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

export async function readResponseError(
  prefix: string,
  res: Response,
  options: { unauthorizedToken?: string } = {},
): Promise<HttpResponseError> {
  const data = await readResponseData(res);
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const detail = stringifyErrorDetail(record?.detail ?? record?.message ?? record?.error ?? data);

  if (res.status === 401 && options.unauthorizedToken) {
    notifyUnauthorized(options.unauthorizedToken);
  }

  return new HttpResponseError(
    detail ? `${prefix}: ${res.status} ${detail}` : `${prefix}: ${res.status}`,
    res.status,
    detail,
  );
}

export function readableErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : stringifyErrorDetail(err) ?? '';
  const message = raw.trim();
  if (!message || message === '[object Object]') return fallback;
  if (isUnauthorizedResponseError(err)) return '登录已过期，请重新登录。';
  if (/Network request failed|Failed to fetch|timeout/i.test(message)) {
    return '暂时无法连接老记服务，请检查网络后重试。';
  }
  return message.replace(/^[^:]+:\s*\d{3}\s*/, '').trim() || fallback;
}
