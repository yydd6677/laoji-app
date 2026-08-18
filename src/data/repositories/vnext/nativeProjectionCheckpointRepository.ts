import type { SQLiteDatabase } from 'expo-sqlite';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';

export interface NativeProjectionCheckpoint {
  deviceEpochId: string;
  surfaceKey: string;
  entityId: string;
  entityRevision: number;
  viewRevision: number;
  surfaceInstanceId: string;
  payloadSha256: string;
  acceptedAtMs: number;
}

export interface NativeProjectionCheckpointInput {
  deviceEpochId: string;
  surfaceKey: string;
  entityId: string;
  entityRevision: number;
  viewRevision: number;
  surfaceInstanceId: string;
  payloadSha256: string;
  acceptedAtMs?: number;
}

export type NativeProjectionCheckpointAcceptResult =
  | { status: 'accepted'; checkpoint: NativeProjectionCheckpoint }
  | { status: 'idempotent'; checkpoint: NativeProjectionCheckpoint }
  | { status: 'stale'; checkpoint: NativeProjectionCheckpoint };

type CheckpointRow = {
  device_epoch_id: string;
  surface_key: string;
  entity_id: string;
  entity_revision: number;
  view_revision: number;
  surface_instance_id: string;
  payload_sha256: string;
  accepted_at_ms: number;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function required(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is invalid`);
  return value;
}

function checkpointFromRow(row: CheckpointRow | null): NativeProjectionCheckpoint | null {
  if (!row) return null;
  return {
    deviceEpochId: row.device_epoch_id,
    surfaceKey: row.surface_key,
    entityId: row.entity_id,
    entityRevision: Number(row.entity_revision),
    viewRevision: Number(row.view_revision),
    surfaceInstanceId: row.surface_instance_id,
    payloadSha256: row.payload_sha256,
    acceptedAtMs: Number(row.accepted_at_ms),
  };
}

type NormalizedProjectionCheckpointInput = Omit<NativeProjectionCheckpointInput, 'acceptedAtMs'> & {
  acceptedAtMs: number;
};

function normalizeInput(input: NativeProjectionCheckpointInput): NormalizedProjectionCheckpointInput {
  const acceptedAtMs = input.acceptedAtMs ?? Date.now();
  const normalized = {
    deviceEpochId: required(input.deviceEpochId, 'deviceEpochId', 128),
    surfaceKey: required(input.surfaceKey, 'surfaceKey', 96),
    entityId: required(input.entityId, 'entityId', 256),
    entityRevision: positiveInteger(input.entityRevision, 'entityRevision'),
    viewRevision: positiveInteger(input.viewRevision, 'viewRevision'),
    surfaceInstanceId: required(input.surfaceInstanceId, 'surfaceInstanceId', 128),
    payloadSha256: input.payloadSha256.trim().toLowerCase(),
    acceptedAtMs,
  };
  if (!SHA256.test(normalized.payloadSha256)) throw new Error('payloadSha256 is invalid');
  if (!Number.isSafeInteger(normalized.acceptedAtMs) || normalized.acceptedAtMs < 0) {
    throw new Error('acceptedAtMs is invalid');
  }
  return normalized;
}

function compareRevision(
  left: Pick<NativeProjectionCheckpointInput, 'entityRevision' | 'viewRevision'>,
  right: Pick<NativeProjectionCheckpoint, 'entityRevision' | 'viewRevision'>,
): number {
  if (left.entityRevision !== right.entityRevision) {
    return left.entityRevision > right.entityRevision ? 1 : -1;
  }
  if (left.viewRevision !== right.viewRevision) {
    return left.viewRevision > right.viewRevision ? 1 : -1;
  }
  return 0;
}

async function readCheckpoint(
  database: SQLiteDatabase,
  deviceEpochId: string,
  surfaceKey: string,
  entityId: string,
): Promise<NativeProjectionCheckpoint | null> {
  return checkpointFromRow(await database.getFirstAsync<CheckpointRow>(
    `SELECT device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
            surface_instance_id, payload_sha256, accepted_at_ms
       FROM native_projection_checkpoints
      WHERE device_epoch_id = ? AND surface_key = ? AND entity_id = ?`,
    deviceEpochId,
    surfaceKey,
    entityId,
  ));
}

export async function getNativeProjectionCheckpoint(input: {
  deviceEpochId: string;
  surfaceKey: string;
  entityId: string;
}): Promise<NativeProjectionCheckpoint | null> {
  const deviceEpochId = required(input.deviceEpochId, 'deviceEpochId', 128);
  const surfaceKey = required(input.surfaceKey, 'surfaceKey', 96);
  const entityId = required(input.entityId, 'entityId', 256);
  return readCheckpoint(await openMeetingDatabase(), deviceEpochId, surfaceKey, entityId);
}

/**
 * Atomically advances the local native projection fence. A retry carrying the
 * same revision and payload is idempotent; an older tuple is rejected. The
 * surface instance is updated on an idempotent retry so a newly recreated
 * native host can take ownership of the same rendered snapshot.
 */
export async function acceptNativeProjectionCheckpoint(
  input: NativeProjectionCheckpointInput,
): Promise<NativeProjectionCheckpointAcceptResult> {
  const normalized = normalizeInput(input);
  return withMeetingDatabaseTransaction(async database => {
    const current = await readCheckpoint(
      database,
      normalized.deviceEpochId,
      normalized.surfaceKey,
      normalized.entityId,
    );
    let idempotent = false;
    if (current) {
      const revisionComparison = compareRevision(normalized, current);
      if (revisionComparison < 0) return { status: 'stale', checkpoint: current };
      if (revisionComparison === 0 && normalized.payloadSha256 !== current.payloadSha256) {
        // A revision is a content fence. Never let a race overwrite a payload
        // under an already accepted revision; the caller must regenerate it.
        return { status: 'stale', checkpoint: current };
      }
      idempotent = revisionComparison === 0;
    }

    await database.runAsync(
      `INSERT INTO native_projection_checkpoints(
         device_epoch_id, surface_key, entity_id, entity_revision, view_revision,
         surface_instance_id, payload_sha256, accepted_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_epoch_id, surface_key, entity_id) DO UPDATE SET
         entity_revision = excluded.entity_revision,
         view_revision = excluded.view_revision,
         surface_instance_id = excluded.surface_instance_id,
         payload_sha256 = excluded.payload_sha256,
         accepted_at_ms = excluded.accepted_at_ms`,
      normalized.deviceEpochId,
      normalized.surfaceKey,
      normalized.entityId,
      normalized.entityRevision,
      normalized.viewRevision,
      normalized.surfaceInstanceId,
      normalized.payloadSha256,
      normalized.acceptedAtMs,
    );
    const checkpoint = await readCheckpoint(
      database,
      normalized.deviceEpochId,
      normalized.surfaceKey,
      normalized.entityId,
    );
    if (!checkpoint) throw new Error('native projection checkpoint write failed');
    return {
      status: idempotent ? 'idempotent' : 'accepted',
      checkpoint,
    };
  });
}

export async function deleteNativeProjectionCheckpointsForEpoch(deviceEpochId: string): Promise<number> {
  const normalized = required(deviceEpochId, 'deviceEpochId', 128);
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      'DELETE FROM native_projection_checkpoints WHERE device_epoch_id = ?',
      normalized,
    );
    return Number(result.changes ?? 0);
  });
}
