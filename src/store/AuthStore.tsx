import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AuthMode,
  RemoteProfile,
  AuthSession,
  AuthUser,
  clearStoredToken,
  deleteAccount as deleteRemoteAccount,
  deleteRemoteAvatar,
  fetchCurrentUser,
  fetchRemoteProfile,
  isAuthUnauthorizedError,
  loadStoredSession,
  loadStoredToken,
  loginAccount,
  logoutAccount,
  refreshAccountSession,
  registerAccount,
  saveStoredSession,
  updateRemoteProfile,
  uploadRemoteAvatar,
} from '../services/auth';
import type { AccountDeleteResult } from '../services/auth';
import {
  DEFAULT_PROFILE,
  GUEST_PROFILE,
  UserProfile,
  loadProfile,
  normalizeAvatarColors,
  persistLocalAvatar,
  removeManagedLocalAvatar,
  saveProfile,
} from '../services/profile';
import { isStoredSessionExpired, shouldRefreshStoredSession } from '../services/authSession';
import { clearLocalAppFiles, clearScheduledAppNotifications } from '../services/localData';
import { clearAppStorage, getAppStorageItem, setAppStorageItem } from '../services/appStorage';
import { setUnauthorizedHandler } from '../services/authInvalidation';
import { deleteMeetingDatabase } from '../data/db/openDatabase';

const AUTH_MODE_KEY = '@laoji:authMode:v1';

