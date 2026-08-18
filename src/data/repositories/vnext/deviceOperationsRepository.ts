import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';
import type { ScopeKey } from '../../../domain/meeting';

export type DeviceOperationReason = 'original' | 'retry' | 'regenerate';
export type DeviceOperationState = 'queued' | 'running' | 'success' | 'failure' | 'cancelled';

const ALLOWED_STATE_TRANSITIONS: Record<DeviceOperationState, readonly DeviceOperationState[]> = {
  queued: ['queued', 'running', 'failure', 'cancelled'],
  running: ['running', 'success', 'failure', 'cancelled'],
  success: ['success'],
  failure: ['failure'],
  cancelled: ['cancelled'],
};

export interface DeviceOperationRecord {
  operationId: string;
  deviceEpochId: string;
  capability: string;
  entityId: string;
  entityRevision: number;
  inputSha256: string;
  generationId: string;
  predecessorOperationId: string | null;
  creationReason: DeviceOperationReason;
  operationRevision: number;
  cancelRevision: number;
  remoteTaskId: string | null;
  acceptedAttemptId: string | null;
  remoteState: DeviceOperationState | null;
  progressDone: number | null;
  progressTotal: number | null;
  errorCode: string | null;
  retryAfterMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
  executorKind: 'workmanager' | null;
  executorId: string | null;
}

type OperationRow = {
  operation_id: string;
  device_epoch_id: string;
  capability: string;
  entity_id: string;
  entity_revision: number;
  input_sha256: string;
  generation_id: string;
  predecessor_operation_id: string | null;
  creation_reason: DeviceOperationReason;
  operation_revision: number;
  cancel_revision: number;
  remote_task_id: string | null;
  accepted_attempt_id: string | null;
  remote_state: DeviceOperationState | null;
  progress_done: number | null;
  progress_total: number | null;
  error_code: string | null;
  retry_after_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
  executor_kind: 'workmanager' | null;
  executor_id: string | null;
};

