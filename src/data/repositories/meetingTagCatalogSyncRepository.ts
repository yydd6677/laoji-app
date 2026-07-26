import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  MeetingTagCatalogV1Mutation,
  RemoteMeetingTagCatalogV1,
} from '../api/v2';
import { parseRemoteMeetingTagCatalogV1 } from '../api/v2';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';
import { assertScopeKey, secureClientIdFactory, type ScopeKey } from '../../domain/meeting';

const AGGREGATE_TYPE = 'meeting_tag_catalog';
const AGGREGATE_ID = 'catalog';
const OPERATION_TYPE = 'meeting_tag_catalog.replace';
const MAXIMUM_SNAPSHOT_BYTES = 2 * 1024 * 1024;

type LocalTag = {
  client_tag_id: string;
  name: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type LocalAssignment = {
  meeting_id: string;
  meeting_remote_id: string | null;
  client_tag_ids: string[];
};

type LocalSnapshot = {
  schema_version: 1;
  tags: LocalTag[];
  assignments: LocalAssignment[];
};

type TagRow = {
  id: string;
  name: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type AssignmentRow = {
  meeting_id: string;
  remote_id: string | null;
  tag_id: string;
};

type StateRow = {
  remote_revision: number;
  remote_snapshot_json: string;
  acknowledged_local_snapshot_json: string;
};

type OutboxRow = {
  operation_id: string;
  payload_json: string;
  request_payload_json: string | null;
  status: string;
  attempt_count: number;
  next_attempt_at_ms: number | null;
  updated_at_ms: number;
  created_at_ms: number;
};

type ConflictRow = {
  id: string;
  local_revision: number | null;
  remote_revision: number | null;
  local_payload_json: string;
  remote_payload_json: string;
  created_at_ms: number;
};

export interface MeetingTagCatalogSyncOverview {
  hasState: boolean;
  localHasContent: boolean;
  hasActiveOperation: boolean;
  hasConflict: boolean;
}

export interface MeetingTagCatalogSyncClaim {
  scopeKey: ScopeKey;
  operationId: string;
  claimToken: string;
  localSnapshotJson: string;
  requestPayloadJson: string;
  idempotencyKey: string;
  attemptCount: number;
}

export interface MeetingTagCatalogSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface MeetingTagCatalogSyncConflictRecord {
  id: string;
  scopeKey: ScopeKey;
  localRevision: number | null;
  remoteRevision: number;
  remote: RemoteMeetingTagCatalogV1;
  createdAtMs: number;
}

export type MeetingTagCatalogClaimResult =
  | { kind: 'claim'; claim: MeetingTagCatalogSyncClaim }
  | { kind: 'waiting'; retryAtMs: number | null }
  | { kind: 'root_pending'; retryAtMs: number }
  | { kind: 'conflict' };

function assertAccountScope(scopeKey: ScopeKey): void {
  assertScopeKey(scopeKey);
  if (scopeKey === 'guest') throw new Error('游客标签不能同步');
}

function assertTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function boundedJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAXIMUM_SNAPSHOT_BYTES) throw new Error(`${label}过大`);
  return serialized;
}

function normalizeLocalSnapshot(value: unknown): LocalSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机标签快照无效');
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.tags) || !Array.isArray(record.assignments)) {
    throw new Error('本机标签快照无效');
  }
  const tags = record.tags.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('本机标签条目无效');
    const row = item as Record<string, unknown>;
    if (
      typeof row.client_tag_id !== 'string' || typeof row.name !== 'string'
      || !Number.isSafeInteger(row.created_at_ms) || !Number.isSafeInteger(row.updated_at_ms)
    ) throw new Error('本机标签条目无效');
    return {
      client_tag_id: row.client_tag_id,
      name: row.name,
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
    };
  });
  const assignments = record.assignments.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('本机标签分配无效');
    const row = item as Record<string, unknown>;
    if (
      typeof row.meeting_id !== 'string'
      || (row.meeting_remote_id !== null && typeof row.meeting_remote_id !== 'string')
      || !Array.isArray(row.client_tag_ids)
      || row.client_tag_ids.some(id => typeof id !== 'string')
    ) throw new Error('本机标签分配无效');
    return {
      meeting_id: row.meeting_id,
      meeting_remote_id: row.meeting_remote_id as string | null,
      client_tag_ids: [...row.client_tag_ids as string[]],
    };
  });
  return { schema_version: 1, tags, assignments };
}

