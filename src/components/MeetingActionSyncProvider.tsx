import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { subscribeMeetingActionSync } from '../application/meeting/actionSyncTrigger';
import type { ScopeKey } from '../domain/meeting';
import { drainMeetingActionSync } from '../services/meetingActionSync';
import { diagnosticWarn } from '../services/diagnostics';
import { useAuth } from '../store/AuthStore';

export function MeetingActionSyncProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (mode !== 'authenticated' || !accessToken || userId === null) return undefined;
    const scopeKey = `user:${userId}` as ScopeKey;
    let active = true;
    let running = false;
    let requested = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const controllers = new Set<AbortController>();

    const clearRetryTimer = () => {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };
    const requestRun = () => {
      if (!active) return;
      requested = true;
      clearRetryTimer();
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            const controller = new AbortController();
            controllers.add(controller);
            try {
              const result = await drainMeetingActionSync({
                scopeKey,
                accessToken,
                signal: controller.signal,
                isCurrent: () => active,
              });
              if (active && result.retryAfterMs !== null && !requested) {
                retryTimer = setTimeout(requestRun, Math.max(1_000, result.retryAfterMs));
              }
            } finally {
              controllers.delete(controller);
            }
          }
        } catch (error) {
          if (active) diagnosticWarn('[meeting-action-sync] drain failed', error);
        } finally {
          running = false;
          if (active && requested) requestRun();
        }
      })();
    };

    const unsubscribe = subscribeMeetingActionSync(requestedScope => {
      if (requestedScope === scopeKey) requestRun();
    });
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestRun();
    });
    requestRun();
    return () => {
      active = false;
      requested = false;
      clearRetryTimer();
      unsubscribe();
      appStateSubscription.remove();
      controllers.forEach(controller => controller.abort());
      controllers.clear();
    };
  }, [accessToken, mode, userId]);

  return <>{children}</>;
}
