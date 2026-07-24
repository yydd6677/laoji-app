import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { subscribeMeetingTranscriptCompletion } from '../application/meeting/transcriptCompletionTrigger';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticWarn } from '../services/diagnostics';
import { runAccountMeetingTranscriptCompletion } from '../services/meetingTranscriptCompletionCoordinator';
import {
  listPendingMeetingTranscriptCompletions,
  meetingTranscriptCompletionRetryDelayMs,
} from '../services/meetingTranscriptCompletionTasks';
import { mirrorLegacyTranscriptProcessingFailure } from '../services/meetingStageMirror';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import type { Meeting } from '../types';
import { meetingRemoteIdentity } from '../utils/meetingMedia';

const FAILED_RECHECK_MS = 30_000;
const MAX_TASKS_PER_DRAIN = 4;

export function MeetingTranscriptCompletionProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const {
    meetings,
    loading,
    getCachedTranscript,
    saveCachedTranscript,
  } = useMeetings();
  const meetingsRef = useRef<readonly Meeting[]>(meetings);
  meetingsRef.current = meetings;
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (mode !== 'authenticated' || !accessToken || userId === null || loading) return undefined;
    const scopeKey = `user:${userId}` as Exclude<ScopeKey, 'guest'>;
    const storageScope = scopeKey;
    let active = true;
    let running = false;
    let requested = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };
    const scheduleRetry = (delayMs: number) => {
      if (!active || requested || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        requestRun();
      }, delayMs);
    };
    const requestRun = () => {
      if (!active) return;
      requested = true;
      clearRetryTimer();
      if (running) return;
      running = true;
      void (async () => {
        let nextRetryMs: number | null = null;
        try {
          while (active && requested) {
            requested = false;
            const tasks = await listPendingMeetingTranscriptCompletions(storageScope);
            if (!active) return;
            const nowMs = Date.now();
            const runnable = tasks.filter(task => {
              const retryAtMs = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : Number.NaN;
              if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs) return true;
              nextRetryMs = Math.min(nextRetryMs ?? retryAtMs - nowMs, retryAtMs - nowMs);
              return false;
            });
            const batch = runnable.slice(0, MAX_TASKS_PER_DRAIN);
            if (runnable.length > batch.length) nextRetryMs = 1_000;
            for (const task of batch) {
              if (!active) return;
              const meeting = meetingsRef.current.find(item => item.id === task.meetingId);
              if (!meeting) continue;
              const remoteMeetingId = meetingRemoteIdentity(meeting) ?? task.remoteMeetingId;
              try {
                const completion = await runAccountMeetingTranscriptCompletion({
                  scopeKey,
                  storageScope,
                  meetingId: task.meetingId,
                  remoteMeetingId,
                  accessToken,
                  localLines: getCachedTranscript(task.meetingId),
                  retryDelaysMs: [0],
                  taskRegistered: true,
                }, {
                  saveTranscript: saveCachedTranscript,
                  getCachedTranscript,
                  onFailure: (kind, reason) => mirrorLegacyTranscriptProcessingFailure(
                    scopeKey,
                    task.meetingId,
                    kind,
                    reason,
                  ),
                });
                if (completion.status === 'pending') {
                  const delayMs = meetingTranscriptCompletionRetryDelayMs(
                    'pending',
                    task.attemptCount + 1,
                  );
                  nextRetryMs = Math.min(nextRetryMs ?? delayMs, delayMs);
                } else if (completion.status === 'failed') {
                  const delayMs = meetingTranscriptCompletionRetryDelayMs(
                    'failed',
                    task.attemptCount + 1,
                  );
                  nextRetryMs = Math.min(nextRetryMs ?? delayMs, delayMs);
                }
              } catch (reason) {
                nextRetryMs = Math.min(nextRetryMs ?? FAILED_RECHECK_MS, FAILED_RECHECK_MS);
                diagnosticWarn('resume transcript completion task failed', reason);
              }
            }
          }
        } catch (reason) {
          nextRetryMs = FAILED_RECHECK_MS;
          if (active) diagnosticWarn('load transcript completion tasks failed', reason);
        } finally {
          running = false;
          if (active && requested) requestRun();
          else if (active && nextRetryMs !== null) scheduleRetry(nextRetryMs);
        }
      })();
    };

    const unsubscribe = subscribeMeetingTranscriptCompletion(requestedScope => {
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
    };
  }, [accessToken, getCachedTranscript, loading, meetings.length, mode, saveCachedTranscript, userId]);

  return <>{children}</>;
}
