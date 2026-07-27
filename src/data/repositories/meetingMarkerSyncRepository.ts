import type { SQLiteDatabase } from 'expo-sqlite';
import type { RemoteMeetingMarkerV1 } from '../api/v2';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';
import { assertScopeKey, secureClientIdFactory, type ScopeKey } from '../../domain/meeting';
import { refreshMeetingSyncState } from './sqliteMeetingNoteRepository';

const AGGREGATE_TYPE = 'meeting_marker';
const CREATE_OPERATION = 'meeting_marker.create';
const DELETE_OPERATION = 'meeting_marker.delete';

type AccountScopeKey = Exclude<ScopeKey, 'guest'>;
type MarkerOperation = 'create' | 'delete';

type MarkerStateRow = {
  scope_key: string;
  marker_id: string;
  meeting_id: string;
  remote_id: string | null;
  remote_revision: number | null;
  lifecycle: 'active' | 'deleted';
  position_ms: number;
  label: string | null;
  kind: 'important';
  client_created_at_ms: number;
  client_updated_at_ms: number;
  sync_state: 'local' | 'pending' | 'synced' | 'failed_retryable' | 'blocked';
  pending_operation: MarkerOperation | null;
  last_error_code: string | null;
  remote_updated_at_ms: number | null;
  deleted_at_ms: number | null;
};

type MarkerOutboxRow = {
  operation_id: string;
  scope_key: string;
  aggregate_id: string;
  operation_type: string;
  base_revision: number | null;
  payload_json: string;
  request_payload_json: string | null;
  status: string;
  attempt_count: number;
  next_attempt_at_ms: number | null;
  claim_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  meeting_id: string;
  meeting_remote_id: string | null;
  remote_id: string | null;
  remote_revision: number | null;
  lifecycle: MarkerStateRow['lifecycle'];
  pending_operation: MarkerOperation | null;
};

