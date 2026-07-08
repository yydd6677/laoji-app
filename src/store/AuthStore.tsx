import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AuthMode,
  AuthSession,
  AuthUser,
  clearStoredToken,
  deleteRemoteAvatar,
  fetchCurrentUser,
  fetchRemoteProfile,
  loadStoredToken,
  loginAccount,
  logoutAccount,
  registerAccount,
  saveStoredToken,
  updateRemoteProfile,
  uploadRemoteAvatar,
} from '../services/auth';
import {
  AVATAR_PRESETS,
  DEFAULT_PROFILE,
  GUEST_PROFILE,
  UserProfile,
  loadProfile,
  normalizeAvatarColors,
  profileInitial,
  saveProfile,
} from '../services/profile';

const AUTH_MODE_KEY = '@laoji:authMode:v1';

interface AuthContextType {
  initializing: boolean;
  mode: AuthMode;
  session: AuthSession | null;
  profile: UserProfile;
  isAuthenticated: boolean;
  isGuest: boolean;
  accessToken: string | null;
  signIn: (account: string, password: string) => Promise<void>;
  register: (account: string, password: string, nickname?: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (profile: UserProfile) => Promise<void>;
  uploadAvatar: (uri: string, fileName?: string, mimeType?: string) => Promise<void>;
  deleteAvatar: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function userToProfile(user: AuthUser): UserProfile {
  const isEmail = user.account.includes('@');
  return {
    nickname: user.nickname || user.account,
    email: user.email || (isEmail ? user.account : DEFAULT_PROFILE.email),
    phone: user.phone || (!isEmail ? user.account : DEFAULT_PROFILE.phone),
    avatarInitial: profileInitial(user.nickname || user.account),
    avatarColors: DEFAULT_PROFILE.avatarColors,
    avatarUrl: user.avatar_url ?? null,
    avatarLocalUri: null,
  };
}

function mergeRemoteProfile(base: UserProfile, remote: any): UserProfile {
  const nickname = remote?.nickname || base.nickname;
  return {
    ...base,
    nickname,
    email: remote?.email ?? base.email,
    phone: remote?.phone ?? base.phone,
    avatarInitial: remote?.avatar_initial ?? remote?.avatarInitial ?? base.avatarInitial ?? profileInitial(nickname),
    avatarColors: normalizeAvatarColors(remote?.avatar_colors ?? remote?.avatarColors, base.avatarColors ?? AVATAR_PRESETS[0]),
    avatarUrl: remote?.avatar_url ?? remote?.avatarUrl ?? base.avatarUrl ?? null,
    avatarLocalUri: remote?.avatar_url || remote?.avatarUrl ? null : base.avatarLocalUri ?? null,
  };
}

function profileToRemote(profile: UserProfile) {
  return {
    nickname: profile.nickname,
    email: profile.email,
    phone: profile.phone,
    avatar_initial: profile.avatarInitial,
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

  const activateSession = useCallback(async (next: AuthSession) => {
    await saveStoredToken(next.accessToken);
    await AsyncStorage.setItem(AUTH_MODE_KEY, 'authenticated');
    const fallbackProfile = userToProfile(next.user);
    let nextProfile = await loadProfile(`user:${next.user.id}`, fallbackProfile);
    try {
      const remote = await fetchRemoteProfile(next.accessToken);
      nextProfile = mergeRemoteProfile(nextProfile, remote);
    } catch {
      // Older backends may not expose profile sync yet; keep the local profile.
    }
    await saveProfile(nextProfile, `user:${next.user.id}`);
    setSession(next);
    setProfile(nextProfile);
    setMode('authenticated');
  }, []);

  useEffect(() => {
    let alive = true;
    async function restore() {
      try {
        const [storedMode, token] = await Promise.all([
          AsyncStorage.getItem(AUTH_MODE_KEY),
          loadStoredToken(),
        ]);
        if (!alive) return;
        if (token) {
          try {
            const user = await fetchCurrentUser(token);
            if (!alive) return;
            const restored: AuthSession = {
              accessToken: token,
              expiresAt: '',
              user,
            };
            let restoredProfile = await loadProfile(`user:${user.id}`, userToProfile(user));
            try {
              const remote = await fetchRemoteProfile(token);
              restoredProfile = mergeRemoteProfile(restoredProfile, remote);
            } catch {
              // Keep local profile if profile sync is temporarily unavailable.
            }
            if (!alive) return;
            setSession(restored);
            setProfile(restoredProfile);
            setMode('authenticated');
            return;
          } catch {
            await clearStoredToken();
          }
        }
        if (storedMode === 'guest') {
          const guestProfile = await loadProfile('guest', GUEST_PROFILE);
          if (!alive) return;
          setSession(null);
          setProfile(guestProfile);
          setMode('guest');
          return;
        }
        setSession(null);
        setProfile(DEFAULT_PROFILE);
        setMode('signed_out');
      } finally {
        if (alive) setInitializing(false);
      }
    }
    restore();
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async (account: string, password: string) => {
    const next = await loginAccount(account.trim(), password);
    await activateSession(next);
  }, [activateSession]);

  const register = useCallback(async (account: string, password: string, nickname?: string) => {
    const next = await registerAccount(account.trim(), password, nickname?.trim() || undefined);
    await activateSession(next);
  }, [activateSession]);

  const continueAsGuest = useCallback(async () => {
    await clearStoredToken();
    await AsyncStorage.setItem(AUTH_MODE_KEY, 'guest');
    const guestProfile = await loadProfile('guest', GUEST_PROFILE);
    setSession(null);
    setProfile(guestProfile);
    setMode('guest');
  }, []);

  const signOut = useCallback(async () => {
    const token = session?.accessToken;
    setSession(null);
    setMode('signed_out');
    setProfile(DEFAULT_PROFILE);
    await AsyncStorage.setItem(AUTH_MODE_KEY, 'signed_out');
    await clearStoredToken();
    if (token) {
      try {
        await logoutAccount(token);
      } catch {
        // Local logout should still complete if the server is unavailable.
      }
    }
  }, [session?.accessToken]);

  const updateProfile = useCallback(async (nextProfile: UserProfile) => {
    const scope = profileScope(mode, session);
    await saveProfile(nextProfile, scope);
    setProfile(nextProfile);
    if (mode === 'authenticated' && session?.accessToken) {
      const remote = await updateRemoteProfile(session.accessToken, profileToRemote(nextProfile));
      const merged = mergeRemoteProfile(nextProfile, remote);
      await saveProfile(merged, scope);
      setProfile(merged);
    }
  }, [mode, session]);

  const uploadAvatar = useCallback(async (uri: string, fileName?: string, mimeType?: string) => {
    const scope = profileScope(mode, session);
    if (mode === 'guest') {
      const nextProfile = { ...profile, avatarLocalUri: uri, avatarUrl: null };
      await saveProfile(nextProfile, scope);
      setProfile(nextProfile);
      return;
    }
    if (!session?.accessToken) throw new Error('not authenticated');
    const remote = await uploadRemoteAvatar(session.accessToken, uri, fileName, mimeType);
    const merged = mergeRemoteProfile({ ...profile, avatarLocalUri: uri }, remote);
    await saveProfile(merged, scope);
    setProfile(merged);
  }, [mode, profile, session]);

  const deleteAvatar = useCallback(async () => {
    const scope = profileScope(mode, session);
    if (mode === 'guest') {
      const nextProfile = { ...profile, avatarLocalUri: null, avatarUrl: null };
      await saveProfile(nextProfile, scope);
      setProfile(nextProfile);
      return;
    }
    if (!session?.accessToken) throw new Error('not authenticated');
    const remote = await deleteRemoteAvatar(session.accessToken);
    const merged = mergeRemoteProfile({ ...profile, avatarLocalUri: null, avatarUrl: null }, remote);
    await saveProfile(merged, scope);
    setProfile(merged);
  }, [mode, profile, session]);

  const value = useMemo<AuthContextType>(() => ({
    initializing,
    mode,
    session,
    profile,
    isAuthenticated: mode === 'authenticated' && Boolean(session),
    isGuest: mode === 'guest',
    accessToken: session?.accessToken ?? null,
    signIn,
    register,
    continueAsGuest,
    signOut,
    updateProfile,
    uploadAvatar,
    deleteAvatar,
  }), [continueAsGuest, deleteAvatar, initializing, mode, profile, register, session, signIn, signOut, updateProfile, uploadAvatar]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
