import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type { ManualNoteV2Mutation, RemoteManualNoteV2 } from './contracts';

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

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableTime(value: unknown, label: string): number | null {
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

export function parseRemoteManualNoteV2(
  value: unknown,
  expectedMeetingRemoteId: string,
): RemoteManualNoteV2 {
  if (!isRecord(value) || value.schema_version !== 2 || typeof value.exists !== 'boolean') {
    throw new Error('笔记同步响应格式无效');
  }
  const meetingRemoteId = identifier(value.meeting_id, '笔记会议标识', 160);
  if (meetingRemoteId !== expectedMeetingRemoteId) throw new Error('笔记不属于当前会议');
  if (typeof value.content !== 'string' || value.content.length > 200_000 || value.content.includes('\u0000')) {
    throw new Error('笔记内容无效');
  }
  const revision = safeInteger(value.revision, '笔记云端版本');
  const clientNoteRevision = safeInteger(value.client_note_revision, '笔记本机版本');
  const clientUpdatedAtMs = safeInteger(value.client_updated_at_ms, '笔记更新时间');
  const userEditedAtMs = nullableTime(value.user_edited_at_ms, '笔记编辑时间');
  if (userEditedAtMs !== null && userEditedAtMs > clientUpdatedAtMs) {
    throw new Error('笔记编辑时间晚于更新时间');
  }
  if (!value.exists) {
    if (
      value.id !== null
      || revision !== 0
      || clientNoteRevision !== 0
      || clientUpdatedAtMs !== 0
      || userEditedAtMs !== null
      || value.content !== ''
      || value.created_at !== null
      || value.updated_at !== null
    ) throw new Error('笔记缺失状态无效');
    return {
      exists: false,
      remoteId: null,
      meetingRemoteId,
      revision: 0,
      clientNoteRevision: 0,
      clientUpdatedAtMs: 0,
      userEditedAtMs: null,
      content: '',
      serverCreatedAtMs: null,
      serverUpdatedAtMs: null,
    };
  }
  const remoteId = identifier(value.id, '笔记云端标识', 160);
  if (revision < 1 || clientNoteRevision < 1) throw new Error('笔记版本无效');
  const serverCreatedAtMs = serverTime(value.created_at, '笔记云端创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '笔记云端更新时间');
  if (serverCreatedAtMs > serverUpdatedAtMs) throw new Error('笔记云端时间顺序无效');
  return {
    exists: true,
    remoteId,
    meetingRemoteId,
    revision,
    clientNoteRevision,
    clientUpdatedAtMs,
    userEditedAtMs,
    content: value.content.replace(/\r\n?/g, '\n'),
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

export class ManualNoteConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('笔记云端版本已变化', status);
    this.name = 'ManualNoteConflictResponseError';
  }
}

export async function getMeetingManualNoteV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<RemoteManualNoteV2> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/manual-note`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('笔记拉取失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  return parseRemoteManualNoteV2(await readResponseData(response), meetingRemoteId);
}

export async function upsertMeetingManualNoteV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  mutation: ManualNoteV2Mutation;
  signal?: AbortSignal;
}): Promise<RemoteManualNoteV2> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().laojiApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/manual-note`,
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
        schema_version: input.mutation.schema_version,
        client_note_revision: input.mutation.client_note_revision,
        client_updated_at_ms: input.mutation.client_updated_at_ms,
        user_edited_at_ms: input.mutation.user_edited_at_ms,
        content: input.mutation.content,
      }),
    },
  );
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new ManualNoteConflictResponseError(
      response.status,
      revisionFrom(data, response),
      conflictPayload(data),
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('笔记同步失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const note = parseRemoteManualNoteV2(await readResponseData(response), meetingRemoteId);
  if (!note.exists) throw new Error('笔记同步响应缺少云端版本');
  return note;
}
