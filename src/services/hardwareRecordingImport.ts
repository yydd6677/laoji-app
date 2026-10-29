import type { PendingHardwareRecording } from 'laoji-native-platform';
import type { MeetingNoteRepository } from '../data/repositories/meetingNoteRepository';
import { canonicalRecordingSourceSha256 } from '../data/repositories/meetingNoteRepository';
import { suggestedMeetingTitleFromFileName } from './meetingMediaImport';

type Repository = Pick<MeetingNoteRepository, 'findByRecordingAssetId' | 'findByNativeSessionId'>;
export type HardwareRecordingImportPlan = { kind: 'adopted' } | { kind: 'deferred' } | {
  kind: 'import';
  meetingId: string;
  title: string;
  recordedAtMs: number;
  targetMeetingId: string | null;
};

/** A verified receive is already the user's save intent; no second confirmation. */
export async function planHardwareRecordingImport(
  recording: PendingHardwareRecording,
  repository: Repository,
  nowMs = Date.now(),
): Promise<HardwareRecordingImportPlan> {
  if (recording.purpose === 'schedule') throw new Error('schedule input cannot be imported as meeting');
  const owner = await repository.findByRecordingAssetId(recording.recordingId, 'guest');
  if (owner) {
    const asset = owner.recordingAssets.find(item => item.id === recording.recordingId);
    if (asset?.localState === 'local_ready' && asset.localUri
      && asset.byteSize === recording.byteSize
      && canonicalRecordingSourceSha256(asset.checksumSha256)
        === canonicalRecordingSourceSha256(recording.checksumSha256)) return { kind: 'adopted' };
    // Never allocate a second root to evade an existing source/asset conflict.
    throw Object.assign(new Error(), { code: 'ERR_MEDIA_IMPORT_IDENTITY_CONFLICT' });
  }
  const meetingId = recording.captureMeetingId ?? recording.recordingId;
  const existing = await repository.findByNativeSessionId(meetingId, 'guest');
  if (existing?.note.lifecycle === 'deleted'
    || (recording.captureMeetingId && (!existing || existing.note.lifecycle === 'active'))) {
    // The live-capture owner must finish its own root first; deletion must not
    // be undone by a delayed receive. The verified source remains recoverable.
    return { kind: 'deferred' };
  }
  const title = existing?.note.title ?? (recording.title?.trim()
    || suggestedMeetingTitleFromFileName(recording.sourceDeviceRecordingId)
    || `外接录音 ${new Date(nowMs).toLocaleString('zh-CN', { hour12: false })}`);
  return {
    kind: 'import', meetingId, title,
    recordedAtMs: Number.isSafeInteger(recording.recordedAtMs)
      && recording.recordedAtMs > 0 && recording.recordedAtMs <= nowMs + 60_000
      ? recording.recordedAtMs : nowMs,
    targetMeetingId: existing ? (existing.note.legacySourceId ?? existing.note.id) : null,
  };
}
