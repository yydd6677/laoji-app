import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  MeetingActionSharePermission,
  SharedMeetingAction,
} from '../../../domain/meeting';

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

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return value.trim() || null;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string, minimum = 0): number | null {
  return value === null ? null : integer(value, label, minimum);
}

function permission(value: unknown): MeetingActionSharePermission {
  if (value !== 'viewer' && value !== 'action_editor') throw new Error('共享权限无效');
  return value;
}

function validToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) throw new Error('共享链接无效');
  return normalized;
}

function apiBase(): string {
  return getApiConfig().apiBase.replace(/\/+$/, '');
}

export interface MeetingActionShareRemoteReceipt {
  remoteId: string;
  clientShareId: string;
  revision: number;
  permission: MeetingActionSharePermission;
  status: 'active' | 'revoked';
  actionRevision: number;
  inviteUrl: string | null;
}

function shareReceipt(value: unknown, expectedClientShareId: string): MeetingActionShareRemoteReceipt {
  const data = record(value);
  if (!data || data.schema_version !== 1) throw new Error('共享响应格式无效');
  const clientShareId = identifier(data.client_share_id, '共享本机标识');
  if (clientShareId !== expectedClientShareId) throw new Error('共享响应标识不一致');
  const status = data.status;
  if (status !== 'active' && status !== 'revoked') throw new Error('共享响应状态无效');
  const inviteUrl = status === 'active'
    ? identifier(data.invite_url, '共享链接', 2_048)
    : data.invite_url === null ? null : (() => { throw new Error('已撤销共享仍包含链接'); })();
  return {
    remoteId: identifier(data.id, '共享云端标识', 160),
    clientShareId,
    revision: integer(data.revision, '共享云端版本', 1),
    permission: permission(data.permission),
    status,
    actionRevision: integer(data.action_revision, '待办云端版本', 1),
    inviteUrl,
  };
}

export class MeetingActionShareConflictError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly code: string | null,
    public readonly current: unknown,
  ) {
    super('共享版本已发生变化', status);
    this.name = 'MeetingActionShareConflictError';
  }
}

async function throwConflict(response: Response): Promise<never> {
  const data = await readResponseData(response);
  const body = record(data);
  const error = record(body?.error);
  throw new MeetingActionShareConflictError(
    response.status as 409 | 412,
    typeof error?.code === 'string' ? error.code.trim() || null : null,
    body?.current ?? null,
  );
}

export async function createMeetingActionShareRemote(input: {
  accessToken: string;
  meetingRemoteId: string;
  clientActionId: string;
  clientShareId: string;
  permission: MeetingActionSharePermission;
  expectedActionRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<MeetingActionShareRemoteReceipt> {
  const meetingId = encodeURIComponent(identifier(input.meetingRemoteId, '会议云端标识', 160));
  const actionId = encodeURIComponent(identifier(input.clientActionId, '待办标识'));
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/meeting-notes/${meetingId}/action-items/${actionId}/shares`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '共享请求标识'),
        'If-Match': `"${integer(input.expectedActionRevision, '待办云端版本', 1)}"`,
      },
      body: JSON.stringify({
        schema_version: 1,
        client_share_id: identifier(input.clientShareId, '共享本机标识'),
        permission: input.permission,
      }),
    },
  );
  if (response.status === 409 || response.status === 412) return throwConflict(response);
  if (!response.ok) {
    throw await readResponseError('待办共享失败', response, { unauthorizedToken: input.accessToken });
  }
  return shareReceipt(await readResponseData(response), input.clientShareId);
}

export async function revokeMeetingActionShareRemote(input: {
  accessToken: string;
  meetingRemoteId: string;
  clientActionId: string;
  clientShareId: string;
  expectedShareRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<MeetingActionShareRemoteReceipt> {
  const meetingId = encodeURIComponent(identifier(input.meetingRemoteId, '会议云端标识', 160));
  const actionId = encodeURIComponent(identifier(input.clientActionId, '待办标识'));
  const shareId = encodeURIComponent(identifier(input.clientShareId, '共享本机标识'));
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/meeting-notes/${meetingId}/action-items/${actionId}/shares/${shareId}`,
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
    throw await readResponseError('撤销共享失败', response, { unauthorizedToken: input.accessToken });
  }
  return shareReceipt(await readResponseData(response), input.clientShareId);
}

function sharedAction(value: unknown): SharedMeetingAction {
  const data = record(value);
  const action = record(data?.action);
  if (!data || data.schema_version !== 1 || !action) throw new Error('共享待办响应格式无效');
  const status = data.status;
  if (status !== 'active' && status !== 'revoked') throw new Error('共享待办状态无效');
  const actionStatus = action.status;
  if (actionStatus !== 'pending' && actionStatus !== 'completed' && actionStatus !== 'dismissed') {
    throw new Error('共享待办事项状态无效');
  }
  const content = identifier(action.content, '共享待办事项内容', 20_000);
  return {
    shareId: identifier(data.share_id, '共享标识', 160),
    shareRevision: integer(data.share_revision, '共享版本', 1),
    permission: permission(data.permission),
    status,
    action: {
      id: identifier(action.id, '待办标识', 160),
      revision: integer(action.revision, '待办版本', 1),
      content,
      status: actionStatus,
      assignee: nullableText(action.assignee, '负责人', 500),
      dueAtMs: nullableInteger(action.due_at_ms, '截止时间'),
      updatedAtMs: integer(action.updated_at_ms, '待办更新时间'),
      actorLabel: nullableText(action.actor_label, '修改人', 120) ?? '共享者',
    },
  };
}

export async function fetchSharedMeetingAction(
  token: string,
  signal?: AbortSignal,
): Promise<SharedMeetingAction> {
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/shared-actions/${encodeURIComponent(validToken(token))}`,
    { signal, headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw await readResponseError('共享待办加载失败', response);
  return sharedAction(await readResponseData(response));
}

export async function updateSharedMeetingAction(input: {
  token: string;
  expectedActionRevision: number;
  idempotencyKey: string;
  actorId: string;
  status: SharedMeetingAction['action']['status'];
  assignee: string | null;
  dueAtMs: number | null;
  signal?: AbortSignal;
}): Promise<SharedMeetingAction> {
  const response = await fetchWithTimeout(
    `${apiBase()}/api/laoji/v2/shared-actions/${encodeURIComponent(validToken(input.token))}`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '协作请求标识'),
        'If-Match': `"${integer(input.expectedActionRevision, '待办版本', 1)}"`,
      },
      body: JSON.stringify({
        schema_version: 1,
        actor_id: identifier(input.actorId, '协作者标识', 160),
        status: input.status,
        assignee: input.assignee?.trim() || null,
        due_at_ms: input.dueAtMs,
      }),
    },
  );
  if (response.status === 409 || response.status === 412) return throwConflict(response);
  if (!response.ok) throw await readResponseError('共享待办更新失败', response);
  return sharedAction(await readResponseData(response));
}