function parseLocalSnapshotJson(value: string): LocalSnapshot {
  if (!value || value.length > MAXIMUM_SNAPSHOT_BYTES) throw new Error('本机标签快照无效');
  return normalizeLocalSnapshot(JSON.parse(value) as unknown);
}

async function localSnapshot(database: SQLiteDatabase, scopeKey: ScopeKey): Promise<LocalSnapshot> {
  const [tags, rows] = await Promise.all([
    database.getAllAsync<TagRow>(
      `SELECT id, name, created_at_ms, updated_at_ms FROM meeting_tags
       WHERE scope_key = ? ORDER BY id`,
      scopeKey,
    ),
    database.getAllAsync<AssignmentRow>(
      `SELECT link.meeting_id, meeting.remote_id, link.tag_id
       FROM meeting_tag_links link
       INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
       WHERE link.scope_key = ? AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
       ORDER BY link.meeting_id, link.tag_id`,
      scopeKey,
      scopeKey,
    ),
  ]);
  const assignments = new Map<string, LocalAssignment>();
  rows.forEach(row => {
    const current = assignments.get(row.meeting_id) ?? {
      meeting_id: row.meeting_id,
      meeting_remote_id: row.remote_id?.trim() || null,
      client_tag_ids: [],
    };
    current.client_tag_ids.push(row.tag_id);
    assignments.set(row.meeting_id, current);
  });
  return {
    schema_version: 1,
    tags: tags.map(tag => ({
      client_tag_id: tag.id,
      name: tag.name,
      created_at_ms: tag.created_at_ms,
      updated_at_ms: tag.updated_at_ms,
    })),
    assignments: [...assignments.values()].map(item => ({
      ...item,
      client_tag_ids: [...item.client_tag_ids].sort(),
    })).sort((left, right) => left.meeting_id.localeCompare(right.meeting_id)),
  };
}

function remoteSnapshotJson(remote: RemoteMeetingTagCatalogV1): string {
  return boundedJson({
    schema_version: 1,
    exists: remote.exists,
    revision: remote.revision,
    client_updated_at_ms: remote.clientUpdatedAtMs,
    tags: remote.tags.map(tag => ({
      client_tag_id: tag.clientTagId,
      name: tag.name,
      created_at_ms: tag.createdAtMs,
      updated_at_ms: tag.updatedAtMs,
    })),
    assignments: remote.assignments.map(item => ({
      meeting_remote_id: item.meetingRemoteId,
      client_tag_ids: [...item.clientTagIds],
    })),
    updated_at: remote.serverUpdatedAtMs === null
      ? null
      : new Date(remote.serverUpdatedAtMs).toISOString(),
  }, '标签云端快照');
}

function remoteFromSnapshotJson(value: string): RemoteMeetingTagCatalogV1 {
  return parseRemoteMeetingTagCatalogV1(JSON.parse(value) as unknown);
}

function emptyRemoteSnapshot(): RemoteMeetingTagCatalogV1 {
  return {
    exists: false,
    revision: 0,
    clientUpdatedAtMs: 0,
    tags: [],
    assignments: [],
    serverUpdatedAtMs: null,
  };
}

