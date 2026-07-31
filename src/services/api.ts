import * as FileSystem from 'expo-file-system/legacy';
import { getApiConfig } from './config';
import { readResponseData, readResponseError, stringifyErrorDetail } from './errors';
import {
  classifyScheduleParseRoute,
  normalizeScheduleParseResult,
  parseLocalScheduleText,
} from './localScheduleParser';
import type { EventCategory } from '../utils/eventColors';
import type { EventRecurrenceScope, MeetingSummary, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import { fetchWithTimeout as fetch } from './http';
import { validateMeetingAudioUrl } from './meetingAudioSecurity';
import { LocalMeetingAudioFileMissingError } from './meetingAudioUploadFailure';
import {
  combineTranscriptRemoteState,
  combineTranscriptServerCompleteness,
  evaluateTranscriptLineCandidate,
  transcriptRemoteStateFromPayload,
  transcriptServerCompletenessFromPayload,
  type TranscriptRemoteState,
  type TranscriptServerCompleteness,
} from './transcriptCompleteness';

// LaoJi Backend API Client
// Endpoints are embedded by app.config.js from EXPO_PUBLIC_* build variables.
// Production builds reject missing, plain-HTTP, and bare-IP values.
const SUMMARY_TASK_WAIT_MS = 5_000;

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

async function apiResponseError(prefix: string, res: Response, accessToken?: string): Promise<Error> {
  return readResponseError(prefix, res, { unauthorizedToken: accessToken });
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
  reference_datetime?: string;
  timezone?: string;
}

export type ScheduleParseErrorCode =
  | 'not_schedule'
  | 'missing_date'
  | 'missing_edit_target'
  | 'ambiguous_range'
  | 'conflicting_time'
  | 'invalid_schedule'
  | 'parser_unavailable';

export interface ScheduleParseContext {
  reference_datetime?: string;
  timezone?: string;
}

export class ScheduleParseError extends Error {
  constructor(
    public readonly code: ScheduleParseErrorCode,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ScheduleParseError';
  }
}

export interface ApiEvent {
  id?: number;
  source_event_id?: number | null;
  occurrence_date?: string | null;
  occurrence_id?: string | null;
  is_expanded?: boolean;
  series_start_date?: string | null;
  series_end_date?: string | null;
  revision?: number;
  segment_id?: number | null;
  is_recurrence_exception?: boolean;
  recurrence_interval?: number | null;
  recurrence_weekdays?: number[] | null;
  recurrence_until_date?: string | null;
  recurrence_effective_from_date?: string | null;
  excluded_occurrence_dates?: string[] | null;
  excluded_after_date?: string | null;
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
  client_request_id?: string | null;
  location?: string | null;
  category?: EventCategory | null;
  detail?: string | null;
  status?: string | null;
  reminder_minutes?: number | null;
}

export interface ApiEventStateCommand {
  client_request_id: string;
  desired_state: 'present' | 'absent';
  scope: EventRecurrenceScope;
  occurrence_date?: string | null;
  expected_revision?: number | null;
}

export interface ApiEventStateCommandResponse {
  client_request_id: string;
  source_event_id: number;
  desired_state: 'present' | 'absent';
  observed_state: 'present' | 'absent';
  scope: EventRecurrenceScope;
  occurrence_date?: string | null;
  revision: number;
  changed: boolean;
  event?: ApiEvent | null;
}

export interface ApiEventRecurrencePatch {
  frequency?: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  weekdays?: number[] | null;
  until_date?: string | null;
}

export interface ApiEventEditPatch {
  title?: string;
  event_type?: string;
  start_date?: string;
  end_date?: string | null;
  color?: string | null;
  spanning?: boolean;
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
  recurrence?: ApiEventRecurrencePatch;
}

export interface ApiEventEditCommand {
  client_request_id: string;
  scope: EventRecurrenceScope;
  occurrence_date: string;
  expected_revision?: number | null;
  patch: ApiEventEditPatch;
}

export interface ApiEventEditCommandResponse {
  client_request_id: string;
  source_event_id: number;
  canonical_ref: {
    source_event_id: number;
    occurrence_date: string;
  };
  scope: EventRecurrenceScope;
  segment_id?: number | null;
  previous_revision: number;
  revision: number;
  changed: boolean;
  event: ApiEvent & { id: number };
  affected_range: {
    from_occurrence_date: string | null;
    through_occurrence_date: string | null;
  };
  reminder_rebuild?: {
    token: string;
    from_occurrence_date: string | null;
    through_occurrence_date: string | null;
  } | null;
}

// ── Parse natural language ──────────────────────────────────────────────────

const SCHEDULE_ERROR_MESSAGES: Record<ScheduleParseErrorCode, string> = {
  not_schedule: '这段内容不是日程安排',
  missing_date: '需要补充具体日期',
  missing_edit_target: '需要先选择要修改的日程',
  ambiguous_range: '日期范围不够明确，请确认开始和结束日期',
  conflicting_time: '时间存在冲突，请确认最终时间',
  invalid_schedule: '日程信息不完整，请修改后重试',
  parser_unavailable: '日程解析服务暂时不可用，请稍后重试',
};

function currentScheduleParseContext(context: ScheduleParseContext = {}): Required<ScheduleParseContext> {
  const reference = context.reference_datetime?.trim();
  const parsedReference = reference ? new Date(reference) : new Date();
  const referenceDatetime = Number.isNaN(parsedReference.getTime())
    ? new Date().toISOString()
    : parsedReference.toISOString();
  let timezone = context.timezone?.trim() ?? '';
  if (!timezone) {
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = '';
    }
  }
  return { reference_datetime: referenceDatetime, timezone: timezone || 'Asia/Shanghai' };
}

