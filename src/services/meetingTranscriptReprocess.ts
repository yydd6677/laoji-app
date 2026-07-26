import { requestMeetingTranscriptCompletion } from '../application/meeting/transcriptCompletionTrigger';
import { loadMeetingCapabilities } from '../data/api/v2';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import {
  assertScopeKey,
  secureClientIdFactory,
  type ScopeKey,
} from '../domain/meeting';
import { discoverMeetingRecordingTranscriptionTasks } from './meetingRecordingTranscriptionSync';

export interface RequestMeetingTranscriptReprocessResult {
  requestBatchId: string;
  recordingCount: number;
}

export async function requestMeetingTranscriptReprocess(input: {
  scopeKey: Exclude<ScopeKey, 'guest'>;
  meetingId: string;
  accessToken: string;
}): Promise<RequestMeetingTranscriptReprocessResult> {
  assertScopeKey(input.scopeKey);
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (
    capability.source !== 'remote'
    || !capability.capabilities.recordingAssetsV2
    || !capability.capabilities.transcriptReprocessV1
  ) throw new Error('当前会议服务暂不支持重新生成文字记录。');

  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
    input.meetingId,
    input.scopeKey,
  );
  if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
  const remoteMeetingId = aggregate.note.remoteId;
  if (!remoteMeetingId) throw new Error('会议正在同步，完成后可重新生成文字记录。');
  const discovery = await discoverMeetingRecordingTranscriptionTasks({
    scopeKey: input.scopeKey,
    accessToken: input.accessToken,
    meeting: { meetingId: aggregate.note.id, remoteMeetingId },
  });
  if (discovery.uploadedAssets.length === 0) {
    throw new Error('当前会议没有已同步的录音。');
  }

  const requestBatchId = secureClientIdFactory.create();
  const requestedAtMs = Date.now();
  let recordingCount: number;
  try {
    recordingCount = await sqliteMeetingNoteRepository.requestRecordingAssetTranscriptReprocess({
      meetingId: aggregate.note.id,
      remoteMeetingId,
      scopeKey: input.scopeKey,
      requestBatchId,
      requestedAtMs,
      assets: discovery.uploadedAssets.map(asset => ({
        clientRecordingAssetId: asset.clientAssetId,
        remoteRecordingAssetId: asset.remoteId,
        clientRequestId: `laoji-recording-transcription:${asset.remoteId}:reprocess:${requestBatchId}`,
        idempotencyKey: `recording-transcription-reprocess:${requestBatchId}:${asset.remoteId}`,
        language: 'zh',
      })),
    });
  } finally {
    // Discovery may have inserted an initial task even when reprocess must wait.
    // Wake the same durable worker in both success and fail-closed paths.
    requestMeetingTranscriptCompletion(input.scopeKey, { discoverRecordingAssets: false });
  }
  return { requestBatchId, recordingCount };
}