function value(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} 无效`);
  }
  return normalized;
}

function fromRow(row: OperationRow | null): DeviceOperationRecord | null {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    deviceEpochId: row.device_epoch_id,
    capability: row.capability,
    entityId: row.entity_id,
    entityRevision: Number(row.entity_revision),
    inputSha256: row.input_sha256,
    generationId: row.generation_id,
    predecessorOperationId: row.predecessor_operation_id,
    creationReason: row.creation_reason,
    operationRevision: Number(row.operation_revision),
    cancelRevision: Number(row.cancel_revision),
    remoteTaskId: row.remote_task_id,
    acceptedAttemptId: row.accepted_attempt_id,
    remoteState: row.remote_state,
    progressDone: row.progress_done === null ? null : Number(row.progress_done),
    progressTotal: row.progress_total === null ? null : Number(row.progress_total),
    errorCode: row.error_code,
    retryAfterMs: row.retry_after_ms === null ? null : Number(row.retry_after_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    terminalAtMs: row.terminal_at_ms === null ? null : Number(row.terminal_at_ms),
    executorKind: row.executor_kind,
    executorId: row.executor_id,
  };
}

export interface DeviceUploadOperationSnapshot {
  operation: DeviceOperationRecord;
  asset: {
    id: string;
    meetingId: string;
    assetGeneration: string;
    role: 'primary' | 'secondary';
    origin: 'captured' | 'imported' | 'recovered';
    nativeSessionId: string | null;
    localUri: string;
    remoteAssetId: string | null;
    mimeType: string | null;
    fileName: string | null;
    byteSize: number | null;
    durationMs: number | null;
    checksumSha256: string | null;
    sourceSha256: string | null;
    updatedAtMs: number;
  };
}

type DeviceUploadOperationRow = OperationRow & {
  asset_id: string;
  asset_meeting_id: string;
  asset_generation: string;
  asset_role: 'primary' | 'secondary';
  asset_origin: 'captured' | 'imported' | 'recovered';
  asset_native_session_id: string | null;
  asset_local_uri: string;
  asset_remote_asset_id: string | null;
  asset_mime_type: string | null;
  asset_file_name: string | null;
  asset_byte_size: number | null;
  asset_duration_ms: number | null;
  asset_checksum_sha256: string | null;
  asset_source_sha256: string | null;
  asset_updated_at_ms: number;
};

async function digest(valueToHash: string): Promise<string> {
  return `sha256:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, valueToHash)}`;
}

async function readById(database: SQLiteDatabase, operationId: string): Promise<DeviceOperationRecord | null> {
  return fromRow(await database.getFirstAsync<OperationRow>(
    `SELECT operation_id, device_epoch_id, capability, entity_id, entity_revision, input_sha256,
            generation_id, predecessor_operation_id, creation_reason, operation_revision,
            cancel_revision, remote_task_id, accepted_attempt_id, remote_state, progress_done,
            progress_total, error_code, retry_after_ms, created_at_ms, updated_at_ms, terminal_at_ms,
            executor_kind, executor_id
       FROM device_operations WHERE operation_id = ?`,
    operationId,
  ));
}

export async function getDeviceOperation(operationId: string): Promise<DeviceOperationRecord | null> {
  return readById(await openMeetingDatabase(), value(operationId, 'operationId'));
}

export async function getLatestDeviceOperation(
  capability: string,
  entityId: string,
): Promise<DeviceOperationRecord | null> {
  const database = await openMeetingDatabase();
  return fromRow(await database.getFirstAsync<OperationRow>(
    `SELECT operation_id, device_epoch_id, capability, entity_id, entity_revision, input_sha256,
            generation_id, predecessor_operation_id, creation_reason, operation_revision,
            cancel_revision, remote_task_id, accepted_attempt_id, remote_state, progress_done,
            progress_total, error_code, retry_after_ms, created_at_ms, updated_at_ms, terminal_at_ms,
            executor_kind, executor_id
       FROM device_operations
      WHERE capability = ? AND entity_id = ?
      ORDER BY created_at_ms DESC, operation_id DESC LIMIT 1`,
    value(capability, 'capability'),
    value(entityId, 'entityId'),
  ));
}

function uploadOperationSelect(): string {
  return `
    SELECT operation.operation_id, operation.device_epoch_id, operation.capability,
           operation.entity_id, operation.entity_revision, operation.input_sha256,
           operation.generation_id, operation.predecessor_operation_id,
           operation.creation_reason, operation.operation_revision,
           operation.cancel_revision, operation.remote_task_id,
           operation.accepted_attempt_id, operation.remote_state,
           operation.progress_done, operation.progress_total, operation.error_code,
           operation.retry_after_ms, operation.created_at_ms, operation.updated_at_ms,
           operation.terminal_at_ms, operation.executor_kind, operation.executor_id,
           asset.id AS asset_id, asset.meeting_id AS asset_meeting_id,
           asset.asset_generation, asset.role AS asset_role, asset.origin AS asset_origin,
           asset.native_session_id AS asset_native_session_id, asset.local_uri AS asset_local_uri,
           asset.remote_asset_id AS asset_remote_asset_id, asset.mime_type AS asset_mime_type,
           asset.file_name AS asset_file_name, asset.byte_size AS asset_byte_size,
           asset.duration_ms AS asset_duration_ms, asset.checksum_sha256 AS asset_checksum_sha256,
           asset.source_sha256 AS asset_source_sha256, asset.updated_at_ms AS asset_updated_at_ms
      FROM device_operations operation
      INNER JOIN recording_assets asset ON asset.upload_operation_id = operation.operation_id
      INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
     WHERE meeting.scope_key = ?
       AND meeting.lifecycle <> 'deleted'
       AND operation.capability = 'media.upload'
       AND operation.remote_state IN ('queued', 'running', 'failure')
       AND asset.local_uri IS NOT NULL
       AND length(trim(asset.local_uri)) > 0
       AND asset.remote_asset_id IS NULL`;
}

export async function listPendingDeviceUploadOperations(
  scopeKey: ScopeKey,
): Promise<readonly DeviceUploadOperationSnapshot[]> {
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<DeviceUploadOperationRow>(
    `${uploadOperationSelect()} ORDER BY operation.updated_at_ms, operation.operation_id`,
    scopeKey,
  );
  return rows.map(row => {
    const operation = fromRow(row);
    if (!operation) throw new Error('设备上传 operation 读取失败');
    return {
      operation,
      asset: {
        id: row.asset_id,
        meetingId: row.asset_meeting_id,
        assetGeneration: row.asset_generation,
        role: row.asset_role,
        origin: row.asset_origin,
        nativeSessionId: row.asset_native_session_id,
        localUri: row.asset_local_uri,
        remoteAssetId: row.asset_remote_asset_id,
        mimeType: row.asset_mime_type,
        fileName: row.asset_file_name,
        byteSize: row.asset_byte_size,
        durationMs: row.asset_duration_ms,
        checksumSha256: row.asset_checksum_sha256,
        sourceSha256: row.asset_source_sha256,
        updatedAtMs: Number(row.asset_updated_at_ms),
      },
    } satisfies DeviceUploadOperationSnapshot;
  });
}

export interface CreateDeviceOperationInput {
  operationId: string;
  deviceEpochId: string;
  capability: string;
  entityId: string;
  entityRevision: number;
  input?: string;
  inputSha256?: string;
  generationId: string;
  predecessorOperationId?: string | null;
  creationReason?: DeviceOperationReason;
  nowMs?: number;
}

export async function createDeviceOperation(
  input: CreateDeviceOperationInput,
): Promise<DeviceOperationRecord> {
  const operationId = value(input.operationId, 'operationId');
  const epochId = value(input.deviceEpochId, 'deviceEpochId');
  const capability = value(input.capability, 'capability');
  const entityId = value(input.entityId, 'entityId');
  const generationId = value(input.generationId, 'generationId');
  if (!Number.isSafeInteger(input.entityRevision) || input.entityRevision < 1) {
    throw new Error('entityRevision 无效');
  }
  const inputSha256 = input.inputSha256 ?? await digest(input.input ?? generationId);
  if (!/^sha256:[0-9a-f]{64}$/.test(inputSha256)) throw new Error('inputSha256 无效');
  const nowMs = input.nowMs ?? Date.now();
  return withMeetingDatabaseTransaction(async database => {
    // Meeting operations are admitted only while their local service binding
    // is active in the same device epoch.  Non-meeting operations (for
    // example a future schedule capability) have no binding row and remain
    // valid here.
    const binding = await database.getFirstAsync<{
      device_epoch_id: string;
      state: 'active' | 'purging' | 'purged';
    }>(
      `SELECT device_epoch_id, state FROM meeting_service_bindings WHERE meeting_id = ?`,
      entityId,
    );
    if (binding && (binding.device_epoch_id !== epochId || binding.state !== 'active')) {
      throw new Error('会议服务连接不可用于创建远端任务');
    }
    await database.runAsync(
      `INSERT OR IGNORE INTO device_operations (
        operation_id, device_epoch_id, capability, entity_id, entity_revision, input_sha256,
        generation_id, predecessor_operation_id, creation_reason, operation_revision,
        cancel_revision, remote_state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'queued', ?, ?)`,
      operationId,
      epochId,
      capability,
      entityId,
      input.entityRevision,
      inputSha256,
      generationId,
      input.predecessorOperationId ?? null,
      input.creationReason ?? 'original',
      nowMs,
      nowMs,
    );
    const created = await readById(database, operationId);
    if (!created) throw new Error('device operation 创建失败');
    return created;
  });
}

export interface UpdateDeviceOperationInput {
  operationId: string;
  expectedRevision: number;
  state?: DeviceOperationState;
  remoteTaskId?: string | null;
  acceptedAttemptId?: string | null;
  progressDone?: number | null;
  progressTotal?: number | null;
  errorCode?: string | null;
  retryAfterMs?: number | null;
  nowMs?: number;
  executorKind?: 'workmanager' | null;
  executorId?: string | null;
}

export async function updateDeviceOperation(input: UpdateDeviceOperationInput): Promise<DeviceOperationRecord | null> {
  const operationId = value(input.operationId, 'operationId');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error('expectedRevision 无效');
  }
  const nowMs = input.nowMs ?? Date.now();
  return withMeetingDatabaseTransaction(async database => {
    const existing = await readById(database, operationId);
    if (!existing || existing.operationRevision !== input.expectedRevision) return null;
    const state = input.state ?? existing.remoteState;
    const currentState = existing.remoteState;
    if (!currentState || !state || !ALLOWED_STATE_TRANSITIONS[currentState].includes(state)) {
      return null;
    }
    const terminal = state === 'success' || state === 'failure' || state === 'cancelled';
    const result = await database.runAsync(
      `UPDATE device_operations
          SET operation_revision = operation_revision + 1,
              remote_state = ?, remote_task_id = ?, accepted_attempt_id = ?,
              progress_done = ?, progress_total = ?, error_code = ?, retry_after_ms = ?,
              executor_kind = ?, executor_id = ?,
              updated_at_ms = ?, terminal_at_ms = CASE WHEN ? = 1 THEN COALESCE(terminal_at_ms, ?) ELSE NULL END
        WHERE operation_id = ? AND operation_revision = ?`,
      state,
      input.remoteTaskId === undefined ? existing.remoteTaskId : input.remoteTaskId,
      input.acceptedAttemptId === undefined ? existing.acceptedAttemptId : input.acceptedAttemptId,
      input.progressDone === undefined ? existing.progressDone : input.progressDone,
      input.progressTotal === undefined ? existing.progressTotal : input.progressTotal,
      input.errorCode === undefined ? existing.errorCode : input.errorCode,
      input.retryAfterMs === undefined ? existing.retryAfterMs : input.retryAfterMs,
      input.executorKind === undefined ? existing.executorKind : input.executorKind,
      input.executorId === undefined ? existing.executorId : input.executorId,
      nowMs,
      terminal ? 1 : 0,
      nowMs,
      operationId,
      input.expectedRevision,
    );
    if (Number(result.changes) !== 1) return null;
    return readById(database, operationId);
  });
}

export async function attachDeviceOperationExecutor(
  operationId: string,
  executorKind: 'workmanager',
  executorId: string,
): Promise<DeviceOperationRecord | null> {
  const existing = await getDeviceOperation(operationId);
  if (!existing) return null;
  const normalized = value(executorId, 'executorId');
  if (existing.executorKind === executorKind && existing.executorId === normalized) return existing;
  if (existing.executorId && existing.executorId !== normalized) {
    throw new Error('设备 operation 执行句柄已变化');
  }
  return updateDeviceOperation({
    operationId,
    expectedRevision: existing.operationRevision,
    state: existing.remoteState ?? 'queued',
    executorKind,
    executorId: normalized,
  });
}

export async function cancelDeviceOperation(
  operationId: string,
  expectedRevision: number,
  nowMs = Date.now(),
): Promise<DeviceOperationRecord | null> {
  return updateDeviceOperation({ operationId, expectedRevision, state: 'cancelled', nowMs });
}
