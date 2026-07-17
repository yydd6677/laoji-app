import { useEffect, useRef } from 'react';
import { useAuth } from '../store/AuthStore';
import { activateMinutesPlaybackStorageScope } from 'laoji-native-platform';
import {
  clearNativeTransferLease,
  ensureNativeTransferLease,
} from '../native/nativeTransferCoordinator';

/** MIN-UPLOAD-001: keep native background work scoped to the active account. */
export function NativePlatformCoordinator() {
  const { initializing, mode, session, accessToken } = useAuth();
  const previousScopeRef = useRef<string | null>(null);

  useEffect(() => {
    if (initializing) return;
    const playbackScope = mode === 'authenticated' && session
      ? `user:${session.user.id}` as const
      : mode === 'guest'
        ? 'guest' as const
        : 'signed_out' as const;
    void activateMinutesPlaybackStorageScope(playbackScope).catch(() => {});
    const nextScope = mode === 'authenticated' && session
      ? `user:${session.user.id}`
      : null;
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = nextScope;

    if (previousScope && previousScope !== nextScope) {
      void clearNativeTransferLease(previousScope).catch(() => {});
    }
    if (nextScope && accessToken) {
      void ensureNativeTransferLease(nextScope, accessToken).catch(() => {});
    }
  }, [accessToken, initializing, mode, session?.user.id]);

  return null;
}
