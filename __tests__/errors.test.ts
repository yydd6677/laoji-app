import {
  HttpResponseError,
  readResponseData,
  readResponseError,
  readableErrorMessage,
} from '../src/services/errors';
import { setUnauthorizedHandler } from '../src/services/authInvalidation';

function response(status: number, body: string): Response {
  return {
    status,
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('HTTP response error parsing', () => {
  it('reads a JSON validation body once and keeps field messages', async () => {
    const res = response(422, JSON.stringify({
      detail: [
        { loc: ['body', 'account'], msg: '账号格式不正确', type: 'value_error' },
        { loc: ['body', 'password'], msg: '密码至少需要 8 位', type: 'value_error' },
      ],
    }));

    await expect(readResponseError('register failed', res)).resolves.toEqual(expect.objectContaining({
      message: 'register failed: 422 账号格式不正确\n密码至少需要 8 位',
    }));
    expect(res.text).toHaveBeenCalledTimes(1);
  });

  it('preserves a plain-text or HTML gateway error without a second body read', async () => {
    const plain = response(502, 'upstream service unavailable');
    await expect(readResponseError('summary failed', plain)).resolves.toEqual(expect.objectContaining({
      message: 'summary failed: 502 upstream service unavailable',
    }));
    expect(plain.text).toHaveBeenCalledTimes(1);
  });

  it('supports json-only legacy response shims', async () => {
    const res = {
      json: jest.fn().mockResolvedValue({ detail: '登录已过期' }),
    } as unknown as Response;
    await expect(readResponseData(res)).resolves.toEqual({ detail: '登录已过期' });
  });

  it('keeps object details user-readable and never emits object Object', () => {
    expect(readableErrorMessage({ detail: { message: '服务器繁忙' } }, 'fallback'))
      .toBe('服务器繁忙');
  });

  it('keeps the response status typed and reports authenticated 401 once', async () => {
    const onUnauthorized = jest.fn();
    const clearHandler = setUnauthorizedHandler(onUnauthorized);
    const res = response(401, JSON.stringify({ detail: '凭证失效' }));

    try {
      const error = await readResponseError('fetch events failed', res, { unauthorizedToken: 'expired-token' });
      expect(error).toBeInstanceOf(HttpResponseError);
      expect(error).toMatchObject({ status: 401, detail: '凭证失效' });
      expect(onUnauthorized).toHaveBeenCalledWith('expired-token');
      expect(readableErrorMessage(error, 'fallback')).toBe('登录已过期，请重新登录。');
    } finally {
      clearHandler();
    }
  });

  it('does not expire an account for an unauthenticated 401 response', async () => {
    const onUnauthorized = jest.fn();
    const clearHandler = setUnauthorizedHandler(onUnauthorized);

    try {
      await readResponseError('guest request failed', response(401, 'guest token expired'));
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      clearHandler();
    }
  });
});
