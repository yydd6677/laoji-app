import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  OccurrenceLinkV2Mutation,
  OccurrenceScheduleSnapshotV2,
  RemoteOccurrenceLinkV2,
} from './contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function nullableIdentifier(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : identifier(value, label, maximum);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function occurrenceDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}无效`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw new Error(`${label}无效`);
  return value;
}

function serverTime(value: unknown, label: string): number {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  ) throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function parseScheduleSnapshot(value: unknown): OccurrenceScheduleSnapshotV2 {
  if (!isRecord(value) || typeof value.all_day !== 'boolean') {
    throw new Error('日程计划快照格式无效');
  }
  const eventTitle = nullableText(value.event_title, '日程计划标题', 20_000);
  if (eventTitle === null) throw new Error('日程计划标题无效');
  const plannedStartMs = nullableInteger(value.planned_start_ms, '日程计划开始时间');
  const plannedEndMs = nullableInteger(value.planned_end_ms, '日程计划结束时间');
  if (
    plannedStartMs !== null
    && plannedEndMs !== null
    && plannedEndMs < plannedStartMs
  ) throw new Error('日程计划时间顺序无效');
  if (!Array.isArray(value.participants) || value.participants.length > 500) {
    throw new Error('日程计划参与人无效');
  }
  const participants = value.participants.map(item => {
    if (
      typeof item !== 'string'
      || !item.trim()
      || item.length > 1_000
      || item.includes('\u0000')
    ) throw new Error('日程计划参与人无效');
    return item;
  });
  return {
    eventTitle,
    plannedStartMs,
    plannedEndMs,
    allDay: value.all_day,
    timezoneId: nullableText(value.timezone_id, '日程计划时区', 160),
    location: nullableText(value.location, '日程计划地点', 2_000),
    participants,
    description: nullableText(value.description, '日程计划说明', 100_000),
    capturedEventRevision: nullableInteger(value.captured_event_revision, '日程计划版本'),
    capturedAtMs: safeInteger(value.captured_at_ms, '日程计划记录时间'),
  };
}

export function parseRemoteOccurrenceLinkV2(
  value: unknown,
  expected: { meetingRemoteId?: string; sourceEventId?: string; occurrenceDate?: string },
): RemoteOccurrenceLinkV2 {
  if (!isRecord(value) || value.schema_version !== 2 || typeof value.exists !== 'boolean') {
    throw new Error('日程关联响应格式无效');
  }
  const meetingRemoteId = nullableIdentifier(value.meeting_id, '日程关联会议标识', 160);
  const sourceEventId = nullableIdentifier(value.source_event_id, '日程关联日程标识');
  const date = value.occurrence_date === null
    ? null
    : occurrenceDate(value.occurrence_date, '日程关联实例日期');
  if (expected.meetingRemoteId && meetingRemoteId !== expected.meetingRemoteId) {
    throw new Error('日程关联不属于当前会议');
  }
  if (expected.sourceEventId && sourceEventId !== expected.sourceEventId) {
    throw new Error('日程关联不属于当前日程');
  }
  if (expected.occurrenceDate && date !== expected.occurrenceDate) {
    throw new Error('日程关联不属于当前日期');
  }
  const revision = safeInteger(value.revision, '日程关联云端版本');
  const clientUpdatedAtMs = safeInteger(value.client_updated_at_ms, '日程关联更新时间');
  if (!value.exists) {
    if (
      value.id !== null
      || revision !== 0
      || value.calendar_revision !== null
      || value.recurrence_segment_id !== null
      || value.series_key !== null
      || value.link_state !== null
      || clientUpdatedAtMs !== 0
      || value.schedule_snapshot !== null
      || value.created_at !== null
      || value.updated_at !== null
    ) throw new Error('日程关联缺失状态无效');
    return {
      exists: false,
      remoteId: null,
      meetingRemoteId,
      revision: 0,
      sourceEventId,
      occurrenceDate: date,
      calendarRevision: null,
      recurrenceSegmentId: null,
      seriesKey: null,
      linkState: null,
      clientUpdatedAtMs: 0,
      scheduleSnapshot: null,
      serverCreatedAtMs: null,
      serverUpdatedAtMs: null,
    };
  }
  const remoteId = identifier(value.id, '日程关联云端标识', 160);
  if (
    meetingRemoteId === null
    || sourceEventId === null
    || date === null
    || revision < 1
    || (value.link_state !== 'active' && value.link_state !== 'orphaned')
  ) throw new Error('日程关联状态无效');
  const serverCreatedAtMs = serverTime(value.created_at, '日程关联云端创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '日程关联云端更新时间');
  if (serverCreatedAtMs > serverUpdatedAtMs) throw new Error('日程关联云端时间顺序无效');
  return {
    exists: true,
    remoteId,
    meetingRemoteId,
    revision,
    sourceEventId,
    occurrenceDate: date,
    calendarRevision: nullableInteger(value.calendar_revision, '日程关联日历版本'),
    recurrenceSegmentId: nullableIdentifier(value.recurrence_segment_id, '重复日程分段标识'),
    seriesKey: nullableIdentifier(value.series_key, '重复日程系列标识'),
    linkState: value.link_state,
    clientUpdatedAtMs,
    scheduleSnapshot: parseScheduleSnapshot(value.schedule_snapshot),
    serverCreatedAtMs,
    serverUpdatedAtMs,
  };
}

function revisionFrom(value: unknown, response: Response): number | null {
  if (isRecord(value)) {
    const direct = value.revision;
    if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct >= 0) return direct;
    if (isRecord(value.current)) {
      const current = value.current.revision;
      if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0) return current;
    }
  }
  const raw = response.headers?.get?.('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function conflictCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string') return null;
  const normalized = value.error.code.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export class OccurrenceLinkConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('日程关联云端版本已变化', status);
    this.name = 'OccurrenceLinkConflictResponseError';
  }
}

