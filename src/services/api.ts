import * as FileSystem from 'expo-file-system/legacy';
import { getApiConfig } from './config';
import { readResponseData, readResponseError, stringifyErrorDetail } from './errors';
import {
  classifyScheduleParseRoute,
  classifyScheduleParseIntent,
  normalizeScheduleParseResult,
  parseLocalScheduleText,
  scheduleTimePeriodFromText,
} from './localScheduleParser';
import type { EventCategory } from '../utils/eventColors';
import type { EventRecurrenceScope, MeetingSummary, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import { fetchWithTimeout as fetch, readJsonWithTimeout } from './http';
import {
  clarifyScheduleRemotely,
  DeviceApiError,
  parseScheduleAudioRemotely,
  parseScheduleRemotely,
} from './deviceApi';
import { loadDeviceV2Capabilities } from './deviceV2Api';
import {
  clarifyScheduleGraphV2,
  parseScheduleGraphV2,
  type ScheduleGraphV1,
} from './scheduleGraphV2';
import { getFeatureFlags } from '../config/featureFlags';
import { validateMeetingAudioUrl } from './meetingAudioSecurity';
import { LocalMeetingAudioFileMissingError } from './meetingAudioUploadFailure';
import {
  meetingSummaryTraceHeaders,
  type MeetingSummaryTraceContext,
} from './meetingSummaryTrace';
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
const API_RESPONSE_BODY_TIMEOUT_MS = 10_000;
const MEETING_AUDIO_INFO_TIMEOUT_MS = 20_000;

function laojiUrl(path: string): string {
  return `${getApiConfig().apiBase}${path}`;
}

function meetingUrl(path: string): string {
  return `${getApiConfig().apiBase}${path}`;
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

/**
 * Account endpoints remain in this module only as a compatibility layer for
 * authenticated installs.  The accountless product must never silently send
 * a request without an account credential: doing so would re-open an old
 * guest/anonymous route and could upload phone-owned content outside the
 * device/epoch contract.  Keep the optional parameter on legacy signatures
 * so older callers still compile, but fail before any network I/O.
 */
function requireAccountAccessToken(accessToken: string | undefined, operation: string): string {
  const token = accessToken?.trim();
  if (!token) {
    throw new Error(`${operation}仅支持已登录的兼容服务`);
  }
  return token;
}

async function apiResponseError(prefix: string, res: Response, accessToken?: string): Promise<Error> {
  return readResponseError(prefix, res, { unauthorizedToken: accessToken });
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParseResult {
  title: string;
  event_type: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence_interval?: number | null;
  recurrence_weekdays?: number[] | null;
  recurrence_until_date?: string | null;
  start_date: string;        // YYYY-MM-DD
  end_date?: string | null;  // YYYY-MM-DD, for multi-day events
  color?: string | null;
  spanning?: boolean | null;
  start_time: string | null; // HH:MM
  end_time: string | null;   // HH:MM
  /** Spoken day period retained when the user did not provide an exact clock. */
  time_period?: 'early_morning' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | null;
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
  /** Immutable vNext graph carried through clarification; never persisted as server-owned event data. */
  schedule_graph?: ScheduleGraphV1;
}

// The HTTP/OpenAPI contract uses null when the parser cannot determine a
// date. Keep the app-facing ParseResult string-only so existing draft and
// calendar code continues to use an explicit empty value after normalization.
type ParseResultWire = Omit<ParseResult, 'start_date'> & {
  start_date?: string | null;
};

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

function scheduleParseErrorFromRemote(error: unknown): ScheduleParseError {
  if (error instanceof ScheduleParseError) return error;
  if (!(error instanceof DeviceApiError)) {
    return new ScheduleParseError('parser_unavailable', SCHEDULE_ERROR_MESSAGES.parser_unavailable);
  }

  const providerCode = error.code?.toUpperCase() ?? '';
  if (error.status >= 500 || providerCode.includes('UNAVAILABLE')) {
    return new ScheduleParseError('parser_unavailable', SCHEDULE_ERROR_MESSAGES.parser_unavailable, error.status);
  }
  if (providerCode === 'NOT_SCHEDULE') {
    return new ScheduleParseError('not_schedule', SCHEDULE_ERROR_MESSAGES.not_schedule, error.status);
  }
  if (providerCode === 'MISSING_DATE') {
    return new ScheduleParseError('missing_date', SCHEDULE_ERROR_MESSAGES.missing_date, error.status);
  }
  if (providerCode === 'MISSING_EDIT_TARGET') {
    return new ScheduleParseError('missing_edit_target', SCHEDULE_ERROR_MESSAGES.missing_edit_target, error.status);
  }
  if (providerCode === 'AMBIGUOUS_RANGE') {
    return new ScheduleParseError('ambiguous_range', SCHEDULE_ERROR_MESSAGES.ambiguous_range, error.status);
  }
  if (providerCode === 'CONFLICTING_TIME') {
    return new ScheduleParseError('conflicting_time', SCHEDULE_ERROR_MESSAGES.conflicting_time, error.status);
  }
  if (providerCode === 'SCHEDULE_MODEL_NO_RESULT') {
    return new ScheduleParseError('invalid_schedule', '未识别到具体安排，请修改后重试', error.status);
  }
  return new ScheduleParseError('invalid_schedule', SCHEDULE_ERROR_MESSAGES.invalid_schedule, error.status);
}

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
  result: ParseResultWire,
  context: Required<ScheduleParseContext>,
  options: { modelOnly?: boolean } = {},
): ParseResult {
  const normalizedWire: ParseResult = {
    ...result,
    start_date: typeof result.start_date === 'string' ? result.start_date : '',
  };
  if (options.modelOnly) {
    return normalizeModelOnlyParseResult(normalizedWire, context);
  }
  return {
    ...normalizeScheduleParseResult(
      text,
      normalizedWire,
      new Date(context.reference_datetime),
      context.timezone,
    ),
    reference_datetime: context.reference_datetime,
    timezone: context.timezone,
  };
}

/**
 * A complex text miss has already been classified by the phone's shared
 * parser. The server then asks Qwen to own the semantics. Keep only transport
 * and schema safety here; do not infer category, dates, reminders, or
 * clarification state from the original text a second time on the phone.
 */
function normalizeModelOnlyParseResult(
  result: ParseResult,
  context: Required<ScheduleParseContext>,
): ParseResult {
  const startDate = typeof result.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.start_date)
    ? result.start_date
    : '';
  const endDate = typeof result.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.end_date)
    ? result.end_date
    : null;
  const startTime = typeof result.start_time === 'string' && /^\d{2}:\d{2}$/.test(result.start_time)
    ? result.start_time
    : null;
  const endTime = typeof result.end_time === 'string' && /^\d{2}:\d{2}$/.test(result.end_time)
    ? result.end_time
    : null;
  const endDateSafe = endDate && startDate && endDate < startDate ? null : endDate;
  const timePeriod = !startTime
    ? scheduleTimePeriodFromText(result.raw_text)
    : null;
  const needsClarification = result.needs_clarification === true;
  return {
    ...result,
    start_date: startDate,
    end_date: endDateSafe,
    spanning: Boolean(endDateSafe && endDateSafe !== startDate),
    start_time: result.is_all_day ? null : startTime,
    end_time: result.is_all_day ? null : endTime,
    time_period: result.is_all_day ? null : timePeriod,
    is_all_day: result.is_all_day === true,
    needs_clarification: needsClarification,
    clarification_question: needsClarification
      ? (typeof result.clarification_question === 'string' && result.clarification_question.trim()
        ? result.clarification_question.trim()
        : '还有一项日程信息需要确认。')
      : null,
    reference_datetime: context.reference_datetime,
    timezone: context.timezone,
  };
}

