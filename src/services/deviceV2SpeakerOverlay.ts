import { activateSpeakerOverlay, type SpeakerOverlayRevision } from '../data/repositories/vnext/speakerOverlayRepository';
import { deviceV2Request } from './deviceV2Api';

type RemoteAssignment = {
  stable_segment_key: string;
  automatic_label: string | null;
  speaker_cluster_id: string | null;
  speaker_profile_id: string | null;
  confidence: number | null;
};

type RemoteOverlay = {
  overlay_revision: number;
  source_manifest_sha256: string;
  profile_manifest_sha256: string;
  model_revision: string;
  output_sha256: string;
  activated_at: string | null;
  assignments: RemoteAssignment[];
};

export interface DeviceV2SpeakerOverlaySnapshot {
  schema_version: 2;
  contract_revision: 'speaker.overlay.v2';
  session_id: string;
  state: 'collecting' | 'queued' | 'running' | 'succeeded' | 'no_content' | 'failed' | 'cancelled';
  task_id: string | null;
  error_code: string | null;
  overlay: RemoteOverlay | null;
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field}无效`);
  }
  return normalized;
}

function timestamp(value: string | null): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Date.now();
}

export async function getDeviceV2SpeakerOverlay(
  sessionId: string,
): Promise<DeviceV2SpeakerOverlaySnapshot> {
  const id = identifier(sessionId, '实时转写会话');
  return deviceV2Request<DeviceV2SpeakerOverlaySnapshot>(
    `/realtime/${encodeURIComponent(id)}/speaker-overlay`,
    {},
    '讲话人结果暂时不可用',
  );
}

export interface ApplyDeviceV2SpeakerOverlayInput {
  sessionId: string;
  meetingId: string;
  transcriptRevisionId: string;
}

/**
 * Apply the server's automatic lane to the existing local overlay owner.
 * Manual overrides remain in their separate CAS table and therefore always
 * win when the effective projection is resolved.
 */
export async function applyDeviceV2SpeakerOverlay(
  input: ApplyDeviceV2SpeakerOverlayInput,
): Promise<SpeakerOverlayRevision | null> {
  const snapshot = await getDeviceV2SpeakerOverlay(input.sessionId);
  const overlay = snapshot.overlay;
  if (!overlay || !['succeeded', 'no_content'].includes(snapshot.state)) return null;
  const createdAtMs = timestamp(overlay.activated_at);
  return activateSpeakerOverlay({
    revisionId: `device-v2-speaker:${snapshot.session_id}:${overlay.overlay_revision}:${overlay.output_sha256.slice(7, 23)}`,
    meetingId: identifier(input.meetingId, '会议'),
    transcriptRevisionId: identifier(input.transcriptRevisionId, '文字记录版本'),
    overlayRevision: overlay.overlay_revision,
    sourceManifestSha256: overlay.source_manifest_sha256,
    modelRevision: overlay.model_revision,
    assignments: overlay.assignments.map(item => ({
      stableSegmentKey: item.stable_segment_key,
      automaticLabel: item.automatic_label,
      speakerClusterId: item.speaker_cluster_id,
      speakerProfileId: item.speaker_profile_id,
      confidence: item.confidence,
    })),
    createdAtMs,
    activatedAtMs: createdAtMs,
  });
}
