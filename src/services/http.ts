export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = 'RequestTimeoutError';
  }
}

function requestAbortError(): Error {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

export function requestTimeoutMs(url: string): number {
  if (/\/api\/laoji\/(?:asr\/transcribe|parse-audio)/.test(url)) return 120_000;
  if (/\/api\/laoji\/parse(?:\?|$)/.test(url) || /\/api\/laoji\/clarify/.test(url)) return 60_000;
  if (/\/summaries\//.test(url) || /guest-summary/.test(url)) return 90_000;
  // Meeting QA is currently a synchronous model call. A cold model can cross
  // 90 seconds even for a short evidence set, so keep the visible request alive
  // long enough for the server's validated answer instead of discarding it at
  // the old boundary. The sheet remains cancellable through its external signal.
  if (/\/questions(?:\/|\?|$)/.test(url) || /guest-questions/.test(url)) return 180_000;
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
