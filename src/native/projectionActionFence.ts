import type { NativeProjectionEnvelope } from 'laoji-native-platform';

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