export interface MeetingMarkerSyncClaim {
  scopeKey: AccountScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  markerId: string;
  operationId: string;
  operationType: typeof CREATE_OPERATION | typeof DELETE_OPERATION;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface MeetingMarkerSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface MergeRemoteMeetingMarkerResult {
  outcome: 'inserted' | 'attached' | 'deleted' | 'pending_local' | 'unchanged';
}

function assertAccountScope(scopeKey: ScopeKey): asserts scopeKey is AccountScopeKey {
  assertScopeKey(scopeKey);
  if (scopeKey === 'guest') throw new Error('游客标记不能同步');
}

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

function markerPayload(row: MarkerStateRow): string {
  return JSON.stringify({
    schema_version: 1,
    client_marker_id: row.marker_id,
    position_ms: row.position_ms,
    label: row.label,
    kind: row.kind,
    client_created_at_ms: row.client_created_at_ms,
    client_updated_at_ms: row.client_updated_at_ms,
  });
}

function deletePayload(row: MarkerStateRow): string {
  if (!row.remote_id || !row.remote_revision) throw new Error('标记云端身份尚未就绪');
  return JSON.stringify({
    schema_version: 1,
    client_marker_id: row.marker_id,
    remote_id: row.remote_id,
    expected_remote_revision: row.remote_revision,
  });
}

function remoteMatchesLocal(remote: RemoteMeetingMarkerV1, row: MarkerStateRow): boolean {
  return remote.clientMarkerId === row.marker_id
    && remote.positionMs === row.position_ms
    && remote.label === row.label
    && remote.kind === row.kind
    && remote.clientCreatedAtMs === row.client_created_at_ms
    && remote.clientUpdatedAtMs === row.client_updated_at_ms;
}

async function stateRow(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  markerId: string,
): Promise<MarkerStateRow | null> {
  return database.getFirstAsync<MarkerStateRow>(
    'SELECT * FROM meeting_marker_sync_state WHERE scope_key = ? AND marker_id = ?',
    scopeKey,
    markerId,
  );
}

async function insertOperation(
  database: SQLiteDatabase,
  scopeKey: AccountScopeKey,
  row: MarkerStateRow,
  operation: MarkerOperation,
  createdAtMs: number,
): Promise<boolean> {
  const operationType = operation === 'create' ? CREATE_OPERATION : DELETE_OPERATION;
  const existing = await database.getFirstAsync<{ operation_id: string }>(
    `SELECT operation_id FROM sync_outbox
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND operation_type = ? AND status <> 'completed'
     LIMIT 1`,
    scopeKey,
    AGGREGATE_TYPE,
    row.marker_id,
    operationType,
  );
  if (existing) return false;
  const payload = operation === 'create' ? markerPayload(row) : deletePayload(row);
  await database.runAsync(
    `INSERT INTO sync_outbox (
       operation_id, scope_key, aggregate_type, aggregate_id,
       operation_type, base_revision, payload_json, status,
       attempt_count, next_attempt_at_ms, last_error_code,
       request_payload_json, claim_token, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
    secureClientIdFactory.create(),
    scopeKey,
    AGGREGATE_TYPE,
    row.marker_id,
    operationType,
    operation === 'delete' ? row.remote_revision : null,
    payload,
    createdAtMs,
    createdAtMs,
  );
  return true;
}

export async function ensureMeetingMarkerSyncOperations(
  scopeKey: ScopeKey,
  nowMs: number,
): Promise<number> {
  assertAccountScope(scopeKey);
  time(nowMs, '标记同步修复时间');
  return withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `DELETE FROM sync_outbox WHERE scope_key = ? AND aggregate_type = ?
       AND NOT EXISTS (
         SELECT 1 FROM meeting_marker_sync_state state
         WHERE state.scope_key = sync_outbox.scope_key
           AND state.marker_id = sync_outbox.aggregate_id
       )`,
      scopeKey,
      AGGREGATE_TYPE,
    );
    await database.runAsync(
      `INSERT OR IGNORE INTO meeting_marker_sync_state (
         scope_key, marker_id, meeting_id, remote_id, remote_revision,
         lifecycle, position_ms, label, kind,
         client_created_at_ms, client_updated_at_ms,
         sync_state, pending_operation, last_error_code,
         remote_updated_at_ms, deleted_at_ms
       )
       SELECT meeting.scope_key, marker.id, marker.meeting_id, NULL, NULL,
         'active', marker.position_ms, marker.label, marker.kind,
         marker.created_at_ms, marker.updated_at_ms,
         'pending', 'create', NULL, NULL, NULL
       FROM markers marker
       INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
       WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
      scopeKey,
    );
    await database.runAsync(
      `UPDATE meeting_marker_sync_state SET sync_state = 'pending',
         pending_operation = CASE
           WHEN remote_id IS NULL THEN 'create'
           WHEN lifecycle = 'deleted' THEN 'delete'
           ELSE pending_operation END,
         last_error_code = CASE WHEN sync_state = 'local' THEN NULL ELSE last_error_code END
       WHERE scope_key = ? AND (
         sync_state = 'local'
         OR (
           lifecycle = 'deleted'
           AND pending_operation IS NULL
           AND sync_state <> 'synced'
         )
       )`,
      scopeKey,
    );
    const rows = await database.getAllAsync<MarkerStateRow>(
      `SELECT state.* FROM meeting_marker_sync_state state
       INNER JOIN meeting_notes meeting
         ON meeting.id = state.meeting_id AND meeting.scope_key = state.scope_key
       WHERE state.scope_key = ? AND meeting.lifecycle <> 'deleted'
         AND state.sync_state <> 'blocked'
         AND (
           state.pending_operation IS NOT NULL
           OR (state.remote_id IS NULL AND state.lifecycle = 'active')
         )
       ORDER BY state.client_updated_at_ms, state.marker_id`,
      scopeKey,
    );
    let inserted = 0;
    const touched = new Set<string>();
    for (const row of rows) {
      const operation: MarkerOperation = row.remote_id && row.lifecycle === 'deleted'
        ? 'delete'
        : 'create';
      if (await insertOperation(database, scopeKey, row, operation, nowMs)) inserted += 1;
      touched.add(row.meeting_id);
    }
    for (const meetingId of touched) await refreshMeetingSyncState(database, meetingId, scopeKey);
    return inserted;
  });
}

