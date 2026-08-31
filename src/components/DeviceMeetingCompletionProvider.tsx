import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { DeviceApiError, getDeviceTask, getDeviceTranscript } from '../services/deviceApi';
import { diagnosticWarn } from '../services/diagnostics';
import { getLocalDeviceSpeakerName } from '../services/speakers';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import {
  advanceDeviceTranscriptEventCursor,
  cancelDeviceTranscriptTask,
  clearDeviceTranscriptTask,
  getDeviceTranscriptTask,
  listPendingDeviceTranscriptTasks,
  markDeviceTranscriptTaskFailed,
  markDeviceTranscriptTaskProgress,
  subscribeDeviceTranscriptTaskChanged,
} from '../services/deviceTranscriptTasks';
import { loadDeviceV2Capabilities } from '../services/deviceV2Api';
import {
  ackDeviceV2ImportTranscriptEvents,
  getDeviceV2ImportTranscriptEvents,
  transcriptProjectionSha256,
} from '../services/deviceV2ImportTranscript';
import { applyDeviceV2ImportSpeakerOverlay } from '../services/deviceV2SpeakerOverlay';
import {
  mirrorDeviceTranscriptTaskTerminal,
  recordTranscriptProcessingFailure,
} from '../services/meetingStageMirror';
import { loadActiveMeetingTranscriptState } from '../services/meetingTranscriptState';
import { useMeetings } from '../store/MeetingsStore';
import type { TranscriptLine } from '../types';

const POLL_MS = 8_000;
const PARTIAL_POLL_MS = 750;
const MAX_RETRY_BACKOFF_MS = 5 * 60_000;

type RetryState = { attempts: number; nextAt: number };

/**
 * The durable transcript task is the only authority that can request a
 * remote completion pull.  In particular, a guest meeting with no task is
 * not evidence of a pending v1 transcript: old local records commonly have
 * no transcript and would otherwise cause an endless `GET /meetings/.../
 * transcript` loop (and, after the v1 credential was retired, repeated 401s).
 *
 * A realtime session writes its draft before the server task is created, but
 * the upload coordinator records the task immediately after submission and
 * notifies this provider.  The next run therefore sees the task; treating a
 * task-less meeting as pending is both unnecessary and unsafe.
 */
async function needsDeviceTranscriptCompletion(meeting: {
  id: string;
  hasTranscript?: boolean;
}): Promise<boolean> {
  const task = await getDeviceTranscriptTask(meeting.id).catch(() => null);
  return task?.state === 'pending';
}