function scheduleErrorCode(value: unknown): ScheduleParseErrorCode | null {
  return typeof value === 'string' && value in SCHEDULE_ERROR_MESSAGES
    ? value as ScheduleParseErrorCode
    : null;
}

async function readScheduleParseError(
  res: Response,
  fallbackCode: ScheduleParseErrorCode = 'invalid_schedule',
): Promise<ScheduleParseError> {
  const data = await readResponseData(res);
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const detail = record?.detail && typeof record.detail === 'object'
    ? record.detail as Record<string, unknown>
    : null;
  const code = scheduleErrorCode(record?.code)
    ?? scheduleErrorCode(detail?.code)
    ?? (res.status >= 500 ? 'parser_unavailable' : fallbackCode);
  const backendMessage = stringifyErrorDetail(
    record?.message ?? detail?.message ?? record?.detail ?? record?.error,
  );
  const message = backendMessage && /[\u3400-\u9fff]/.test(backendMessage) && !/[A-Za-z]/.test(backendMessage)
    ? backendMessage
    : SCHEDULE_ERROR_MESSAGES[code];
  return new ScheduleParseError(code, message, res.status);
}

function normalizedParseResult(
  text: string,
  result: ParseResult,
  context: Required<ScheduleParseContext>,
): ParseResult {
  return {
    ...normalizeScheduleParseResult(text, result, new Date(context.reference_datetime)),
    reference_datetime: context.reference_datetime,
    timezone: context.timezone,
  };
}

export async function parseText(
  text: string,
  contextInput: ScheduleParseContext = {},
): Promise<ParseResult> {
  const context = currentScheduleParseContext(contextInput);
  const referenceDate = new Date(context.reference_datetime);

  const local = parseLocalScheduleText(text, referenceDate);
  const decision = classifyScheduleParseRoute(text, local, referenceDate);
  if (decision.route === 'reject') {
    const code = decision.code ?? 'not_schedule';
    throw new ScheduleParseError(code, decision.message ?? SCHEDULE_ERROR_MESSAGES[code]);
  }
  if ((decision.route === 'local_safe' || decision.route === 'clarify') && decision.result) {
    return normalizedParseResult(text, decision.result, context);
  }

  try {
    const res = await fetch(laojiUrl('/api/laoji/parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...context }),
    });
    if (res.ok) {
      const parsed = await res.json() as ParseResult;
      return normalizedParseResult(text, parsed, context);
    }
    throw await readScheduleParseError(res, decision.code ?? 'invalid_schedule');
  } catch (err) {
    if (err instanceof ScheduleParseError) throw err;
    throw new ScheduleParseError(
      'parser_unavailable',
      SCHEDULE_ERROR_MESSAGES.parser_unavailable,
    );
  }
}

