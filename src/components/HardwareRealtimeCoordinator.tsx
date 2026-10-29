import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  acknowledgeHardwareRealtime, addHardwareRealtimeListener, attachHardwareRealtime,
  hasNativeHardwareSupport, listHardwareRealtimeSessions, retireHardwareRealtime,
} from 'laoji-native-platform';
import { sqliteMeetingNoteRepository } from '../data/repositories/sqliteMeetingNoteRepository';
import { UpdateGuestMeetingCaptureUseCase } from '../application/meeting/updateGuestMeetingCapture';
import { prepareDeviceV2RealtimeRecording } from '../services/deviceV2Realtime';
import { loadActiveMeetingTranscriptState } from '../services/meetingTranscriptState';
import { useMeetings } from '../store/MeetingsStore';
import { hardwareRealtimeProjectionKey, orderHardwareRealtimeSessions, projectHardwareCapture, projectHardwareRealtimeDraft } from '../services/hardwareRealtimeProjection';
import type { CaptureStatus } from '../domain/meeting';
import { isLocalDataErasing, localDataEraseRevision } from '../services/localDataEraseState';

const captureOwner = new UpdateGuestMeetingCaptureUseCase({ repository: sqliteMeetingNoteRepository });

/** Global canonical projection; navigation does not start/stop or own external ASR. */
export function HardwareRealtimeCoordinator(): null {
  const store = useMeetings();
  const current = useRef(store);
  current.current = store;
  useEffect(() => {
    if (store.loading || !hasNativeHardwareSupport()) return undefined;
    let active = true;
    let running = false;
    let rerun = false;
    let forceRerun = false;
    const projected = new Map<string, string>();
    const retryAt = new Map<string, number>();
    const attach = new Set<string>();
    const run = async (force = false) => {
      if (!active || isLocalDataErasing()) return;
      if (running) { rerun = true; forceRerun = forceRerun || force; return; }
      const revision = localDataEraseRevision();
      const valid = () => active && !isLocalDataErasing() && localDataEraseRevision() === revision;
      running = true;
      try {
        const sessions = orderHardwareRealtimeSessions(await listHardwareRealtimeSessions());
        const present = new Set(sessions.map(session => session.meetingId));
        for (const id of projected.keys()) if (!present.has(id)) projected.delete(id);
        for (const session of sessions) {
          if (!valid()) return;
          try {
          const id = session.meetingId;
          const projectionKey = hardwareRealtimeProjectionKey(session);
          const attachDue = ['waiting', 'unavailable'].includes(session.asrPhase)
            && !attach.has(id) && Date.now() >= (retryAt.get(id) ?? 0);
          // Partial text can arrive five times per second. It must not reload
          // every meeting aggregate or rebuild the global meeting projection.
          if (!force && !attachDue && projected.get(id) === projectionKey) continue;
          let aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(id, 'guest');
          if (!valid()) return;
          if (aggregate?.note.lifecycle === 'deleted') { await retireHardwareRealtime(id); continue; }
          if (!aggregate) {
            const date = new Date(session.recordedAtMs);
            await current.current.createMeeting(`外接录音 ${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`, {
              id, clientRequestId: `hardware-live:${id}`, mode: 'realtime', recordedAt: date.toISOString(),
              fastLocalResult: true,
            });
            aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(id, 'guest');
          }
          if (!aggregate) continue;
          if (!valid()) return;
          // The local meeting is now durable. Start its binding/lease before
          // broad UI refreshes or transcript projection; neither is an ASR
          // prerequisite. The original per-session retry/epoch guards remain.
          if (attachDue) {
            attach.add(id);
            retryAt.set(id, Date.now() + 30_000);
            void prepareDeviceV2RealtimeRecording({ meetingId: id, sessionId: session.sessionId })
              .then(options => valid() ? attachHardwareRealtime(id, options) : undefined)
              .catch(() => { /* Real SD recording is unaffected; retry on the same identity. */ })
              .finally(() => attach.delete(id));
          }
          const alreadyReceived = aggregate.recordingAssets.some(asset => asset.localState === 'local_ready');
          const capture = projectHardwareCapture(session,
            (aggregate.processingStages.find(stage => stage.stage === 'capture')?.status as CaptureStatus | undefined) ?? null,
            alreadyReceived);
          if (capture) {
            await captureOwner.execute({ meetingId: aggregate.note.id, scopeKey: 'guest', canonicalWrite: true,
              capture,
            });
            await current.current.refreshMeetings();
          }
          // Final, verified import wins forever. A late live event must not
          // downgrade it or overwrite another source's completed transcript.
          if (session.events.length) {
            const canonical = await loadActiveMeetingTranscriptState('guest', id);
            if (!valid()) return;
            const draft = projectHardwareRealtimeDraft(session,
              canonical?.lines ?? current.current.getCachedTranscript(id),
              Boolean(canonical && canonical.kind !== 'realtime_draft'));
            if (draft) {
              await current.current.saveCachedTranscript(id, draft.lines, {
                candidateKind: 'realtime_draft', serverCompleteness: 'incomplete',
                // canonical-live is mutable. Remote revision IDs describe
                // immutable completed documents, never a streaming session.
                remoteRevisionId: draft.remoteRevisionId,
              });
            }
            await acknowledgeHardwareRealtime(id, Math.max(...session.events.map(event => event.sequence)));
          }
          if (valid()) projected.set(id, projectionKey);
          } catch (error) {
            // A failed old draft must not starve another board session.
            console.warn('[laoji-audit] hardware_realtime_session_deferred', error instanceof Error ? error.name : 'unknown');
          }
        }
      } catch (error) {
        console.warn('[laoji-audit] hardware_realtime_projection_deferred', error instanceof Error ? error.name : 'unknown');
      } finally {
        running = false;
        if (rerun && active) {
          const forceNext = forceRerun;
          rerun = false; forceRerun = false;
          void run(forceNext);
        }
      }
    };
    const listener = addHardwareRealtimeListener(() => { void run(); });
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void run(true); });
    const timer = setInterval(() => { void run(true); }, 3_000);
    void run(true);
    return () => { active = false; listener.remove(); foreground.remove(); clearInterval(timer); };
  }, [store.loading]);
  return null;
}