function graphRequestId(kind: 'parse' | 'clarify'): string {
  return `schedule-graph-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function graphParseResult(
  graph: ScheduleGraphV1,
  context: Required<ScheduleParseContext>,
): ParseResult {
  if (graph.intent === 'reject' || graph.state === 'reject') {
    throw new ScheduleParseError('not_schedule', SCHEDULE_ERROR_MESSAGES.not_schedule);
  }
  if (!['create', 'clarify'].includes(graph.intent) || graph.state === 'operation') {
    throw new ScheduleParseError('invalid_schedule', '这段内容不是新建日程，请换一种说法。');
  }
  const slots = graph.slots;
  const eventTypes = new Set<ParseResult['event_type']>(['once', 'daily', 'weekly', 'monthly', 'yearly']);
  const eventType = eventTypes.has(slots.event_type as ParseResult['event_type'])
    ? slots.event_type as ParseResult['event_type']
    : 'once';
  const recurrence = slots.recurrence ?? {};
  const reminder = slots.reminder ?? {};
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(slots.start_date ?? '')
    ? slots.start_date!
    : '';
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(slots.end_date ?? '')
    ? slots.end_date
    : null;
  const startTime = /^\d{2}:\d{2}$/.test(slots.start_time ?? '') ? slots.start_time : null;
  const endTime = /^\d{2}:\d{2}$/.test(slots.end_time ?? '') ? slots.end_time : null;
  const period = slots.time_period ?? null;
  const needsClarification = graph.state === 'needs_clarification' || graph.state === 'incomplete';
  const missingLabels: Record<string, string> = {
    start_date: '具体日期',
    start_time: '具体时间',
    title: '日程内容',
    location: '地点',
  };
  const missing = graph.missing.map(item => missingLabels[item] ?? item);
  return {
    title: slots.title?.trim() ?? '',
    event_type: eventType,
    recurrence_interval: Number.isSafeInteger(recurrence.recurrence_interval)
      ? Number(recurrence.recurrence_interval)
      : null,
    recurrence_weekdays: Array.isArray(recurrence.recurrence_weekdays)
      ? recurrence.recurrence_weekdays.map(Number).filter(Number.isSafeInteger)
      : null,
    recurrence_until_date: typeof recurrence.recurrence_until_date === 'string'
      ? recurrence.recurrence_until_date
      : null,
    start_date: startDate,
    end_date: endDate,
    spanning: Boolean(startDate && endDate && endDate !== startDate),
    start_time: startTime,
    end_time: endTime,
    time_period: period,
    is_all_day: !startTime && !endTime && !period,
    description: null,
    location: slots.location,
    category: null,
    detail: null,
    status: null,
    reminder_minutes: Number.isSafeInteger(reminder.minutes) ? Number(reminder.minutes) : null,
    raw_text: graph.source.text,
    parse_source: graph.provenance.engine === 'server-model' ? 'local_llm' : 'rules',
    confidence: graph.state === 'complete' ? 0.9 : 0.5,
    needs_clarification: needsClarification,
    clarification_question: needsClarification
      ? `还需要补充${missing.length > 0 ? missing.join('、') : '日程信息'}。`
      : null,
    reference_datetime: context.reference_datetime,
    timezone: context.timezone,
    schedule_graph: graph,
  };
}

export async function parseText(
  text: string,
  contextInput: ScheduleParseContext = {},
): Promise<ParseResult> {
  const context = currentScheduleParseContext(contextInput);
  const referenceDate = new Date(context.reference_datetime);

  const local = parseLocalScheduleText(text, referenceDate, context.timezone);
  const decision = classifyScheduleParseRoute(text, local, referenceDate, context.timezone);
  if (decision.route === 'reject') {
    const code = decision.code ?? 'not_schedule';
    throw new ScheduleParseError(code, decision.message ?? SCHEDULE_ERROR_MESSAGES[code]);
  }
  if ((decision.route === 'local_safe' || decision.route === 'clarify') && decision.result) {
    return normalizedParseResult(text, decision.result, context);
  }

  const remoteIntent = classifyScheduleParseIntent(text);
  try {
    const v2 = getFeatureFlags().scheduleGraphV2Candidate
      ? await loadDeviceV2Capabilities().catch(() => null)
      : null;
    if (v2?.scheduleGraphV2) {
      const graph = await parseScheduleGraphV2({
        text,
        referenceDatetime: context.reference_datetime,
        timezone: context.timezone,
        clientIntent: remoteIntent,
        clientRequestId: graphRequestId('parse'),
      });
      return graphParseResult(graph, context);
    }
    const response = await parseScheduleRemotely(
      text,
      context.reference_datetime,
      context.timezone,
      {
        clientRuleMiss: true,
        clientIntent: remoteIntent,
      },
    );
    const parsed = (response?.result ?? response) as ParseResultWire;
    return normalizedParseResult(text, parsed, context, { modelOnly: remoteIntent === 'create' });
  } catch (err) {
    throw scheduleParseErrorFromRemote(err);
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
  try {
    if (draft.schedule_graph) {
      const graph = await clarifyScheduleGraphV2({
        graph: draft.schedule_graph,
        answer: supplement,
        clientRequestId: graphRequestId('clarify'),
      });
      return graphParseResult(graph, context);
    }
    const parsed = await clarifyScheduleRemotely(
      { ...draft, raw_text: draft.raw_text ?? original },
      supplement,
      context.reference_datetime,
      context.timezone,
    );
    // The server has already applied this answer to the existing draft. Do
    // not run the combined text through the local parser again: that turns a
    // clarification such as “下午” into a second independent request and can
    // overwrite the server's date/time/title merge.
    return normalizeModelOnlyParseResult(parsed as ParseResultWire as ParseResult, context);
  } catch (err) {
    throw scheduleParseErrorFromRemote(err);
  }
}

// ── Save event ──────────────────────────────────────────────────────────────

export async function saveEvent(event: ApiEvent, accessToken?: string): Promise<ApiEvent> {
  const token = requireAccountAccessToken(accessToken, '保存远程日程');
  const res = await fetch(laojiUrl('/api/laoji/events'), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(event),
  });
  if (!res.ok) throw await apiResponseError('save event failed', res, token);
  return readJsonWithTimeout<ApiEvent>(res, API_RESPONSE_BODY_TIMEOUT_MS);
}

// ── Fetch events by month ───────────────────────────────────────────────────

export async function fetchEvents(year?: number, month?: number, accessToken?: string): Promise<ApiEvent[]> {
  const token = requireAccountAccessToken(accessToken, '读取远程日程');
  const query = year != null && month != null ? `?year=${year}&month=${month}` : '';
  const res = await fetch(
    laojiUrl(`/api/laoji/events${query}`),
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw await apiResponseError('fetch events failed', res, token);
  const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS);
  return Array.isArray(data) ? data : data.events ?? [];
}

function parseAudioResult(value: unknown, context: Required<ScheduleParseContext>): ParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduleParseError('invalid_schedule', '未识别到日程，请重试。');
  }
  const data = value as Partial<ParseResultWire> & Record<string, unknown>;
  const rawText = typeof data.raw_text === 'string' ? data.raw_text.trim() : '';
  if (!rawText) {
    throw new ScheduleParseError('invalid_schedule', '未识别到语音内容，请重新录音。');
  }
  if (
    typeof data.title !== 'string'
    || (data.start_date !== undefined && data.start_date !== null && typeof data.start_date !== 'string')
  ) {
    throw new ScheduleParseError('invalid_schedule', '日程解析结果不完整，请重试。');
  }
  return normalizedParseResult(rawText, data as ParseResultWire, context);
}

function filenameFromUri(audioUri: string): string {
  const fallback = 'recording.m4a';
  const file = audioUri.split('?')[0].split('#')[0].split('/').pop();
  try {
    return decodeURIComponent(file || fallback) || fallback;
  } catch {
    return fallback;
  }
}

export async function parseAudio(
  audioUri: string,
  contextInput: ScheduleParseContext = {},
): Promise<ParseResult> {
  const context = currentScheduleParseContext(contextInput);
  try {
    const result = await parseScheduleAudioRemotely(
      audioUri,
      filenameFromUri(audioUri),
      context.reference_datetime,
      context.timezone,
    );
    return { ...parseAudioResult(result, context), ...context };
  } catch (err) {
    throw scheduleParseErrorFromRemote(err);
  }
}

// ── Delete event ────────────────────────────────────────────────────────────

export async function deleteEvent(id: number, accessToken?: string): Promise<void> {
  const token = requireAccountAccessToken(accessToken, '删除远程日程');
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}`), {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw await apiResponseError('delete event failed', res, token);
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
  return readJsonWithTimeout<ApiEventStateCommandResponse>(res, API_RESPONSE_BODY_TIMEOUT_MS);
}

