import type {
  MeetingContentShareKey,
  MeetingContentShareSnapshot,
  SharedMeetingContent,
} from '../../../domain/meeting';
import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';

const CONTENT_KEYS: readonly MeetingContentShareKey[] = [
  'info',
  'summary',
  'actions',
  'transcript',
  'markers',
  'attachments',
  'manualNote',
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function serverTime(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function contentKey(value: unknown): MeetingContentShareKey {
  if (typeof value !== 'string' || !CONTENT_KEYS.includes(value as MeetingContentShareKey)) {
    throw new Error('共享内容范围无效');
  }
  return value as MeetingContentShareKey;
}

function contentScope(value: unknown): MeetingContentShareKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONTENT_KEYS.length) {
    throw new Error('共享内容范围无效');
  }
  const result = value.map(contentKey);
  if (new Set(result).size !== result.length) throw new Error('共享内容范围重复');
  return result;
}

export interface RemoteMeetingContentShareReceipt {
  remoteId: string;
  clientShareId: string;
  revision: number;
  status: 'active' | 'revoked';
  contentScope: readonly MeetingContentShareKey[];
  followLatestSummary: boolean;
  sourceSummaryVersionId: string | null;
  inviteUrl: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

function ownerReceipt(value: unknown): RemoteMeetingContentShareReceipt {
  const data = record(value);
  if (!data || data.schema_version !== 1 || typeof data.follow_latest_summary !== 'boolean') {
    throw new Error('共享链接响应格式无效');
  }
  const status = data.status;
  if (status !== 'active' && status !== 'revoked') throw new Error('共享链接状态无效');
  const inviteUrl = status === 'active'
    ? identifier(data.invite_url, '共享链接', 2_048)
    : data.invite_url === null ? null : (() => { throw new Error('已撤销链接仍包含地址'); })();
  const scope = contentScope(data.content_scope);
  if (data.follow_latest_summary && !scope.includes('summary')) {
    throw new Error('共享链接最新整理设置无效');
  }
  return {
    remoteId: identifier(data.id, '共享云端标识', 160),
    clientShareId: identifier(data.client_share_id, '共享本机标识'),
    revision: integer(data.revision, '共享云端版本', 1),
    status,
    contentScope: scope,
    followLatestSummary: data.follow_latest_summary,
    sourceSummaryVersionId: nullableIdentifier(data.source_summary_version_id, '整理结果版本'),
    inviteUrl,
    createdAtMs: serverTime(data.created_at, '共享创建时间'),
    updatedAtMs: serverTime(data.updated_at, '共享更新时间'),
  };
}

function apiBase(): string {
  return getApiConfig().meetingApiBase.replace(/\/+$/, '');
}

function validToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) throw new Error('共享链接无效');
  return normalized;
}

export class MeetingContentShareConflictError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly code: string | null,
    public readonly current: unknown,
  ) {
    super('共享链接版本已变化', status);
    this.name = 'MeetingContentShareConflictError';
  }
}

async function throwConflict(response: Response): Promise<never> {
  const body = record(await readResponseData(response));
  const error = record(body?.error);
  throw new MeetingContentShareConflictError(
    response.status as 409 | 412,
    typeof error?.code === 'string' ? error.code.trim() || null : null,
    body?.current ?? null,
  );
}

export async function listMeetingContentSharesRemote(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<readonly RemoteMeetingContentShareReceipt[]> {
  const meetingId = encodeURIComponent(identifier(input.meetingRemoteId, '会议云端标识', 160));
  const response = await fetchWithTimeout(`${apiBase()}/api/laoji/v2/meeting-notes/${meetingId}/shares`, {
    signal: input.signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw await readResponseError('共享链接读取失败', response, { unauthorizedToken: input.accessToken });
  }
  const data = record(await readResponseData(response));
  if (!data || data.schema_version !== 1 || !Array.isArray(data.items) || data.items.length > 1_000) {
    throw new Error('共享链接列表格式无效');
  }
  return data.items.map(ownerReceipt);
}

export async function createMeetingContentShareRemote(input: {
  accessToken: string;
  meetingRemoteId: string;
  clientShareId: string;
  snapshot: MeetingContentShareSnapshot;
  followLatestSummary: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingContentShareReceipt> {
  const meetingId = encodeURIComponent(identifier(input.meetingRemoteId, '会议云端标识', 160));
  const response = await fetchWithTimeout(`${apiBase()}/api/laoji/v2/meeting-notes/${meetingId}/shares`, {
    method: 'POST',
    signal: input.signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': identifier(input.idempotencyKey, '共享请求标识'),
    },
    body: JSON.stringify({
      schema_version: 1,
      client_share_id: identifier(input.clientShareId, '共享本机标识'),
      content_scope: input.snapshot.sections.map(section => section.key),
      frozen_payload: input.snapshot,
      follow_latest_summary: input.followLatestSummary,
    }),
  });
  if (response.status === 409 || response.status === 412) return throwConflict(response);
  if (!response.ok) {
    throw await readResponseError('共享链接创建失败', response, { unauthorizedToken: input.accessToken });
  }
  return ownerReceipt(await readResponseData(response));
}

export async function revokeMeetingContentShareRemote(input: {
  accessToken: string;
  meetingRemoteId: string;
  clientShareId: string;
  expectedShareRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingContentShareReceipt> {
  const meetingId = encodeURIComponent(identifier(input.meetingRemoteId, '会议云端标识', 160));
  const shareId = encodeURIComponent(identifier(input.clientShareId, '共享本机标识'));
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/meeting-notes/${meetingId}/shares/${shareId}`,
    {
      method: 'DELETE',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '共享请求标识'),
        'If-Match': `"${integer(input.expectedShareRevision, '共享云端版本', 1)}"`,
      },
    },
  );
  if (response.status === 409 || response.status === 412) return throwConflict(response);
  if (!response.ok) {
    throw await readResponseError('共享链接撤销失败', response, { unauthorizedToken: input.accessToken });
  }
  return ownerReceipt(await readResponseData(response));
}

export async function fetchSharedMeetingContent(
  token: string,
  signal?: AbortSignal,
): Promise<SharedMeetingContent> {
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/shared-meetings/${encodeURIComponent(validToken(token))}`,
    { signal, headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw await readResponseError('共享会议资料加载失败', response);
  const data = record(await readResponseData(response));
  if (
    !data || data.schema_version !== 1 || data.status !== 'active'
    || typeof data.follow_latest_summary !== 'boolean' || !Array.isArray(data.sections)
  ) throw new Error('共享会议资料格式无效');
  const scope = contentScope(data.content_scope);
  const sections = data.sections.map(item => {
    const section = record(item);
    if (!section) throw new Error('共享会议资料内容无效');
    const key = contentKey(section.key);
    const title = identifier(section.title, '共享内容标题', 80);
    if (typeof section.content !== 'string' || !section.content.trim() || section.content.length > 200_000) {
      throw new Error('共享会议资料内容无效');
    }
    return { key, title, content: section.content };
  });
  if (
    sections.length !== scope.length
    || sections.some((section, index) => section.key !== scope[index])
  ) throw new Error('共享会议资料范围不一致');
  return {
    shareId: identifier(data.share_id, '共享标识', 160),
    shareRevision: integer(data.share_revision, '共享版本', 1),
    status: 'active',
    contentScope: scope,
    followLatestSummary: data.follow_latest_summary,
    summaryVersionId: nullableIdentifier(data.summary_version_id, '整理结果版本'),
    sections,
    createdAtMs: serverTime(data.created_at, '共享创建时间'),
    updatedAtMs: serverTime(data.updated_at, '共享更新时间'),
  };
}
