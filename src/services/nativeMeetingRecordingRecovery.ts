import type {
  NativeRecoveredRecording,
  NativeRecorderSnapshot,
} from 'laoji-native-platform';

export function findOwnedRecoveredMeetingRecording(
  recordings: readonly NativeRecoveredRecording[],
  sessionId: string,
  storageScope: string,
): NativeRecoveredRecording | null {
  const expectedSessionId = sessionId.trim();
  const expectedScope = storageScope.trim();
  if (!expectedSessionId || !expectedScope) return null;
  const recovered = recordings
    .filter(recording => (
      recording.sessionId === expectedSessionId
      && recording.purpose === 'meeting'
      && recording.mode === 'realtime'
      && recording.storageScope === expectedScope
      && recording.localUri.trim().length > 0
    ))
    .sort((left, right) => (
      right.bytesRecorded - left.bytesRecorded
      || right.durationMs - left.durationMs
      || left.localUri.localeCompare(right.localUri)
    ))[0];
  return recovered ? { ...recovered, localUri: recovered.localUri.trim() } : null;
}

export function nativeMeetingSnapshotFromRecovery(
  recording: NativeRecoveredRecording,
  nowMs = Date.now(),
): NativeRecorderSnapshot {
  if (
    recording.purpose !== 'meeting'
    || recording.mode !== 'realtime'
    || !recording.storageScope
    || !recording.localUri.trim()
  ) throw new Error('recovered meeting recording is invalid');
  const updatedAtMs = Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now();
  const durationMs = Number.isSafeInteger(recording.durationMs)
    ? Math.max(0, recording.durationMs)
    : 0;
  const bytesRecorded = Number.isSafeInteger(recording.bytesRecorded)
    ? Math.max(0, recording.bytesRecorded)
    : 0;
  return {
    sessionId: recording.sessionId,
    purpose: 'meeting',
    mode: 'realtime',
    storageScope: recording.storageScope,
    state: 'localSaved',
    startedAtMs: Math.max(0, updatedAtMs - durationMs),
    updatedAtMs,
    bytesRecorded,
    durationMs,
    localUri: recording.localUri.trim(),
    asrConnected: false,
    asrRequired: true,
    readyToStop: false,
    transcriptRecoveryRequired: true,
    errorCode: null,
    errorMessage: null,
  };
}
