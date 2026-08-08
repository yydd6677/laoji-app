export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = 'RequestTimeoutError';
  }
}

const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 5_000;

function requestAbortError(): Error {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

export function requestTimeoutMs(url: string): number {
  if (/\/api\/laoji\/(?:asr\/transcribe|parse-audio)/.test(url)) return 120_000;
  if (/\/api\/laoji\/parse(?:\?|$)/.test(url) || /\/api\/laoji\/clarify/.test(url)) return 60_000;
  if (/\/summaries\//.test(url) || /guest-summary/.test(url)) return 90_000;
  // A foreground question can arrive while one non-preemptible background
  // summary block is already running. The provider gives it the next queue
  // slot, but a 30-second client abort can still discard a successful response
  // (observed at 48 seconds under real summary contention). Keep a bounded
  // window that covers one block plus the interactive inference.
  if (/\/questions(?:\/|\?|$)/.test(url) || /guest-questions/.test(url)) return 75_000;
  if (/\/api\/laoji\/speakers(?:\/|\?|$)/.test(url)) return 90_000;
  if (/\/audio(?:\/|\?|$)/.test(url) || /\/upload(?:\?|$)/.test(url)) return 180_000;
  return 20_000;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  const timeout = timeoutMs ?? requestTimeoutMs(url);
  const externalSignal = init.signal;
  if (externalSignal?.aborted) throw requestAbortError();

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let rejectBoundary: (reason: Error) => void = () => {};
  const boundary = new Promise<Response>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const forwardAbort = () => {
    externallyAborted = true;
    rejectBoundary(requestAbortError());
    controller.abort();
  };
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    rejectBoundary(new RequestTimeoutError(timeout));
    controller.abort();
  }, timeout);
  try {
    return await Promise.race([
      globalThis.fetch(input, { ...init, signal: controller.signal }),
      boundary,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof RequestTimeoutError)) throw new RequestTimeoutError(timeout);
    if (externallyAborted && (error as Error)?.name !== 'AbortError') throw requestAbortError();
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function readBodyWithTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  cancelBody?: () => void | Promise<void>,
): Promise<T> {
  const timeout = Number.isFinite(timeoutMs)
    ? Math.max(10, Math.floor(timeoutMs))
    : DEFAULT_RESPONSE_BODY_TIMEOUT_MS;
  if (externalSignal?.aborted) throw requestAbortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externallyAborted = false;
  let bodyCancelled = false;
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelBodyOnce = () => {
    if (bodyCancelled) return;
    bodyCancelled = true;
    try {
      const result = cancelBody?.();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // A body may already be locked or closed. The request boundary still
      // converges even when the platform cannot cancel the stream.
    }
  };
  const abortBoundary = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const forwardAbort = () => {
    externallyAborted = true;
    cancelBodyOnce();
    rejectAbort(requestAbortError());
  };
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutBoundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancelBodyOnce();
      reject(new RequestTimeoutError(timeout));
    }, timeout);
  });
  try {
    return await Promise.race([
      read(),
      timeoutBoundary,
      abortBoundary,
    ]);
  } catch (error) {
    if (externallyAborted && (error as Error)?.name !== 'AbortError') {
      throw requestAbortError();
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Bound a small JSON response after fetch headers have arrived.
 *
 * `fetchWithTimeout` owns the request deadline, but the platform's `Response`
 * body is read by callers after that function returns.  Keeping this helper
 * explicit avoids making binary downloads or file uploads eagerly buffered,
 * while preventing interactive JSON surfaces (question/summary metadata) from
 * waiting forever on a stalled body stream.
 */
export async function readJsonWithTimeout<T = unknown>(
  response: Response,
  timeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  return readBodyWithTimeout(
    () => response.json() as Promise<T>,
    timeoutMs,
    externalSignal,
    () => response.body?.cancel(),
  );
}

/**
 * Bound a text response after fetch headers have arrived.  Error responses
 * commonly use text or JSON interchangeably; both paths must share the same
 * finite body deadline so a stalled proxy cannot block error presentation.
 */
export async function readTextWithTimeout(
  response: Response,
  timeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<string> {
  return readBodyWithTimeout(
    () => response.text(),
    timeoutMs,
    externalSignal,
    () => response.body?.cancel(),
  );
}

/** Bound a remote binary response before converting it to an audio payload. */
export async function readBlobWithTimeout(
  response: Response,
  timeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Blob> {
  return readBodyWithTimeout(
    () => response.blob(),
    timeoutMs,
    externalSignal,
    () => response.body?.cancel(),
  );
}
