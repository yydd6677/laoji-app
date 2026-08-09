import {
  createDeviceTranscription,
  createMeetingBinding,
  registerDeviceAsset,
  uploadDeviceAssetContent,
} from './deviceApi';
import { waitForBackgroundNetworkTurn } from './deviceNetworkPriority';
import { diagnosticAudit } from './diagnostics';
import type { PendingMeetingAudioUpload } from './meetingRecording';

export interface DeviceMeetingUploadResult {
  remoteId: string;
  revision: number;
  remoteAssetId: string;
  remoteRevision: number;
  transcriptionTaskId: string | null;
}

function requestId(prefix: string, value: string): string {
  return `${prefix}:${value}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 480);
}

/**
 * Upload one phone-owned recording through the device/epoch contract.  The
 * source file remains on the phone; the server receives it only for the
 * bounded transcription window and returns generated results.
 */
export async function uploadMeetingRecordingToDeviceService(
  pending: PendingMeetingAudioUpload,
): Promise<DeviceMeetingUploadResult> {
  await waitForBackgroundNetworkTurn();
  const meetingId = pending.meetingId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId)) {
    throw new Error('本机会议标识无效，无法提交服务');
  }
  diagnosticAudit('device_recording_upload_stage', { stage: 'binding', meeting_id_suffix: meetingId.slice(-8) });
  await createMeetingBinding(meetingId);
  diagnosticAudit('device_recording_upload_stage', { stage: 'binding_done', meeting_id_suffix: meetingId.slice(-8) });
  const registration = await registerDeviceAsset(
    meetingId,
    {
      client_asset_id: pending.recordingAssetId,
      role: pending.role,
      origin: pending.origin === 'captured' ? 'realtime' : pending.origin === 'imported' ? 'file_import' : 'video_import',
      mime_type: pending.mimeType,
      byte_size: pending.byteSize ?? null,
      duration_ms: pending.durationMs ?? null,
      checksum_sha256: pending.checksumSha256 ?? null,
    },
    requestId('device-asset-register', pending.recordingAssetId),
  );
  diagnosticAudit('device_recording_upload_stage', { stage: 'asset_registered', meeting_id_suffix: meetingId.slice(-8) });
  const assetId = String(registration.id || '').trim();
  const revision = Number(registration.revision);
  if (!assetId || !Number.isSafeInteger(revision) || revision < 1) throw new Error('服务返回的录音资产无效');
  const uploaded = await uploadDeviceAssetContent(
    assetId,
    pending.audioUri,
    revision,
    requestId('device-asset-content', pending.recordingAssetId),
    'device-recording',
    pending.mimeType,
    pending.byteSize,
    pending.checksumSha256,
  );
  diagnosticAudit('device_recording_upload_stage', { stage: 'content_uploaded', meeting_id_suffix: meetingId.slice(-8) });
  const uploadedRevision = Number(uploaded.revision);
  const transcription = await createDeviceTranscription(
    assetId,
    { clientRequestId: requestId('device-transcript', pending.recordingAssetId), language: 'zh' },
    requestId('device-transcript-submit', pending.recordingAssetId),
  );
  diagnosticAudit('device_recording_upload_stage', { stage: 'transcription_submitted', meeting_id_suffix: meetingId.slice(-8) });
  const transcriptionTaskId = [
    transcription?.job_id,
    transcription?.task_id,
    transcription?.transcription_task_id,
  ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  return {
    remoteId: assetId,
    revision: Number.isSafeInteger(uploadedRevision) && uploadedRevision >= 1
      ? uploadedRevision
      : revision + 1,
    remoteAssetId: assetId,
    remoteRevision: Number.isSafeInteger(uploadedRevision) && uploadedRevision >= 1
      ? uploadedRevision
      : revision + 1,
    // The deployed device API uses job_id.  Keep the two explicit aliases for
    // rolling upgrades so a response from an older/newer worker cannot lose
    // the durable polling hint after the upload has already succeeded.
    transcriptionTaskId: transcriptionTaskId?.trim() || null,
  };
}