// ── Update event ────────────────────────────────────────────────────────────

export async function updateEvent(
  id: number,
  changes: Partial<ApiEvent>,
  accessToken?: string,
): Promise<ApiEvent> {
  const token = requireAccountAccessToken(accessToken, '修改远程日程');
  const res = await fetch(laojiUrl(`/api/laoji/events/${id}`), {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw await apiResponseError('update event failed', res, token);
  return readJsonWithTimeout<ApiEvent>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  return readJsonWithTimeout<ApiEventEditCommandResponse>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  return readJsonWithTimeout<ApiEventEditCommandResponse>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  stage?: 'queued' | 'preparing' | 'generating' | 'verifying' | 'persisting' | 'success' | 'failure' | string;
  /** Identity echoed by durable device summary-v3 tasks for recovery matching. */
  source_fingerprint?: string;
  model_revision?: string;
  prompt_revision?: string;
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
  const token = requireAccountAccessToken(accessToken, '读取远程会议');
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings?page=${page}&size=${size}`),
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw await apiResponseError('fetch meetings failed', res, token);
  const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  const token = requireAccountAccessToken(accessToken, '创建远程会议');
  const res = await fetch(meetingUrl('/api/laoji/meetings'), {
    method: 'POST',
    headers: jsonHeaders(token),
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
  if (!res.ok) throw await apiResponseError('create meeting failed', res, token);
  return readJsonWithTimeout<ApiMeeting>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
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
  return readJsonWithTimeout<ApiGuestRealtimeSession>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  let errorCode: string | null = null;
  let script: 'zh-Hans' | 'unknown' = 'unknown';
  let offset = 0;

  while (true) {
    const res = await fetch(
      meetingUrl(`/api/laoji/meetings/guest-sessions/${encodeURIComponent(meetingId)}/transcripts?offset=${offset}&limit=${pageSize}`),
      { headers: { 'X-Guest-Session-Token': guestToken }, signal: options.signal },
    );
    if (!res.ok) throw await readResponseError('fetch guest meeting transcript failed', res);
    const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS, options.signal);
    completeness = combineTranscriptServerCompleteness(
      completeness,
      transcriptServerCompletenessFromPayload(data),
    );
    if (transcriptScriptFromPayload(data) === 'zh-Hans') script = 'zh-Hans';
    remoteState = combineTranscriptRemoteState(
      remoteState,
      transcriptRemoteStateFromPayload(data),
    );
    errorCode = errorCode ?? transcriptErrorCodeFromPayload(data);
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

  return { items: all, completeness, remoteState, errorCode, remoteRevisionId: null, script };
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
  const token = requireAccountAccessToken(accessToken, '修改远程会议');
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}`), {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify(changes),
    signal,
  });
  if (!res.ok) throw await apiResponseError('update meeting failed', res, token);
  return readJsonWithTimeout<ApiMeeting>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
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
  return readJsonWithTimeout<GuestMeetingImportResult>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  errorCode: string | null;
  remoteRevisionId: string | null;
  /** Server-side OpenCC policy marker; unknown is a legacy endpoint/cache. */
  script: 'zh-Hans' | 'unknown';
}

function transcriptErrorCodeFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const value = record.transcript_error_code ?? record.error_code;
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('transcript remote error code is invalid');
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('transcript remote error code is invalid');
  }
  return normalized;
}

function transcriptScriptFromPayload(payload: unknown): 'zh-Hans' | 'unknown' {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unknown';
  const value = (payload as Record<string, unknown>).script;
  return value === 'zh-Hans' ? 'zh-Hans' : 'unknown';
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
  const token = requireAccountAccessToken(accessToken, '读取远程文字记录');
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? 1000));
  const all: TranscriptLine[] = [];
  const seenIds = new Set<string>();
  let completeness: TranscriptServerCompleteness = 'unknown';
  let remoteState: TranscriptRemoteState = 'unknown';
  let errorCode: string | null = null;
  let remoteRevisionId: string | null = null;
  let script: 'zh-Hans' | 'unknown' = 'unknown';
  let offset = 0;

  while (true) {
    const res = await fetch(
      meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}/transcripts?offset=${offset}&limit=${pageSize}`),
      { headers: authHeaders(token), signal: options.signal },
    );
    if (!res.ok) throw await apiResponseError('fetch meeting transcript failed', res, token);
    const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS, options.signal);
    const pageRevisionId = transcriptRemoteRevisionId(data);
    if (remoteRevisionId && pageRevisionId && remoteRevisionId !== pageRevisionId) {
      throw new Error('transcript pagination changed remote revision');
    }
    remoteRevisionId = remoteRevisionId ?? pageRevisionId;
    const pageScript = transcriptScriptFromPayload(data);
    if (pageScript === 'zh-Hans') script = 'zh-Hans';
    completeness = combineTranscriptServerCompleteness(
      completeness,
      transcriptServerCompletenessFromPayload(data),
    );
    remoteState = combineTranscriptRemoteState(
      remoteState,
      transcriptRemoteStateFromPayload(data),
    );
    errorCode = errorCode ?? transcriptErrorCodeFromPayload(data);
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
    errorCode,
    remoteRevisionId: remoteState === 'complete' ? remoteRevisionId : null,
    script,
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

export async function fetchMeetingSummaryDetail(
  meetingId: string,
  accessToken?: string,
  signal?: AbortSignal,
  trace?: MeetingSummaryTraceContext,
): Promise<unknown | null> {
  const token = requireAccountAccessToken(accessToken, '读取远程整理结果');
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/final`),
    { headers: { ...(authHeaders(token) ?? {}), ...meetingSummaryTraceHeaders(trace) }, signal },
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw await apiResponseError('fetch meeting summary failed', res, token);
  return readJsonWithTimeout<unknown>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
}

