import * as SecureStore from 'expo-secure-store';

/**
 * Durable retry state for closing the current device-v1 data epoch. The v2
 * purge credential remains owned by the native Keystore-backed purge journal.
 */
const DEVICE_EPOCH_CLEANUP_JOURNAL_KEY = 'laoji.device.v1.epoch-cleanup.journal';

export type DeviceEpochCleanupState = 'registering' | 'pending' | 'confirmed';

export interface DeviceEpochCleanupEntry {
  schemaVersion: 1;
  epochId: string;
  state: DeviceEpochCleanupState;
  createdAtMs: number;
  updatedAtMs: number;
}

function validEpoch(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalize(value: unknown): DeviceEpochCleanupEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DeviceEpochCleanupEntry>;
  if (candidate.schemaVersion !== 1 || typeof candidate.epochId !== 'string'
    || !validEpoch(candidate.epochId)
    || !['registering', 'pending', 'confirmed'].includes(String(candidate.state))
    || !Number.isSafeInteger(candidate.createdAtMs)
    || !Number.isSafeInteger(candidate.updatedAtMs)) return null;
  return {
    schemaVersion: 1,
    epochId: candidate.epochId.toLowerCase(),
    state: candidate.state as DeviceEpochCleanupState,
    createdAtMs: candidate.createdAtMs as number,
    updatedAtMs: candidate.updatedAtMs as number,
  };
}

export async function readDeviceEpochCleanupJournal(): Promise<DeviceEpochCleanupEntry | null> {
  const raw = await SecureStore.getItemAsync(DEVICE_EPOCH_CLEANUP_JOURNAL_KEY);
  if (!raw) return null;
  try {
    return normalize(JSON.parse(raw));
  } catch {
    await SecureStore.deleteItemAsync(DEVICE_EPOCH_CLEANUP_JOURNAL_KEY);
    return null;
  }
}

export async function writeDeviceEpochCleanupJournal(
  epochId: string,
  state: DeviceEpochCleanupState,
  nowMs = Date.now(),
): Promise<DeviceEpochCleanupEntry> {
  if (!validEpoch(epochId)) throw new Error('清除 epoch 无效');
  const previous = await readDeviceEpochCleanupJournal();
  const normalizedEpochId = epochId.toLowerCase();
  const entry: DeviceEpochCleanupEntry = {
    schemaVersion: 1,
    epochId: normalizedEpochId,
    state,
    createdAtMs: previous?.epochId === normalizedEpochId ? previous.createdAtMs : nowMs,
    updatedAtMs: nowMs,
  };
  await SecureStore.setItemAsync(DEVICE_EPOCH_CLEANUP_JOURNAL_KEY, JSON.stringify(entry));
  return entry;
}

export async function clearDeviceEpochCleanupJournal(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_EPOCH_CLEANUP_JOURNAL_KEY);
}