export async function getOccurrenceLinkByReferenceV2(input: {
  accessToken: string;
  sourceEventId: string;
  occurrenceDate: string;
  signal?: AbortSignal;
}): Promise<RemoteOccurrenceLinkV2> {
  const sourceEventId = identifier(input.sourceEventId, '日程标识');
  const date = occurrenceDate(input.occurrenceDate, '日程实例日期');
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/occurrence-links/lookup?source_event_id=${encodeURIComponent(sourceEventId)}&occurrence_date=${encodeURIComponent(date)}`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('日程关联拉取失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  return parseRemoteOccurrenceLinkV2(await readResponseData(response), {
    sourceEventId,
    occurrenceDate: date,
  });
}

export async function getMeetingOccurrenceLinkV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<RemoteOccurrenceLinkV2> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/occurrence-link`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('日程关联拉取失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  return parseRemoteOccurrenceLinkV2(await readResponseData(response), { meetingRemoteId });
}

export async function upsertMeetingOccurrenceLinkV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  mutation: OccurrenceLinkV2Mutation;
  signal?: AbortSignal;
}): Promise<RemoteOccurrenceLinkV2> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const snapshot = input.mutation.schedule_snapshot;
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/occurrence-link`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '请求标识'),
        ...(input.mutation.expected_remote_revision === null
          ? { 'If-None-Match': '*' }
          : { 'If-Match': `"${input.mutation.expected_remote_revision}"` }),
      },
      body: JSON.stringify({
        schema_version: 2,
        source_event_id: input.mutation.source_event_id,
        occurrence_date: input.mutation.occurrence_date,
        calendar_revision: input.mutation.calendar_revision,
        recurrence_segment_id: input.mutation.recurrence_segment_id,
        series_key: input.mutation.series_key,
        link_state: input.mutation.link_state,
        client_updated_at_ms: input.mutation.client_updated_at_ms,
        schedule_snapshot: {
          event_title: snapshot.eventTitle,
          planned_start_ms: snapshot.plannedStartMs,
          planned_end_ms: snapshot.plannedEndMs,
          all_day: snapshot.allDay,
          timezone_id: snapshot.timezoneId,
          location: snapshot.location,
          participants: snapshot.participants,
          description: snapshot.description,
          captured_event_revision: snapshot.capturedEventRevision,
          captured_at_ms: snapshot.capturedAtMs,
        },
      }),
    },
  );
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new OccurrenceLinkConflictResponseError(
      response.status,
      revisionFrom(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current')
        ? data.current
        : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('日程关联同步失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const link = parseRemoteOccurrenceLinkV2(await readResponseData(response), { meetingRemoteId });
  if (!link.exists) throw new Error('日程关联同步响应缺少云端版本');
  return link;
}
