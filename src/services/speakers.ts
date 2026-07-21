import { getApiConfig } from './config';
import { readResponseError } from './errors';
import { fetchWithTimeout as fetch } from './http';

export interface SpeakerProfile {
  speaker_id: string;
  name: string;
  sample_count: number;
  quality: number;
  registered_at?: string | null;
  updated_at?: string | null;
  available_in_realtime?: boolean;
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
  return `${getApiConfig().meetingApiBase}/api/laoji/speakers${path}`;
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
  const data = await response.json() as SpeakerListResponse | SpeakerProfile[];
  return Array.isArray(data) ? data : Array.isArray(data.speakers) ? data.speakers : [];
}

function voiceForm(audioUri: string, fileName: string, name?: string): FormData {
  const form = new FormData();
  if (name != null) form.append('name', name);
  form.append('capture_profile', SPEAKER_CAPTURE_PROFILE);
  form.append('audio', { uri: audioUri, name: fileName, type: 'audio/wav' } as any);
  return form;
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
  return response.json();
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
  return response.json();
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
  return response.json();
}

export async function deleteSpeaker(speakerId: string, accessToken: string): Promise<void> {
  const response = await fetch(endpoint(`/${encodeURIComponent(speakerId)}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw await speakerError('删除讲话人失败', response, accessToken);
}
