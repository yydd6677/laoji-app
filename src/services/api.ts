import * as FileSystem from 'expo-file-system/legacy';
import { getApiConfig } from './config';
import { readResponseError } from './errors';
import { isNonScheduleControlText, parseLocalScheduleText, shouldUseLocalScheduleParseFirst } from './localScheduleParser';
import type { EventCategory } from '../utils/eventColors';
import type { MeetingSummary, TranscriptLine } from '../types';

// LaoJi Backend API Client
// Defaults target the internal test server. Production builds must provide
// HTTPS endpoints through EXPO_PUBLIC_* environment variables.

function laojiUrl(path: string): string {
  return `${getApiConfig().laojiApiBase}${path}`;
}

function meetingUrl(path: string): string {
  return `${getApiConfig().meetingApiBase}${path}`;
}

function jsonHeaders(accessToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function authHeaders(accessToken?: string): Record<string, string> | undefined {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParseResult {
  title: string;
  event_type: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  start_date: string;        // YYYY-MM-DD
  end_date?: string | null;  // YYYY-MM-DD, for multi-day events
  color?: string | null;
  spanning?: boolean | null;
  start_time: string | null; // HH:MM
  end_time: string | null;   // HH:MM
  is_all_day: boolean;
  description: string | null;
  location?: string | null;
  category?: EventCategory | null;
  detail?: string | null;
  status?: string | null;
  reminder_minutes?: number | null;
  raw_text: string;
  parse_source: 'rules' | 'local_llm' | 'llm' | 'clarified';
  confidence: number;
  needs_clarification: boolean;
  clarification_question: string | null;
}

export interface ApiEvent {
  id?: number;
  title: string;
  event_type: string;
  start_date: string;
  end_date?: string | null;
  color?: string | null;
  spanning?: boolean | null;
  start_time?: string | null;
  end_time?: string | null;
  is_all_day?: boolean;
  description?: string | null;
  raw_text?: string | null;
  location?: string | null;
  category?: EventCategory | null;
  detail?: string | null;
  status?: string | null;
  reminder_minutes?: number | null;
}

// ── Parse natural language ──────────────────────────────────────────────────

export async function parseText(text: string): Promise<ParseResult> {
  if (isNonScheduleControlText(text)) throw new Error('parse skipped: non-schedule control text');

  const local = parseLocalScheduleText(text);
  if (local && shouldUseLocalScheduleParseFirst(text, local)) return local;

  let error: Error | null = null;
  try {
    const res = await fetch(laojiUrl('/api/laoji/parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return res.json();
    error = new Error(`parse failed: ${res.status}`);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }

  if (local) return local;
  throw error ?? new Error('parse failed');
}

// ── Clarify (follow-up) ─────────────────────────────────────────────────────

export async function clarifyText(
  original: string,
  supplement: string,
  draft: ParseResult
): Promise<ParseResult> {
  const res = await fetch(laojiUrl('/api/laoji/clarify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: { ...draft, raw_text: draft.raw_text ?? original }, answer: supplement }),
  });
  if (!res.ok) throw new Error(`clarify failed: ${res.status}`);
  return res.json();
}

// ── Save event ──────────────────────────────────────────────────────────────

export async function saveEvent(event: ApiEvent, accessToken?: string): Promise<ApiEvent> {
  const res = await fetch(laojiUrl('/api/laoji/events'), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`save event failed: ${res.status}`);
  return res.json();
}

// ── Fetch events by month ───────────────────────────────────────────────────

export async function fetchEvents(year: number, month: number, accessToken?: string): Promise<ApiEvent[]> {
  const res = await fetch(
    laojiUrl(`/api/laoji/events?year=${year}&month=${month}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw new Error(`fetch events failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.events ?? [];
}

// ── ASR transcribe ──────────────────────────────────────────────────────────

async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === 'function') {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    if (typeof btoa === 'function') return btoa(binary);
    const nodeBuffer = (globalThis as any).Buffer;
    if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read audio failed'));
    reader.onloadend = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

async function audioUriToBase64(audioUri: string): Promise<string> {
  if (audioUri.startsWith('data:')) {
    return audioUri.includes(',') ? audioUri.split(',')[1] : audioUri;
  }

  if (audioUri.startsWith('file://') || audioUri.startsWith('content://')) {
    return FileSystem.readAsStringAsync(audioUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  const res = await fetch(audioUri);
  if (!res.ok) throw new Error(`read audio failed: ${res.status}`);
  return blobToBase64(await res.blob());
}

function filenameFromUri(audioUri: string): string {
  const fallback = 'recording.m4a';
  const file = audioUri.split('?')[0].split('#')[0].split('/').pop();
  return decodeURIComponent(file || fallback);
}

export async function transcribeAudio(audioUri: string): Promise<string> {
  const audio_base64 = await audioUriToBase64(audioUri);
  const filename = filenameFromUri(audioUri);

  const res = await fetch(laojiUrl('/api/laoji/asr/transcribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_base64, filename }),
  });
  if (!res.ok) throw await readResponseError('ASR failed', res);
  const data = await res.json();
  return data.text ?? data.result ?? '';
}

export async function parseAudio(audioUri: string): Promise<ParseResult> {
  const audio_base64 = await audioUriToBase64(audioUri);
  const filename = filenameFromUri(audioUri);

  const res = await fetch(laojiUrl('/api/laoji/parse-audio'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_base64, filename }),
  });
  if (!res.ok) throw await readResponseError('audio parse failed', res);
  return res.json();
}

// ── Delete event ────────────────────────────────────────────────────────────

export async function deleteEvent(id: number, accessToken?: string): Promise<void> {
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`delete event failed: ${res.status}`);
}

// ── Update event ────────────────────────────────────────────────────────────

export async function updateEvent(
  id: number,
  changes: Partial<ApiEvent>,
  accessToken?: string,
): Promise<ApiEvent> {
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}`), {
    method: 'PUT',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new Error(`update event failed: ${res.status}`);
  return res.json();
}

// ── Meetings ────────────────────────────────────────────────────────────────

export interface ApiMeeting {
  id: string;
  title: string;
  description?: string;
  status: string;
  mode?: 'realtime' | 'offline' | 'whisper' | 'qwen' | 'hybrid';
  participants?: string[];
  created_at: string;
  updated_at: string;
  audio_available?: boolean;
  audio_mime_type?: string | null;
  audio_file_name?: string | null;
  audio_duration_sec?: number | null;
}

export interface ApiMeetingAudioInfo {
  url: string;
  mime_type?: string | null;
  duration_sec?: number | null;
  file_name?: string | null;
  expires_at?: string | null;
  requires_auth?: boolean;
}

export interface ApiMeetingSummaryTask {
  message?: string;
  task_id: string;
  transcript_count?: number;
}

export interface ApiMeetingTaskStatus {
  task_id?: string;
  status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | string;
  result?: unknown;
}

export async function fetchMeetings(page = 1, size = 20, accessToken?: string): Promise<ApiMeeting[]> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings?page=${page}&size=${size}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw new Error(`fetch meetings failed: ${res.status}`);
  const data = await res.json();
  return data.items ?? data ?? [];
}

export async function createMeeting(
  payload: { title: string; description?: string | null; participants?: string[]; mode?: ApiMeeting['mode'] },
  accessToken?: string,
): Promise<ApiMeeting> {
  const res = await fetch(meetingUrl('/api/laoji/meetings'), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({
      title: payload.title,
      description: payload.description ?? null,
      participants: payload.participants ?? [],
      mode: payload.mode ?? 'realtime',
    }),
  });
  if (!res.ok) throw await readResponseError('create meeting failed', res);
  return res.json();
}

export async function updateMeeting(
  meetingId: string,
  changes: Partial<Pick<ApiMeeting, 'title' | 'description' | 'status' | 'participants' | 'mode'>>,
  accessToken?: string,
): Promise<ApiMeeting> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}`), {
    method: 'PATCH',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new Error(`update meeting failed: ${res.status}`);
  return res.json();
}

export async function fetchMeetingTranscript(meetingId: string, accessToken?: string): Promise<TranscriptLine[]> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/transcripts?offset=0&limit=1000`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

function summaryValueToText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(summaryValueToText).filter(Boolean).join('\n\n').trim();
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const fields = ['overview', 'summary', 'content', 'markdown', 'full_text', 'text'];
    return fields.map(field => summaryValueToText(obj[field])).filter(Boolean).join('\n\n').trim();
  }
  return '';
}

export async function fetchMeetingSummaryDetail(meetingId: string, accessToken?: string): Promise<MeetingSummary | null> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/final`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) return null;
  return res.json();
}

export async function fetchMeetingSummary(meetingId: string, accessToken?: string): Promise<string> {
  const data = await fetchMeetingSummaryDetail(meetingId, accessToken);
  if (!data) return '';
  return (
    summaryValueToText((data as any).summary) ||
    summaryValueToText((data as any).content) ||
    summaryValueToText(data.markdown) ||
    summaryValueToText(data.full_text) ||
    summaryValueToText(data.overview) ||
    summaryValueToText(data)
  );
}

export async function generateMeetingSummary(meetingId: string, accessToken?: string): Promise<ApiMeetingSummaryTask> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/generate?summary_type=final`), {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readResponseError('generate meeting summary failed', res);
  return res.json();
}

export async function fetchMeetingSummaryTask(
  meetingId: string,
  taskId: string,
  accessToken?: string,
): Promise<ApiMeetingTaskStatus> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/task/${taskId}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readResponseError('fetch meeting summary task failed', res);
  return res.json();
}

export async function generateGuestMeetingSummary(
  meetingId: string,
  transcriptLines: TranscriptLine[],
  title?: string,
): Promise<ApiMeetingSummaryTask> {
  const res = await fetch(meetingUrl('/api/laoji/meetings/guest-summary'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meeting_id: meetingId,
      title: title ?? null,
      transcript_lines: transcriptLines.map(line => ({
        speaker_label: line.speaker_label ?? null,
        speaker_id: line.speaker_id ?? null,
        text: line.text,
        start_time: line.start_time ?? null,
        end_time: line.end_time ?? null,
        confidence: line.confidence ?? null,
      })),
    }),
  });
  if (!res.ok) throw await readResponseError('generate guest meeting summary failed', res);
  return res.json();
}

export async function fetchGuestMeetingSummaryTask(taskId: string): Promise<ApiMeetingTaskStatus> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/guest-summary/tasks/${encodeURIComponent(taskId)}`));
  if (!res.ok) throw await readResponseError('fetch guest meeting summary task failed', res);
  return res.json();
}

