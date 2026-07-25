import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  CreateMeetingNoteV2Request,
  MeetingNoteV2Response,
  RemoteMeetingNoteV2,
  UpdateMeetingNoteV2Request,
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

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label}无效`);
  return normalized;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  return text(value, label, maximum, true) || null;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
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

function nullableServerTime(value: unknown, label: string): number | null {
  return value === null ? null : serverTime(value, label);
}

function parseParticipants(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label}无效`);
  const result = value.map(item => text(item, label, 1_000));
  if (new Set(result).size !== result.length) throw new Error(`${label}存在重复项`);
  return result;
}

function parseOccurrence(value: unknown): MeetingNoteV2Response['occurrence_ref'] {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('会议日程关联无效');
  const occurrenceDate = text(value.occurrence_date, '日程实例日期', 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(occurrenceDate);
  const parsedDate = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
  if (
    !match
    || !parsedDate
    || parsedDate.getUTCFullYear() !== Number(match[1])
    || parsedDate.getUTCMonth() !== Number(match[2]) - 1
    || parsedDate.getUTCDate() !== Number(match[3])
  ) {
    throw new Error('日程实例日期无效');
  }
  const linkState = value.link_state;
  if (linkState !== 'active' && linkState !== 'orphaned') throw new Error('日程关联状态无效');
  return {
    id: identifier(value.id, '日程关联云端标识', 160),
    revision: safeInteger(value.revision, '日程关联版本', 1),
    source_event_id: identifier(value.source_event_id, '日程来源标识'),
    occurrence_date: occurrenceDate,
    calendar_revision: nullableInteger(value.calendar_revision, '日程版本'),
    recurrence_segment_id: value.recurrence_segment_id === null
      ? null
      : identifier(value.recurrence_segment_id, '日程分段标识'),
    series_key: value.series_key === null
      ? null
      : identifier(value.series_key, '日程序列标识'),
    link_state: linkState,
  };
}

function parseScheduleSnapshot(value: unknown): MeetingNoteV2Response['schedule_snapshot'] {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('会议日程快照无效');
  const plannedStartMs = nullableInteger(value.planned_start_ms, '计划开始时间');
  const plannedEndMs = nullableInteger(value.planned_end_ms, '计划结束时间');
  if (plannedStartMs !== null && plannedEndMs !== null && plannedEndMs < plannedStartMs) {
    throw new Error('计划结束时间早于开始时间');
  }
  if (typeof value.all_day !== 'boolean') throw new Error('日程全天状态无效');
  return {
    event_title: text(value.event_title, '日程标题', 20_000, true),
    planned_start_ms: plannedStartMs,
    planned_end_ms: plannedEndMs,
    all_day: value.all_day,
    timezone_id: nullableText(value.timezone_id, '日程时区', 160),
    location: nullableText(value.location, '日程地点', 2_000),
    participants: parseParticipants(value.participants, '日程参与人'),
    description: nullableText(value.description, '日程说明', 100_000),
    captured_event_revision: nullableInteger(value.captured_event_revision, '日程快照版本'),
    captured_at_ms: safeInteger(value.captured_at_ms, '日程快照时间'),
  };
}

const PROCESSING_STAGES = ['capture', 'upload', 'transcript', 'summary', 'speaker'] as const;

function parseProcessingStages(value: unknown): MeetingNoteV2Response['processing_stages'] {
  if (!Array.isArray(value) || value.length !== PROCESSING_STAGES.length) {
    throw new Error('会议处理状态不完整');
  }
  const seen = new Set<string>();
  const stages = value.map(item => {
    if (!isRecord(item) || !PROCESSING_STAGES.includes(item.stage as typeof PROCESSING_STAGES[number])) {
      throw new Error('会议处理阶段无效');
    }
    const stage = item.stage as typeof PROCESSING_STAGES[number];
    if (seen.has(stage)) throw new Error('会议处理阶段重复');
    seen.add(stage);
    const status = identifier(item.status, '会议处理状态', 160);
    const attempt = safeInteger(item.attempt, '会议处理次数');
    const progress = item.progress === undefined || item.progress === null
      ? null
      : Number(item.progress);
    if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1)) {
      throw new Error('会议处理进度无效');
    }
    const errorCode = item.error_code === undefined || item.error_code === null
      ? null
      : identifier(item.error_code, '会议处理错误', 160);
    if (item.retryable !== undefined && typeof item.retryable !== 'boolean') {
      throw new Error('会议处理重试状态无效');
    }
    return {
      stage,
      status,
      attempt,
      progress,
      error_code: errorCode,
      retryable: item.retryable === true,
    };
  });
  return stages;
}

