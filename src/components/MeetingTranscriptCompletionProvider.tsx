import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { subscribeMeetingTranscriptCompletion } from '../application/meeting/transcriptCompletionTrigger';
import { loadMeetingCapabilities } from '../data/api/v2';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import { drainMeetingRecordingTranscription } from '../services/meetingRecordingTranscriptionSync';
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
const CONTENT_RECHECK_MS = 15_000;
const DISCOVERY_TTL_MS = 5 * 60_000;
const CAPABILITY_FALSE_RECHECK_MS = 5 * 60_000;
const MAX_TASKS_PER_DRAIN = 4;

function recordingDiscoveryMeetings(meetings: readonly Meeting[]) {
  const byRemoteId = new Map<string, { meetingId: string; remoteMeetingId: string }>();
  meetings.forEach(meeting => {
    const remoteMeetingId = meetingRemoteIdentity(meeting);
    if (!remoteMeetingId) return;
    const mayHaveRecording = Boolean(
      meeting.audioAvailable
      || meeting.audioLocalUri
      || meeting.audioSyncPending
      || meeting.hasTranscript,
    );
    if (!mayHaveRecording || byRemoteId.has(remoteMeetingId)) return;
    byRemoteId.set(remoteMeetingId, { meetingId: meeting.id, remoteMeetingId });
  });
  return [...byRemoteId.values()];
}

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
    const controller = new AbortController();
    let active = true;
    let running = false;
    let requested = true;
    let forceRecordingDiscovery = true;
    let recordingCapabilityReady = false;
    let recordingCapabilityRetryAtMs = 0;
    let lastRecordingDiscoveryAtMs = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const isCurrent = () => active && !controller.signal.aborted;
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
      }, Math.max(1_000, delayMs));
    };
    const requestRun = (discoverRecordingAssets = false) => {
      if (!active) return;
      forceRecordingDiscovery = forceRecordingDiscovery || discoverRecordingAssets;
      requested = true;
      clearRetryTimer();
      if (running) return;
      running = true;
      void (async () => {
        let nextRetryMs: number | null = null;
        const noteRetry = (delayMs: number) => {
          nextRetryMs = Math.min(nextRetryMs ?? delayMs, delayMs);
        };
        const ensureRecordingCapability = async (): Promise<boolean> => {
          if (recordingCapabilityReady) return true;
          const nowMs = Date.now();
          if (recordingCapabilityRetryAtMs > nowMs) {
            noteRetry(recordingCapabilityRetryAtMs - nowMs);
            return false;
          }
          try {
            const capability = await loadMeetingCapabilities({
              accessToken,
              forceRefresh: true,
              allowStaleOnError: false,
            });
            if (!isCurrent()) return false;
            if (capability.source === 'remote' && capability.capabilities.recordingAssetsV2) {
              recordingCapabilityReady = true;
              recordingCapabilityRetryAtMs = 0;
              return true;
            }
            recordingCapabilityRetryAtMs = nowMs + CAPABILITY_FALSE_RECHECK_MS;
            noteRetry(CAPABILITY_FALSE_RECHECK_MS);
            diagnosticAudit('recording_asset_transcription_capability', { status: 'unavailable' });
          } catch (reason) {
            recordingCapabilityRetryAtMs = nowMs + FAILED_RECHECK_MS;
            noteRetry(FAILED_RECHECK_MS);
            diagnosticWarn('[recording-transcription] fresh capability check failed', reason);
          }
          return false;
        };
        const completeRemoteMeeting = async (
          meeting: Meeting,
          remoteMeetingId: string,
          taskRegistered: boolean,
          completedCandidateKind: 'final' | 'reprocessed' = 'final',
          requestBatchId: string | null = null,
        ) => {
          const completion = await runAccountMeetingTranscriptCompletion({
            scopeKey,
            storageScope,
            meetingId: meeting.id,
            remoteMeetingId,
            accessToken,
            localLines: getCachedTranscript(meeting.id),
            retryDelaysMs: [0],
            taskRegistered,
            completedCandidateKind,
          }, {
            saveTranscript: saveCachedTranscript,
            getCachedTranscript,
            onFailure: (kind, reason) => mirrorLegacyTranscriptProcessingFailure(
              scopeKey,
              meeting.id,
              kind,
              reason,
            ),
          });
          if (completion.status === 'ready') {
            await sqliteMeetingNoteRepository.markRecordingAssetTranscriptionContentSynced(
              scopeKey,
              remoteMeetingId,
              requestBatchId,
              Date.now(),
            );
          }
          return completion.status;
        };

        try {
          while (active && requested) {
            requested = false;
            const handledMeetingIds = new Set<string>();
            if (await ensureRecordingCapability()) {
              const nowMs = Date.now();
              const shouldDiscover = forceRecordingDiscovery
                || nowMs - lastRecordingDiscoveryAtMs >= DISCOVERY_TTL_MS;
              forceRecordingDiscovery = false;
              const recordingResult = await drainMeetingRecordingTranscription({
                scopeKey,
                accessToken,
                discoveryMeetings: shouldDiscover
                  ? recordingDiscoveryMeetings(meetingsRef.current)
                  : [],
                signal: controller.signal,
                isCurrent,
              });
              if (!isCurrent()) return;
              if (shouldDiscover) lastRecordingDiscoveryAtMs = Date.now();
              if (recordingResult.retryAfterMs !== null) noteRetry(recordingResult.retryAfterMs);
              for (const readyContent of recordingResult.readyContents) {
                if (!isCurrent()) return;
                const meeting = meetingsRef.current.find(item => (
                  meetingRemoteIdentity(item) === readyContent.remoteMeetingId
                ));
                if (!meeting) {
                  noteRetry(FAILED_RECHECK_MS);
                  continue;
                }
                handledMeetingIds.add(meeting.id);
                try {
                  const status = await completeRemoteMeeting(
                    meeting,
                    readyContent.remoteMeetingId,
                    true,
                    readyContent.candidateKind,
                    readyContent.requestBatchId,
                  );
                  if (status === 'pending') noteRetry(CONTENT_RECHECK_MS);
                  else if (status === 'failed') noteRetry(FAILED_RECHECK_MS);
                } catch (reason) {
                  noteRetry(FAILED_RECHECK_MS);
                  diagnosticWarn('complete recording asset transcript failed', reason);
                }
              }
              if (
                recordingResult.processedCount > 0
                && recordingResult.retryAfterMs === null
                && recordingResult.readyContents.length === 0
              ) noteRetry(CONTENT_RECHECK_MS);
            }

            const tasks = await listPendingMeetingTranscriptCompletions(storageScope);
            if (!active) return;
            const nowMs = Date.now();
            const runnable = tasks.filter(task => {
              const retryAtMs = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : Number.NaN;
              if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs) return true;
              noteRetry(retryAtMs - nowMs);
              return false;
            });
            const unhandledRunnable = runnable
              .filter(task => !handledMeetingIds.has(task.meetingId));
            const batch = unhandledRunnable.slice(0, MAX_TASKS_PER_DRAIN);
            if (unhandledRunnable.length > batch.length) noteRetry(1_000);
            for (const task of batch) {
              if (!active) return;
              const meeting = meetingsRef.current.find(item => item.id === task.meetingId);
              if (!meeting) continue;
              const remoteMeetingId = meetingRemoteIdentity(meeting) ?? task.remoteMeetingId;
              try {
                const status = await completeRemoteMeeting(meeting, remoteMeetingId, true);
                if (status === 'pending') {
                  noteRetry(meetingTranscriptCompletionRetryDelayMs(
                    'pending',
                    task.attemptCount + 1,
                  ));
                } else if (status === 'failed') {
                  noteRetry(meetingTranscriptCompletionRetryDelayMs(
                    'failed',
                    task.attemptCount + 1,
                  ));
                }
              } catch (reason) {
                noteRetry(FAILED_RECHECK_MS);
                diagnosticWarn('resume transcript completion task failed', reason);
              }
            }
          }
        } catch (reason) {
          nextRetryMs = FAILED_RECHECK_MS;
          if (active && (reason as Error)?.name !== 'AbortError') {
            diagnosticWarn('load transcript completion tasks failed', reason);
          }
        } finally {
          running = false;
          if (active && requested) requestRun();
          else if (active && nextRetryMs !== null) scheduleRetry(nextRetryMs);
        }
      })();
    };

    const unsubscribe = subscribeMeetingTranscriptCompletion((requestedScope, options) => {
      if (requestedScope === scopeKey) requestRun(options.discoverRecordingAssets === true);
    });
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestRun(true);
    });
    requestRun(true);
    return () => {
      active = false;
      requested = false;
      controller.abort();
      clearRetryTimer();
      unsubscribe();
      appStateSubscription.remove();
    };
  }, [accessToken, getCachedTranscript, loading, mode, saveCachedTranscript, userId]);

  return <>{children}</>;
}
