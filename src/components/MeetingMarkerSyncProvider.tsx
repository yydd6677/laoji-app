import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { subscribeMeetingMarkerSync } from '../application/meeting/markerSyncTrigger';
import { getFeatureFlags } from '../config/featureFlags';
import type { ScopeKey } from '../domain/meeting';
import { useAuth } from '../store/AuthStore';
import { diagnosticWarn } from '../services/diagnostics';
import { synchronizeMeetingMarkers } from '../services/meetingMarkerSync';
import { sqliteMeetingNoteRepository } from '../data/repositories';

export function MeetingMarkerSyncProvider({ children }: { children: React.ReactNode }) {
  const { accessToken, mode, session } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (
      !getFeatureFlags().meetingMarkerSyncV1
      || mode !== 'authenticated'
      || !accessToken
      || userId === null
    ) return undefined;
    const scopeKey = `user:${userId}` as ScopeKey;
    let active = true;
    let running = false;
    let requested = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const controllers = new Set<AbortController>();

    const clearRetry = () => {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };
    const requestRun = () => {
      if (!active) return;
      requested = true;
      clearRetry();
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            const controller = new AbortController();
            controllers.add(controller);
            try {
              const result = await synchronizeMeetingMarkers({
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
          if (active) {
            diagnosticWarn('[meeting-marker-sync] synchronization failed', error);
            if (!retryTimer && !requested) retryTimer = setTimeout(requestRun, 60_000);
          }
        } finally {
          running = false;
          if (active && requested) requestRun();
        }
      })();
    };

    const unsubscribe = subscribeMeetingMarkerSync(requestedScope => {
      if (requestedScope === scopeKey) requestRun();
    });
    // Meeting-root pull and marker pull are independent providers. Re-run once
    // a newly downloaded root enters the local projection so a second device
    // does not miss markers merely because its first marker pass won the race.
    const unsubscribeMeetings = sqliteMeetingNoteRepository.observeList(scopeKey, requestRun);
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') requestRun();
    });
    requestRun();
    return () => {
      active = false;
      requested = false;
      clearRetry();
      unsubscribe();
      unsubscribeMeetings();
      appState.remove();
      controllers.forEach(controller => controller.abort());
      controllers.clear();
    };
  }, [accessToken, mode, userId]);

  return <>{children}</>;
}
