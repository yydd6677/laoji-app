import { fetchWithTimeout, requestTimeoutMs } from '../src/services/http';

describe('http timeouts', () => {
  it('assigns longer budgets to ASR, LLM, summary, and media requests', () => {
    expect(requestTimeoutMs('https://api.example.com/api/auth/me')).toBe(20_000);
    expect(requestTimeoutMs('https://api.example.com/api/laoji/parse')).toBe(60_000);
    expect(requestTimeoutMs('https://api.example.com/api/laoji/asr/transcribe')).toBe(120_000);
    expect(requestTimeoutMs('https://api.example.com/summaries/task/1')).toBe(90_000);
    expect(requestTimeoutMs('https://api.example.com/meetings/1/audio')).toBe(180_000);
  });

  it('aborts and reports a typed timeout instead of waiting forever', async () => {
    jest.useFakeTimers();
    const originalFetch = global.fetch;
    global.fetch = jest.fn((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as jest.Mock;

    try {
      const pending = fetchWithTimeout('https://api.example.com/health', {}, 1_000);
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'RequestTimeoutError',
        message: '请求超时（1 秒）',
      });
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      global.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  it('settles at the deadline even when the native fetch ignores abort', async () => {
    jest.useFakeTimers();
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;

    try {
      const pending = fetchWithTimeout('https://api.example.com/health', {}, 1_000);
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'RequestTimeoutError',
        timeoutMs: 1_000,
      });
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      global.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  it('settles with AbortError when an external signal cancels an uncooperative fetch', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;
    const controller = new AbortController();

    try {
      const pending = fetchWithTimeout(
        'https://api.example.com/health',
        { signal: controller.signal },
        20_000,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: '请求已取消' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not start a request when the caller signal is already aborted', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn() as jest.Mock;
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(fetchWithTimeout(
        'https://api.example.com/health',
        { signal: controller.signal },
      )).rejects.toMatchObject({ name: 'AbortError' });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
