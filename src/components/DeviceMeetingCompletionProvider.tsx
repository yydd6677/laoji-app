import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { DeviceApiError, getDeviceTask, getDeviceTranscript } from '../services/deviceApi';
import { diagnosticWarn } from '../services/diagnostics';
import { getLocalDeviceSpeakerName } from '../services/speakers';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import {
  clearDeviceTranscriptTask,
  getDeviceTranscriptTask,
  markDeviceTranscriptTaskFailed,
} from '../services/deviceTranscriptTasks';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import type { TranscriptLine } from '../types';

const POLL_MS = 15_000;
const MAX_RETRY_BACKOFF_MS = 5 * 60_000;

type RetryState = { attempts: number; nextAt: number };

/**
 * A realtime session writes a readable local draft before the device upload
 * finishes, so `meeting.hasTranscript` alone cannot tell us whether the
 * server-side Qwen pass is complete. Read the canonical local revision and
 * keep polling only while it is absent, draft, or finalizing. Historical
 * local-only meetings with an already-ready revision are never sent again.
 */
async function needsDeviceTranscriptCompletion(meeting: {
  id: string;
  hasTranscript?: boolean;
}): Promise<boolean> {
  const task = await getDeviceTranscriptTask(meeting.id).catch(() => null);
  if (task?.state === 'failed') return false;
  if (task?.state === 'pending') return true;
  const canonicalId = await sqliteMeetingNoteRepository
    .resolveCanonicalMeetingId(meeting.id, 'guest')
    .catch(() => null);
  if (!canonicalId) return !meeting.hasTranscript;
  const current = await sqliteMeetingNoteRepository
    .getActiveTranscriptContent(canonicalId, 'guest')
    .catch(() => null);
  if (!current) return !meeting.hasTranscript;
  return current.revision.kind === 'realtime_draft'
    || !['ready', 'archived'].includes(current.revision.status);
}

/** Pull generated transcript bodies for phone-owned recordings only. */
export function DeviceMeetingCompletionProvider(): null {
  const { mode } = useAuth();
  const {
    meetings,
    loading,
    getCachedTranscript,
    saveCachedTranscript,
    updateMeetingStatus,
  } = useMeetings();
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const retryRef = useRef<Record<string, RetryState>>({});

  useEffect(() => {
    if (mode !== 'guest' || loading) return undefined;
    let active = true;
    let running = false;
    const run = async () => {
      if (!active || running) return;
      running = true;
      try {
        const candidatePool = meetingsRef.current.filter(meeting => (
          (meeting.audioAvailable || meeting.audioSyncPending || meeting.status === 'processing')
          && (retryRef.current[meeting.id]?.nextAt ?? 0) <= Date.now()
        )).slice(0, 12);
        const pendingChecks = await Promise.all(candidatePool.map(async meeting => (
          [meeting, await needsDeviceTranscriptCompletion(meeting)] as const
        )));
        const candidates = pendingChecks
          .filter(([, pending]) => pending)
          .map(([meeting]) => meeting)
          .slice(0, 4);
        for (const meeting of candidates) {
          if (!active) return;
          try {
            const task = await getDeviceTranscriptTask(meeting.id).catch(() => null);
            let taskStatus: any = null;
            if (task?.state === 'pending') {
              try {
                taskStatus = await getDeviceTask(task.taskId, 0);
              } catch (error) {
                // A task can disappear during server retention cleanup. Fall
                // back to the transcript endpoint once; a readable result is
                // still useful even when the task metadata has expired.
                if (error instanceof DeviceApiError && error.status === 404) {
                  await clearDeviceTranscriptTask(meeting.id).catch(() => undefined);
                } else {
                  throw error;
                }
              }
            }
            const taskState = String(taskStatus?.status ?? '').trim().toLowerCase();
            if (taskState === 'queued' || taskState === 'running') continue;
            if (taskState === 'failed' || taskState === 'failure') {
              await markDeviceTranscriptTaskFailed(
                meeting.id,
                typeof taskStatus?.error_code === 'string' ? taskStatus.error_code : 'transcription_failed',
              ).catch(() => undefined);
              continue;
            }
            const payload = await getDeviceTranscript(meeting.id);
            delete retryRef.current[meeting.id];
            if (!Array.isArray(payload?.items) || payload.items.length === 0) {
              if (task?.state === 'pending' && taskState === 'completed') {
                await markDeviceTranscriptTaskFailed(meeting.id, 'no_speech').catch(() => undefined);
              }
              continue;
            }
            const lines: TranscriptLine[] = await Promise.all(payload.items.map(async (item: any, index: number) => ({
              id: String(item.id || `${meeting.id}:${index}`),
              meeting_id: meeting.id,
              recording_asset_id: item.recording_asset_id ?? null,
              transcription_job_id: item.transcription_job_id ?? null,
              speaker_id: item.speaker_id,
              speaker_label: await getLocalDeviceSpeakerName(item.speaker_id)
                || String(item.speaker_label || '未知讲话人'),
              text: String(item.text || ''),
              start_time: Number(item.start_ms || 0) / 1000,
              end_time: Number(item.end_ms || 0) / 1000,
              confidence: Number(item.confidence || 0),
              isFinal: true,
              revisionKind: 'final',
              script: 'zh-Hans',
            }))).then(items => items.filter((line: TranscriptLine) => line.text.trim()));
            if (lines.length === 0) continue;
            const existing = getCachedTranscript(meeting.id);
            if (existing.length >= lines.length && existing.every((line, index) => line.text === lines[index]?.text)) continue;
            await saveCachedTranscript(meeting.id, lines, {
              candidateKind: 'final',
              serverCompleteness: 'complete',
              remoteRevisionId: typeof payload.revision_id === 'string' ? payload.revision_id : null,
            });
            await clearDeviceTranscriptTask(meeting.id).catch(() => undefined);
            await updateMeetingStatus(meeting.id, 'ended', { hasTranscript: true }, { remoteSync: 'background' });
          } catch (error) {
            const previous = retryRef.current[meeting.id] ?? { attempts: 0, nextAt: 0 };
            const attempts = previous.attempts + 1;
            // A missing remote binding can be temporary during upload/delete
            // races.  Back off instead of polling the same 404 every 15 sec;
            // later foreground runs still retry and can recover a late task.
            const delay = error instanceof DeviceApiError && error.status === 404
              ? MAX_RETRY_BACKOFF_MS
              : Math.min(MAX_RETRY_BACKOFF_MS, POLL_MS * (2 ** Math.min(attempts - 1, 5)));
            retryRef.current[meeting.id] = { attempts, nextAt: Date.now() + delay };
            if (active) diagnosticWarn('[device-transcript] pull deferred', {
              meeting_id_suffix: meeting.id.slice(-8),
              status: error instanceof DeviceApiError ? error.status : undefined,
              retry_in_ms: delay,
            });
          }
        }
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(() => { void run(); }, POLL_MS);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void run();
    });
    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [getCachedTranscript, loading, mode, saveCachedTranscript, updateMeetingStatus]);

  return null;
}
