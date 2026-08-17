import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../data/db/openDatabase';

export type VNextBarrierState = 'open' | 'draining' | 'closed';

export interface VNextCapabilityBarrier {
  capability: string;
  state: VNextBarrierState;
  lastLegacySubmitAtMs: number | null;
  legacySubmitCount: number;
  updatedAtMs: number;
}

type BarrierRow = {
  capability: string;
  barrier_state: VNextBarrierState;
  last_legacy_submit_at_ms: number | null;
  legacy_submit_count: number;
  updated_at_ms: number;
};

function normalizedCapability(value: string): string {
  const capability = value.trim();
  if (!capability || capability.length > 120 || /[\u0000-\u001f\u007f]/.test(capability)) {
    throw new Error('vNext capability 无效');
  }
  return capability;
}

function fromRow(row: BarrierRow | null): VNextCapabilityBarrier | null {
  if (!row) return null;
  return {
    capability: row.capability,
    state: row.barrier_state,
    lastLegacySubmitAtMs: row.last_legacy_submit_at_ms === null
      ? null
      : Number(row.last_legacy_submit_at_ms),
    legacySubmitCount: Number(row.legacy_submit_count),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export async function getVNextCapabilityBarrier(
  capabilityValue: string,
): Promise<VNextCapabilityBarrier | null> {
  const capability = normalizedCapability(capabilityValue);
  const database = await openMeetingDatabase();
  return fromRow(await database.getFirstAsync<BarrierRow>(
    `SELECT capability, barrier_state, last_legacy_submit_at_ms,
            legacy_submit_count, updated_at_ms
       FROM vnext_cutover_tombstones WHERE capability = ?`,
    capability,
  ));
}

/** A closed barrier is monotonic. An app restart or failed probe cannot reopen legacy writes. */
export async function closeVNextCapabilityBarrier(
  capabilityValue: string,
  nowMs = Date.now(),
): Promise<VNextCapabilityBarrier> {
  const capability = normalizedCapability(capabilityValue);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('vNext barrier 时间无效');
  return withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `INSERT INTO vnext_cutover_tombstones (
         capability, barrier_state, last_legacy_submit_at_ms,
         legacy_submit_count, updated_at_ms
       ) VALUES (?, 'closed', NULL, 0, ?)
       ON CONFLICT(capability) DO UPDATE SET
         barrier_state = 'closed',
         updated_at_ms = MAX(vnext_cutover_tombstones.updated_at_ms, excluded.updated_at_ms)`,
      capability,
      nowMs,
    );
    const row = await database.getFirstAsync<BarrierRow>(
      `SELECT capability, barrier_state, last_legacy_submit_at_ms,
              legacy_submit_count, updated_at_ms
         FROM vnext_cutover_tombstones WHERE capability = ?`,
      capability,
    );
    const barrier = fromRow(row);
    if (!barrier || barrier.state !== 'closed') throw new Error('vNext barrier 未能持久化');
    return barrier;
  });
}

export async function recordVNextLegacySubmit(
  capabilityValue: string,
  nowMs = Date.now(),
): Promise<void> {
  const capability = normalizedCapability(capabilityValue);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('vNext legacy 时间无效');
  await withMeetingDatabaseTransaction(async database => {
    const existing = await database.getFirstAsync<BarrierRow>(
      `SELECT capability, barrier_state, last_legacy_submit_at_ms,
              legacy_submit_count, updated_at_ms
         FROM vnext_cutover_tombstones WHERE capability = ?`,
      capability,
    );
    if (existing?.barrier_state === 'closed') {
      throw new Error('vNext capability 已关闭旧提交');
    }
    await database.runAsync(
      `INSERT INTO vnext_cutover_tombstones (
         capability, barrier_state, last_legacy_submit_at_ms,
         legacy_submit_count, updated_at_ms
       ) VALUES (?, 'open', ?, 1, ?)
       ON CONFLICT(capability) DO UPDATE SET
         last_legacy_submit_at_ms = excluded.last_legacy_submit_at_ms,
         legacy_submit_count = vnext_cutover_tombstones.legacy_submit_count + 1,
         updated_at_ms = MAX(vnext_cutover_tombstones.updated_at_ms, excluded.updated_at_ms)`,
      capability,
      nowMs,
      nowMs,
    );
  });
}

export async function selectClosedVNextCapability(
  capabilityValue: string,
  remoteReady: boolean,
): Promise<boolean> {
  if (remoteReady) {
    await closeVNextCapabilityBarrier(capabilityValue);
    return true;
  }
  return (await getVNextCapabilityBarrier(capabilityValue))?.state === 'closed';
}