async function buildMutation(
  database: SQLiteDatabase,
  scopeKey: ScopeKey,
  local: LocalSnapshot,
  clientUpdatedAtMs: number,
): Promise<MeetingTagCatalogV1Mutation | null> {
  const state = await database.getFirstAsync<StateRow>(
    `SELECT remote_revision, remote_snapshot_json, acknowledged_local_snapshot_json
     FROM meeting_tag_catalog_sync_state WHERE scope_key = ?`,
    scopeKey,
  );
  const remote = state ? remoteFromSnapshotJson(state.remote_snapshot_json) : emptyRemoteSnapshot();
  const knownRows = await database.getAllAsync<{ remote_id: string }>(
    `SELECT remote_id FROM meeting_notes
     WHERE scope_key = ? AND lifecycle <> 'deleted'
       AND remote_id IS NOT NULL AND LENGTH(TRIM(remote_id)) > 0
     ORDER BY remote_id`,
    scopeKey,
  );
  const knownRemoteIds = new Set(knownRows.map(row => row.remote_id.trim()));
  const missingRoot = local.assignments.some(item => item.client_tag_ids.length > 0 && !item.meeting_remote_id);
  if (missingRoot) return null;
  const tagIds = new Set(local.tags.map(tag => tag.client_tag_id));
  const assignments = new Map<string, string[]>();
  remote.assignments.forEach(item => {
    if (knownRemoteIds.has(item.meetingRemoteId)) return;
    const retained = item.clientTagIds.filter(id => tagIds.has(id));
    if (retained.length > 0) assignments.set(item.meetingRemoteId, [...retained].sort());
  });
  local.assignments.forEach(item => {
    if (!item.meeting_remote_id || item.client_tag_ids.length === 0) return;
    assignments.set(item.meeting_remote_id, [...item.client_tag_ids].sort());
  });
  return {
    schema_version: 1,
    expected_remote_revision: state && state.remote_revision > 0 ? state.remote_revision : null,
    client_updated_at_ms: clientUpdatedAtMs,
    tags: local.tags.map(tag => ({ ...tag })),
    assignments: [...assignments.entries()]
      .map(([meeting_remote_id, client_tag_ids]) => ({ meeting_remote_id, client_tag_ids }))
      .sort((left, right) => left.meeting_remote_id.localeCompare(right.meeting_remote_id)),
  };
}

async function applyRemote(
  database: SQLiteDatabase,
  scopeKey: ScopeKey,
  remote: RemoteMeetingTagCatalogV1,
  appliedAtMs: number,
): Promise<readonly string[]> {
  const localMeetings = await database.getAllAsync<{ id: string; remote_id: string }>(
    `SELECT id, remote_id FROM meeting_notes
     WHERE scope_key = ? AND lifecycle <> 'deleted'
       AND remote_id IS NOT NULL AND LENGTH(TRIM(remote_id)) > 0`,
    scopeKey,
  );
  const localIdByRemote = new Map(localMeetings.map(item => [item.remote_id.trim(), item.id]));
  await database.runAsync('DELETE FROM meeting_tags WHERE scope_key = ?', scopeKey);
  for (const tag of remote.tags) {
    await database.runAsync(
      `INSERT INTO meeting_tags (
         id, scope_key, name, normalized_name, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      tag.clientTagId,
      scopeKey,
      tag.name,
      tag.name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase(),
      tag.createdAtMs,
      tag.updatedAtMs,
    );
  }
  const touched = new Set<string>();
  for (const assignment of remote.assignments) {
    const meetingId = localIdByRemote.get(assignment.meetingRemoteId);
    if (!meetingId) continue;
    touched.add(meetingId);
    for (const tagId of assignment.clientTagIds) {
      await database.runAsync(
        `INSERT INTO meeting_tag_links (meeting_id, tag_id, scope_key, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        meetingId,
        tagId,
        scopeKey,
        appliedAtMs,
      );
    }
  }
  localMeetings.forEach(item => touched.add(item.id));
  return [...touched];
}

async function storeState(
  database: SQLiteDatabase,
  scopeKey: ScopeKey,
  remote: RemoteMeetingTagCatalogV1,
  acknowledgedLocalSnapshotJson: string,
  updatedAtMs: number,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO meeting_tag_catalog_sync_state (
       scope_key, remote_revision, remote_snapshot_json,
       acknowledged_local_snapshot_json, pulled_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       remote_revision = excluded.remote_revision,
       remote_snapshot_json = excluded.remote_snapshot_json,
       acknowledged_local_snapshot_json = excluded.acknowledged_local_snapshot_json,
       pulled_at_ms = excluded.pulled_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
    scopeKey,
    remote.revision,
    remoteSnapshotJson(remote),
    acknowledgedLocalSnapshotJson,
    updatedAtMs,
    updatedAtMs,
  );
}

