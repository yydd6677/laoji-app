import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthMode, AuthSession, AuthUser } from '../services/auth';
import type { AccountDeleteResult } from '../services/auth';
import {
  DEFAULT_PROFILE,
  GUEST_PROFILE,
  UserProfile,
  loadProfile,
  persistLocalAvatar,
  removeManagedLocalAvatar,
  saveProfile,
} from '../services/profile';

/**
 * Compatibility name retained while the rest of the meeting repository is
 * being cut over.  It is no longer an account provider: every installation
 * runs one local data scope and no startup request is made.
 */
export const LOCAL_SCOPE_KEY = 'guest' as const;

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

function removedAccountFeature(): never {
  throw new Error('账号功能已移除，请直接使用本机数据');
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initializing, setInitializing] = useState(false);
  const [profile, setProfile] = useState<UserProfile>(GUEST_PROFILE);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Hydrate only local display preferences.  Never hold the first frame on
    // this read; the calendar and meeting stores have their own local loaders.
    void loadProfile(LOCAL_SCOPE_KEY, GUEST_PROFILE)
      .then(next => {
        if (alive) setProfile(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setInitializing(false);
      });
    return () => { alive = false; };
  }, []);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  const signOut = useCallback(async () => {
    await saveProfile(GUEST_PROFILE, LOCAL_SCOPE_KEY);
    setProfile(GUEST_PROFILE);
    setSessionNotice(null);
  }, []);

  const continueAsGuest = useCallback(async () => {
    setSessionNotice(null);
  }, []);

  const updateProfile = useCallback(async (next: UserProfile) => {
    await saveProfile(next, LOCAL_SCOPE_KEY);
    setProfile(next);
  }, []);

  const uploadAvatar = useCallback(async (uri: string) => {
    const localUri = await persistLocalAvatar(uri, LOCAL_SCOPE_KEY);
    const previous = profile.avatarLocalUri;
    const next = {
      ...profile,
      avatarLocalUri: localUri,
      avatarUrl: null,
      avatarInitial: '',
      avatarInitialManual: false,
    };
    await saveProfile(next, LOCAL_SCOPE_KEY);
    setProfile(next);
    if (previous && previous !== localUri) await removeManagedLocalAvatar(previous);
  }, [profile]);

  const deleteAvatar = useCallback(async () => {
    const previous = profile.avatarLocalUri;
    const next = {
      ...profile,
      avatarLocalUri: null,
      avatarUrl: null,
      avatarInitial: '',
      avatarInitialManual: false,
    };
    await saveProfile(next, LOCAL_SCOPE_KEY);
    setProfile(next);
    await removeManagedLocalAvatar(previous);
  }, [profile]);

  const value = useMemo<AuthContextType>(() => ({
    initializing,
    mode: 'guest',
    session: null,
    profile,
    isAuthenticated: false,
    isGuest: true,
    accessToken: null,
    sessionNotice,
    clearSessionNotice,
    signIn: async () => removedAccountFeature(),
    register: async () => removedAccountFeature(),
    continueAsGuest,
    signOut,
    deleteAccount: async () => removedAccountFeature(),
    updateProfile,
    uploadAvatar,
    deleteAvatar,
  }), [clearSessionNotice, continueAsGuest, deleteAvatar, initializing, profile, sessionNotice, signOut, updateProfile, uploadAvatar]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