// ── Clarify (follow-up) ─────────────────────────────────────────────────────

export async function clarifyText(
  original: string,
  supplement: string,
  draft: ParseResult,
  contextInput: ScheduleParseContext = {},
): Promise<ParseResult> {
  const context = currentScheduleParseContext({
    reference_datetime: contextInput.reference_datetime ?? draft.reference_datetime,
    timezone: contextInput.timezone ?? draft.timezone,
  });
  const res = await fetch(laojiUrl('/api/laoji/clarify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current: { ...draft, raw_text: draft.raw_text ?? original },
      answer: supplement,
      ...context,
    }),
  });
  if (!res.ok) throw await readScheduleParseError(res, 'invalid_schedule');
  const parsed = await res.json() as ParseResult;
  return normalizedParseResult(`${original}\n${supplement}`, parsed, context);
}

// ── Save event ──────────────────────────────────────────────────────────────

export async function saveEvent(event: ApiEvent, accessToken?: string): Promise<ApiEvent> {
  const res = await fetch(laojiUrl('/api/laoji/events'), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(event),
  });
  if (!res.ok) throw await apiResponseError('save event failed', res, accessToken);
  return res.json();
}

// ── Fetch events by month ───────────────────────────────────────────────────

export async function fetchEvents(year?: number, month?: number, accessToken?: string): Promise<ApiEvent[]> {
  const query = year != null && month != null ? `?year=${year}&month=${month}` : '';
  const res = await fetch(
    laojiUrl(`/api/laoji/events${query}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await apiResponseError('fetch events failed', res, accessToken);
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
  if (!res.ok) throw await readResponseError('read audio failed', res);
  return blobToBase64(await res.blob());
}

function requireAudioPayload(value: string): string {
  const payload = value.trim();
  if (!payload) {
    throw new ScheduleParseError('invalid_schedule', '录音内容为空，请重新录音。');
  }
  return payload;
}

function parseAudioResult(value: unknown): ParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduleParseError('invalid_schedule', '未识别到日程，请重试。');
  }
  const data = value as Partial<ParseResult> & Record<string, unknown>;
  const rawText = typeof data.raw_text === 'string' ? data.raw_text.trim() : '';
  if (!rawText) {
    throw new ScheduleParseError('invalid_schedule', '未识别到语音内容，请重新录音。');
  }
  if (typeof data.title !== 'string' || typeof data.start_date !== 'string') {
    throw new ScheduleParseError('invalid_schedule', '日程解析结果不完整，请重试。');
  }
  return normalizeScheduleParseResult(rawText, data as ParseResult);
}

function filenameFromUri(audioUri: string): string {
  const fallback = 'recording.m4a';
  const file = audioUri.split('?')[0].split('#')[0].split('/').pop();
  return decodeURIComponent(file || fallback);
}

export async function transcribeAudio(
  audioUri: string,
  contextInput: ScheduleParseContext = {},
): Promise<string> {
  const audio_base64 = requireAudioPayload(await audioUriToBase64(audioUri));
  const filename = filenameFromUri(audioUri);
  const context = currentScheduleParseContext(contextInput);

  const res = await fetch(meetingUrl('/api/laoji/asr/transcribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_base64, filename, ...context }),
  });
  if (!res.ok) throw await readResponseError('语音识别失败', res);
  const data = await res.json();
  const text = typeof data?.text === 'string'
    ? data.text.trim()
    : typeof data?.result === 'string' ? data.result.trim() : '';
  if (!text) throw new ScheduleParseError('invalid_schedule', '未识别到语音内容，请重新录音。');
  return text;
}

export async function parseAudio(
  audioUri: string,
  contextInput: ScheduleParseContext = {},
): Promise<ParseResult> {
  const audio_base64 = requireAudioPayload(await audioUriToBase64(audioUri));
  const filename = filenameFromUri(audioUri);
  const context = currentScheduleParseContext(contextInput);

  const res = await fetch(meetingUrl('/api/laoji/parse-audio'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_base64, filename, ...context }),
  });
  if (!res.ok) throw await readResponseError('日程语音解析失败', res);
  const parsed = parseAudioResult(await res.json());
  return { ...parsed, ...context };
}

// ── Delete event ────────────────────────────────────────────────────────────

export async function deleteEvent(id: number, accessToken?: string): Promise<void> {
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await apiResponseError('delete event failed', res, accessToken);
}

export async function commandEventState(
  id: number,
  command: ApiEventStateCommand,
  accessToken: string,
): Promise<ApiEventStateCommandResponse> {
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}/commands`), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(command),
  });
  if (!res.ok) throw await apiResponseError('event state command failed', res, accessToken);
  return res.json();
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
  if (!res.ok) throw await apiResponseError('update event failed', res, accessToken);
  return res.json();
}

