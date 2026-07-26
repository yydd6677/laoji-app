import type {
  MeetingContentShare,
  MeetingContentShareKey,
  MeetingContentShareSnapshot,
  MeetingContentShareStatus,
  ScopeKey,
} from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import type { RemoteMeetingContentShareReceipt } from '../api/v2';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';

const CONTENT_KEYS: readonly MeetingContentShareKey[] = [
  'info',
  'summary',
  'actions',
  'transcript',
  'markers',
  'attachments',
  'manualNote',
];
const MAXIMUM_SNAPSHOT_BYTES = 1_000_000;

type ShareRow = {
  id: string;
  meeting_id: string;
  content_scope_json: string;
  frozen_payload_json: string | null;
  follow_latest_summary: number;
  source_summary_version_id: string | null;
  status: MeetingContentShareStatus;
  remote_id: string | null;
  remote_revision: number | null;
  invite_url: string | null;
  operation_id: string | null;
  pending_operation: 'create' | 'revoke' | null;
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

function parseScope(value: string): MeetingContentShareKey[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > CONTENT_KEYS.length) {
    throw new Error('共享内容范围已损坏');
  }
  const result = parsed.map(item => {
    if (typeof item !== 'string' || !CONTENT_KEYS.includes(item as MeetingContentShareKey)) {
      throw new Error('共享内容范围已损坏');
    }
    return item as MeetingContentShareKey;
  });
  if (new Set(result).size !== result.length) throw new Error('共享内容范围已损坏');
  return result;
}

function parseSnapshot(value: string | null): MeetingContentShareSnapshot | null {
  if (value === null) return null;
  if (value.length > MAXIMUM_SNAPSHOT_BYTES) throw new Error('共享冻结内容已损坏');
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('共享冻结内容已损坏');
  }
  const snapshot = parsed as Record<string, unknown>;
  if (snapshot.schema_version !== 1 || !Array.isArray(snapshot.sections)) {
    throw new Error('共享冻结内容已损坏');
  }
  const sections = snapshot.sections.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('共享冻结内容已损坏');
    }
    const section = item as Record<string, unknown>;
    if (
      typeof section.key !== 'string'
      || !CONTENT_KEYS.includes(section.key as MeetingContentShareKey)
      || typeof section.title !== 'string'
      || typeof section.content !== 'string'
      || !section.title.trim()
      || !section.content.trim()
    ) throw new Error('共享冻结内容已损坏');
    return {
      key: section.key as MeetingContentShareKey,
      title: section.title,
      content: section.content,
    };
  });
  if (new Set(sections.map(item => item.key)).size !== sections.length) {
    throw new Error('共享冻结内容已损坏');
  }
  const sourceVersion = snapshot.source_summary_version_id;
  if (sourceVersion !== null && typeof sourceVersion !== 'string') {
    throw new Error('共享冻结内容已损坏');
  }
  return {
    schema_version: 1,
    sections,
    source_summary_version_id: sourceVersion as string | null,
  };
}

function snapshotJson(value: MeetingContentShareSnapshot): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAXIMUM_SNAPSHOT_BYTES) throw new Error('共享内容过大');
  const parsed = parseSnapshot(serialized);
  if (!parsed || parsed.sections.length !== value.sections.length) throw new Error('共享内容无效');
  return serialized;
}

function fromRow(row: ShareRow): MeetingContentShare {
  if (
    !['pending', 'active', 'failed_retryable', 'blocked', 'revoking', 'revoked'].includes(row.status)
    || (row.pending_operation !== null && !['create', 'revoke'].includes(row.pending_operation))
    || ![0, 1].includes(row.follow_latest_summary)
  ) throw new Error('会议共享记录已损坏');
  const contentScope = parseScope(row.content_scope_json);
  const snapshot = parseSnapshot(row.frozen_payload_json);
  if (
    snapshot
    && (
      snapshot.sections.length !== contentScope.length
      || snapshot.sections.some((section, index) => section.key !== contentScope[index])
    )
  ) {
    throw new Error('会议共享范围与冻结内容不一致');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    contentScope,
    snapshot,
    followLatestSummary: row.follow_latest_summary === 1,
    sourceSummaryVersionId: row.source_summary_version_id,
    status: row.status,
    remoteId: row.remote_id,
    remoteRevision: row.remote_revision,
    inviteUrl: row.invite_url,
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
    `SELECT share.* FROM meeting_content_shares share
     INNER JOIN meeting_notes meeting
       ON meeting.id = share.meeting_id AND meeting.scope_key = share.scope_key
     WHERE share.id = ? AND share.scope_key = ?`,
    shareId,
    scopeKey,
  );
}