export async function generateMeetingSummary(
  meetingId: string,
  accessToken?: string,
  signal?: AbortSignal,
  force = false,
  template: Pick<MeetingTemplate, 'id' | 'revision'> = DEFAULT_MEETING_TEMPLATE,
  carryForward?: MeetingSummaryCarryForwardAuthorization | null,
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null,
  trace?: MeetingSummaryTraceContext,
): Promise<ApiMeetingSummaryTask> {
  const token = requireAccountAccessToken(accessToken, '生成远程整理结果');
  const query = new URLSearchParams({
    summary_type: 'final',
    force: String(force),
    template_id: template.id,
    template_revision: String(template.revision),
  });
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/generate?${query}`), {
    method: 'POST',
    headers: { ...jsonHeaders(token), ...meetingSummaryTraceHeaders(trace) },
    signal,
    body: JSON.stringify({
      carry_forward: summaryCarryForwardPayload(carryForward),
      attachment_authorization: summaryAttachmentAuthorizationPayload(attachmentAuthorization),
    }),
  });
  if (!res.ok) throw await apiResponseError('generate meeting summary failed', res, token);
  return readJsonWithTimeout<ApiMeetingSummaryTask>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
}

export async function fetchMeetingSummaryTask(
  meetingId: string,
  taskId: string,
  accessToken?: string,
  signal?: AbortSignal,
  waitMs = SUMMARY_TASK_WAIT_MS,
  trace?: MeetingSummaryTraceContext,
): Promise<ApiMeetingTaskStatus> {
  const token = requireAccountAccessToken(accessToken, '读取远程整理进度');
  const query = new URLSearchParams({ wait_ms: String(waitMs) });
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/summaries/task/${taskId}?${query}`),
    { headers: { ...(authHeaders(token) ?? {}), ...meetingSummaryTraceHeaders(trace) }, signal },
  );
  if (!res.ok) throw await apiResponseError('fetch meeting summary task failed', res, token);
  return readJsonWithTimeout<ApiMeetingTaskStatus>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
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
  trace?: MeetingSummaryTraceContext,
): Promise<ApiMeetingSummaryTask> {
  const res = await fetch(meetingUrl('/api/laoji/meetings/guest-summary'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...meetingSummaryTraceHeaders(trace) },
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
  return readJsonWithTimeout<ApiMeetingSummaryTask>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
}

export async function fetchGuestMeetingSummaryTask(
  taskId: string,
  signal?: AbortSignal,
  waitMs = SUMMARY_TASK_WAIT_MS,
  trace?: MeetingSummaryTraceContext,
): Promise<ApiMeetingTaskStatus> {
  const query = new URLSearchParams({ wait_ms: String(waitMs) });
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/guest-summary/tasks/${encodeURIComponent(taskId)}?${query}`),
    { headers: meetingSummaryTraceHeaders(trace), signal },
  );
  if (!res.ok) throw await readResponseError('fetch guest meeting summary task failed', res);
  return readJsonWithTimeout<ApiMeetingTaskStatus>(res, API_RESPONSE_BODY_TIMEOUT_MS, signal);
}

export async function fetchMeetingAudioInfo(meetingId: string, accessToken?: string): Promise<ApiMeetingAudioInfo | null> {
  const token = requireAccountAccessToken(accessToken, '读取远程录音');
  const res = await fetch(
    meetingUrl(`/api/laoji/meetings/${meetingId}/audio`),
    { headers: authHeaders(token) },
    MEETING_AUDIO_INFO_TIMEOUT_MS,
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw await apiResponseError('fetch meeting audio failed', res, token);
  const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  const token = requireAccountAccessToken(accessToken, '上传远程录音');
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
    headers: authHeaders(token),
    body: form,
  });
  if (!res.ok) throw await apiResponseError('upload meeting audio failed', res, token);
  const data = await readJsonWithTimeout<any>(res, API_RESPONSE_BODY_TIMEOUT_MS);
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
  const token = requireAccountAccessToken(accessToken, '删除远程会议');
  const res = await fetch(meetingUrl(`/api/laoji/meetings/${encodeURIComponent(meetingId)}`), {
    method: 'DELETE',
    headers: authHeaders(token),
    signal,
  });
  if (!res.ok && res.status !== 404) {
    throw await apiResponseError('delete meeting failed', res, token);
  }
}