export async function commandEventEdit(
  id: number,
  command: ApiEventEditCommand,
  accessToken: string,
): Promise<ApiEventEditCommandResponse> {
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}/edit-commands`), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(command),
  });
  if (!res.ok) throw await apiResponseError('event edit command failed', res, accessToken);
  return res.json();
}

export async function fetchEventEditCommand(
  clientRequestId: string,
  accessToken: string,
): Promise<ApiEventEditCommandResponse> {
  const res = await fetch(
    laojiUrl(`/api/laoji/event-commands/${encodeURIComponent(clientRequestId)}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await apiResponseError('fetch event edit command failed', res, accessToken);
  return res.json();
}

// ── Meetings ────────────────────────────────────────────────────────────────

export interface ApiMeeting {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  mode?: 'realtime' | 'offline' | 'whisper' | 'qwen';
  participants?: string[];
  location?: string | null;
  recorded_at?: string | null;
  created_at: string;
  updated_at: string;
  audio_available?: boolean;
  audio_mime_type?: string | null;
  audio_file_name?: string | null;
  audio_duration_sec?: number | null;
  transcript_count?: number;
  transcript_available?: boolean;
  summary_available?: boolean;
  client_request_id?: string | null;
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
  long_poll_supported?: boolean;
}

function summaryCarryForwardPayload(
  authorization: MeetingSummaryCarryForwardAuthorization | null | undefined,
): Record<string, unknown> | null {
  if (!authorization) return null;
  return {
    request_id: authorization.requestId,
    items: authorization.items.map(item => ({
      kind: item.kind,
      source_meeting_id: item.sourceMeetingId,
      source_item_id: item.sourceItemId,
      source_title: item.sourceTitle,
      source_occurrence_date: item.sourceOccurrenceDate,
      content: item.content,
      assignee: item.assignee,
      due_at: item.dueAt,
    })),
  };
}

function summaryAttachmentAuthorizationPayload(
  authorization: MeetingSummaryAttachmentAuthorization | null | undefined,
): Record<string, unknown> | null {
  if (!authorization) return null;
  return {
    request_id: authorization.requestId,
    items: authorization.items.map(item => item.kind === 'text' ? {
      attachment_id: item.attachmentId,
      kind: 'text',
      position_ms: item.positionMs,
      content: item.content,
      content_sha256: item.contentSha256,
      updated_at_ms: item.updatedAtMs,
    } : {
      attachment_id: item.attachmentId,
      kind: 'image',
      position_ms: item.positionMs,
      remote_attachment_id: item.remoteAttachmentId,
      remote_revision: item.remoteRevision,
      mime_type: item.mimeType,
      byte_size: item.byteSize,
      checksum_sha256: item.checksumSha256,
      updated_at_ms: item.updatedAtMs,
    }),
  };
}