export async function listMeetingContentShares(
  meetingId: string,
  scopeKey: ScopeKey,
): Promise<readonly MeetingContentShare[]> {
  assertScopeKey(scopeKey);
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<ShareRow>(
    `SELECT share.* FROM meeting_content_shares share
     INNER JOIN meeting_notes meeting
       ON meeting.id = share.meeting_id AND meeting.scope_key = share.scope_key
     WHERE share.meeting_id = ? AND share.scope_key = ?
     ORDER BY share.created_at_ms DESC, share.id DESC`,
    identifier(meetingId, '会议标识'),
    scopeKey,
  );
  return rows.map(fromRow);
}

export async function insertPendingMeetingContentShare(input: {
  id: string;
  meetingId: string;
  scopeKey: ScopeKey;
  snapshot: MeetingContentShareSnapshot;
  followLatestSummary: boolean;
  operationId: string;
  createdAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const id = identifier(input.id, '共享标识');
  const meetingId = identifier(input.meetingId, '会议标识');
  const operationId = identifier(input.operationId, '共享请求标识');
  const createdAtMs = time(input.createdAtMs, '共享创建时间');
  const frozenJson = snapshotJson(input.snapshot);
  const contentScope = input.snapshot.sections.map(section => section.key);
  if (input.followLatestSummary && !contentScope.includes('summary')) {
    throw new Error('最新整理结果链接必须包含整理结果');
  }
  const row = await withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{ lifecycle: string }>(
      'SELECT lifecycle FROM meeting_notes WHERE id = ? AND scope_key = ?',
      meetingId,
      input.scopeKey,
    );
    if (!meeting || meeting.lifecycle === 'deleted') throw new Error('会议记录已不可用');
    await database.runAsync(
      `INSERT INTO meeting_content_shares (
         id, meeting_id, scope_key, content_scope_json, frozen_payload_json,
         follow_latest_summary, source_summary_version_id, status,
         remote_id, remote_revision, invite_url, operation_id, pending_operation,
         attempt_count, last_error_code, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, 'create', 0, NULL, ?, ?)`,
      id,
      meetingId,
      input.scopeKey,
      JSON.stringify(contentScope),
      frozenJson,
      input.followLatestSummary ? 1 : 0,
      input.snapshot.source_summary_version_id,
      operationId,
      createdAtMs,
      createdAtMs,
    );
    return rowForShare(database, id, input.scopeKey);
  });
  if (!row) throw new Error('共享链接未能保存');
  return fromRow(row);
}

export async function markMeetingContentShareAttempt(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  status: 'pending' | 'revoking';
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const expectedOperation = input.status === 'pending' ? 'create' : 'revoke';
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, identifier(input.shareId, '共享标识'), input.scopeKey);
    if (!existing || existing.operation_id !== input.operationId || existing.pending_operation !== expectedOperation) {
      throw new Error('共享请求已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_content_shares
       SET status = ?, attempt_count = attempt_count + 1,
         last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      input.status,
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      existing.id,
      input.scopeKey,
      identifier(input.operationId, '共享请求标识'),
    );
    return rowForShare(database, existing.id, input.scopeKey);
  });
  if (!row) throw new Error('共享请求未能更新');
  return fromRow(row);
}

