import {
  classifyScheduleParseRoute,
  classifyScheduleParseIntent,
  normalizeScheduleParseResult,
  parseLocalScheduleText,
  scheduleTimePeriodFromText,
} from './localScheduleParser';
import type { EventCategory } from '../utils/eventColors';
import {
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
  const remoteIntent = classifyScheduleParseIntent(text);

  // Simple high-confidence creation stays local. MentionGraph is the sole
  // semantic owner for complex creation and clarification. Query/delete
  // operations continue through the device operation endpoint.
  const graphRequired = (remoteIntent === 'create' || remoteIntent === 'clarify')
    && (decision.route === 'server_required' || decision.route === 'clarify');
  if (graphRequired) {
    const v2 = await loadDeviceV2Capabilities().catch(() => null);
    if (v2?.scheduleGraphV2 !== true) {
      throw new ScheduleParseError('parser_unavailable', SCHEDULE_ERROR_MESSAGES.parser_unavailable);
    }
    try {
      const graph = await parseScheduleGraphV2({
        text,
        referenceDatetime: context.reference_datetime,
        timezone: context.timezone,
        clientIntent: remoteIntent,
        clientRequestId: graphRequestId('parse'),
      });
      return graphParseResult(graph, context);
    } catch (err) {
      throw scheduleParseErrorFromRemote(err);
    }
  }

  if ((decision.route === 'local_safe' || decision.route === 'clarify') && decision.result) {
    return normalizedParseResult(text, decision.result, context);
  }

  try {
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
      const capabilities = await loadDeviceV2Capabilities().catch(() => null);
      if (!capabilities?.scheduleGraphV2) {
        throw new ScheduleParseError('parser_unavailable', SCHEDULE_ERROR_MESSAGES.parser_unavailable);
      }
      const graph = await clarifyScheduleGraphV2({
        graph: draft.schedule_graph,
        answer: supplement,
        clientRequestId: graphRequestId('clarify'),
      });
      return graphParseResult(graph, context);
    }

    const capabilities = await loadDeviceV2Capabilities().catch(() => null);
    if (!capabilities?.scheduleGraphV2) {
      throw new ScheduleParseError('parser_unavailable', SCHEDULE_ERROR_MESSAGES.parser_unavailable);
    }
    const graph = await parseScheduleGraphV2({
      text: draft.raw_text?.trim() || original,
      referenceDatetime: context.reference_datetime,
      timezone: context.timezone,
      clientIntent: 'create',
      clientRequestId: graphRequestId('parse'),
    });
    const clarified = await clarifyScheduleGraphV2({
      graph,
      answer: supplement,
      clientRequestId: graphRequestId('clarify'),
    });
    return graphParseResult(clarified, context);
  } catch (err) {
    throw scheduleParseErrorFromRemote(err);
  }
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
