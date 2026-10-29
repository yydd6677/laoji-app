import type { NativeProjectionEnvelope } from 'laoji-native-platform';
import type { MinutesRecordingControlIdentity } from 'laoji-native-platform';

/** Commands belong to a live capture, not to a content hash that changes every tick. */
export function fenceNativeRecordingControl(
  current: MinutesRecordingControlIdentity & { meetingId: string; active: boolean },
  action: { meetingId?: string; recordingControl?: MinutesRecordingControlIdentity | null },
  requireActive: boolean,
): { accepted: true } | { accepted: false; reason: string } {
  const identity = action.recordingControl;
  if (!identity || !current.surfaceId || identity.surfaceId !== current.surfaceId) {
    return { accepted: false, reason: 'recording_surface_stale' };
  }
  if (action.meetingId !== current.meetingId) return { accepted: false, reason: 'recording_meeting_stale' };
  if (!Number.isSafeInteger(identity.sessionStartedAtMs) || identity.sessionStartedAtMs < 0
    || identity.sessionStartedAtMs !== current.sessionStartedAtMs) {
    return { accepted: false, reason: 'recording_capture_stale' };
  }
  if (requireActive && (!current.active || current.sessionStartedAtMs <= 0)) {
    return { accepted: false, reason: 'recording_capture_inactive' };
  }
  return { accepted: true };
}

export type NativeProjectionActionFenceResult =
  | { accepted: true; reason: 'current_projection' }
  | { accepted: false; reason: 'projection_pending' | 'projection_missing' | 'projection_stale' };

function sameProjection(
  left: NativeProjectionEnvelope,
  right: NativeProjectionEnvelope,
): boolean {
  return left.deviceEpoch === right.deviceEpoch
    && left.entityId === right.entityId
    && left.entityRevision === right.entityRevision
    && left.viewRevision === right.viewRevision
    && left.surfaceInstanceId === right.surfaceInstanceId
    && left.payloadSha256 === right.payloadSha256;
}

/**
 * Final JS-side fence for an action emitted by a native projection.
 *
 * Native views already reject stale incoming snapshots. This second boundary
 * covers an event that was queued on the bridge before a newer JS snapshot was
 * accepted. The current path fails closed while the hash is pending.
 */
export function fenceNativeProjectionAction(
  current: NativeProjectionEnvelope | null | undefined,
  action: NativeProjectionEnvelope | null | undefined,
): NativeProjectionActionFenceResult {
  if (!current) return { accepted: false, reason: 'projection_pending' };
  if (!action) return { accepted: false, reason: 'projection_missing' };
  if (!sameProjection(current, action)) return { accepted: false, reason: 'projection_stale' };
  return { accepted: true, reason: 'current_projection' };
}
