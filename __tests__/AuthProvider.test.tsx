import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import * as authService from '../src/services/auth';
import { AuthProvider, useAuth } from '../src/store/AuthStore';
import { notifyUnauthorized } from '../src/services/authInvalidation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/services/auth', () => {
  const actual = jest.requireActual('../src/services/auth');
  return {
    ...actual,
    clearStoredToken: jest.fn().mockResolvedValue(undefined),
    deleteAccount: jest.fn(),
    fetchCurrentUser: jest.fn(),
    fetchRemoteProfile: jest.fn(),
    loginAccount: jest.fn(),
    logoutAccount: jest.fn().mockResolvedValue(undefined),
    loadStoredSession: jest.fn(),
    loadStoredToken: jest.fn(),
    refreshAccountSession: jest.fn(),
    saveStoredSession: jest.fn().mockResolvedValue(undefined),
    updateRemoteProfile: jest.fn(),
  };
});

const cachedSession: authService.AuthSession = {
  accessToken: 'cached-token',
  expiresAt: '2099-08-01T00:00:00.000Z',
  user: {
    id: 7,
    account: 'offline@example.com',
    nickname: '离线用户',
    created_at: '2026-07-01T00:00:00.000Z',
  },
};

describe('AuthProvider session restoration', () => {
  let current: ReturnType<typeof useAuth> | null = null;

  function Probe() {
    current = useAuth();
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    current = null;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:authMode:v1' ? 'authenticated' : null
    ));
    (authService.loadStoredSession as jest.Mock).mockResolvedValue(cachedSession);
    (authService.loadStoredToken as jest.Mock).mockResolvedValue(cachedSession.accessToken);
    (authService.fetchRemoteProfile as jest.Mock).mockRejectedValue(new Error('Network request failed'));
  });

  it('keeps an unexpired cached account signed in when startup is offline', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockRejectedValue(new Error('Network request failed'));

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.initializing).toBe(false));
    expect(current?.mode).toBe('authenticated');
    expect(current?.session?.user.nickname).toBe('离线用户');
    expect(authService.clearStoredToken).not.toHaveBeenCalled();
  });

  it('refreshes a cached session that is within seven days of expiry', async () => {
    const soon = { ...cachedSession, expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() };
    const refreshed = { ...cachedSession, accessToken: 'new-token', expiresAt: '2099-09-01T00:00:00.000Z' };
    (authService.loadStoredSession as jest.Mock).mockResolvedValue(soon);
    (authService.refreshAccountSession as jest.Mock).mockResolvedValue(refreshed);

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.initializing).toBe(false));
    expect(authService.refreshAccountSession).toHaveBeenCalledWith('cached-token');
    expect(authService.saveStoredSession).toHaveBeenCalledWith(refreshed);
    expect(current?.session?.accessToken).toBe('new-token');
  });

  it('clears all local scopes only after the server confirms account deletion', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockResolvedValue(cachedSession.user);
    (authService.deleteAccount as jest.Mock).mockResolvedValue({
      deleted: true,
      events_deleted: 1,
      meetings_deleted: 2,
      sessions_deleted: 1,
      cleanup_pending: 0,
    });

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('authenticated'));

    await act(async () => {
      await current?.deleteAccount('Password123', '删除账号');
    });

    expect(authService.deleteAccount).toHaveBeenCalledWith('cached-token', 'Password123', '删除账号');
    expect(authService.clearStoredToken).toHaveBeenCalled();
    expect(AsyncStorage.clear).toHaveBeenCalled();
    expect(current?.mode).toBe('signed_out');
    expect(current?.session).toBeNull();
  });

  it('keeps the local session when server-side deletion fails', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockResolvedValue(cachedSession.user);
    (authService.deleteAccount as jest.Mock).mockRejectedValue(new Error('当前密码错误'));

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('authenticated'));

    await expect(current?.deleteAccount('wrong-pass', '删除账号')).rejects.toThrow('当前密码错误');
    expect(authService.clearStoredToken).not.toHaveBeenCalled();
    expect(AsyncStorage.clear).not.toHaveBeenCalled();
    expect(current?.mode).toBe('authenticated');
  });

  it('clears an active local session when an authenticated request returns 401', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockResolvedValue(cachedSession.user);

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('authenticated'));

    await act(async () => {
      notifyUnauthorized('cached-token');
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.mode).toBe('signed_out'));
    expect(current?.session).toBeNull();
    expect(current?.sessionNotice).toContain('重新登录');
    expect(authService.clearStoredToken).toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@laoji:authMode:v1', 'signed_out');
  });

  it('does not let an old account profile response overwrite a newly signed-in account', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockResolvedValue(cachedSession.user);
    let resolveOldProfile = (_profile: authService.RemoteProfile) => {};
    const oldProfileResponse = new Promise<authService.RemoteProfile>(resolve => {
      resolveOldProfile = resolve;
    });
    (authService.updateRemoteProfile as jest.Mock).mockReturnValue(oldProfileResponse);

    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('authenticated'));

    let oldUpdate: Promise<void> | undefined;
    await act(async () => {
      oldUpdate = current?.updateProfile({ ...current.profile, nickname: '账号 A 的延迟资料' });
      await Promise.resolve();
    });
    expect(authService.updateRemoteProfile).toHaveBeenCalled();

    await act(async () => {
      notifyUnauthorized('cached-token');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('signed_out'));

    const accountB: authService.AuthSession = {
      accessToken: 'account-b-token',
      expiresAt: '2099-10-01T00:00:00.000Z',
      user: {
        id: 8,
        account: 'account-b@example.com',
        nickname: '账号 B',
        created_at: '2026-07-13T00:00:00.000Z',
      },
    };
    (authService.loginAccount as jest.Mock).mockResolvedValue(accountB);
    (authService.fetchRemoteProfile as jest.Mock).mockResolvedValue({ nickname: '账号 B' });
    await act(async () => {
      await current?.signIn(accountB.user.account, 'Password123');
    });
    expect(current?.profile.nickname).toBe('账号 B');

    await act(async () => {
      notifyUnauthorized('cached-token');
      await Promise.resolve();
    });
    expect(current?.mode).toBe('authenticated');
    expect(current?.session?.user.id).toBe(8);

    await act(async () => {
      resolveOldProfile({ nickname: '账号 A 的云端资料' });
      await oldUpdate;
    });

    expect(current?.mode).toBe('authenticated');
    expect(current?.session?.user.id).toBe(8);
    expect(current?.profile.nickname).toBe('账号 B');
  });

  it('keeps the latest login intent when two login responses finish out of order', async () => {
    (authService.fetchCurrentUser as jest.Mock).mockResolvedValue(cachedSession.user);
    await act(async () => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.mode).toBe('authenticated'));
    await act(async () => { await current?.signOut(); });

    let resolveA = (_session: authService.AuthSession) => {};
    let resolveB = (_session: authService.AuthSession) => {};
    const loginA = new Promise<authService.AuthSession>(resolve => { resolveA = resolve; });
    const loginB = new Promise<authService.AuthSession>(resolve => { resolveB = resolve; });
    (authService.loginAccount as jest.Mock).mockImplementation((account: string) => (
      account === 'a@example.com' ? loginA : loginB
    ));
    (authService.fetchRemoteProfile as jest.Mock).mockImplementation(async (token: string) => ({
      nickname: token === 'token-b' ? '账号 B' : '账号 A',
    }));

    let requestA: Promise<void> | undefined;
    let requestB: Promise<void> | undefined;
    await act(async () => {
      requestA = current?.signIn('a@example.com', 'Password123');
      requestB = current?.signIn('b@example.com', 'Password123');
      await Promise.resolve();
    });

    const sessionB: authService.AuthSession = {
      accessToken: 'token-b',
      expiresAt: '2099-10-01T00:00:00.000Z',
      user: { id: 9, account: 'b@example.com', nickname: '账号 B', created_at: '2026-07-13T00:00:00.000Z' },
    };
    await act(async () => {
      resolveB(sessionB);
      await requestB;
    });
    expect(current?.session?.accessToken).toBe('token-b');

    const sessionA: authService.AuthSession = {
      accessToken: 'token-a',
      expiresAt: '2099-10-01T00:00:00.000Z',
      user: { id: 10, account: 'a@example.com', nickname: '账号 A', created_at: '2026-07-13T00:00:00.000Z' },
    };
    await act(async () => {
      resolveA(sessionA);
      await requestA;
    });

    expect(current?.mode).toBe('authenticated');
    expect(current?.session?.accessToken).toBe('token-b');
    expect(current?.profile.nickname).toBe('账号 B');
    expect(authService.fetchRemoteProfile).not.toHaveBeenCalledWith('token-a');
  });
});
