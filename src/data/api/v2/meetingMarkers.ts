import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type { MeetingMarkerV1Registration, RemoteMeetingMarkerV1 } from './contracts';

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

function nullableLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 500 || /\u0000/.test(value)) {
    throw new Error('标记名称无效');
  }
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

function nullableServerTime(value: unknown, label: string): number | null {
  return value === null ? null : serverTime(value, label);
}

export function parseRemoteMeetingMarkerV1(
  value: unknown,
  expected: { meetingRemoteId?: string; clientMarkerId?: string; remoteId?: string } = {},
): RemoteMeetingMarkerV1 {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error('标记同步响应格式无效');
  const remoteId = identifier(value.id, '标记云端标识', 160);
  const meetingRemoteId = identifier(value.meeting_id, '标记会议标识', 160);
  const clientMarkerId = identifier(value.client_marker_id, '标记本机标识');
  if (expected.remoteId && expected.remoteId !== remoteId) throw new Error('标记云端标识发生变化');
  if (expected.meetingRemoteId && expected.meetingRemoteId !== meetingRemoteId) {
    throw new Error('标记不属于当前会议');
  }
  if (expected.clientMarkerId && expected.clientMarkerId !== clientMarkerId) {
    throw new Error('标记本机标识发生变化');
  }
  const lifecycle = value.lifecycle;
  if (lifecycle !== 'active' && lifecycle !== 'deleted') throw new Error('标记云端状态无效');
  if (value.kind !== 'important') throw new Error('标记类型无效');
  const clientCreatedAtMs = safeInteger(value.client_created_at_ms, '标记本机创建时间');
  const clientUpdatedAtMs = safeInteger(value.client_updated_at_ms, '标记本机更新时间');
  if (clientUpdatedAtMs < clientCreatedAtMs) throw new Error('标记本机更新时间无效');
  const serverDeletedAtMs = nullableServerTime(value.deleted_at, '标记删除时间');
  if ((lifecycle === 'deleted') !== (serverDeletedAtMs !== null)) throw new Error('标记删除状态无效');
  return {
    remoteId,
    meetingRemoteId,
    clientMarkerId,
    revision: safeInteger(value.revision, '标记版本', 1),
    lifecycle,
    positionMs: safeInteger(value.position_ms, '标记时间点'),
    label: nullableLabel(value.label),
    kind: 'important',
    clientCreatedAtMs,
    clientUpdatedAtMs,
    serverCreatedAtMs: serverTime(value.created_at, '标记创建时间'),
    serverUpdatedAtMs: serverTime(value.updated_at, '标记更新时间'),
    serverDeletedAtMs,
  };
}

function responseRevision(value: unknown, response: Response): number | null {
  if (isRecord(value) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1) {
    return Number(value.revision);
  }
  if (isRecord(value) && isRecord(value.current) && Number.isSafeInteger(value.current.revision)) {
    return Number(value.current.revision);
  }
  const raw = response.headers?.get?.('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function conflictCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string') return null;
  const normalized = value.error.code.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export class MeetingMarkerConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('标记云端状态已变化', status);
    this.name = 'MeetingMarkerConflictResponseError';
  }
}

async function readMarkerResponse(
  response: Response,
  accessToken: string,
  expected: { meetingRemoteId?: string; clientMarkerId?: string; remoteId?: string },
): Promise<RemoteMeetingMarkerV1> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new MeetingMarkerConflictResponseError(
      response.status,
      responseRevision(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current') ? data.current : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('标记同步失败', response, { unauthorizedToken: accessToken });
  }
  return parseRemoteMeetingMarkerV1(await readResponseData(response), expected);
}

export async function registerMeetingMarkerV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  registration: MeetingMarkerV1Registration;
  signal?: AbortSignal;
}): Promise<RemoteMeetingMarkerV1> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/markers`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '标记请求标识'),
      },
      body: JSON.stringify(input.registration),
    },
  );
  return readMarkerResponse(response, input.accessToken, {
    meetingRemoteId,
    clientMarkerId: input.registration.client_marker_id,
  });
}

export async function deleteMeetingMarkerV1(input: {
  accessToken: string;
  remoteMarkerId: string;
  meetingRemoteId: string;
  clientMarkerId: string;
  expectedRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingMarkerV1> {
  const remoteMarkerId = identifier(input.remoteMarkerId, '标记云端标识', 160);
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-markers/${encodeURIComponent(remoteMarkerId)}`,
    {
      method: 'DELETE',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '标记删除请求标识'),
        'If-Match': `"${safeInteger(input.expectedRevision, '标记版本', 1)}"`,
      },
    },
  );
  return readMarkerResponse(response, input.accessToken, {
    remoteId: remoteMarkerId,
    meetingRemoteId: input.meetingRemoteId,
    clientMarkerId: input.clientMarkerId,
  });
}

export async function listMeetingMarkersV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<readonly RemoteMeetingMarkerV1[]> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/markers`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('标记列表同步失败', response, { unauthorizedToken: input.accessToken });
  }
  const data = await readResponseData(response);
  if (!isRecord(data) || data.schema_version !== 1 || !Array.isArray(data.items)) {
    throw new Error('标记列表同步响应格式无效');
  }
  if (identifier(data.meeting_id, '标记列表会议标识', 160) !== meetingRemoteId) {
    throw new Error('标记列表不属于当前会议');
  }
  const items = data.items.map(item => parseRemoteMeetingMarkerV1(item, { meetingRemoteId }));
  if (
    new Set(items.map(item => item.remoteId)).size !== items.length
    || new Set(items.map(item => item.clientMarkerId)).size !== items.length
  ) throw new Error('标记列表存在重复项目');
  return items;
}
