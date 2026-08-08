import { getApiConfig } from './config';
import { readResponseError } from './errors';
import { fetchWithTimeout as fetch, readJsonWithTimeout } from './http';

const SPEAKER_RESPONSE_BODY_TIMEOUT_MS = 10_000;

export interface SpeakerProfile {
  speaker_id: string;
  name: string;
  sample_count: number;
  quality: number;
  registered_at?: string | null;
  updated_at?: string | null;
  available_in_realtime?: boolean;
  profile_revision?: number;
  consent_state?: 'granted' | 'revoked';
  consent_version?: string | null;
  model_version?: string;
}

interface SpeakerListResponse {
  speakers?: SpeakerProfile[];
  total?: number;
}

const SPEAKER_CAPTURE_PROFILE = 'android-voice-communication-v1';

export interface SpeakerMutationResponse {
  success: boolean;
  speaker: SpeakerProfile;
  quality_level?: string;
  quality_description?: string;
  quality_issues?: string[];
  duration_sec?: number;
}

function endpoint(path = ''): string {
  return `${getApiConfig().apiBase}/api/laoji/speakers${path}`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

async function speakerError(prefix: string, response: Response, accessToken: string): Promise<Error> {
  return readResponseError(prefix, response, { unauthorizedToken: accessToken });
}

export async function fetchSpeakers(accessToken: string): Promise<SpeakerProfile[]> {
  const response = await fetch(endpoint(), { headers: authHeaders(accessToken) });
  if (!response.ok) throw await speakerError('读取讲话人失败', response, accessToken);
  const data = await readJsonWithTimeout<SpeakerListResponse | SpeakerProfile[]>(
    response,
    SPEAKER_RESPONSE_BODY_TIMEOUT_MS,
  );
  return Array.isArray(data) ? data : Array.isArray(data.speakers) ? data.speakers : [];
}

function voiceForm(audioUri: string, fileName: string, name?: string): FormData {
  const form = new FormData();
  if (name != null) form.append('name', name);
  form.append('capture_profile', SPEAKER_CAPTURE_PROFILE);
  form.append('voiceprint_consent_accepted', 'true');
  form.append('voiceprint_consent_version', 'voiceprint-v1');
  form.append('audio', { uri: audioUri, name: fileName, type: 'audio/wav' } as any);
  return form;
}

export interface SpeakerReprocessJob {
  schema_version: 1;
  job_id: string;
  speaker_profile_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  attempt: number;
  progress: number | null;
  total_meetings: number;
  processed_meetings: number;
  matched_segments: number;
  skipped_locked_segments: number;
  error_code: string | null;
  retryable: boolean;
  profile_revision: number;
  model_version: string;
  result_speaker_revision_id: string | null;
}

export async function startSpeakerReprocess(
  speakerId: string,
  idempotencyKey: string,
  accessToken: string,
): Promise<SpeakerReprocessJob> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}/reprocess`), {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'Idempotency-Key': idempotencyKey },
  });
  if (!response.ok) throw await speakerError('重新匹配旧会议失败', response, accessToken);
  return readJsonWithTimeout<SpeakerReprocessJob>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function fetchSpeakerReprocess(
  speakerId: string,
  jobId: string,
  accessToken: string,
): Promise<SpeakerReprocessJob> {
  const response = await fetch(endpoint(
    `/${encodeURIComponent(speakerId)}/reprocess/${encodeURIComponent(jobId)}`,
  ), { headers: authHeaders(accessToken) });
  if (!response.ok) throw await speakerError('读取重新匹配进度失败', response, accessToken);
  return readJsonWithTimeout<SpeakerReprocessJob>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function fetchLatestSpeakerReprocess(
  speakerId: string,
  accessToken: string,
): Promise<SpeakerReprocessJob | null> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}/reprocess`), {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw await speakerError('读取重新匹配进度失败', response, accessToken);
  const data = await readJsonWithTimeout<{ job?: SpeakerReprocessJob | null }>(
    response,
    SPEAKER_RESPONSE_BODY_TIMEOUT_MS,
  );
  return data.job ?? null;
}

export async function retrySpeakerReprocess(
  speakerId: string,
  jobId: string,
  accessToken: string,
): Promise<SpeakerReprocessJob> {
  const response = await fetch(endpoint(
    `/${encodeURIComponent(speakerId)}/reprocess/${encodeURIComponent(jobId)}/retry`,
  ), { method: 'POST', headers: authHeaders(accessToken) });
  if (!response.ok) throw await speakerError('重试旧会议匹配失败', response, accessToken);
  return readJsonWithTimeout<SpeakerReprocessJob>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function registerSpeaker(
  name: string,
  audioUri: string,
  fileName: string,
  accessToken: string,
): Promise<SpeakerMutationResponse> {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: voiceForm(audioUri, fileName, name.trim()),
  });
  if (!response.ok) throw await speakerError('新建讲话人失败', response, accessToken);
  return readJsonWithTimeout<SpeakerMutationResponse>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function supplementSpeaker(
  speakerId: string,
  audioUri: string,
  fileName: string,
  accessToken: string,
): Promise<SpeakerMutationResponse> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}/samples`), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: voiceForm(audioUri, fileName),
  });
  if (!response.ok) throw await speakerError('补录音色失败', response, accessToken);
  return readJsonWithTimeout<SpeakerMutationResponse>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function renameSpeaker(
  speakerId: string,
  name: string,
  accessToken: string,
): Promise<SpeakerMutationResponse> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}`), {
    method: 'PATCH',
    headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!response.ok) throw await speakerError('修改讲话人失败', response, accessToken);
  return readJsonWithTimeout<SpeakerMutationResponse>(response, SPEAKER_RESPONSE_BODY_TIMEOUT_MS);
}

export async function deleteSpeaker(speakerId: string, accessToken: string): Promise<void> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw await speakerError('删除讲话人失败', response, accessToken);
}
