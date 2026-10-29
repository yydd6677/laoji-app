import {
  getHardwareState,
  getNativeRecorderState,
  listHardwareRealtimeSessions,
  hasNativeHardwareSupport,
  hasNativeRecorder,
} from 'laoji-native-platform';

/** Null is an unavailable owner, not proof that a recording belongs to AudioRecord. */
export async function loadExternalCaptureMeetingIds(): Promise<ReadonlySet<string> | null> {
  if (!hasNativeHardwareSupport()) return new Set();
  try {
    // Finished/interrupted sessions also remain hardware-owned while their
    // verified file is being recovered. The microphone journal cannot repair them.
    return new Set((await listHardwareRealtimeSessions()).map(session => session.meetingId));
  } catch {
    return null;
  }
}

/** An unavailable owner is unknown, never proof that capture has stopped. */
export async function meetingCaptureOwnersIdle(): Promise<boolean> {
  if (!hasNativeRecorder() || !hasNativeHardwareSupport()) return false;
  const [recorder, hardware] = await Promise.all([
    getNativeRecorderState(),
    getHardwareState(),
  ]);
  return (recorder === null || ['idle', 'localSaved', 'failed'].includes(recorder.state))
    && ['disconnected', 'discovered', 'permission_required', 'ready', 'incompatible'].includes(hardware.phase);
}