export async function fetchMeetings(page = 1, size = 20, accessToken?: string): Promise<ApiMeeting[]> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings?page=${page}&size=${size}`),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await apiResponseError('fetch meetings failed', res, accessToken);
  const data = await res.json();
  return data.items ?? data ?? [];
}

export async function fetchAllMeetings(accessToken?: string, pageSize = 100): Promise<ApiMeeting[]> {
  const safePageSize = Math.max(1, Math.min(100, pageSize));
  const all: ApiMeeting[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 50; page += 1) {
    const batch = await fetchMeetings(page, safePageSize, accessToken);
    for (const meeting of batch) {
      if (!seen.has(meeting.id)) {
        seen.add(meeting.id);
        all.push(meeting);
      }
    }
    if (batch.length < safePageSize) break;
  }
  return all;
}

export async function createMeeting(
  payload: {
    title: string;
    description?: string | null;
    participants?: string[];
    mode?: ApiMeeting['mode'];
    clientRequestId?: string;
    location?: string | null;
    recordedAt?: string | null;
  },
  accessToken?: string,
  signal?: AbortSignal,
): Promise<ApiMeeting> {
  const res = await fetch(meetingUrl('/api/laoji/meetings'), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    signal,
    body: JSON.stringify({
      title: payload.title,
      description: payload.description ?? null,
      participants: payload.participants ?? [],
      mode: payload.mode ?? 'realtime',
      client_request_id: payload.clientRequestId ?? null,
      location: payload.location ?? null,
      recorded_at: payload.recordedAt ?? null,
    }),
  });
  if (!res.ok) throw await apiResponseError('create meeting failed', res, accessToken);
  return res.json();
}

export interface ApiGuestRealtimeSession {
  meeting_id: string;
  guest_token: string;
  expires_at: string;
  transient: true;
}

export async function createGuestRealtimeSession(title: string): Promise<ApiGuestRealtimeSession> {
  const res = await fetch(meetingUrl('/api/laoji/meetings/guest-sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() || null }),
  });
  if (!res.ok) throw await readResponseError('create guest meeting session failed', res);
  return res.json();
}

export async function deleteGuestRealtimeSession(meetingId: string, guestToken: string): Promise<void> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/guest-sessions/${encodeURIComponent(meetingId)}`), {
    method: 'DELETE',
    headers: { 'X-Guest-Session-Token': guestToken },
  });
  if (!res.ok && res.status !== 404) {
    throw await readResponseError('delete guest meeting session failed', res);
  }
}

export async function fetchGuestMeetingTranscriptSnapshot(
  meetingId: string,
  guestToken: string,
  options: FetchMeetingTranscriptOptions = {},
): Promise<ApiTranscriptSnapshot> {
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? 1000));
  const all: TranscriptLine[] = [];
  const seenIds = new Set<string>();
  let completeness: TranscriptServerCompleteness = 'unknown';
  let remoteState: TranscriptRemoteState = 'unknown';
  let offset = 0;

  while (true) {
    const res = await fetch(
      meetingUrl(`/api/laoji/meetings/guest-sessions/${encodeURIComponent(meetingId)}/transcripts?offset=${offset}&limit=${pageSize}`),
      { headers: { 'X-Guest-Session-Token': guestToken }, signal: options.signal },
    );
    if (!res.ok) throw await readResponseError('fetch guest meeting transcript failed', res);
    const data = await res.json();
    completeness = combineTranscriptServerCompleteness(
      completeness,
      transcriptServerCompletenessFromPayload(data),
    );
    remoteState = combineTranscriptRemoteState(
      remoteState,
      transcriptRemoteStateFromPayload(data),
    );
    const batch: TranscriptLine[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const total = !Array.isArray(data) && typeof data?.total === 'number' && data.total >= 0
      ? data.total
      : undefined;
    const previousCount = all.length;
    batch.forEach(line => {
      if (line.id && seenIds.has(line.id)) return;
      if (line.id) seenIds.add(line.id);
      all.push(line);
    });
    offset += batch.length;
    if (batch.length === 0) break;
    if (total != null && offset >= total) break;
    if (batch.length < pageSize) break;
    if (all.length === previousCount) break;
  }

  return { items: all, completeness, remoteState, remoteRevisionId: null };
}