export async function fetchMeetingAudioInfo(meetingId: string, accessToken?: string): Promise<ApiMeetingAudioInfo | null> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/audio`),
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw await readResponseError('fetch meeting audio failed', res);
  const data = await res.json();
  const url = typeof data?.url === 'string' ? data.url.trim() : '';
  if (!url) return null;
  const absoluteUrl = url.startsWith('/') ? meetingUrl(url) : url;
  return {
    url: absoluteUrl,
    mime_type: data.mime_type ?? data.mimeType ?? null,
    duration_sec: typeof data.duration_sec === 'number' ? data.duration_sec : data.durationSec ?? null,
    file_name: data.file_name ?? data.fileName ?? null,
    expires_at: data.expires_at ?? data.expiresAt ?? null,
    requires_auth: data.requires_auth ?? data.requiresAuth ?? false,
  };
}

export async function uploadMeetingAudio(
  meetingId: string,
  audioUri: string,
  accessToken?: string,
  options: { fileName?: string; mimeType?: string; process?: boolean } = {},
): Promise<ApiMeetingAudioInfo | null> {
  const fileName = options.fileName ?? filenameFromUri(audioUri).replace(/\.(m4a|aac)$/i, '.$1');
  const mimeType = options.mimeType ?? (
    fileName.endsWith('.wav') ? 'audio/wav'
      : fileName.endsWith('.mp3') ? 'audio/mpeg'
        : fileName.endsWith('.m4a') || fileName.endsWith('.aac') ? 'audio/mp4'
          : 'application/octet-stream'
  );
  const form = new FormData();
  form.append('file', { uri: audioUri, name: fileName, type: mimeType } as any);
  const endpoint = options.process ? 'upload' : 'audio';
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}/${endpoint}`), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: form,
  });
  if (!res.ok) throw await readResponseError('upload meeting audio failed', res);
  const data = await res.json();
  const audio = data.audio ?? data;
  if (!audio?.url) return null;
  const url = String(audio.url).startsWith('/') ? meetingUrl(audio.url) : String(audio.url);
  return {
    url,
    mime_type: audio.mime_type ?? null,
    duration_sec: audio.duration_sec ?? null,
    file_name: audio.file_name ?? null,
    expires_at: audio.expires_at ?? null,
    requires_auth: audio.requires_auth ?? false,
  };
}

export async function deleteMeeting(meetingId: string, accessToken?: string): Promise<void> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`delete meeting failed: ${res.status}`);
}