async function hasUnresolvedConflict(database: SQLiteDatabase, scopeKey: ScopeKey): Promise<boolean> {
  const row = await database.getFirstAsync<{ present: number }>(
    `SELECT 1 AS present FROM sync_conflicts
     WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ? AND status = 'unresolved'
     LIMIT 1`,
    scopeKey,
    AGGREGATE_TYPE,
    AGGREGATE_ID,
  );
  return Boolean(row);
}

export async function getMeetingTagCatalogSyncOverview(
  scopeKey: ScopeKey,
): Promise<MeetingTagCatalogSyncOverview> {
  assertAccountScope(scopeKey);
  const database = await openMeetingDatabase();
  const [state, tag, operation, conflict] = await Promise.all([
    database.getFirstAsync<{ present: number }>(
      'SELECT 1 AS present FROM meeting_tag_catalog_sync_state WHERE scope_key = ?',
      scopeKey,
    ),
    database.getFirstAsync<{ present: number }>(
      'SELECT 1 AS present FROM meeting_tags WHERE scope_key = ? LIMIT 1',
      scopeKey,
    ),
    database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sync_outbox
       WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status IN ('pending', 'retry', 'in_flight') LIMIT 1`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    ),
    database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sync_conflicts
       WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status = 'unresolved' LIMIT 1`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    ),
  ]);
  return {
    hasState: Boolean(state),
    localHasContent: Boolean(tag),
    hasActiveOperation: Boolean(operation),
    hasConflict: Boolean(conflict),
  };
}

