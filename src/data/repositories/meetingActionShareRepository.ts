import type {
  MeetingActionShare,
  MeetingActionShareOperation,
  MeetingActionSharePermission,
  MeetingActionShareStatus,
  ScopeKey,
} from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';

type ShareRow = {
  id: string;
  meeting_id: string;
  action_id: string;
  permission: MeetingActionSharePermission;
  status: MeetingActionShareStatus;
  remote_id: string | null;
  remote_revision: number | null;
  invite_url: string | null;
  expected_action_remote_revision: number | null;
  operation_id: string;
  pending_operation: MeetingActionShareOperation | null;
  attempt_count: number;
  last_error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

function identifier(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function time(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function revision(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}无效`);
  return value;
}

function fromRow(row: ShareRow): MeetingActionShare {
  if (
    !['viewer', 'action_editor'].includes(row.permission)
    || !['pending', 'active', 'failed_retryable', 'blocked', 'revoking', 'revoked'].includes(row.status)
    || (row.pending_operation !== null && !['create', 'revoke'].includes(row.pending_operation))
  ) throw new Error('待办共享记录已损坏');
  return {
    id: row.id,
    meetingId: row.meeting_id,
    actionId: row.action_id,
    permission: row.permission,
    status: row.status,
    remoteId: row.remote_id,
    remoteRevision: row.remote_revision,
    inviteUrl: row.invite_url,
    expectedActionRemoteRevision: row.expected_action_remote_revision,
    operationId: row.operation_id,
    pendingOperation: row.pending_operation,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

async function rowForShare(
  database: Awaited<ReturnType<typeof openMeetingDatabase>>,
  shareId: string,
  scopeKey: ScopeKey,
): Promise<ShareRow | null> {
  return database.getFirstAsync<ShareRow>(
    `SELECT share.* FROM meeting_action_shares share
     INNER JOIN meeting_notes meeting
       ON meeting.id = share.meeting_id AND meeting.scope_key = share.scope_key
     WHERE share.id = ? AND share.scope_key = ?`,
    shareId,
    scopeKey,
  );
}

export async function listMeetingActionShares(
  meetingId: string,
  actionId: string,
  scopeKey: ScopeKey,
): Promise<readonly MeetingActionShare[]> {
  assertScopeKey(scopeKey);
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<ShareRow>(
    `SELECT share.* FROM meeting_action_shares share
     INNER JOIN meeting_notes meeting
       ON meeting.id = share.meeting_id AND meeting.scope_key = share.scope_key
     WHERE share.meeting_id = ? AND share.action_id = ? AND share.scope_key = ?
     ORDER BY share.created_at_ms DESC, share.id DESC`,
    identifier(meetingId, '会议标识'),
    identifier(actionId, '待办标识'),
    scopeKey,
  );
  return rows.map(fromRow);
}

export async function insertPendingMeetingActionShare(input: {
  id: string;
  meetingId: string;
  actionId: string;
  scopeKey: ScopeKey;
  permission: MeetingActionSharePermission;
  expectedActionRemoteRevision: number | null;
  operationId: string;
  createdAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  if (!['viewer', 'action_editor'].includes(input.permission)) throw new Error('共享权限无效');
  const id = identifier(input.id, '共享标识');
  const meetingId = identifier(input.meetingId, '会议标识');
  const actionId = identifier(input.actionId, '待办标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const expectedActionRemoteRevision = revision(
    input.expectedActionRemoteRevision,
    '待办云端版本',
  );
  const createdAtMs = time(input.createdAtMs, '共享创建时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const action = await database.getFirstAsync<{ lifecycle: string }>(
      `SELECT meeting.lifecycle FROM action_items action
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       WHERE action.id = ? AND action.meeting_id = ? AND meeting.scope_key = ?`,
      actionId,
      meetingId,
      input.scopeKey,
    );
    if (!action || action.lifecycle === 'deleted') throw new Error('待办事项已不可用');
    await database.runAsync(
      `INSERT INTO meeting_action_shares (
         id, meeting_id, scope_key, action_id, permission, status,
         remote_id, remote_revision, invite_url, expected_action_remote_revision,
         operation_id, pending_operation, attempt_count, last_error_code,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, 'create', 0, NULL, ?, ?)`,
      id,
      meetingId,
      input.scopeKey,
      actionId,
      input.permission,
      expectedActionRemoteRevision,
      operationId,
      createdAtMs,
      createdAtMs,
    );
    return rowForShare(database, id, input.scopeKey);
  });
  if (!row) throw new Error('待办共享记录未能保存');
  return fromRow(row);
}

export async function markMeetingActionShareAttempt(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  status: 'pending' | 'revoking';
  updatedAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const expectedOperation = input.status === 'pending' ? 'create' : 'revoke';
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (!existing || existing.operation_id !== operationId) throw new Error('共享请求已发生变化');
    if (existing.pending_operation !== expectedOperation) throw new Error('共享请求状态无效');
    await database.runAsync(
      `UPDATE meeting_action_shares
       SET status = ?, attempt_count = attempt_count + 1, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      input.status,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
      operationId,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享请求未能更新');
  return fromRow(row);
}

export async function restartMeetingActionShareCreate(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  expectedActionRemoteRevision: number;
  updatedAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const expectedActionRemoteRevision = revision(
    input.expectedActionRemoteRevision,
    '待办云端版本',
  );
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (
      !existing
      || existing.pending_operation !== 'create'
      || !['failed_retryable', 'blocked'].includes(existing.status)
    ) throw new Error('共享创建请求已发生变化');
    await database.runAsync(
      `UPDATE meeting_action_shares
       SET status = 'pending', expected_action_remote_revision = ?, operation_id = ?,
           attempt_count = 0, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND pending_operation = 'create'`,
      expectedActionRemoteRevision,
      operationId,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享创建请求未能刷新');
  return fromRow(row);
}

export async function completeMeetingActionShareCreate(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  remoteId: string;
  remoteRevision: number;
  inviteUrl: string;
  updatedAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const remoteId = identifier(input.remoteId, '共享云端标识', 160);
  const remoteRevision = revision(input.remoteRevision, '共享云端版本');
  const inviteUrl = identifier(input.inviteUrl, '共享链接', 2_048);
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (!existing || existing.operation_id !== operationId || existing.pending_operation !== 'create') {
      throw new Error('共享请求已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_action_shares
       SET status = 'active', remote_id = ?, remote_revision = ?, invite_url = ?,
           pending_operation = NULL, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      remoteId,
      remoteRevision,
      inviteUrl,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
      operationId,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享链接未能保存');
  return fromRow(row);
}

export async function failMeetingActionShareOperation(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  disposition: 'failed_retryable' | 'blocked';
  errorCode: string;
  updatedAtMs: number;
}): Promise<MeetingActionShare | null> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const errorCode = identifier(input.errorCode, '共享错误', 120);
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (!existing || existing.operation_id !== operationId || existing.pending_operation === null) {
      return existing;
    }
    await database.runAsync(
      `UPDATE meeting_action_shares SET status = ?, last_error_code = ?, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      input.disposition,
      errorCode,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
      operationId,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  return row ? fromRow(row) : null;
}

export async function beginRevokeMeetingActionShare(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  updatedAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (!existing || existing.status !== 'active' || !existing.remote_id || !existing.remote_revision) {
      throw new Error('共享链接已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_action_shares
       SET status = 'revoking', operation_id = ?, pending_operation = 'revoke',
           attempt_count = 0, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND status = 'active'`,
      operationId,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享撤销请求未能保存');
  return fromRow(row);
}

export async function completeMeetingActionShareRevoke(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  remoteRevision: number;
  updatedAtMs: number;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  const shareId = identifier(input.shareId, '共享标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const remoteRevision = revision(input.remoteRevision, '共享云端版本');
  const updatedAtMs = time(input.updatedAtMs, '共享更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, shareId, input.scopeKey);
    if (!existing || existing.operation_id !== operationId || existing.pending_operation !== 'revoke') {
      throw new Error('共享撤销请求已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_action_shares
       SET status = 'revoked', remote_revision = ?, pending_operation = NULL,
           invite_url = NULL, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      remoteRevision,
      Math.max(existing.created_at_ms, updatedAtMs),
      shareId,
      input.scopeKey,
      operationId,
    );
    return rowForShare(database, shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享链接未能撤销');
  return fromRow(row);
}
