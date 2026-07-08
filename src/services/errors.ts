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

export async function readResponseError(prefix: string, res: Response): Promise<Error> {
  let detail: string | null = null;
  try {
    const data = await res.json();
    detail = stringifyErrorDetail(data?.detail ?? data?.message ?? data?.error ?? data);
  } catch {
    try {
      detail = stringifyErrorDetail(await res.text());
    } catch {
      detail = null;
    }
  }

  return new Error(detail ? `${prefix}: ${res.status} ${detail}` : `${prefix}: ${res.status}`);
}

export function readableErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : stringifyErrorDetail(err) ?? '';
  const message = raw.trim();
  if (!message || message === '[object Object]') return fallback;
  if (/Network request failed|Failed to fetch|timeout/i.test(message)) {
    return '暂时无法连接老记服务，请检查网络后重试。';
  }
  return message.replace(/^[^:]+:\s*\d{3}\s*/, '').trim() || fallback;
}