interface AuthContextType {
  initializing: boolean;
  mode: AuthMode;
  session: AuthSession | null;
  profile: UserProfile;
  isAuthenticated: boolean;
  isGuest: boolean;
  accessToken: string | null;
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  signIn: (account: string, password: string) => Promise<void>;
  register: (account: string, password: string, nickname?: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: (currentPassword: string, confirmation: string) => Promise<AccountDeleteResult>;
  updateProfile: (profile: UserProfile) => Promise<void>;
  uploadAvatar: (uri: string, fileName?: string, mimeType?: string) => Promise<void>;
  deleteAvatar: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function userToProfile(user: AuthUser): UserProfile {
  const isEmail = user.account.includes('@');
  return {
    nickname: user.nickname || user.account,
    email: user.email || (isEmail ? user.account : ''),
    phone: user.phone || (!isEmail ? user.account : ''),
    avatarInitial: '',
    avatarInitialManual: false,
    avatarColors: DEFAULT_PROFILE.avatarColors,
    avatarUrl: user.avatar_url ?? null,
    avatarLocalUri: null,
  };
}

function mergeRemoteProfile(base: UserProfile, remote: RemoteProfile): UserProfile {
  const nickname = remote?.nickname || base.nickname;
  const hasRemoteEmail = remote && Object.prototype.hasOwnProperty.call(remote, 'email');
  const hasRemotePhone = remote && Object.prototype.hasOwnProperty.call(remote, 'phone');
  return {
    ...base,
    nickname,
    email: hasRemoteEmail ? remote.email ?? '' : base.email,
    phone: hasRemotePhone ? remote.phone ?? '' : base.phone,
    avatarInitial: '',
    avatarInitialManual: false,
    avatarColors: normalizeAvatarColors(remote.avatar_colors, base.avatarColors ?? DEFAULT_PROFILE.avatarColors),
    avatarUrl: remote.avatar_url ?? base.avatarUrl ?? null,
    avatarLocalUri: remote.avatar_url ? null : base.avatarLocalUri ?? null,
  };
}

function profileToRemote(profile: UserProfile) {
  return {
    nickname: profile.nickname,
    email: profile.email.trim() || null,
    phone: profile.phone.trim() || null,
    avatar_initial: '',
    avatar_colors: profile.avatarColors,
  };
}

function profileScope(mode: AuthMode, session: AuthSession | null): string | undefined {
  if (mode === 'guest') return 'guest';
  if (mode === 'authenticated' && session) return `user:${session.user.id}`;
  return undefined;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initializing, setInitializing] = useState(true);
  const [mode, setMode] = useState<AuthMode>('signed_out');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const authStateRef = useRef<{ mode: AuthMode; accessToken: string | null }>({
    mode: 'signed_out',
    accessToken: null,
  });
  const authGenerationRef = useRef(0);
  const activationRequestRef = useRef(0);

  const commitAuthState = useCallback((nextMode: AuthMode, nextSession: AuthSession | null) => {
    const nextAccessToken = nextSession?.accessToken ?? null;
    if (
      authStateRef.current.mode !== nextMode
      || authStateRef.current.accessToken !== nextAccessToken
    ) {
      authGenerationRef.current += 1;
    }
    authStateRef.current = { mode: nextMode, accessToken: nextAccessToken };
    setSession(nextSession);
    setMode(nextMode);
  }, []);

  const isCurrentAuthOperation = useCallback((generation: number, accessToken: string | null) => (
    authGenerationRef.current === generation
    && authStateRef.current.accessToken === accessToken
  ), []);

  const expireUnauthorizedSession = useCallback((failedAccessToken: string) => {
    const current = authStateRef.current;
    if (
      current.mode !== 'authenticated'
      || !current.accessToken
      || current.accessToken !== failedAccessToken
    ) return;
    activationRequestRef.current += 1;
    commitAuthState('signed_out', null);
    setProfile(DEFAULT_PROFILE);
    setSessionNotice('登录状态已失效，为保护账号数据，请重新登录。');
    void Promise.allSettled([
      setAppStorageItem(AUTH_MODE_KEY, 'signed_out'),
      clearStoredToken(),
    ]);
  }, [commitAuthState]);

  useEffect(() => setUnauthorizedHandler(expireUnauthorizedSession), [expireUnauthorizedSession]);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  const activateSession = useCallback(async (next: AuthSession, requestId: number) => {
    const isCurrentRequest = () => activationRequestRef.current === requestId;
    if (!isCurrentRequest()) return;
    const fallbackProfile = userToProfile(next.user);
    let nextProfile = await loadProfile(`user:${next.user.id}`, fallbackProfile);
    if (!isCurrentRequest()) return;
    try {
      const remote = await fetchRemoteProfile(next.accessToken);
      nextProfile = mergeRemoteProfile(nextProfile, remote);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (isAuthUnauthorizedError(error)) {
        await Promise.all([
          clearStoredToken(),
          setAppStorageItem(AUTH_MODE_KEY, 'signed_out'),
        ]);
        throw error;
      }
      // Older backends may not expose profile sync yet; keep the local profile.
    }
    if (!isCurrentRequest()) return;
    commitAuthState('authenticated', next);
    setProfile(nextProfile);
    setSessionNotice(null);
    try {
      await Promise.all([
        saveStoredSession(next),
        setAppStorageItem(AUTH_MODE_KEY, 'authenticated'),
        saveProfile(nextProfile, `user:${next.user.id}`),
      ]);
    } catch (error) {
      if (authStateRef.current.accessToken === next.accessToken) {
        commitAuthState('signed_out', null);
        setProfile(DEFAULT_PROFILE);
        setSessionNotice('登录状态无法安全保存在本机，请重新登录。');
        await Promise.allSettled([
          clearStoredToken(),
          setAppStorageItem(AUTH_MODE_KEY, 'signed_out'),
        ]);
      }
      throw error;
    }
  }, [commitAuthState]);

  useEffect(() => {
    let alive = true;
    async function restore() {
      try {
        const [storedMode, cachedSession, legacyToken] = await Promise.all([
          getAppStorageItem(AUTH_MODE_KEY),
          loadStoredSession(),
          loadStoredToken(),
        ]);
        if (!alive) return;
        let token = cachedSession?.accessToken ?? legacyToken;
        if (token) {
          let restored = cachedSession;
          if (restored && isStoredSessionExpired(restored)) {
            await clearStoredToken();
            restored = null;
            token = null;
          }
          try {
            if (token) {
              if (restored && shouldRefreshStoredSession(restored)) {
                restored = await refreshAccountSession(token);
              } else {
                const user = await fetchCurrentUser(token);
                restored = { accessToken: token, expiresAt: restored?.expiresAt ?? '', user };
              }
              await saveStoredSession(restored);
            }
          } catch (error) {
            if (isAuthUnauthorizedError(error)) {
              await clearStoredToken();
              restored = null;
              if (storedMode === 'authenticated') {
                setSessionNotice('登录状态已失效，为保护账号数据，请重新登录。');
              }
            }
            // Network failures keep an unexpired cached session usable offline.
          }
          if (restored) {
            if (!alive) return;
            const restoredUser = restored.user;
            let restoredProfile = await loadProfile(`user:${restoredUser.id}`, userToProfile(restoredUser));
            try {
              const remote = await fetchRemoteProfile(restored.accessToken);
              restoredProfile = mergeRemoteProfile(restoredProfile, remote);
            } catch (error) {
              if (isAuthUnauthorizedError(error)) {
                await clearStoredToken();
                setSessionNotice('登录状态已失效，为保护账号数据，请重新登录。');
                restored = null;
              }
              // Keep local profile if profile sync is temporarily unavailable.
            }
            if (restored) {
              if (!alive) return;
              await saveProfile(restoredProfile, `user:${restoredUser.id}`);
              commitAuthState('authenticated', restored);
              setProfile(restoredProfile);
              return;
            }
          }
        }
        if (storedMode === 'guest') {
          const guestProfile = await loadProfile('guest', GUEST_PROFILE);
          if (!alive) return;
          commitAuthState('guest', null);
          setProfile(guestProfile);
          return;
        }
        commitAuthState('signed_out', null);
        setProfile(DEFAULT_PROFILE);
      } finally {
        if (alive) setInitializing(false);
      }
    }
    restore();
    return () => { alive = false; };
  }, [commitAuthState]);

  const signIn = useCallback(async (account: string, password: string) => {
    const requestId = activationRequestRef.current + 1;
    activationRequestRef.current = requestId;
    const next = await loginAccount(account.trim(), password);
    if (activationRequestRef.current !== requestId) return;
    await activateSession(next, requestId);
  }, [activateSession]);

  const register = useCallback(async (account: string, password: string, nickname?: string) => {
    const requestId = activationRequestRef.current + 1;
    activationRequestRef.current = requestId;
    const next = await registerAccount(account.trim(), password, nickname?.trim() || undefined);
    if (activationRequestRef.current !== requestId) return;
    await activateSession(next, requestId);
  }, [activateSession]);

  const continueAsGuest = useCallback(async () => {
    activationRequestRef.current += 1;
    await clearStoredToken();
    await setAppStorageItem(AUTH_MODE_KEY, 'guest');
    const guestProfile = await loadProfile('guest', GUEST_PROFILE);
    commitAuthState('guest', null);
    setProfile(guestProfile);
    setSessionNotice(null);
  }, [commitAuthState]);

  const signOut = useCallback(async () => {
    activationRequestRef.current += 1;
    const token = session?.accessToken;
    commitAuthState('signed_out', null);
    setProfile(DEFAULT_PROFILE);
    setSessionNotice(null);
    await setAppStorageItem(AUTH_MODE_KEY, 'signed_out');
    await clearStoredToken();
    if (token) {
      try {
        await logoutAccount(token);
      } catch {
        // Local logout should still complete if the server is unavailable.
      }
    }
  }, [commitAuthState, session?.accessToken]);

  const deleteAccount = useCallback(async (
    currentPassword: string,
    confirmation: string,
  ): Promise<AccountDeleteResult> => {
    const token = session?.accessToken;
    if (!token) throw new Error('请先登录');
    const result = await deleteRemoteAccount(token, currentPassword, confirmation);
    if (!result.deleted) throw new Error('服务器未确认账号删除');

    activationRequestRef.current += 1;
    commitAuthState('signed_out', null);
    setProfile(DEFAULT_PROFILE);
    const cleanupResults = await Promise.allSettled([
      clearStoredToken(),
      clearLocalAppFiles(),
      clearScheduledAppNotifications(),
      clearAppStorage(),
      deleteMeetingDatabase(),
    ]);
    return {
      ...result,
      local_cleanup_failed: cleanupResults.filter(outcome => outcome.status === 'rejected').length,
    };
  }, [commitAuthState, session?.accessToken]);

  const updateProfile = useCallback(async (nextProfile: UserProfile) => {
    const scope = profileScope(mode, session);
    const operationGeneration = authGenerationRef.current;
    const operationToken = session?.accessToken ?? null;
    if (mode === 'authenticated' && session?.accessToken) {
      const remote = await updateRemoteProfile(session.accessToken, profileToRemote(nextProfile));
      const merged = mergeRemoteProfile(nextProfile, remote);
      await saveProfile(merged, scope);
      if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(merged);
      return;
    }
    await saveProfile(nextProfile, scope);
    if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(nextProfile);
  }, [isCurrentAuthOperation, mode, session]);

  const uploadAvatar = useCallback(async (uri: string, fileName?: string, mimeType?: string) => {
    const scope = profileScope(mode, session);
    const operationGeneration = authGenerationRef.current;
    const operationToken = session?.accessToken ?? null;
    if (mode === 'guest') {
      const localUri = await persistLocalAvatar(uri, scope);
      const previousLocalUri = profile.avatarLocalUri;
      const nextProfile = { ...profile, avatarLocalUri: localUri, avatarUrl: null, avatarInitial: '', avatarInitialManual: false };
      await saveProfile(nextProfile, scope);
      if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(nextProfile);
      if (previousLocalUri !== localUri) await removeManagedLocalAvatar(previousLocalUri);
      return;
    }
    if (!session?.accessToken) throw new Error('not authenticated');
    try {
      const remote = await uploadRemoteAvatar(session.accessToken, uri, fileName, mimeType);
      const merged = mergeRemoteProfile({ ...profile, avatarLocalUri: null, avatarInitial: '', avatarInitialManual: false }, remote);
      await saveProfile(merged, scope);
      if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(merged);
      await removeManagedLocalAvatar(profile.avatarLocalUri);
    } catch (error) {
      if (isAuthUnauthorizedError(error)) throw error;
      try {
        const localUri = await persistLocalAvatar(uri, scope);
        const fallback = { ...profile, avatarLocalUri: localUri, avatarUrl: null, avatarInitial: '', avatarInitialManual: false };
        await saveProfile(fallback, scope);
        if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(fallback);
        if (profile.avatarLocalUri !== localUri) await removeManagedLocalAvatar(profile.avatarLocalUri);
        throw new Error('头像已保存在本机，但云端上传失败，请稍后重试。');
      } catch (fallbackError) {
        if (fallbackError instanceof Error && fallbackError.message.includes('已保存在本机')) throw fallbackError;
        throw error;
      }
    }
  }, [isCurrentAuthOperation, mode, profile, session]);

  const deleteAvatar = useCallback(async () => {
    const scope = profileScope(mode, session);
    const operationGeneration = authGenerationRef.current;
    const operationToken = session?.accessToken ?? null;
    if (mode === 'guest') {
      const previousLocalUri = profile.avatarLocalUri;
      const nextProfile = { ...profile, avatarLocalUri: null, avatarUrl: null, avatarInitial: '', avatarInitialManual: false };
      await saveProfile(nextProfile, scope);
      if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(nextProfile);
      await removeManagedLocalAvatar(previousLocalUri);
      return;
    }
    if (!session?.accessToken) throw new Error('not authenticated');
    const remote = await deleteRemoteAvatar(session.accessToken);
    const merged = mergeRemoteProfile({ ...profile, avatarLocalUri: null, avatarUrl: null, avatarInitial: '', avatarInitialManual: false }, remote);
    await saveProfile(merged, scope);
    if (isCurrentAuthOperation(operationGeneration, operationToken)) setProfile(merged);
    await removeManagedLocalAvatar(profile.avatarLocalUri);
  }, [isCurrentAuthOperation, mode, profile, session]);

  const value = useMemo<AuthContextType>(() => ({
    initializing,
    mode,
    session,
    profile,
    isAuthenticated: mode === 'authenticated' && Boolean(session),
    isGuest: mode === 'guest',
    accessToken: session?.accessToken ?? null,
    sessionNotice,
    clearSessionNotice,
    signIn,
    register,
    continueAsGuest,
    signOut,
    deleteAccount,
    updateProfile,
    uploadAvatar,
    deleteAvatar,
  }), [clearSessionNotice, continueAsGuest, deleteAccount, deleteAvatar, initializing, mode, profile, register, session, sessionNotice, signIn, signOut, updateProfile, uploadAvatar]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