function readyAt(row: MarkerOutboxRow, staleClaimAfterMs: number): number {
  if (row.status === 'pending') return 0;
  if (row.status === 'retry') return row.next_attempt_at_ms ?? 0;
  if (row.status === 'in_flight') {
    return Math.min(Number.MAX_SAFE_INTEGER, row.updated_at_ms + staleClaimAfterMs);
  }
  return Number.MAX_SAFE_INTEGER;
}

export async function claimMeetingMarkerSyncOperations(
  scopeKey: ScopeKey,
  options: { nowMs: number; staleClaimAfterMs: number; limit: number },
): Promise<readonly MeetingMarkerSyncClaim[]> {
  assertAccountScope(scopeKey);
  time(options.nowMs, '标记同步认领时间');
  time(options.staleClaimAfterMs, '标记同步失效间隔');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('标记同步批量大小无效');
  }
  return withMeetingDatabaseTransaction(async database => {
    const rows = await database.getAllAsync<MarkerOutboxRow>(
      `SELECT outbox.*, state.meeting_id, meeting.remote_id AS meeting_remote_id,
         state.remote_id, state.remote_revision, state.lifecycle, state.pending_operation
       FROM sync_outbox outbox
       INNER JOIN meeting_marker_sync_state state
         ON state.scope_key = outbox.scope_key AND state.marker_id = outbox.aggregate_id
       INNER JOIN meeting_notes meeting
         ON meeting.id = state.meeting_id AND meeting.scope_key = state.scope_key
       WHERE outbox.scope_key = ? AND outbox.aggregate_type = ?
         AND outbox.operation_type IN (?, ?)
         AND meeting.lifecycle <> 'deleted' AND meeting.remote_id IS NOT NULL
         AND outbox.status IN ('pending','retry','in_flight')
       ORDER BY outbox.created_at_ms, outbox.operation_id`,
      scopeKey,
      AGGREGATE_TYPE,
      CREATE_OPERATION,
      DELETE_OPERATION,
    );
    const byMarker = new Map<string, MarkerOutboxRow[]>();
    rows.forEach(row => {
      const bucket = byMarker.get(row.aggregate_id) ?? [];
      bucket.push(row);
      byMarker.set(row.aggregate_id, bucket);
    });
    const claims: MeetingMarkerSyncClaim[] = [];
    const touched = new Set<string>();
    for (const bucket of byMarker.values()) {
      if (claims.length >= options.limit) break;
      const row = bucket[0];
      const createValid = row.operation_type === CREATE_OPERATION
        && row.remote_id === null
        && row.pending_operation === 'create';
      const deleteValid = row.operation_type === DELETE_OPERATION
        && row.remote_id !== null
        && row.remote_revision !== null
        && row.lifecycle === 'deleted'
        && row.pending_operation === 'delete';
      if (!createValid && !deleteValid) {
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'completed', claim_token = NULL,
             next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
           WHERE operation_id = ? AND status <> 'completed'`,
          options.nowMs,
          row.operation_id,
        );
        touched.add(row.meeting_id);
        continue;
      }
      if (readyAt(row, options.staleClaimAfterMs) > options.nowMs) continue;
      const claimToken = secureClientIdFactory.create();
      const claimed = await database.runAsync(
        `UPDATE sync_outbox SET status = 'in_flight',
           request_payload_json = COALESCE(request_payload_json, payload_json),
           claim_token = ?, attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND status IN ('pending','retry','in_flight')`,
        claimToken,
        options.nowMs,
        row.operation_id,
      );
      if (claimed.changes !== 1) continue;
      const snapshot = row.request_payload_json ?? row.payload_json;
      claims.push({
        scopeKey,
        meetingId: row.meeting_id,
        meetingRemoteId: identifier(row.meeting_remote_id ?? '', '标记会议云端标识', 160),
        markerId: row.aggregate_id,
        operationId: row.operation_id,
        operationType: row.operation_type as MeetingMarkerSyncClaim['operationType'],
        claimToken,
        requestPayloadJson: snapshot,
        attemptCount: row.attempt_count + 1,
      });
      touched.add(row.meeting_id);
    }
    for (const meetingId of touched) await refreshMeetingSyncState(database, meetingId, scopeKey);
    return claims;
  });
}

export async function nextMeetingMarkerSyncAttemptAt(
  scopeKey: ScopeKey,
  staleClaimAfterMs: number,
): Promise<number | null> {
  assertAccountScope(scopeKey);
  time(staleClaimAfterMs, '标记同步失效间隔');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<MarkerOutboxRow>(
    `SELECT outbox.*, state.meeting_id, meeting.remote_id AS meeting_remote_id,
       state.remote_id, state.remote_revision, state.lifecycle, state.pending_operation
     FROM sync_outbox outbox
     INNER JOIN meeting_marker_sync_state state
       ON state.scope_key = outbox.scope_key AND state.marker_id = outbox.aggregate_id
     INNER JOIN meeting_notes meeting
       ON meeting.id = state.meeting_id AND meeting.scope_key = state.scope_key
     WHERE outbox.scope_key = ? AND outbox.aggregate_type = ?
       AND meeting.lifecycle <> 'deleted' AND meeting.remote_id IS NOT NULL
       AND outbox.status IN ('pending','retry','in_flight')`,
    scopeKey,
    AGGREGATE_TYPE,
  );
  const values = rows.map(row => readyAt(row, staleClaimAfterMs));
  return values.length > 0 ? Math.min(...values) : null;
}

export async function hasMeetingMarkerSyncWaitingForRoot(scopeKey: ScopeKey): Promise<boolean> {
  assertAccountScope(scopeKey);
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_outbox outbox
     INNER JOIN meeting_marker_sync_state state
       ON state.scope_key = outbox.scope_key AND state.marker_id = outbox.aggregate_id
     INNER JOIN meeting_notes meeting
       ON meeting.id = state.meeting_id AND meeting.scope_key = state.scope_key
     WHERE outbox.scope_key = ? AND outbox.aggregate_type = ?
       AND outbox.status <> 'completed' AND meeting.lifecycle <> 'deleted'
       AND meeting.remote_id IS NULL LIMIT 1`,
    scopeKey,
    AGGREGATE_TYPE,
  );
  return Boolean(row);
}

async function claimedOutbox(
  database: SQLiteDatabase,
  claim: MeetingMarkerSyncClaim,
): Promise<{ operation_id: string } | null> {
  return database.getFirstAsync<{ operation_id: string }>(
    `SELECT operation_id FROM sync_outbox
     WHERE operation_id = ? AND scope_key = ? AND aggregate_type = ?
       AND aggregate_id = ? AND operation_type = ?
       AND status = 'in_flight' AND claim_token = ?`,
    claim.operationId,
    claim.scopeKey,
    AGGREGATE_TYPE,
    claim.markerId,
    claim.operationType,
    claim.claimToken,
  );
}

export async function completeMeetingMarkerCreateClaim(
  claim: MeetingMarkerSyncClaim,
  remote: RemoteMeetingMarkerV1,
  completedAtMs: number,
): Promise<boolean> {
  time(completedAtMs, '标记同步完成时间');
  return withMeetingDatabaseTransaction(async database => {
    if (!await claimedOutbox(database, claim)) return false;
    const row = await stateRow(database, claim.scopeKey, claim.markerId);
    if (!row || remote.meetingRemoteId !== claim.meetingRemoteId
      || !remoteMatchesLocal(remote, row)) return false;
    await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', claim_token = NULL,
         next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND claim_token = ?`,
      completedAtMs,
      claim.operationId,
      claim.claimToken,
    );
    const alreadyDeleted = remote.lifecycle === 'deleted';
    if (alreadyDeleted && row.lifecycle !== 'deleted') return false;
    const deleting = row.lifecycle === 'deleted' && !alreadyDeleted;
    await database.runAsync(
      `UPDATE meeting_marker_sync_state SET remote_id = ?, remote_revision = ?,
         lifecycle = ?, sync_state = ?, pending_operation = ?, last_error_code = NULL,
         remote_updated_at_ms = ?, deleted_at_ms = ?
       WHERE scope_key = ? AND marker_id = ?`,
      remote.remoteId,
      remote.revision,
      row.lifecycle,
      deleting ? 'pending' : 'synced',
      deleting ? 'delete' : null,
      remote.serverUpdatedAtMs,
      row.lifecycle === 'deleted'
        ? row.deleted_at_ms ?? remote.serverDeletedAtMs ?? completedAtMs
        : null,
      claim.scopeKey,
      claim.markerId,
    );
    if (deleting) {
      const next = await stateRow(database, claim.scopeKey, claim.markerId);
      if (next) await insertOperation(database, claim.scopeKey, next, 'delete', completedAtMs);
    }
    await refreshMeetingSyncState(database, row.meeting_id, claim.scopeKey);
    return true;
  });
}

export async function completeMeetingMarkerDeleteClaim(
  claim: MeetingMarkerSyncClaim,
  remote: RemoteMeetingMarkerV1,
  completedAtMs: number,
): Promise<boolean> {
  time(completedAtMs, '标记删除同步完成时间');
  return withMeetingDatabaseTransaction(async database => {
    if (!await claimedOutbox(database, claim)) return false;
    const row = await stateRow(database, claim.scopeKey, claim.markerId);
    if (!row || remote.lifecycle !== 'deleted'
      || remote.meetingRemoteId !== claim.meetingRemoteId
      || remote.clientMarkerId !== claim.markerId
      || (row.remote_id !== null && row.remote_id !== remote.remoteId)) return false;
    await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', claim_token = NULL,
         next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND claim_token = ?`,
      completedAtMs,
      claim.operationId,
      claim.claimToken,
    );
    await database.runAsync(
      `UPDATE meeting_marker_sync_state SET remote_id = ?, remote_revision = ?,
         lifecycle = 'deleted', sync_state = 'synced', pending_operation = NULL,
         last_error_code = NULL, remote_updated_at_ms = ?,
         deleted_at_ms = COALESCE(deleted_at_ms, ?)
       WHERE scope_key = ? AND marker_id = ?`,
      remote.remoteId,
      remote.revision,
      remote.serverUpdatedAtMs,
      remote.serverDeletedAtMs ?? completedAtMs,
      claim.scopeKey,
      claim.markerId,
    );
    await database.runAsync('DELETE FROM markers WHERE id = ? AND meeting_id = ?', claim.markerId, row.meeting_id);
    await refreshMeetingSyncState(database, row.meeting_id, claim.scopeKey);
    return true;
  });
}

export async function failMeetingMarkerSyncClaim(
  claim: MeetingMarkerSyncClaim,
  failure: MeetingMarkerSyncFailure,
): Promise<boolean> {
  identifier(failure.errorCode, '标记同步错误码', 160);
  time(failure.updatedAtMs, '标记同步失败时间');
  if (failure.nextAttemptAtMs !== null) time(failure.nextAttemptAtMs, '标记同步重试时间');
  const status = failure.disposition === 'retry'
    ? 'retry'
    : failure.disposition === 'blocked'
      ? 'blocked'
      : 'permanent_error';
  return withMeetingDatabaseTransaction(async database => {
    if (!await claimedOutbox(database, claim)) return false;
    const row = await stateRow(database, claim.scopeKey, claim.markerId);
    if (!row) return false;
    const updated = await database.runAsync(
      `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?,
         last_error_code = ?, claim_token = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND claim_token = ? AND status = 'in_flight'`,
      status,
      failure.nextAttemptAtMs,
      failure.errorCode,
      failure.updatedAtMs,
      claim.operationId,
      claim.claimToken,
    );
    if (updated.changes !== 1) return false;
    await database.runAsync(
      `UPDATE meeting_marker_sync_state SET sync_state = ?, last_error_code = ?
       WHERE scope_key = ? AND marker_id = ?`,
      failure.disposition === 'retry' ? 'failed_retryable' : 'blocked',
      failure.errorCode,
      claim.scopeKey,
      claim.markerId,
    );
    await refreshMeetingSyncState(database, row.meeting_id, claim.scopeKey);
    return true;
  });
}

export async function mergeRemoteMeetingMarker(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  remote: RemoteMeetingMarkerV1;
  mergedAtMs: number;
}): Promise<MergeRemoteMeetingMarkerResult> {
  assertAccountScope(input.scopeKey);
  const scopeKey = input.scopeKey as AccountScopeKey;
  identifier(input.meetingId, '标记本机会议标识');
  identifier(input.meetingRemoteId, '标记云端会议标识', 160);
  time(input.mergedAtMs, '标记合并时间');
  if (input.remote.meetingRemoteId !== input.meetingRemoteId) {
    throw new Error('云端标记不属于当前会议');
  }
  return withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{ remote_id: string | null }>(
      `SELECT remote_id FROM meeting_notes
       WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
      input.meetingId,
      input.scopeKey,
    );
    if (!meeting || meeting.remote_id !== input.meetingRemoteId) {
      throw new Error('标记合并目标已变化');
    }
    const byClient = await stateRow(database, scopeKey, input.remote.clientMarkerId);
    const byRemote = await database.getFirstAsync<MarkerStateRow>(
      'SELECT * FROM meeting_marker_sync_state WHERE scope_key = ? AND remote_id = ?',
      input.scopeKey,
      input.remote.remoteId,
    );
    if (byClient && byRemote && byClient.marker_id !== byRemote.marker_id) {
      throw new Error('标记云端身份存在歧义');
    }
    const existing = byClient ?? byRemote;
    if (existing && existing.meeting_id !== input.meetingId) {
      throw new Error('标记云端身份属于其他会议');
    }
    if (existing?.remote_revision && input.remote.revision < existing.remote_revision) {
      return { outcome: 'unchanged' };
    }
    if (input.remote.lifecycle === 'deleted') {
      if (existing) {
        await database.runAsync('DELETE FROM markers WHERE id = ? AND meeting_id = ?', existing.marker_id, input.meetingId);
        await database.runAsync(
          `UPDATE meeting_marker_sync_state SET remote_id = ?, remote_revision = ?,
             lifecycle = 'deleted', sync_state = 'synced', pending_operation = NULL,
             last_error_code = NULL, remote_updated_at_ms = ?,
             deleted_at_ms = COALESCE(deleted_at_ms, ?)
           WHERE scope_key = ? AND marker_id = ?`,
          input.remote.remoteId,
          input.remote.revision,
          input.remote.serverUpdatedAtMs,
          input.remote.serverDeletedAtMs ?? input.mergedAtMs,
          input.scopeKey,
          existing.marker_id,
        );
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'completed', claim_token = NULL,
             next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
             AND status <> 'completed'`,
          input.mergedAtMs,
          input.scopeKey,
          AGGREGATE_TYPE,
          existing.marker_id,
        );
      } else {
        await database.runAsync(
          `INSERT INTO meeting_marker_sync_state (
             scope_key, marker_id, meeting_id, remote_id, remote_revision,
             lifecycle, position_ms, label, kind,
             client_created_at_ms, client_updated_at_ms,
             sync_state, pending_operation, last_error_code,
             remote_updated_at_ms, deleted_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'deleted', ?, ?, ?, ?, ?,
             'synced', NULL, NULL, ?, ?)`,
          input.scopeKey,
          input.remote.clientMarkerId,
          input.meetingId,
          input.remote.remoteId,
          input.remote.revision,
          input.remote.positionMs,
          input.remote.label,
          input.remote.kind,
          input.remote.clientCreatedAtMs,
          input.remote.clientUpdatedAtMs,
          input.remote.serverUpdatedAtMs,
          input.remote.serverDeletedAtMs ?? input.mergedAtMs,
        );
      }
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      return { outcome: existing ? 'deleted' : 'inserted' };
    }
    if (existing && !remoteMatchesLocal(input.remote, existing)) {
      await database.runAsync(
        `UPDATE meeting_marker_sync_state SET sync_state = 'blocked',
           last_error_code = 'meeting_marker_identity_mismatch'
         WHERE scope_key = ? AND marker_id = ?`,
        input.scopeKey,
        existing.marker_id,
      );
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      throw new Error('云端标记内容与本机身份不一致');
    }
    if (existing?.lifecycle === 'deleted') {
      await database.runAsync(
        `UPDATE meeting_marker_sync_state SET remote_id = ?, remote_revision = ?,
           sync_state = 'pending', pending_operation = 'delete',
           last_error_code = NULL, remote_updated_at_ms = ?
         WHERE scope_key = ? AND marker_id = ?`,
        input.remote.remoteId,
        input.remote.revision,
        input.remote.serverUpdatedAtMs,
        input.scopeKey,
        existing.marker_id,
      );
      const next = await stateRow(database, scopeKey, existing.marker_id);
      if (next) await insertOperation(database, scopeKey, next, 'delete', input.mergedAtMs);
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      return { outcome: 'pending_local' };
    }
    if (existing) {
      await database.runAsync(
        `UPDATE meeting_marker_sync_state SET remote_id = ?, remote_revision = ?,
           lifecycle = 'active', sync_state = 'synced', pending_operation = NULL,
           last_error_code = NULL, remote_updated_at_ms = ?, deleted_at_ms = NULL
         WHERE scope_key = ? AND marker_id = ?`,
        input.remote.remoteId,
        input.remote.revision,
        input.remote.serverUpdatedAtMs,
        input.scopeKey,
        existing.marker_id,
      );
      await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', claim_token = NULL,
           next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
           AND operation_type = ? AND status <> 'completed'`,
        input.mergedAtMs,
        input.scopeKey,
        AGGREGATE_TYPE,
        existing.marker_id,
        CREATE_OPERATION,
      );
      const marker = await database.getFirstAsync<{ id: string }>(
        'SELECT id FROM markers WHERE id = ? AND meeting_id = ?',
        existing.marker_id,
        input.meetingId,
      );
      if (!marker) {
        await database.runAsync(
          `INSERT INTO markers (
             id, meeting_id, position_ms, nearest_segment_id, label, kind,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
          existing.marker_id,
          input.meetingId,
          existing.position_ms,
          existing.label,
          existing.kind,
          existing.client_created_at_ms,
          existing.client_updated_at_ms,
        );
      }
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      return { outcome: 'attached' };
    }
    const collision = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM markers WHERE id = ?',
      input.remote.clientMarkerId,
    );
    if (collision) throw new Error('标记本机身份已被其他会议占用');
    await database.runAsync(
      `INSERT INTO meeting_marker_sync_state (
         scope_key, marker_id, meeting_id, remote_id, remote_revision,
         lifecycle, position_ms, label, kind,
         client_created_at_ms, client_updated_at_ms,
         sync_state, pending_operation, last_error_code,
         remote_updated_at_ms, deleted_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?,
         'synced', NULL, NULL, ?, NULL)`,
      input.scopeKey,
      input.remote.clientMarkerId,
      input.meetingId,
      input.remote.remoteId,
      input.remote.revision,
      input.remote.positionMs,
      input.remote.label,
      input.remote.kind,
      input.remote.clientCreatedAtMs,
      input.remote.clientUpdatedAtMs,
      input.remote.serverUpdatedAtMs,
    );
    await database.runAsync(
      `INSERT INTO markers (
         id, meeting_id, position_ms, nearest_segment_id, label, kind,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      input.remote.clientMarkerId,
      input.meetingId,
      input.remote.positionMs,
      input.remote.label,
      input.remote.kind,
      input.remote.clientCreatedAtMs,
      input.remote.clientUpdatedAtMs,
    );
    await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
    return { outcome: 'inserted' };
  });
}