export async function completeMeetingContentShareCreate(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  remote: RemoteMeetingContentShareReceipt;
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, input.shareId, input.scopeKey);
    if (
      !existing || existing.operation_id !== input.operationId
      || existing.pending_operation !== 'create' || input.remote.clientShareId !== input.shareId
    ) throw new Error('共享创建请求已发生变化');
    await database.runAsync(
      `UPDATE meeting_content_shares SET status = 'active', remote_id = ?, remote_revision = ?,
         invite_url = ?, operation_id = NULL, pending_operation = NULL,
         last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      input.remote.remoteId,
      revision(input.remote.revision, '共享云端版本'),
      identifier(input.remote.inviteUrl ?? '', '共享链接', 2_048),
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      input.shareId,
      input.scopeKey,
      input.operationId,
    );
    return rowForShare(database, input.shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享链接未能确认');
  return fromRow(row);
}

export async function failMeetingContentShareOperation(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  disposition: 'failed_retryable' | 'blocked';
  errorCode: string;
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, input.shareId, input.scopeKey);
    if (!existing || existing.operation_id !== input.operationId || !existing.pending_operation) {
      throw new Error('共享请求已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_content_shares SET status = ?, last_error_code = ?, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      input.disposition,
      identifier(input.errorCode, '共享错误码', 160),
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      input.shareId,
      input.scopeKey,
      input.operationId,
    );
    return rowForShare(database, input.shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享失败状态未能保存');
  return fromRow(row);
}

export async function restartMeetingContentShareCreate(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, input.shareId, input.scopeKey);
    if (!existing || existing.pending_operation !== 'create' || !existing.frozen_payload_json) {
      throw new Error('这条共享记录不能重试');
    }
    await database.runAsync(
      `UPDATE meeting_content_shares SET status = 'pending', operation_id = ?,
         attempt_count = 0, last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ?`,
      identifier(input.operationId, '共享请求标识'),
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      input.shareId,
      input.scopeKey,
    );
    return rowForShare(database, input.shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享重试请求未能保存');
  return fromRow(row);
}

export async function beginRevokeMeetingContentShare(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, input.shareId, input.scopeKey);
    if (!existing || existing.status !== 'active' || !existing.remote_id || !existing.remote_revision) {
      throw new Error('共享链接已发生变化，请重新打开');
    }
    await database.runAsync(
      `UPDATE meeting_content_shares SET status = 'revoking', operation_id = ?,
         pending_operation = 'revoke', attempt_count = 0, last_error_code = NULL,
         updated_at_ms = ? WHERE id = ? AND scope_key = ?`,
      identifier(input.operationId, '共享请求标识'),
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      input.shareId,
      input.scopeKey,
    );
    return rowForShare(database, input.shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享撤销请求未能保存');
  return fromRow(row);
}

export async function completeMeetingContentShareRevoke(input: {
  shareId: string;
  scopeKey: ScopeKey;
  operationId: string;
  remoteRevision: number;
  updatedAtMs: number;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForShare(database, input.shareId, input.scopeKey);
    if (!existing || existing.operation_id !== input.operationId || existing.pending_operation !== 'revoke') {
      throw new Error('共享撤销请求已发生变化');
    }
    await database.runAsync(
      `UPDATE meeting_content_shares SET status = 'revoked', remote_revision = ?,
         invite_url = NULL, operation_id = NULL, pending_operation = NULL,
         last_error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND scope_key = ? AND operation_id = ?`,
      revision(input.remoteRevision, '共享云端版本'),
      Math.max(existing.created_at_ms, time(input.updatedAtMs, '共享更新时间')),
      input.shareId,
      input.scopeKey,
      input.operationId,
    );
    return rowForShare(database, input.shareId, input.scopeKey);
  });
  if (!row) throw new Error('共享链接未能撤销');
  return fromRow(row);
}

export async function mergeRemoteMeetingContentShares(input: {
  meetingId: string;
  scopeKey: ScopeKey;
  remote: readonly RemoteMeetingContentShareReceipt[];
  mergedAtMs: number;
}): Promise<readonly MeetingContentShare[]> {
  assertScopeKey(input.scopeKey);
  const meetingId = identifier(input.meetingId, '会议标识');
  const mergedAtMs = time(input.mergedAtMs, '共享同步时间');
  return withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{ present: number }>(
      'SELECT 1 AS present FROM meeting_notes WHERE id = ? AND scope_key = ?',
      meetingId,
      input.scopeKey,
    );
    if (!meeting) throw new Error('会议记录已不可用');
    for (const remote of input.remote) {
      const existing = await rowForShare(database, remote.clientShareId, input.scopeKey);
      if (
        existing?.pending_operation === 'revoke'
        && existing.status !== 'blocked'
        && remote.status === 'active'
      ) continue;
      if (!existing) {
        await database.runAsync(
          `INSERT INTO meeting_content_shares (
             id, meeting_id, scope_key, content_scope_json, frozen_payload_json,
             follow_latest_summary, source_summary_version_id, status,
             remote_id, remote_revision, invite_url, operation_id, pending_operation,
             attempt_count, last_error_code, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)`,
          remote.clientShareId,
          meetingId,
          input.scopeKey,
          JSON.stringify(remote.contentScope),
          remote.followLatestSummary ? 1 : 0,
          remote.sourceSummaryVersionId,
          remote.status,
          remote.remoteId,
          remote.revision,
          remote.inviteUrl,
          remote.createdAtMs,
          Math.max(remote.createdAtMs, remote.updatedAtMs, mergedAtMs),
        );
        continue;
      }
      await database.runAsync(
        `UPDATE meeting_content_shares SET content_scope_json = ?,
           follow_latest_summary = ?, source_summary_version_id = ?, status = ?,
           remote_id = ?, remote_revision = ?, invite_url = ?, operation_id = NULL,
           pending_operation = NULL, last_error_code = NULL, updated_at_ms = ?
         WHERE id = ? AND scope_key = ?`,
        JSON.stringify(remote.contentScope),
        remote.followLatestSummary ? 1 : 0,
        remote.sourceSummaryVersionId,
        remote.status,
        remote.remoteId,
        remote.revision,
        remote.inviteUrl,
        Math.max(existing.created_at_ms, remote.updatedAtMs, mergedAtMs),
        remote.clientShareId,
        input.scopeKey,
      );
    }
    const rows = await database.getAllAsync<ShareRow>(
      `SELECT * FROM meeting_content_shares WHERE meeting_id = ? AND scope_key = ?
       ORDER BY created_at_ms DESC, id DESC`,
      meetingId,
      input.scopeKey,
    );
    return rows.map(fromRow);
  });
}
