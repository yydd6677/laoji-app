import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  LOCAL_PROFILE,
  type UserProfile,
  loadProfile,
  persistLocalAvatar,
  removeManagedLocalAvatar,
  saveProfile,
} from '../services/profile';

/**
 * The historical storage scope remains `guest` so existing local preferences
 * continue to load. It is an installation-local namespace, not an account or
 * anonymous server session.
 */
export const LOCAL_PROFILE_SCOPE = 'guest' as const;

interface LocalProfileContextValue {
  initializing: boolean;
  profile: UserProfile;
  updateProfile: (profile: UserProfile) => Promise<void>;
  uploadAvatar: (uri: string) => Promise<void>;
  deleteAvatar: () => Promise<void>;
}

const LocalProfileContext = createContext<LocalProfileContextValue | null>(null);

export function LocalProfileProvider({ children }: { children: React.ReactNode }) {
  const [initializing, setInitializing] = useState(true);
  const [profile, setProfile] = useState<UserProfile>(LOCAL_PROFILE);

  useEffect(() => {
    let alive = true;
    void loadProfile(LOCAL_PROFILE_SCOPE, LOCAL_PROFILE)
      .then(next => {
        if (alive) setProfile(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setInitializing(false);
      });
    return () => { alive = false; };
  }, []);

  const updateProfile = useCallback(async (next: UserProfile) => {
    await saveProfile(next, LOCAL_PROFILE_SCOPE);
    setProfile(next);
  }, []);

  const uploadAvatar = useCallback(async (uri: string) => {
    const localUri = await persistLocalAvatar(uri, LOCAL_PROFILE_SCOPE);
    const previous = profile.avatarLocalUri;
    const next = {
      ...profile,
      avatarLocalUri: localUri,
      avatarUrl: null,
      avatarInitial: '',
      avatarInitialManual: false,
    };
    await saveProfile(next, LOCAL_PROFILE_SCOPE);
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
    await saveProfile(next, LOCAL_PROFILE_SCOPE);
    setProfile(next);
    await removeManagedLocalAvatar(previous);
  }, [profile]);

  const value = useMemo<LocalProfileContextValue>(() => ({
    initializing,
    profile,
    updateProfile,
    uploadAvatar,
    deleteAvatar,
  }), [deleteAvatar, initializing, profile, updateProfile, uploadAvatar]);

  return <LocalProfileContext.Provider value={value}>{children}</LocalProfileContext.Provider>;
}

export function useLocalProfile(): LocalProfileContextValue {
  const value = useContext(LocalProfileContext);
  if (!value) throw new Error('useLocalProfile must be used inside LocalProfileProvider');
  return value;
}