export async function fetchGuestMeetingTranscript(
  meetingId: string,
  guestToken: string,
  options: FetchMeetingTranscriptOptions = {},
): Promise<TranscriptLine[]> {
  const snapshot = await fetchGuestMeetingTranscriptSnapshot(meetingId, guestToken, options);
  return transcriptWithFallback(snapshot, options.fallbackItems ?? []);
}

export async function updateMeeting(
  meetingId: string,
  changes: Partial<Pick<ApiMeeting, 'title' | 'description' | 'status' | 'participants' | 'mode' | 'location'>>,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<ApiMeeting> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}`), {
    method: 'PATCH',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(changes),
    signal,
  });
  if (!res.ok) throw await apiResponseError('update meeting failed', res, accessToken);
  return res.json();
}

export interface GuestMeetingImportResult {
  meeting_id: string;
  transcript_count: number;
  summary_imported: boolean;
  already_imported: boolean;
}

export async function importGuestMeetingData(
  meetingId: string,
  payload: {
    sourceMeetingId: string;
    transcripts: TranscriptLine[];
    summary: MeetingSummary | null;
  },
  accessToken: string,
): Promise<GuestMeetingImportResult> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}/imports/guest`),
    {
      method: 'POST',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({
        source_meeting_id: payload.sourceMeetingId,
        transcripts: payload.transcripts.map(line => ({
          id: line.id,
          recording_asset_id: line.recording_asset_id ?? line.recordingAssetRemoteId ?? null,
          transcription_job_id: line.transcription_job_id ?? line.transcriptionJobId ?? null,
          speaker_id: line.speaker_id ?? null,
          speaker_label: line.speaker_label ?? null,
          text: line.text,
          start_time: line.start_time ?? null,
          end_time: line.end_time ?? null,
          confidence: line.confidence ?? null,
          created_at: line.created_at ?? null,
        })),
        summary: payload.summary,
      }),
    },
  );
  if (!res.ok) throw await apiResponseError('import guest meeting failed', res, accessToken);
  return res.json();
}

export interface FetchMeetingTranscriptOptions {
  fallbackItems?: TranscriptLine[];
  pageSize?: number;
  signal?: AbortSignal;
}

export interface ApiTranscriptSnapshot {
  items: TranscriptLine[];
  completeness: TranscriptServerCompleteness;
  remoteState: TranscriptRemoteState;
  remoteRevisionId: string | null;
}

function transcriptRemoteRevisionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const revision = record.revision && typeof record.revision === 'object' && !Array.isArray(record.revision)
    ? record.revision as Record<string, unknown>
    : null;
  const value = record.transcript_revision_id ?? record.revision_id ?? revision?.id;
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('transcript remote revision identity is invalid');
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('transcript remote revision identity is invalid');
  }
  return normalized;
}

function transcriptWithFallback(
  snapshot: ApiTranscriptSnapshot,
  fallbackItems: readonly TranscriptLine[],
): TranscriptLine[] {
  const candidateKind = snapshot.completeness === 'incomplete' ? 'realtime_draft' : 'final';
  const decision = evaluateTranscriptLineCandidate(fallbackItems, snapshot.items, {
    candidateKind,
    serverCompleteness: snapshot.completeness,
  });
  return [...(decision.useCandidate ? snapshot.items : fallbackItems)];
}