/** Pull generated transcript bodies for phone-owned recordings only. */
export function DeviceMeetingCompletionProvider(): null {
  const {
    meetings,
    loading,
    getCachedTranscript,
    saveCachedTranscript,
    updateMeetingStatus,
    refreshMeetings,
  } = useMeetings();
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const retryRef = useRef<Record<string, RetryState>>({});
  const terminalProjectionAuditRef = useRef(new Set<string>());

  useEffect(() => {
    if (loading) return undefined;
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const currentTranscriptLines = async (meetingId: string): Promise<TranscriptLine[]> => {
      const canonical = await loadActiveMeetingTranscriptState('guest', meetingId).catch(() => null);
      return canonical?.lines ?? getCachedTranscript(meetingId);
    };
    const run = async () => {
      if (!active || running) return;
      running = true;
      let hasActivePartialTask = false;
      try {
        // Enumerate the durable operation owner first. A task must remain
        // recoverable even when the list is still showing an old roots cache
        // or a local projection refresh was interrupted.
        const durableTasks = await listPendingDeviceTranscriptTasks(64);
        const visiblePendingChecks = await Promise.all(meetingsRef.current.slice(0, 64).map(async meeting => (
          [meeting, await needsDeviceTranscriptCompletion(meeting)] as const
        )));
        const pendingIds = new Set(durableTasks.map(task => task.meetingId));
        visiblePendingChecks
          .filter(([, pending]) => pending)
          .forEach(([meeting]) => pendingIds.add(meeting.id));

        // Repair a final transcript whose earlier client acknowledged the
        // server result but was interrupted between content activation and
        // clearing the list-stage spinner. Pending tasks are excluded so an
        // older final revision cannot hide a genuine reprocessing operation.
        let repairedTerminalProjection = false;
        for (const [meeting, pending] of visiblePendingChecks) {
          if (pending) {
            terminalProjectionAuditRef.current.delete(meeting.id);
            continue;
          }
          if (!meeting.hasTranscript || terminalProjectionAuditRef.current.has(meeting.id)) continue;
          terminalProjectionAuditRef.current.add(meeting.id);
          repairedTerminalProjection = await mirrorDeviceTranscriptTaskTerminal(
            'guest',
            meeting.id,
            'text',
          ).catch(() => false) || repairedTerminalProjection;
        }
        if (repairedTerminalProjection) await refreshMeetings();

        if ([...pendingIds].some(id => !meetingsRef.current.some(meeting => meeting.id === id))) {
          await refreshMeetings();
        }
        const visibleById = new Map(meetingsRef.current.map(meeting => [meeting.id, meeting]));
        const missingIds = [...pendingIds].filter(id => !visibleById.has(id));
        // A durable operation with no active meeting after a canonical refresh
        // belongs to a deleted/incompatible local root. Safely retire the
        // local recovery intent instead of displaying an endless hidden task.
        await Promise.all(missingIds.map(id => cancelDeviceTranscriptTask(id).catch(() => undefined)));
        const candidates = [...pendingIds]
          .filter(id => (retryRef.current[id]?.nextAt ?? 0) <= Date.now())
          .map(id => visibleById.get(id))
          .filter((meeting): meeting is NonNullable<typeof meeting> => Boolean(meeting))
          .slice(0, 4);
        for (const meeting of candidates) {
          if (!active) return;
          try {
            const task = await getDeviceTranscriptTask(meeting.id).catch(() => null);
            if (task?.taskId.startsWith('v2-transcript-')) {
              const v2Capabilities = await loadDeviceV2Capabilities().catch(() => null);
              if (v2Capabilities?.importTranscriptEventsV2) {
                const snapshot = await getDeviceV2ImportTranscriptEvents(
                  task.taskId,
                  task.eventCursor,
                );
                if (snapshot.last_acked_event_seq > task.eventCursor) {
                  throw new Error('本机文字记录游标落后于已确认服务端事件');
                }
                if (snapshot.payload_expired && task.eventCursor < snapshot.last_event_seq) {
                  await markDeviceTranscriptTaskFailed(
                    meeting.id,
                    'transcript_events_expired',
                  ).catch(() => undefined);
                  continue;
                }
                if (snapshot.state === 'failed' || snapshot.state === 'cancelled') {
                  const changed = await markDeviceTranscriptTaskFailed(
                    meeting.id,
                    snapshot.error_code ?? 'transcription_failed',
                  ).catch(() => false);
                  if (changed) await refreshMeetings();
                  continue;
                }
                if (snapshot.last_acked_event_seq < task.eventCursor) {
                  const canonicalId = await sqliteMeetingNoteRepository
                    .resolveCanonicalMeetingId(meeting.id, 'guest');
                  const activeProjection = canonicalId
                    ? await sqliteMeetingNoteRepository.getActiveTranscriptContent(canonicalId, 'guest')
                    : null;
                  const hasTaskSegments = activeProjection?.segments.some(
                    segment => segment.sourceTranscriptionJobId === task.taskId,
                  ) ?? false;
                  const ackOutcome = snapshot.state === 'no_content'
                    && task.eventCursor === snapshot.last_event_seq
                    ? 'no_speech'
                    : 'text';
                  if (ackOutcome === 'text' && !hasTaskSegments) {
                    throw new Error('待确认文字记录已不在本机权威版本中');
                  }
                  const replayProjectionSha256 = await transcriptProjectionSha256({
                    taskId: task.taskId,
                    meetingId: meeting.id,
                    throughEventSeq: task.eventCursor,
                    outcome: ackOutcome,
                    transcriptRevisionId: hasTaskSegments ? activeProjection?.revision.id ?? null : null,
                  });
                  await ackDeviceV2ImportTranscriptEvents(
                    task.taskId,
                    task.eventCursor,
                    replayProjectionSha256,
                  );
                }
                const newEvents = snapshot.events.filter(event => event.event_sequence > task.eventCursor);
                if (newEvents.length > 0) {
                  let expectedSequence = task.eventCursor + 1;
                  newEvents.forEach(event => {
                    if (event.event_sequence !== expectedSequence) {
                      throw new Error('文字记录事件序号不连续');
                    }
                    expectedSequence += 1;
                  });
                  const finalEvent = newEvents.find(event => event.event_kind === 'final') ?? null;
                  const stableEvents = newEvents.filter(event => event.event_kind === 'stable' && event.outcome === 'text');
                  const previous = (await currentTranscriptLines(meeting.id)).filter(line => (
                    (line.transcription_job_id ?? line.transcriptionJobId) === task.taskId
                  ));
                  const byStableKey = new Map(previous.map(line => [line.id, line]));
                  stableEvents.forEach(event => {
                    const stableKey = String(event.stable_segment_key);
                    byStableKey.set(stableKey, {
                      id: stableKey,
                      meeting_id: meeting.id,
                      recording_asset_id: null,
                      transcription_job_id: task.taskId,
                      speaker_label: '未知讲话人',
                      text: event.text,
                      start_time: event.source_start_ms / 1000,
                      end_time: event.source_end_ms / 1000,
                      confidence: 0,
                      isFinal: finalEvent?.outcome === 'text',
                      textState: finalEvent?.outcome === 'text' ? 'final' : 'stable',
                      revisionKind: finalEvent?.outcome === 'text' ? 'final' : 'realtimeDraft',
                      script: 'zh-Hans',
                    });
                  });
                  const lines = [...byStableKey.values()].sort((left, right) => (
                    Number(left.start_time ?? 0) - Number(right.start_time ?? 0)
                    || left.id.localeCompare(right.id)
                  )).map(line => finalEvent?.outcome === 'text'
                    ? {
                        ...line,
                        isFinal: true,
                        textState: 'final' as const,
                        revisionKind: 'final' as const,
                      }
                    : line);
                  let transcriptRevisionId: string | null = null;
                  if (lines.length > 0) {
                    await saveCachedTranscript(meeting.id, lines, {
                      candidateKind: finalEvent ? 'final' : 'realtime_draft',
                      serverCompleteness: finalEvent ? 'complete' : 'incomplete',
                      // A stable event prefix is a mutable local projection,
                      // not an immutable remote revision. Reusing one
                      // `${taskId}:live` identity caused the second prefix to
                      // be rejected as changed remote content, so the device
                      // acknowledged only its first batch forever. The final
                      // event is the first immutable remote revision.
                      remoteRevisionId: finalEvent ? `${task.taskId}:final` : null,
                    });
                    const canonicalId = await sqliteMeetingNoteRepository
                      .resolveCanonicalMeetingId(meeting.id, 'guest');
                    const activeProjection = canonicalId
                      ? await sqliteMeetingNoteRepository.getActiveTranscriptContent(canonicalId, 'guest')
                      : null;
                    const storedKeys = new Set(
                      activeProjection?.segments
                        .filter(segment => segment.sourceTranscriptionJobId === task.taskId)
                        .map(segment => segment.stableSegmentKey) ?? [],
                    );
                    if (stableEvents.some(event => !storedKeys.has(String(event.stable_segment_key)))) {
                      throw new Error('稳定文字记录尚未写入本机权威版本');
                    }
                    transcriptRevisionId = activeProjection?.revision.id ?? null;
                  }
                  if (finalEvent?.outcome === 'text' && (!transcriptRevisionId || lines.length === 0)) {
                    throw new Error('最终文字记录没有形成可读本机版本');
                  }
                  const nextCursor = newEvents.at(-1)!.event_sequence;
                  const advanced = await advanceDeviceTranscriptEventCursor(
                    meeting.id,
                    task.taskId,
                    task.eventCursor,
                    nextCursor,
                    snapshot.last_event_seq,
                  );
                  if (!advanced) throw new Error('文字记录事件游标已由其他进程修改');
                  const projectionSha256 = await transcriptProjectionSha256({
                    taskId: task.taskId,
                    meetingId: meeting.id,
                    throughEventSeq: nextCursor,
                    outcome: finalEvent?.outcome ?? 'text',
                    transcriptRevisionId,
                  });
                  await ackDeviceV2ImportTranscriptEvents(
                    task.taskId,
                    nextCursor,
                    projectionSha256,
                  );
                  if (finalEvent) {
                    if (finalEvent.outcome === 'no_speech') {
                      await recordTranscriptProcessingFailure(
                        'guest',
                        meeting.id,
                        'no_speech',
                        new Error('no_speech'),
                      );
                    }
                    await mirrorDeviceTranscriptTaskTerminal(
                      'guest',
                      meeting.id,
                      finalEvent.outcome,
                    );
                    await updateMeetingStatus(
                      meeting.id,
                      'ended',
                      { hasTranscript: finalEvent.outcome === 'text' || Boolean(meeting.hasTranscript) },
                    );
                    // Retire the durable operation only after both terminal
                    // content and its list projection are committed.
                    await clearDeviceTranscriptTask(meeting.id);
                    await refreshMeetings();
                    if (transcriptRevisionId) {
                      void applyDeviceV2ImportSpeakerOverlay({
                        taskId: task.taskId,
                        meetingId: meeting.id,
                        transcriptRevisionId,
                      }).catch(() => undefined);
                    }
                  } else {
                    hasActivePartialTask = true;
                  }
                } else if (snapshot.state === 'queued' || snapshot.state === 'running') {
                  hasActivePartialTask = true;
                  const changed = await markDeviceTranscriptTaskProgress(
                    meeting.id,
                    snapshot.state,
                  ).catch(() => false);
                  if (changed) await refreshMeetings();
                } else if (
                  snapshot.last_event_seq === task.eventCursor
                  && ['succeeded', 'no_content'].includes(snapshot.state)
                ) {
                  if (snapshot.state === 'no_content') {
                    await recordTranscriptProcessingFailure(
                      'guest',
                      meeting.id,
                      'no_speech',
                      new Error('no_speech'),
                    );
                  }
                  await mirrorDeviceTranscriptTaskTerminal(
                    'guest',
                    meeting.id,
                    snapshot.state === 'no_content' ? 'no_speech' : 'text',
                  );
                  await clearDeviceTranscriptTask(meeting.id);
                  await refreshMeetings();
                }
                delete retryRef.current[meeting.id];
                continue;
              }
            }
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
            if (taskState === 'failed' || taskState === 'failure') {
              const changed = await markDeviceTranscriptTaskFailed(
                meeting.id,
                typeof taskStatus?.error_code === 'string' ? taskStatus.error_code : 'transcription_failed',
              ).catch(() => false);
              if (changed) await refreshMeetings();
              continue;
            }
            const payload = await getDeviceTranscript(meeting.id);
            delete retryRef.current[meeting.id];
            const payloadComplete = payload?.complete !== false
              && payload?.source_kind !== 'provisional';
            const taskStillRunning = taskState === 'queued' || taskState === 'running';
            if (taskStillRunning || payloadComplete === false) {
              hasActivePartialTask = true;
              if (task?.state === 'pending') {
                const changed = await markDeviceTranscriptTaskProgress(
                  meeting.id,
                  taskState === 'running' ? 'running' : 'queued',
                ).catch(() => false);
                if (changed) await refreshMeetings();
              }
            }
            if (!Array.isArray(payload?.items) || payload.items.length === 0) {
              if (task?.state === 'pending' && taskState === 'completed' && payloadComplete) {
                // An explicitly completed, empty payload is a valid
                // no-speech result.  Do not surface it as a transcription
                // failure; transport/API failures are handled above and keep
                // their retryable error state.
                await recordTranscriptProcessingFailure(
                  'guest',
                  meeting.id,
                  'no_speech',
                  new Error('no_speech'),
                );
                await clearDeviceTranscriptTask(meeting.id).catch(() => undefined);
                await updateMeetingStatus(
                  meeting.id,
                  'ended',
                  { hasTranscript: Boolean(meeting.hasTranscript) },
                ).catch(() => undefined);
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
              isFinal: payloadComplete,
              textState: payloadComplete ? 'final' : 'stable',
              revisionKind: payloadComplete ? 'final' : 'realtimeDraft',
              script: 'zh-Hans',
            }))).then(items => items.filter((line: TranscriptLine) => line.text.trim()));
            if (lines.length === 0) continue;
            const existing = await currentTranscriptLines(meeting.id);
            const sameVisibleLines = existing.length === lines.length
              && existing.every((line, index) => (
                line.id === lines[index]?.id
                && line.text === lines[index]?.text
                && line.end_time === lines[index]?.end_time
                && line.isFinal === lines[index]?.isFinal
              ));
            if (sameVisibleLines) {
              if (payloadComplete) {
                await clearDeviceTranscriptTask(meeting.id).catch(() => undefined);
                await updateMeetingStatus(meeting.id, 'ended', { hasTranscript: true });
              }
              continue;
            }
            await saveCachedTranscript(meeting.id, lines, {
              candidateKind: payloadComplete ? 'final' : 'realtime_draft',
              serverCompleteness: payloadComplete ? 'complete' : 'incomplete',
              remoteRevisionId: typeof payload.revision_id === 'string' ? payload.revision_id : null,
            });
            if (payloadComplete) {
              await clearDeviceTranscriptTask(meeting.id).catch(() => undefined);
              await updateMeetingStatus(meeting.id, 'ended', { hasTranscript: true });
            }
          } catch (error) {
            const previous = retryRef.current[meeting.id] ?? { attempts: 0, nextAt: 0 };
            const attempts = previous.attempts + 1;
            // A missing remote binding can be temporary during upload/delete
            // races.  Back off instead of polling the same 404 every 15 sec;
            // later foreground runs still retry and can recover a late task.
            const delay = error instanceof DeviceApiError && error.status === 404
              ? MAX_RETRY_BACKOFF_MS
              : Math.min(MAX_RETRY_BACKOFF_MS, PARTIAL_POLL_MS * (2 ** Math.min(attempts - 1, 5)));
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
        if (active) {
          timer = setTimeout(() => {
            timer = null;
            void run();
          }, hasActivePartialTask ? PARTIAL_POLL_MS : POLL_MS);
        }
      }
    };
    void run();
    const unsubscribeTask = subscribeDeviceTranscriptTaskChanged(meetingId => {
      if (!active) return;
      // A pre-binding probe may have backed this meeting off after a 404.
      // Registering a real task is new evidence and must wake it immediately.
      delete retryRef.current[meetingId];
      if (timer) clearTimeout(timer);
      timer = null;
      void run();
    });
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        if (timer) clearTimeout(timer);
        timer = null;
        void run();
      }
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribeTask();
      subscription.remove();
    };
  }, [getCachedTranscript, loading, refreshMeetings, saveCachedTranscript, updateMeetingStatus]);

  return null;
}
