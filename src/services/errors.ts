import { notifyUnauthorized } from './authInvalidation';
import { readJsonWithTimeout, readTextWithTimeout } from './http';

const ERROR_RESPONSE_BODY_TIMEOUT_MS = 10_000;

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

type RecorderErrorLike = {
  code?: unknown;
  errorCode?: unknown;
  providerCode?: unknown;
  providerRetryable?: unknown;
  recoverable?: unknown;
  errorMessage?: unknown;
  message?: unknown;
  result?: {
    errorCode?: unknown;
    errorMessage?: unknown;
    localSaved?: unknown;
  } | null;
};

function recorderErrorMetadata(value: unknown): {
  code: string | null;
  providerCode: string | null;
  recoverable: boolean;
  detail: unknown;
} {
  if (!value || typeof value !== 'object') {
    return { code: null, providerCode: null, recoverable: false, detail: value };
  }
  const record = value as RecorderErrorLike;
  const result = record.result;
  const rawCode = record.errorCode ?? record.code ?? result?.errorCode;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;
  const providerCode = typeof record.providerCode === 'string' && record.providerCode.trim()
    ? record.providerCode.trim()
    : null;
  const rawDetail = record.errorMessage ?? record.message ?? result?.errorMessage ?? value;
  return {
    code,
    providerCode,
    recoverable: record.recoverable === true || (
      code !== null
      && ['server_error', 'service_unavailable', 'websocket_connect_failed', 'websocket_disconnected', 'websocket_send_failed'].includes(code)
      && result?.localSaved === true
    ),
    detail: rawDetail,
  };
}

/**
 * Native recorder errors carry a stable code in addition to provider text.
 * Provider text can be stale or misleading (for example “检查麦克风权限”
 * while PCM is still being recorded), so user-visible copy must prefer the
 * code and never expose that raw detail for a recoverable ASR failure.
 */
export function readableRecorderErrorMessage(
  errorCode: string | null | undefined,
  detail: unknown,
  fallback: string,
  recoverable = false,
  providerCode: string | null | undefined = null,
): string {
  const code = typeof errorCode === 'string' ? errorCode.trim() : '';
  const normalizedProviderCode = typeof providerCode === 'string' ? providerCode.trim() : '';
  if (normalizedProviderCode === 'qwen_asr_queue_full') {
    return recoverable
      ? '实时转写暂时繁忙，录音仍会保存在本机，结束后可继续同步。'
      : '实时转写暂时繁忙，请稍后重试。';
  }
  if (code === 'permission_denied') return '请允许麦克风权限后重试。';
  if (code === 'storage_limit') return '本机存储空间不足，请清理空间后重试。';
  if (code === 'storage_failed') return '录音已保存，但本机记录暂时未能更新，请稍后重试。';
  if (code === 'audio_unavailable' || code === 'audio_read_failed') {
    return '录音暂时不可用，请检查麦克风权限后重试。';
  }
  if (code === 'ready_to_stop_timeout' || code === 'stop_ack_timeout' || code === 'final_drain_timeout') {
    return '录音已保存在本机，但实时转写结束确认超时；可在会议详情中继续同步。';
  }
  if (code === 'recovery_failed') return '录音恢复失败，请稍后重试。';
  if (['server_error', 'service_unavailable', 'websocket_connect_failed', 'websocket_disconnected', 'websocket_send_failed'].includes(code)) {
    return recoverable
      ? '实时转写服务暂时不可用，录音仍会保存在本机，结束后可继续同步。'
      : '实时转写服务暂时不可用，录音仍会保存在本机，请稍后重试。';
  }
  return readableErrorMessage(detail, fallback);
}

export async function readResponseData(
  res: Response,
  timeoutMs = ERROR_RESPONSE_BODY_TIMEOUT_MS,
): Promise<unknown> {
  const response = res as Response & {
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  if (typeof response.text === 'function') {
    try {
      const raw = await readTextWithTimeout(response, timeoutMs);
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
      return await readJsonWithTimeout(response, timeoutMs);
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
  const metadata = recorderErrorMetadata(err);
  if (metadata.code) {
    return readableRecorderErrorMessage(
      metadata.code,
      metadata.detail,
      fallback,
      metadata.recoverable,
      metadata.providerCode,
    );
  }
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : stringifyErrorDetail(err) ?? '';
  const message = raw.trim();
  if (!message || message === '[object Object]') return fallback;
  if (isUnauthorizedResponseError(err)) return '登录已过期，请重新登录。';
  const cleaned = message.replace(/^[^:]+:\s*\d{3}\s*/, '').trim();
  if (/Network request failed|Failed to fetch|connection refused/i.test(cleaned)) {
    return '暂时无法连接老记服务，请检查网络后重试。';
  }
  if (/support[_ -]?models?[_ -]?not[_ -]?ready|models?[_ -]?not[_ -]?ready|qwen[_ -]?asr[_ -]?unreachable/i.test(cleaned)) {
    return '实时转写服务暂时未就绪，录音仍会保存在本机，请稍后重试。';
  }
  if (/timeout|timed out/i.test(cleaned)) return '请求超时，请稍后重试。';
  if (/401|unauthorized|token expired/i.test(cleaned)) return '登录已过期，请重新登录。';
  if (/microphone|permission|recording|audio input/i.test(cleaned)) {
    return '录音暂时不可用，请稍后重试。';
  }
  if (/parse|schedule/i.test(cleaned)) return '日程解析失败，请检查输入后重试。';
  if (/audio|playback/i.test(cleaned)) return '音频暂时无法播放，请稍后重试。';
  if (/server|500|502|503/i.test(cleaned)) return '老记服务暂时不可用，请稍后重试。';

  // A wholly Chinese backend message can be useful. Mixed Chinese/English is
  // still raw transport/provider copy and must not bypass the fallback merely
  // because it contains one Chinese phrase.
  return /[\u3400-\u9fff]/.test(cleaned) && !/[A-Za-z]/.test(cleaned)
    ? cleaned
    : fallback;
}