export async function fetchMeetingTranscriptSnapshot(
  meetingId: string,
  accessToken?: string,
  options: FetchMeetingTranscriptOptions = {},
): Promise<ApiTranscriptSnapshot> {
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? 1000));
  const all: TranscriptLine[] = [];
  const seenIds = new Set<string>();
  let completeness: TranscriptServerCompleteness = 'unknown';
  let remoteState: TranscriptRemoteState = 'unknown';
  let remoteRevisionId: string | null = null;
  let offset = 0;

  while (true) {
    const res = await fetch(
      meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}/transcripts?offset=${offset}&limit=${pageSize}`),
      { headers: authHeaders(accessToken), signal: options.signal },
    );
    if (!res.ok) throw await apiResponseError('fetch meeting transcript failed', res, accessToken);
    const data = await res.json();
    const pageRevisionId = transcriptRemoteRevisionId(data);
    if (remoteRevisionId && pageRevisionId && remoteRevisionId !== pageRevisionId) {
      throw new Error('transcript pagination changed remote revision');
    }
    remoteRevisionId = remoteRevisionId ?? pageRevisionId;
    completeness = combineTranscriptServerCompleteness(
      completeness,
      transcriptServerCompletenessFromPayload(data),
    );
    remoteState = combineTranscriptRemoteState(
      remoteState,
      transcriptRemoteStateFromPayload(data),
    );
    const batch: TranscriptLine[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const total = !Array.isArray(data) && typeof data?.total === 'number' && data.total >= 0
      ? data.total
      : undefined;
    const previousCount = all.length;

    batch.forEach(line => {
      if (line.id && seenIds.has(line.id)) return;
      if (line.id) seenIds.add(line.id);
      all.push(line);
    });
    offset += batch.length;

    if (batch.length === 0) break;
    if (total != null && offset >= total) break;
    if (batch.length < pageSize) break;
    if (all.length === previousCount) break;
  }

  return {
    items: all,
    completeness,
    remoteState,
    remoteRevisionId: remoteState === 'complete' ? remoteRevisionId : null,
  };
}

export async function fetchMeetingTranscript(
  meetingId: string,
  accessToken?: string,
  options: FetchMeetingTranscriptOptions = {},
): Promise<TranscriptLine[]> {
  const snapshot = await fetchMeetingTranscriptSnapshot(meetingId, accessToken, options);
  return transcriptWithFallback(snapshot, options.fallbackItems ?? []);
}

export async function fetchMeetingSummaryDetail(meetingId: string, accessToken?: string, signal?: AbortSignal): Promise<unknown | null> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/final`),
    { headers: authHeaders(accessToken), signal },
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw await apiResponseError('fetch meeting summary failed', res, accessToken);
  return res.json();
}

export async function generateMeetingSummary(
  meetingId: string,
  accessToken?: string,
  signal?: AbortSignal,
  force = false,
  template: Pick<MeetingTemplate, 'id' | 'revision'> = DEFAULT_MEETING_TEMPLATE,
  carryForward?: MeetingSummaryCarryForwardAuthorization | null,
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null,
): Promise<ApiMeetingSummaryTask> {
  const query = new URLSearchParams({
    summary_type: 'final',
    force: String(force),
    template_id: template.id,
    template_revision: String(template.revision),
  });
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/generate?${query}`), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    signal,
    body: JSON.stringify({
      carry_forward: summaryCarryForwardPayload(carryForward),
      attachment_authorization: summaryAttachmentAuthorizationPayload(attachmentAuthorization),
    }),
  });
  if (!res.ok) throw await apiResponseError('generate meeting summary failed', res, accessToken);
  return res.json();
}

export async function fetchMeetingSummaryTask(
  meetingId: string,
  taskId: string,
  accessToken?: string,
  signal?: AbortSignal,
  waitMs = SUMMARY_TASK_WAIT_MS,
): Promise<ApiMeetingTaskStatus> {
  const query = new URLSearchParams({ wait_ms: String(waitMs) });
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/task/${taskId}?${query}`),
    { headers: authHeaders(accessToken), signal },
  );
  if (!res.ok) throw await apiResponseError('fetch meeting summary task failed', res, accessToken);
  return res.json();
}

