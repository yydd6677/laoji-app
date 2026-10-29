import type { HardwareRecordingPreview, PendingHardwareRecording } from 'laoji-native-platform';

/** A reused filename is not the same audio; session/name alone is not identity. */
export function hasReceivedHardwareRecording(
  local: readonly PendingHardwareRecording[], deviceId: string | null | undefined,
  source: Pick<HardwareRecordingPreview, 'recordingId' | 'generation' | 'localRecordingId'>,
  adoptedAssetIds: ReadonlySet<string> = new Set(),
): boolean {
  return Boolean(deviceId) && Boolean(source.generation) && (
    Boolean(source.localRecordingId && adoptedAssetIds.has(source.localRecordingId))
    || local.some(item => item.deviceId === deviceId
    && item.sourceDeviceRecordingId === source.recordingId
    && item.sourceGeneration === source.generation));
}
