import type { SQLiteDatabase } from 'expo-sqlite';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';

export type DeviceEpochStatus = 'active' | 'retired';
export type MeetingBindingState = 'active' | 'purging' | 'purged';

export interface DeviceAuthorityState {
  epochId: string | null;
  authorityRevision: number;
  nextBindingEpochSeq: number;
  updatedAtMs: number;
}

export interface MeetingServiceBinding {
  meetingId: string;
  deviceEpochId: string;
  bindingId: string;
  bindingGeneration: string;
  bindingEpochSeq: number;
  bindingRevision: number;
  state: MeetingBindingState;
  cancelRevision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

type AuthorityRow = {
  current_epoch_id: string | null;
  authority_revision: number;
  next_binding_epoch_seq: number;
  updated_at_ms: number;
};

type BindingRow = {
  meeting_id: string;
  device_epoch_id: string;
  binding_id: string;
  binding_generation: string;
  binding_epoch_seq: number;
  binding_revision: number;
  state: MeetingBindingState;
  cancel_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function authorityFromRow(row: AuthorityRow | null): DeviceAuthorityState | null {
  if (!row) return null;
  return {
    epochId: row.current_epoch_id,
    authorityRevision: Number(row.authority_revision),
    nextBindingEpochSeq: Number(row.next_binding_epoch_seq),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function bindingFromRow(row: BindingRow | null): MeetingServiceBinding | null {
  if (!row) return null;
  return {
    meetingId: row.meeting_id,
    deviceEpochId: row.device_epoch_id,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    bindingEpochSeq: Number(row.binding_epoch_seq),
    bindingRevision: Number(row.binding_revision),
    state: row.state,
    cancelRevision: Number(row.cancel_revision),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

async function readAuthority(database: SQLiteDatabase): Promise<DeviceAuthorityState | null> {
  return authorityFromRow(await database.getFirstAsync<AuthorityRow>(
    `SELECT current_epoch_id, authority_revision, next_binding_epoch_seq, updated_at_ms
       FROM device_authority_state WHERE singleton_id = 1`,
  ));
}

export async function getDeviceAuthorityState(): Promise<DeviceAuthorityState | null> {
  return readAuthority(await openMeetingDatabase());
}

/**
 * Makes the device epoch visible to the local owner. Repeating this call is
 * safe; a retired epoch cannot silently become active again.
 */
export async function ensureDeviceEpoch(epochId: string, nowMs = Date.now()): Promise<DeviceAuthorityState> {
  const normalizedEpochId = required(epochId, 'epochId');
  return withMeetingDatabaseTransaction(async database => {
    const epoch = await database.getFirstAsync<{ status: DeviceEpochStatus }>(
      'SELECT status FROM device_epochs WHERE epoch_id = ?',
      normalizedEpochId,
    );
    if (epoch?.status === 'retired') throw new Error('设备 epoch 已撤销');
    await database.runAsync(
      `INSERT OR IGNORE INTO device_epochs (epoch_id, status, created_at_ms)
       VALUES (?, 'active', ?)`,
      normalizedEpochId,
      nowMs,
    );
    const current = await readAuthority(database);
    if (!current) throw new Error('设备权威状态缺失');
    if (current.epochId !== normalizedEpochId) {
      await database.runAsync(
        `UPDATE device_authority_state
            SET current_epoch_id = ?, authority_revision = authority_revision + 1, updated_at_ms = ?
          WHERE singleton_id = 1`,
        normalizedEpochId,
        nowMs,
      );
    }
    const result = await readAuthority(database);
    if (!result || result.epochId !== normalizedEpochId) throw new Error('设备 epoch 激活失败');
    return result;
  });
}

export async function retireDeviceEpoch(epochId: string, nowMs = Date.now()): Promise<boolean> {
  const normalizedEpochId = required(epochId, 'epochId');
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      `UPDATE device_epochs SET status = 'retired', retired_at_ms = ?
        WHERE epoch_id = ? AND status = 'active'`,
      nowMs,
      normalizedEpochId,
    );
    if (Number(result.changes) === 0) return false;
    await database.runAsync(
      `UPDATE device_authority_state
          SET current_epoch_id = CASE WHEN current_epoch_id = ? THEN NULL ELSE current_epoch_id END,
              authority_revision = authority_revision + 1,
              updated_at_ms = ?
        WHERE singleton_id = 1`,
      normalizedEpochId,
      nowMs,
    );
    return true;
  });
}

export async function getMeetingServiceBinding(meetingId: string): Promise<MeetingServiceBinding | null> {
  const normalizedMeetingId = required(meetingId, 'meetingId');
  return bindingFromRow(await (await openMeetingDatabase()).getFirstAsync<BindingRow>(
    `SELECT meeting_id, device_epoch_id, binding_id, binding_generation, binding_epoch_seq,
            binding_revision, state, cancel_revision, created_at_ms, updated_at_ms
       FROM meeting_service_bindings WHERE meeting_id = ?`,
    normalizedMeetingId,
  ));
}

export interface CreateMeetingServiceBindingInput {
  meetingId: string;
  bindingId: string;
  bindingGeneration: string;
  epochId: string;
  nowMs?: number;
}

export async function createMeetingServiceBinding(
  input: CreateMeetingServiceBindingInput,
): Promise<MeetingServiceBinding> {
  const meetingId = required(input.meetingId, 'meetingId');
  const bindingId = required(input.bindingId, 'bindingId');
  const bindingGeneration = required(input.bindingGeneration, 'bindingGeneration');
  const epochId = required(input.epochId, 'epochId');
  const nowMs = input.nowMs ?? Date.now();
  return withMeetingDatabaseTransaction(async database => {
    const authority = await readAuthority(database);
    if (!authority || authority.epochId !== epochId) throw new Error('设备 epoch 未激活');
    const existing = bindingFromRow(await database.getFirstAsync<BindingRow>(
      `SELECT meeting_id, device_epoch_id, binding_id, binding_generation, binding_epoch_seq,
              binding_revision, state, cancel_revision, created_at_ms, updated_at_ms
         FROM meeting_service_bindings WHERE meeting_id = ?`,
      meetingId,
    ));
    if (existing) {
      if (existing.bindingId !== bindingId || existing.bindingGeneration !== bindingGeneration) {
        throw new Error('会议 binding generation 冲突');
      }
      return existing;
    }
    const sequence = authority.nextBindingEpochSeq;
    await database.runAsync(
      `UPDATE device_authority_state
          SET next_binding_epoch_seq = ?, updated_at_ms = ?
        WHERE singleton_id = 1 AND current_epoch_id = ? AND next_binding_epoch_seq = ?`,
      sequence + 1,
      nowMs,
      epochId,
      sequence,
    );
    await database.runAsync(
      `INSERT INTO meeting_service_bindings (
        meeting_id, device_epoch_id, binding_id, binding_generation, binding_epoch_seq,
        binding_revision, state, cancel_revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 1, 'active', 0, ?, ?)`,
      meetingId,
      epochId,
      bindingId,
      bindingGeneration,
      sequence,
      nowMs,
      nowMs,
    );
    const created = bindingFromRow(await database.getFirstAsync<BindingRow>(
      `SELECT meeting_id, device_epoch_id, binding_id, binding_generation, binding_epoch_seq,
              binding_revision, state, cancel_revision, created_at_ms, updated_at_ms
         FROM meeting_service_bindings WHERE meeting_id = ?`,
      meetingId,
    ));
    if (!created) throw new Error('会议 binding 创建失败');
    return created;
  });
}

export async function advanceMeetingBinding(
  meetingId: string,
  expectedRevision: number,
  nowMs = Date.now(),
): Promise<boolean> {
  const normalizedMeetingId = required(meetingId, 'meetingId');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('binding revision 无效');
  }
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      `UPDATE meeting_service_bindings
          SET binding_revision = binding_revision + 1, updated_at_ms = ?
        WHERE meeting_id = ? AND state = 'active' AND binding_revision = ?`,
      nowMs,
      normalizedMeetingId,
      expectedRevision,
    );
    return Number(result.changes) === 1;
  });
}

export async function beginMeetingBindingPurge(
  meetingId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const normalizedMeetingId = required(meetingId, 'meetingId');
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      `UPDATE meeting_service_bindings
          SET state = 'purging', cancel_revision = cancel_revision + 1,
              binding_revision = binding_revision + 1, updated_at_ms = ?
        WHERE meeting_id = ? AND state = 'active'`,
      nowMs,
      normalizedMeetingId,
    );
    return Number(result.changes) === 1;
  });
}