export async function generateGuestMeetingSummary(
  meetingId: string,
  transcriptLines: TranscriptLine[],
  title?: string,
  signal?: AbortSignal,
  meetingDate?: string,
  force = false,
  template: Pick<MeetingTemplate, 'id' | 'revision'> = DEFAULT_MEETING_TEMPLATE,
  carryForward?: MeetingSummaryCarryForwardAuthorization | null,
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null,
): Promise<ApiMeetingSummaryTask> {
  const res = await fetch(meetingUrl('/api/laoji/meetings/guest-summary'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      meeting_id: meetingId,
      title: title ?? null,
      meeting_date: meetingDate ?? null,
      force,
      template_id: template.id,
      template_revision: template.revision,
      carry_forward: summaryCarryForwardPayload(carryForward),
      attachment_authorization: summaryAttachmentAuthorizationPayload(attachmentAuthorization),
      transcript_lines: transcriptLines.map(line => ({
        id: line.id,
        recording_asset_id: line.recording_asset_id ?? line.recordingAssetRemoteId ?? null,
        transcription_job_id: line.transcription_job_id ?? line.transcriptionJobId ?? null,
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

export async function fetchGuestMeetingSummaryTask(
  taskId: string,
  signal?: AbortSignal,
  waitMs = SUMMARY_TASK_WAIT_MS,
): Promise<ApiMeetingTaskStatus> {
  const query = new URLSearchParams({ wait_ms: String(waitMs) });
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/guest-summary/tasks/${encodeURIComponent(taskId)}?${query}`),
    { signal },
  );
  if (!res.ok) throw await readResponseError('fetch guest meeting summary task failed', res);
  return res.json();
}

export async function fetchMeetingAudioInfo(meetingId: string, accessToken?: string): Promise<ApiMeetingAudioInfo | null> {
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/audio`),
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw await apiResponseError('fetch meeting audio failed', res, accessToken);
  const data = await res.json();
  const url = typeof data?.url === 'string' ? data.url.trim() : '';
  if (!url) return null;
  const requiresAuth = data.requires_auth ?? data.requiresAuth ?? false;
  const expiresAt = data.expires_at ?? data.expiresAt ?? null;
  const absoluteUrl = validateMeetingAudioUrl(url, { requiresAuth, expiresAt });
  return {
    url: absoluteUrl,
    mime_type: data.mime_type ?? data.mimeType ?? null,
    duration_sec: typeof data.duration_sec === 'number' ? data.duration_sec : data.durationSec ?? null,
    file_name: data.file_name ?? data.fileName ?? null,
    expires_at: expiresAt,
    requires_auth: requiresAuth,
  };
}

export async function uploadMeetingAudio(
  meetingId: string,
  audioUri: string,
  accessToken?: string,
  options: { fileName?: string; mimeType?: string; process?: boolean } = {},
): Promise<ApiMeetingAudioInfo | null> {
  if (audioUri.startsWith('file://')) {
    try {
      const info = await FileSystem.getInfoAsync(audioUri);
      if (info?.exists === false) throw new LocalMeetingAudioFileMissingError();
    } catch (error) {
      if (error instanceof LocalMeetingAudioFileMissingError) throw error;
    }
  }
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
  if (!res.ok) throw await apiResponseError('upload meeting audio failed', res, accessToken);
  const data = await res.json();
  const audio = data.audio ?? data;
  if (!audio?.url) return null;
  const requiresAuth = audio.requires_auth ?? false;
  const expiresAt = audio.expires_at ?? null;
  const url = validateMeetingAudioUrl(String(audio.url), { requiresAuth, expiresAt });
  return {
    url,
    mime_type: audio.mime_type ?? null,
    duration_sec: audio.duration_sec ?? null,
    file_name: audio.file_name ?? null,
    expires_at: expiresAt,
    requires_auth: requiresAuth,
  };
}

export async function deleteMeeting(
  meetingId: string,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
    signal,
  });
  if (!res.ok && res.status !== 404) {
    throw await apiResponseError('delete meeting failed', res, accessToken);
  }
}
