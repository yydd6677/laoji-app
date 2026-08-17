import * as SecureStore from 'expo-secure-store';

/**
 * Temporary v1 compatibility journal. It retains only the old static-device
 * epoch close request until the v1 barrier drains. The v2 purge credential
 * never enters this file or SecureStore; its only owner is the native
 * Keystore-backed purge-only journal.
 */
const LEGACY_EPOCH_JOURNAL_KEY = 'laoji.device.v1.epoch-cleanup.journal';
const HISTORICAL_EPOCH_JOURNAL_KEY = 'laoji.purge-only.v1.journal';

export type LegacyEpochCleanupState = 'registering' | 'pending' | 'confirmed';

export interface LegacyEpochCleanupEntry {
  schemaVersion: 1;
  epochId: string;
  state: LegacyEpochCleanupState;
  createdAtMs: number;
  updatedAtMs: number;
}

function validEpoch(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalize(value: unknown): LegacyEpochCleanupEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<LegacyEpochCleanupEntry>;
  if (candidate.schemaVersion !== 1 || typeof candidate.epochId !== 'string'
    || !validEpoch(candidate.epochId)
    || !['registering', 'pending', 'confirmed'].includes(String(candidate.state))
    || !Number.isSafeInteger(candidate.createdAtMs)
    || !Number.isSafeInteger(candidate.updatedAtMs)) return null;
  return {
    schemaVersion: 1,
    epochId: candidate.epochId.toLowerCase(),
    state: candidate.state as LegacyEpochCleanupState,
    createdAtMs: candidate.createdAtMs as number,
    updatedAtMs: candidate.updatedAtMs as number,
  };
}

export async function readLegacyEpochCleanupJournal(): Promise<LegacyEpochCleanupEntry | null> {
  const [current, historical] = await Promise.all([
    SecureStore.getItemAsync(LEGACY_EPOCH_JOURNAL_KEY),
    SecureStore.getItemAsync(HISTORICAL_EPOCH_JOURNAL_KEY),
  ]);
  const raw = current ?? historical;
  if (!raw) return null;
  try {
    const entry = normalize(JSON.parse(raw));
    if (!current && historical && entry) {
      await SecureStore.setItemAsync(LEGACY_EPOCH_JOURNAL_KEY, JSON.stringify(entry));
      await SecureStore.deleteItemAsync(HISTORICAL_EPOCH_JOURNAL_KEY);
    }
    return entry;
  } catch {
    await Promise.all([
      SecureStore.deleteItemAsync(LEGACY_EPOCH_JOURNAL_KEY),
      SecureStore.deleteItemAsync(HISTORICAL_EPOCH_JOURNAL_KEY),
    ]);
    return null;
  }
}

export async function writeLegacyEpochCleanupJournal(
  epochId: string,
  state: LegacyEpochCleanupState,
  nowMs = Date.now(),
): Promise<LegacyEpochCleanupEntry> {
  if (!validEpoch(epochId)) throw new Error('清除 epoch 无效');
  const previous = await readLegacyEpochCleanupJournal();
  const entry: LegacyEpochCleanupEntry = {
    schemaVersion: 1,
    epochId: epochId.toLowerCase(),
    state,
    createdAtMs: previous?.epochId === epochId.toLowerCase() ? previous.createdAtMs : nowMs,
    updatedAtMs: nowMs,
  };
  await SecureStore.setItemAsync(LEGACY_EPOCH_JOURNAL_KEY, JSON.stringify(entry));
  return entry;
}

export async function clearLegacyEpochCleanupJournal(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LEGACY_EPOCH_JOURNAL_KEY),
    SecureStore.deleteItemAsync(HISTORICAL_EPOCH_JOURNAL_KEY),
  ]);
}

export const legacyEpochCleanupStorageKey = LEGACY_EPOCH_JOURNAL_KEY;