export async function ensureMeetingTagCatalogSyncOperation(
  scopeKey: ScopeKey,
  createdAtMs: number,
): Promise<boolean> {
  assertAccountScope(scopeKey);
  assertTime(createdAtMs, '标签同步时间');
  return withMeetingDatabaseTransaction(async database => {
    if (await hasUnresolvedConflict(database, scopeKey)) return false;
    const snapshot = await localSnapshot(database, scopeKey);
    const payloadJson = boundedJson(snapshot, '本机标签快照');
    const state = await database.getFirstAsync<StateRow>(
      `SELECT remote_revision, remote_snapshot_json, acknowledged_local_snapshot_json
       FROM meeting_tag_catalog_sync_state WHERE scope_key = ?`,
      scopeKey,
    );
    if (state?.acknowledged_local_snapshot_json === payloadJson) return false;
    const active = await database.getAllAsync<OutboxRow>(
      `SELECT operation_id, payload_json, request_payload_json, status, attempt_count,
         next_attempt_at_ms, updated_at_ms, created_at_ms
       FROM sync_outbox WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status IN ('pending', 'retry', 'in_flight')
       ORDER BY created_at_ms, operation_id`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    if (active.some(row => row.payload_json === payloadJson)) return false;
    await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', last_error_code = 'superseded',
         next_attempt_at_ms = NULL, claim_token = NULL, updated_at_ms = ?
       WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status IN ('pending', 'retry')`,
      createdAtMs,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    const operationId = secureClientIdFactory.create();
    const inserted = await database.runAsync(
      `INSERT INTO sync_outbox (
         operation_id, scope_key, aggregate_type, aggregate_id, operation_type,
         base_revision, payload_json, status, attempt_count, next_attempt_at_ms,
         last_error_code, request_payload_json, claim_token, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      operationId,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
      OPERATION_TYPE,
      state?.remote_revision ?? null,
      payloadJson,
      createdAtMs,
      createdAtMs,
    );
    if (inserted.changes !== 1) throw new Error('标签同步任务未能保存');
    return true;
  });
}

export async function claimMeetingTagCatalogSyncOperation(
  scopeKey: ScopeKey,
  options: { nowMs: number; staleBeforeMs: number },
): Promise<MeetingTagCatalogClaimResult> {
  assertAccountScope(scopeKey);
  assertTime(options.nowMs, '标签同步领取时间');
  assertTime(options.staleBeforeMs, '标签同步过期时间');
  return withMeetingDatabaseTransaction(async database => {
    if (await hasUnresolvedConflict(database, scopeKey)) return { kind: 'conflict' };
    const rows = await database.getAllAsync<OutboxRow>(
      `SELECT operation_id, payload_json, request_payload_json, status, attempt_count,
         next_attempt_at_ms, updated_at_ms, created_at_ms
       FROM sync_outbox WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND operation_type = ? AND status IN ('pending', 'retry', 'in_flight')
       ORDER BY created_at_ms, operation_id`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
      OPERATION_TYPE,
    );
    const inFlight = rows.filter(row => row.status === 'in_flight');
    let selected: OutboxRow | null = null;
    let mode: 'pending' | 'retry' | 'stale' = 'pending';
    if (inFlight.length > 0) {
      const stale = inFlight.filter(row => row.updated_at_ms <= options.staleBeforeMs);
      if (stale.length === 0) {
        return {
          kind: 'waiting',
          retryAtMs: Math.min(...inFlight.map(row => row.updated_at_ms + 90_000)),
        };
      }
      selected = stale[stale.length - 1];
      mode = 'stale';
    } else {
      const retries = rows.filter(row => row.status === 'retry');
      const eligibleRetry = retries.find(row => (
        row.next_attempt_at_ms === null || row.next_attempt_at_ms <= options.nowMs
      ));
      if (eligibleRetry) {
        selected = eligibleRetry;
        mode = 'retry';
      } else {
        selected = rows.filter(row => row.status === 'pending').at(-1) ?? null;
        if (!selected) {
          const retryAtMs = retries.reduce<number | null>((earliest, row) => {
            if (row.next_attempt_at_ms === null) return earliest;
            return earliest === null ? row.next_attempt_at_ms : Math.min(earliest, row.next_attempt_at_ms);
          }, null);
          return { kind: 'waiting', retryAtMs };
        }
      }
    }
    const local = parseLocalSnapshotJson(selected.payload_json);
    let requestPayloadJson = selected.request_payload_json;
    if (mode === 'pending' || !requestPayloadJson) {
      const mutation = await buildMutation(database, scopeKey, local, selected.created_at_ms);
      if (!mutation) return { kind: 'root_pending', retryAtMs: options.nowMs + 30_000 };
      requestPayloadJson = boundedJson(mutation, '标签同步请求');
    }
    const claimToken = secureClientIdFactory.create();
    const updated = await database.runAsync(
      `UPDATE sync_outbox SET status = 'in_flight', attempt_count = attempt_count + 1,
         next_attempt_at_ms = NULL, last_error_code = NULL,
         request_payload_json = ?, claim_token = ?, updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND status = ?
         ${mode === 'stale' ? 'AND updated_at_ms <= ?' : ''}`,
      requestPayloadJson,
      claimToken,
      options.nowMs,
      selected.operation_id,
      scopeKey,
      mode === 'stale' ? 'in_flight' : mode,
      ...(mode === 'stale' ? [options.staleBeforeMs] : []),
    );
    if (updated.changes !== 1) return { kind: 'waiting', retryAtMs: options.nowMs + 1_000 };
    return {
      kind: 'claim',
      claim: {
        scopeKey,
        operationId: selected.operation_id,
        claimToken,
        localSnapshotJson: selected.payload_json,
        requestPayloadJson,
        idempotencyKey: selected.operation_id,
        attemptCount: selected.attempt_count + 1,
      },
    };
  });
}

export async function completeMeetingTagCatalogSyncClaim(
  claim: MeetingTagCatalogSyncClaim,
  remote: RemoteMeetingTagCatalogV1,
  completedAtMs: number,
): Promise<boolean> {
  assertAccountScope(claim.scopeKey);
  assertTime(completedAtMs, '标签同步完成时间');
  return withMeetingDatabaseTransaction(async database => {
    const current = await database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sync_outbox WHERE operation_id = ? AND scope_key = ?
       AND status = 'in_flight' AND claim_token = ?`,
      claim.operationId,
      claim.scopeKey,
      claim.claimToken,
    );
    if (!current) return false;
    await storeState(
      database,
      claim.scopeKey,
      remote,
      claim.localSnapshotJson,
      completedAtMs,
    );
    const completed = await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
         last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND status = 'in_flight' AND claim_token = ?`,
      completedAtMs,
      claim.operationId,
      claim.scopeKey,
      claim.claimToken,
    );
    return completed.changes === 1;
  });
}

