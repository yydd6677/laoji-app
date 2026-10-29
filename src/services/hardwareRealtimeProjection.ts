import type { HardwareRealtimeSession } from 'laoji-native-platform';
import type { TranscriptLine } from '../types';
import type { CaptureStatus, ProcessingStageTransition } from '../domain/meeting';

/** Preview-only events belong to the live page, not the canonical DB writer.
 * Keep every persisted field in this key, including corrections under one ID;
 * a periodic forced reconciliation still observes independent local edits. */
export function hardwareRealtimeProjectionKey(session: HardwareRealtimeSession): string {
  return JSON.stringify([session.capturePhase, session.asrPhase, session.inputEnded,
    session.audioReady, session.hasGap, session.events]);
}

/** A live source must not wait behind an arbitrary ConcurrentHashMap order of
 * historical sessions. Stable pending events come next; no session is dropped. */
export function orderHardwareRealtimeSessions(sessions: readonly HardwareRealtimeSession[]): HardwareRealtimeSession[] {
  const rank = (s: HardwareRealtimeSession) => !s.inputEnded ? 0 : s.events.length ? 1 : 2;
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.recordedAtMs - a.recordedAtMs);
}

/** Reconcile persisted state, not a page/poller cache of the last native phase. */
export function projectHardwareCapture(
  session: HardwareRealtimeSession,
  current: CaptureStatus | null,
  verifiedAssetPresent: boolean,
): Extract<ProcessingStageTransition, { stage: 'capture' }> | null {
  if (verifiedAssetPresent) return null;
  const status: CaptureStatus = session.capturePhase === 'recording' || session.capturePhase === 'paused'
    ? session.capturePhase
    : session.audioReady ? 'local_ready'
    : session.capturePhase === 'finished' ? 'finalizing'
    : 'failed_recoverable';
  if (current === status) return null;
  return status === 'failed_recoverable'
    ? { stage: 'capture', status, errorCode: 'hardware_disconnected',
      userMessageKey: 'meeting.capture.retryable', retryable: true }
    : { stage: 'capture', status, ...(status === 'local_ready' ? { progress: 1 } : {}) };
}

/** Stable events extend one mutable local draft; preview text is never committed. */
export function projectHardwareRealtimeDraft(
  session: HardwareRealtimeSession,
  previous: readonly TranscriptLine[],
  finalAlreadyActive: boolean,
): { lines: TranscriptLine[]; remoteRevisionId: null; throughSequence: number } | null {
  if (finalAlreadyActive || !session.events.length) return null;
  const lines = new Map(previous.map(line => [line.id, line]));
  for (const event of session.events) {
    if (!event.text.trim()) continue;
    lines.set(event.id, {
      id: event.id, meeting_id: session.meetingId, text: event.text,
      speaker_label: event.speaker || '未知讲话人',
      start_time: event.startMs == null ? undefined : event.startMs / 1000,
      end_time: event.endMs == null ? undefined : event.endMs / 1000,
      isFinal: true, textState: 'stable', revisionKind: 'realtimeDraft', script: 'zh-Hans',
    });
  }
  return {
    lines: [...lines.values()].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0)),
    // A session/cursor is not an immutable remote transcript document ID.
    remoteRevisionId: null,
    throughSequence: Math.max(...session.events.map(event => event.sequence)),
  };
}
