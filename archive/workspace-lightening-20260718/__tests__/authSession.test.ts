import * as SecureStore from 'expo-secure-store';
import {
  AUTH_SESSION_KEY,
  AUTH_TOKEN_KEY,
  AuthSession,
  clearStoredToken,
  flushAuthStorageOperations,
  loadStoredSession,
  resetAuthStorageQueueForTests,
  saveStoredSession,
} from '../src/services/auth';
import {
  isStoredSessionExpired,
  shouldRefreshStoredSession,
} from '../src/services/authSession';

const session: AuthSession = {
  accessToken: 'token-1',
  expiresAt: '2026-08-01T00:00:00.000Z',
  user: {
    id: 7,
    account: 'user@example.com',
    nickname: '用户',
    created_at: '2026-07-01T00:00:00.000Z',
  },
};

describe('auth session persistence', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthStorageQueueForTests();
    values.clear();
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => values.get(key) ?? null);
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
      values.set(key, value);
    });
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => {
      values.delete(key);
    });
  });

  it('stores token and restorable session metadata in SecureStore', async () => {
    await saveStoredSession(session);

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 'token-1');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_SESSION_KEY, JSON.stringify(session));
  });

  it('loads a valid cached session for offline startup', async () => {
    values.set(AUTH_SESSION_KEY, JSON.stringify(session));
    await expect(loadStoredSession()).resolves.toEqual(expect.objectContaining({
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      user: expect.objectContaining(session.user),
    }));
  });

  it('clears both legacy token and session metadata', async () => {
    await clearStoredToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_SESSION_KEY);
  });

  it('serializes an expired-session clear before an immediate new login save', async () => {
    let releaseDelete = () => {};
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => {
      await deleteGate;
      values.delete(key);
    });

    const clearing = clearStoredToken();
    const replacement = { ...session, accessToken: 'replacement-token' };
    const saving = saveStoredSession(replacement);
    await Promise.resolve();

    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    releaseDelete();
    await Promise.all([clearing, saving]);
    await flushAuthStorageOperations();

    expect(values.get(AUTH_TOKEN_KEY)).toBe('replacement-token');
    expect(values.get(AUTH_SESSION_KEY)).toBe(JSON.stringify(replacement));
  });

  it('continues the storage queue after a native clear failure', async () => {
    (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keystore unavailable'));
    const clearing = clearStoredToken();
    const replacement = { ...session, accessToken: 'recovered-token' };
    const saving = saveStoredSession(replacement);

    await expect(clearing).rejects.toThrow('keystore unavailable');
    await expect(saving).resolves.toBeUndefined();
    expect(values.get(AUTH_TOKEN_KEY)).toBe('recovered-token');
    expect(values.get(AUTH_SESSION_KEY)).toBe(JSON.stringify(replacement));
  });

  it('refreshes only within the seven-day window and rejects expired cache', () => {
    const now = Date.parse('2026-07-26T00:00:00.000Z');
    expect(shouldRefreshStoredSession(session, now)).toBe(true);
    expect(isStoredSessionExpired(session, now)).toBe(false);
    expect(isStoredSessionExpired(session, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(true);
  });
});