export async function failMeetingTagCatalogSyncClaim(
  claim: MeetingTagCatalogSyncClaim,
  failure: MeetingTagCatalogSyncFailure,
): Promise<boolean> {
  assertAccountScope(claim.scopeKey);
  assertTime(failure.updatedAtMs, '标签同步失败时间');
  if ((failure.disposition === 'retry') !== (failure.nextAttemptAtMs !== null)) {
    throw new Error('标签同步重试时间无效');
  }
  const errorCode = failure.errorCode.trim().slice(0, 160) || 'unknown';
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?, last_error_code = ?,
         claim_token = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND status = 'in_flight' AND claim_token = ?`,
      failure.disposition,
      failure.nextAttemptAtMs,
      errorCode,
      failure.updatedAtMs,
      claim.operationId,
      claim.scopeKey,
      claim.claimToken,
    );
    return result.changes === 1;
  });
}

export async function recordMeetingTagCatalogSyncConflict(
  claim: MeetingTagCatalogSyncClaim,
  remote: RemoteMeetingTagCatalogV1,
  createdAtMs: number,
): Promise<boolean> {
  assertAccountScope(claim.scopeKey);
  assertTime(createdAtMs, '标签同步冲突时间');
  const request = JSON.parse(claim.requestPayloadJson) as MeetingTagCatalogV1Mutation;
  const conflictId = `meeting-tag-catalog:${claim.operationId}`;
  return withMeetingDatabaseTransaction(async database => {
    const current = await database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sync_outbox WHERE operation_id = ? AND scope_key = ?
       AND status = 'in_flight' AND claim_token = ?`,
      claim.operationId,
      claim.scopeKey,
      claim.claimToken,
    );
    if (!current) return false;
    await database.runAsync(
      `INSERT OR IGNORE INTO sync_conflicts (
         id, scope_key, aggregate_type, aggregate_id, local_revision, remote_revision,
         local_payload_json, remote_payload_json, status, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)`,
      conflictId,
      claim.scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
      request.expected_remote_revision,
      remote.revision,
      claim.localSnapshotJson,
      remoteSnapshotJson(remote),
      createdAtMs,
    );
    const blocked = await database.runAsync(
      `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
         last_error_code = 'revision_conflict', claim_token = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND scope_key = ? AND status = 'in_flight' AND claim_token = ?`,
      createdAtMs,
      claim.operationId,
      claim.scopeKey,
      claim.claimToken,
    );
    return blocked.changes === 1;
  });
}

