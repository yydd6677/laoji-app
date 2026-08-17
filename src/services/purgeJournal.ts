import * as SecureStore from 'expo-secure-store';

/**
 * The purge journal is deliberately kept outside AsyncStorage and the
 * business database.  It is the only state that may survive a local erase:
 * it contains no meeting identifiers, content, paths, or credentials.
 */
const PURGE_JOURNAL_KEY = 'laoji.purge-only.v1.journal';

export type PurgeJournalState = 'registering' | 'pending' | 'confirmed';

export interface PurgeJournalEntry {
  schemaVersion: 1;
  epochId: string;
  state: PurgeJournalState;
  createdAtMs: number;
  updatedAtMs: number;
}

function validEpoch(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalize(value: unknown): PurgeJournalEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PurgeJournalEntry>;
  if (candidate.schemaVersion !== 1 || typeof candidate.epochId !== 'string'
    || !validEpoch(candidate.epochId)
    || !['registering', 'pending', 'confirmed'].includes(String(candidate.state))
    || !Number.isSafeInteger(candidate.createdAtMs)
    || !Number.isSafeInteger(candidate.updatedAtMs)) return null;
  const createdAtMs = candidate.createdAtMs as number;
  const updatedAtMs = candidate.updatedAtMs as number;
  return {
    schemaVersion: 1,
    epochId: candidate.epochId.toLowerCase(),
    state: candidate.state as PurgeJournalState,
    createdAtMs,
    updatedAtMs,
  };
}

export async function readPurgeJournal(): Promise<PurgeJournalEntry | null> {
  const raw = await SecureStore.getItemAsync(PURGE_JOURNAL_KEY);
  if (!raw) return null;
  try {
    return normalize(JSON.parse(raw));
  } catch {
    // A corrupt journal is not a reason to retain business data.  Drop only
    // the unusable control record and let the next erase create a new one.
    await SecureStore.deleteItemAsync(PURGE_JOURNAL_KEY);
    return null;
  }
}

export async function writePurgeJournal(
  epochId: string,
  state: PurgeJournalState,
  nowMs = Date.now(),
): Promise<PurgeJournalEntry> {
  if (!validEpoch(epochId)) throw new Error('清除 epoch 无效');
  const previous = await readPurgeJournal();
  const entry: PurgeJournalEntry = {
    schemaVersion: 1,
    epochId: epochId.toLowerCase(),
    state,
    createdAtMs: previous?.epochId === epochId.toLowerCase() ? previous.createdAtMs : nowMs,
    updatedAtMs: nowMs,
  };
  await SecureStore.setItemAsync(PURGE_JOURNAL_KEY, JSON.stringify(entry));
  return entry;
}

export async function clearPurgeJournal(): Promise<void> {
  await SecureStore.deleteItemAsync(PURGE_JOURNAL_KEY);
}

export const purgeJournalStorageKey = PURGE_JOURNAL_KEY;
