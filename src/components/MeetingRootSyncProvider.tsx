import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { subscribeMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import { requestMeetingActionSync } from '../application/meeting/actionSyncTrigger';
import { requestMeetingSpeakerCorrectionSync } from '../application/meeting/speakerCorrectionSyncTrigger';
import { requestMeetingOccurrenceSync } from '../application/meeting/occurrenceSyncTrigger';
import { requestMeetingTagCatalogSync } from '../application/meeting/tagCatalogSyncTrigger';
import { requestMeetingAttachmentSync } from '../application/meeting/attachmentSyncTrigger';
import { requestMeetingManualNoteSync } from '../application/meeting/manualNoteSyncTrigger';
import { requestMeetingMarkerSync } from '../application/meeting/markerSyncTrigger';
import { requestMeetingSummarySync } from '../application/meeting/summarySyncTrigger';
import { getFeatureFlags } from '../config/featureFlags';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticWarn } from '../services/diagnostics';
import { drainMeetingRootSync } from '../services/meetingRootSync';
import { useAuth } from '../store/AuthStore';

// Keep foreground sync self-healing when a provider was interrupted after
// claiming an operation (network handoff, token refresh, or process pressure).
// Individual workers still honor their durable retry times, so this heartbeat
// does not bypass backoff for ordinary retryable failures.
const FOREGROUND_SYNC_HEARTBEAT_MS = 30_000;

export function MeetingRootSyncProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (
      !getFeatureFlags().localMeetingDbAccountRootWriteV1
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
              const result = await drainMeetingRootSync({
                scopeKey,
                accessToken,
                signal: controller.signal,
                isCurrent: () => active,
              });
              if (active && result.processedCount > 0) {
                requestMeetingOccurrenceSync(scopeKey);
                requestMeetingActionSync(scopeKey);
                requestMeetingSpeakerCorrectionSync(scopeKey);
                requestMeetingTagCatalogSync(scopeKey);
              }
              if (active && result.retryAfterMs !== null && !requested) {
                retryTimer = setTimeout(requestRun, Math.max(1_000, result.retryAfterMs));
              }
            } finally {
              controllers.delete(controller);
            }
          }
        } catch (error) {
          if (active) diagnosticWarn('[meeting-root-sync] drain failed', error);
        } finally {
          running = false;
          if (active && requested) requestRun();
        }
      })();
    };

    const unsubscribe = subscribeMeetingRootSync(requestedScope => {
      if (requestedScope === scopeKey) requestRun();
    });
    const requestAllSync = () => {
      requestRun();
      requestMeetingOccurrenceSync(scopeKey);
      requestMeetingActionSync(scopeKey);
      requestMeetingSpeakerCorrectionSync(scopeKey);
      requestMeetingTagCatalogSync(scopeKey);
      requestMeetingAttachmentSync(scopeKey);
      requestMeetingManualNoteSync(scopeKey);
      requestMeetingMarkerSync(scopeKey);
      requestMeetingSummarySync(scopeKey);
    };
    const heartbeat = setInterval(requestAllSync, FOREGROUND_SYNC_HEARTBEAT_MS);
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestAllSync();
    });
    requestAllSync();
    return () => {
      active = false;
      requested = false;
      clearRetryTimer();
      unsubscribe();
      clearInterval(heartbeat);
      appStateSubscription.remove();
      controllers.forEach(controller => controller.abort());
      controllers.clear();
    };
  }, [accessToken, mode, userId]);

  return <>{children}</>;
}