export async function applyMeetingTagCatalogPull(
  scopeKey: ScopeKey,
  remote: RemoteMeetingTagCatalogV1,
  pulledAtMs: number,
): Promise<{ applied: boolean; meetingIds: readonly string[] }> {
  assertAccountScope(scopeKey);
  assertTime(pulledAtMs, '标签拉取时间');
  return withMeetingDatabaseTransaction(async database => {
    const active = await database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sync_outbox WHERE scope_key = ? AND aggregate_type = ?
       AND aggregate_id = ? AND status IN ('pending', 'retry', 'in_flight', 'blocked') LIMIT 1`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    if (active || await hasUnresolvedConflict(database, scopeKey)) {
      return { applied: false, meetingIds: [] };
    }
    const meetingIds = await applyRemote(database, scopeKey, remote, pulledAtMs);
    const acknowledged = boundedJson(await localSnapshot(database, scopeKey), '本机标签快照');
    await storeState(database, scopeKey, remote, acknowledged, pulledAtMs);
    return { applied: true, meetingIds };
  });
}

export async function getMeetingTagCatalogSyncConflict(
  scopeKey: ScopeKey,
): Promise<MeetingTagCatalogSyncConflictRecord | null> {
  assertAccountScope(scopeKey);
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<ConflictRow>(
    `SELECT id, local_revision, remote_revision, local_payload_json,
       remote_payload_json, created_at_ms
     FROM sync_conflicts WHERE scope_key = ? AND aggregate_type = ?
       AND aggregate_id = ? AND status = 'unresolved'
     ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    scopeKey,
    AGGREGATE_TYPE,
    AGGREGATE_ID,
  );
  if (!row) return null;
  const remote = remoteFromSnapshotJson(row.remote_payload_json);
  if (row.remote_revision === null || row.remote_revision !== remote.revision) {
    throw new Error('标签同步冲突记录已损坏');
  }
  return {
    id: row.id,
    scopeKey,
    localRevision: row.local_revision,
    remoteRevision: remote.revision,
    remote,
    createdAtMs: row.created_at_ms,
  };
}

export async function resolveMeetingTagCatalogSyncConflict(
  scopeKey: ScopeKey,
  resolution: 'keep_local' | 'use_cloud',
  resolvedAtMs: number,
): Promise<{ resolved: boolean; meetingIds: readonly string[] }> {
  assertAccountScope(scopeKey);
  assertTime(resolvedAtMs, '标签同步冲突解决时间');
  return withMeetingDatabaseTransaction(async database => {
    const row = await database.getFirstAsync<ConflictRow>(
      `SELECT id, local_revision, remote_revision, local_payload_json,
         remote_payload_json, created_at_ms
       FROM sync_conflicts WHERE scope_key = ? AND aggregate_type = ?
         AND aggregate_id = ? AND status = 'unresolved'
       ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    if (!row) return { resolved: false, meetingIds: [] };
    const remote = remoteFromSnapshotJson(row.remote_payload_json);
    let meetingIds: readonly string[] = [];
    if (resolution === 'use_cloud') {
      meetingIds = await applyRemote(database, scopeKey, remote, resolvedAtMs);
      const acknowledged = boundedJson(await localSnapshot(database, scopeKey), '本机标签快照');
      await storeState(database, scopeKey, remote, acknowledged, resolvedAtMs);
    } else {
      const currentState = await database.getFirstAsync<StateRow>(
        `SELECT remote_revision, remote_snapshot_json, acknowledged_local_snapshot_json
         FROM meeting_tag_catalog_sync_state WHERE scope_key = ?`,
        scopeKey,
      );
      await storeState(
        database,
        scopeKey,
        remote,
        currentState?.acknowledged_local_snapshot_json ?? boundedJson({
          schema_version: 1,
          tags: [],
          assignments: [],
        }, '本机标签快照'),
        resolvedAtMs,
      );
    }
    await database.runAsync(
      `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
       WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status = 'unresolved'`,
      resolvedAtMs,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    await database.runAsync(
      `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
         last_error_code = 'conflict_resolved', claim_token = NULL, updated_at_ms = ?
       WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
         AND status = 'blocked'`,
      resolvedAtMs,
      scopeKey,
      AGGREGATE_TYPE,
      AGGREGATE_ID,
    );
    return { resolved: true, meetingIds };
  });
}

export async function getNextMeetingTagCatalogSyncAttemptAt(
  scopeKey: ScopeKey,
  staleAfterMs: number,
): Promise<number | null> {
  assertAccountScope(scopeKey);
  assertTime(staleAfterMs, '标签同步过期间隔');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<OutboxRow>(
    `SELECT operation_id, payload_json, request_payload_json, status, attempt_count,
       next_attempt_at_ms, updated_at_ms, created_at_ms
     FROM sync_outbox WHERE scope_key = ? AND aggregate_type = ? AND aggregate_id = ?
       AND status IN ('pending', 'retry', 'in_flight')`,
    scopeKey,
    AGGREGATE_TYPE,
    AGGREGATE_ID,
  );
  let earliest: number | null = null;
  rows.forEach(row => {
    const value = row.status === 'pending'
      ? 0
      : row.status === 'in_flight' ? row.updated_at_ms + staleAfterMs : row.next_attempt_at_ms;
    if (value === null) return;
    earliest = earliest === null ? value : Math.min(earliest, value);
  });
  return earliest;
}