export function parseMeetingNoteV2(
  value: unknown,
  expected: { remoteId?: string; clientNoteId?: string } = {},
): RemoteMeetingNoteV2 {
  if (!isRecord(value) || value.schema_version !== 2) throw new Error('会议记录同步响应格式无效');
  const remoteId = identifier(value.id, '会议云端标识', 160);
  const clientNoteId = identifier(value.client_note_id, '会议本机标识', 160);
  if (expected.remoteId && remoteId !== expected.remoteId) throw new Error('会议云端标识发生变化');
  if (expected.clientNoteId && clientNoteId !== expected.clientNoteId) {
    throw new Error('会议本机标识发生变化');
  }
  const revision = safeInteger(value.revision, '会议云端版本', 1);
  const origin = value.origin;
  if (origin !== 'calendar' && origin !== 'ad_hoc' && origin !== 'file_import' && origin !== 'share_intent') {
    throw new Error('会议来源无效');
  }
  const entryPoint = value.entry_point;
  const entryPoints = new Set([
    'calendar_detail', 'notification', 'widget', 'meeting_tab', 'quick_tile',
    'document_picker', 'share_intent', 'legacy_store', 'recorder_recovery',
  ]);
  if (entryPoint !== null && (typeof entryPoint !== 'string' || !entryPoints.has(entryPoint))) {
    throw new Error('会议入口无效');
  }
  const mode = value.mode;
  if (mode !== 'realtime' && mode !== 'offline' && mode !== 'whisper' && mode !== 'qwen') {
    throw new Error('会议录制模式无效');
  }
  const lifecycle = value.lifecycle;
  if (lifecycle !== 'active' && lifecycle !== 'deleted') throw new Error('会议生命周期无效');
  const recordedAtMs = nullableServerTime(value.recorded_at, '会议记录时间');
  const deletedAtMs = nullableServerTime(value.deleted_at, '会议删除时间');
  if ((lifecycle === 'deleted') !== (deletedAtMs !== null)) throw new Error('会议删除状态无效');
  const occurrenceRef = parseOccurrence(value.occurrence_ref);
  const scheduleSnapshot = parseScheduleSnapshot(value.schedule_snapshot);
  if ((occurrenceRef === null) !== (scheduleSnapshot === null)) throw new Error('会议日程上下文不完整');
  if ((origin === 'calendar') !== (occurrenceRef !== null)) throw new Error('会议来源与日程上下文不一致');
  const serverCreatedAtMs = serverTime(value.created_at, '会议云端创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '会议云端更新时间');
  if (serverCreatedAtMs > serverUpdatedAtMs) throw new Error('会议云端时间顺序无效');
  return {
    remoteId,
    clientNoteId,
    revision,
    origin,
    entryPoint: entryPoint as RemoteMeetingNoteV2['entryPoint'],
    title: text(value.title, '会议标题', 255, true),
    description: nullableText(value.description, '会议说明', 100_000),
    participants: parseParticipants(value.participants, '会议参与人'),
    location: nullableText(value.location, '会议地点', 500),
    mode,
    status: identifier(value.status, '会议状态', 160),
    recordedAtMs,
    lifecycle,
    deletedAtMs,
    occurrenceRef,
    scheduleSnapshot,
    processingStages: parseProcessingStages(value.processing_stages),
    serverCreatedAtMs,
    serverUpdatedAtMs,
  };
}

function revisionFrom(value: unknown, response: Response): number | null {
  if (isRecord(value)) {
    const direct = value.revision;
    if (Number.isSafeInteger(direct) && Number(direct) >= 1) return Number(direct);
    if (isRecord(value.current) && Number.isSafeInteger(value.current.revision)) {
      return Number(value.current.revision);
    }
  }
  const raw = response.headers?.get?.('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function conflictPayload(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'current')
    ? value.current
    : value;
}

function conflictCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string') return null;
  const normalized = value.error.code.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export class MeetingNoteConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('会议记录云端版本已变化', status);
    this.name = 'MeetingNoteConflictResponseError';
  }
}

export class MeetingNoteResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingNoteResponseContractError';
  }
}

async function readMeetingResponse(
  response: Response,
  accessToken: string,
  expected: { remoteId?: string; clientNoteId?: string },
): Promise<RemoteMeetingNoteV2> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new MeetingNoteConflictResponseError(
      response.status,
      revisionFrom(data, response),
      conflictPayload(data),
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('会议记录同步失败', response, {
      unauthorizedToken: accessToken,
    });
  }
  try {
    return parseMeetingNoteV2(await readResponseData(response), expected);
  } catch (error) {
    throw new MeetingNoteResponseContractError(
      error instanceof Error ? error.message : '会议记录同步响应格式无效',
    );
  }
}

export async function createMeetingNoteV2(input: {
  accessToken: string;
  idempotencyKey: string;
  request: CreateMeetingNoteV2Request;
  signal?: AbortSignal;
}): Promise<RemoteMeetingNoteV2> {
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(`${base}/api/laoji/v2/meeting-notes`, {
    method: 'POST',
    signal: input.signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': identifier(input.idempotencyKey, '请求标识'),
    },
    body: JSON.stringify(input.request),
  });
  return readMeetingResponse(response, input.accessToken, {
    clientNoteId: input.request.client_note_id,
  });
}

export async function getMeetingNoteV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingNoteV2> {
  const remoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(remoteId)}`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  return readMeetingResponse(response, input.accessToken, { remoteId });
}

export async function updateMeetingNoteV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  expectedRevision: number;
  idempotencyKey: string;
  request: UpdateMeetingNoteV2Request;
  signal?: AbortSignal;
}): Promise<RemoteMeetingNoteV2> {
  const remoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const expectedRevision = safeInteger(input.expectedRevision, '会议云端版本', 1);
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(remoteId)}`,
    {
      method: 'PATCH',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '请求标识'),
        'If-Match': `"${expectedRevision}"`,
      },
      body: JSON.stringify(input.request),
    },
  );
  return readMeetingResponse(response, input.accessToken, { remoteId });
}

export async function deleteMeetingNoteV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  expectedRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingNoteV2> {
  const remoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const expectedRevision = safeInteger(input.expectedRevision, '会议云端版本', 1);
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(remoteId)}`,
    {
      method: 'DELETE',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '请求标识'),
        'If-Match': `"${expectedRevision}"`,
      },
    },
  );
  return readMeetingResponse(response, input.accessToken, { remoteId });
}
