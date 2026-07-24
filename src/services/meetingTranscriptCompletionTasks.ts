import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const PENDING_TRANSCRIPT_COMPLETIONS_KEY = '@laoji:pendingMeetingTranscriptCompletions:v1';
const ACCOUNT_COMPLETION_RETENTION_MS = 23 * 60 * 60 * 1000;

export type MeetingTranscriptCompletionTaskResult = 'pending' | 'failed';

export interface PendingMeetingTranscriptCompletion {
  meetingId: string;
  remoteMeetingId: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  attemptCount: number;
  lastResult?: MeetingTranscriptCompletionTaskResult;
  nextAttemptAt?: string;
}

type PendingTranscriptCompletionMap = Record<string, PendingMeetingTranscriptCompletion>;

let pendingStorageMutation: Promise<void> = Promise.resolve();

export function meetingTranscriptCompletionRetryDelayMs(
  result: MeetingTranscriptCompletionTaskResult,
  attemptCount: number,
): number {
  if (result === 'pending') return 15_000;
  const exponent = Math.max(0, Math.min(8, Math.floor(attemptCount) - 1));
  return Math.min(15 * 60 * 1000, 30_000 * (2 ** exponent));
}

function normalizedIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 200
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

export async function listPendingMeetingTranscriptCompletions(
  storageScope: string,
  nowMs = Date.now(),
): Promise<PendingMeetingTranscriptCompletion[]> {
  await pendingStorageMutation.catch(() => {});
  const records = await readPendingCompletions(storageScope);
  const expiredRecords = Object.values(records)
    .filter(item => {
      const createdAtMs = Date.parse(item.createdAt);
      return !Number.isFinite(createdAtMs)
        || nowMs - createdAtMs >= ACCOUNT_COMPLETION_RETENTION_MS;
    })
    .map(item => ({ meetingId: item.meetingId, createdAt: item.createdAt }));
  if (expiredRecords.length > 0) {
    await mutatePendingCompletions(storageScope, current => {
      expiredRecords.forEach(expired => {
        if (current[expired.meetingId]?.createdAt === expired.createdAt) {
          delete current[expired.meetingId];
        }
      });
    });
  }
  const expired = new Set(expiredRecords.map(item => item.meetingId));
  return Object.values(records)
    .filter(item => !expired.has(item.meetingId))
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.meetingId.localeCompare(right.meetingId)
    ));
}

export async function savePendingMeetingTranscriptCompletion(
  storageScope: string,
  meetingId: string,
  remoteMeetingId: string,
): Promise<PendingMeetingTranscriptCompletion> {
  const normalizedMeetingId = normalizedIdentity(meetingId, 'meeting ID');
  const normalizedRemoteMeetingId = normalizedIdentity(remoteMeetingId, 'remote meeting ID');
  const now = new Date().toISOString();
  let saved: PendingMeetingTranscriptCompletion | null = null;
  await mutatePendingCompletions(storageScope, records => {
    const existing = records[normalizedMeetingId];
    saved = {
      meetingId: normalizedMeetingId,
      remoteMeetingId: normalizedRemoteMeetingId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAttemptAt: existing?.lastAttemptAt,
      attemptCount: existing?.attemptCount ?? 0,
      lastResult: existing?.lastResult,
      nextAttemptAt: existing?.nextAttemptAt,
    };
    records[normalizedMeetingId] = saved;
  });
  if (!saved) throw new Error('pending transcript completion was not saved');
  return saved;
}

export async function recordMeetingTranscriptCompletionAttempt(
  storageScope: string,
  meetingId: string,
): Promise<void> {
  const normalizedMeetingId = normalizedIdentity(meetingId, 'meeting ID');
  const attemptedAt = new Date().toISOString();
  await mutatePendingCompletions(storageScope, records => {
    const existing = records[normalizedMeetingId];
    if (!existing) return;
    records[normalizedMeetingId] = {
      ...existing,
      updatedAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      attemptCount: Math.min(Number.MAX_SAFE_INTEGER, existing.attemptCount + 1),
      lastResult: undefined,
      nextAttemptAt: undefined,
    };
  });
}

export async function recordMeetingTranscriptCompletionResult(
  storageScope: string,
  meetingId: string,
  result: MeetingTranscriptCompletionTaskResult,
): Promise<void> {
  const normalizedMeetingId = normalizedIdentity(meetingId, 'meeting ID');
  const updated = new Date();
  const updatedAt = updated.toISOString();
  await mutatePendingCompletions(storageScope, records => {
    const existing = records[normalizedMeetingId];
    if (!existing) return;
    records[normalizedMeetingId] = {
      ...existing,
      updatedAt,
      lastResult: result,
      nextAttemptAt: new Date(
        updated.getTime() + meetingTranscriptCompletionRetryDelayMs(result, existing.attemptCount),
      ).toISOString(),
    };
  });
}

export async function clearPendingMeetingTranscriptCompletion(
  storageScope: string,
  meetingId: string,
): Promise<void> {
  const normalizedMeetingId = normalizedIdentity(meetingId, 'meeting ID');
  await mutatePendingCompletions(storageScope, records => {
    delete records[normalizedMeetingId];
  });
}

function mutatePendingCompletions(
  storageScope: string,
  mutator: (records: PendingTranscriptCompletionMap) => void,
): Promise<void> {
  const storageKey = pendingCompletionsKey(storageScope);
  const operation = pendingStorageMutation
    .catch(() => {})
    .then(async () => {
      const records = await readPendingCompletions(storageScope);
      mutator(records);
      if (Object.keys(records).length === 0) {
        await removeAppStorageItem(storageKey);
      } else {
        await setAppStorageItem(storageKey, JSON.stringify(records));
      }
    });
  pendingStorageMutation = operation;
  return operation;
}

async function readPendingCompletions(storageScope: string): Promise<PendingTranscriptCompletionMap> {
  const raw = await getAppStorageItem(pendingCompletionsKey(storageScope));
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pending transcript completion registry is invalid');
  }
  const records: PendingTranscriptCompletionMap = {};
  Object.entries(parsed).forEach(([meetingId, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Partial<PendingMeetingTranscriptCompletion>;
    try {
      const normalizedMeetingId = normalizedIdentity(meetingId, 'meeting ID');
      const remoteMeetingId = normalizedIdentity(item.remoteMeetingId ?? '', 'remote meeting ID');
      records[normalizedMeetingId] = {
        meetingId: normalizedMeetingId,
        remoteMeetingId,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
        lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : undefined,
        attemptCount: Number.isSafeInteger(item.attemptCount) && Number(item.attemptCount) >= 0
          ? Number(item.attemptCount)
          : 0,
        lastResult: item.lastResult === 'pending' || item.lastResult === 'failed'
          ? item.lastResult
          : undefined,
        nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : undefined,
      };
    } catch {
      // Ignore malformed entries without discarding valid tasks in this scope.
    }
  });
  return records;
}

function pendingCompletionsKey(storageScope: string): string {
  const normalized = normalizedIdentity(storageScope, 'transcript completion storage scope');
  return `${PENDING_TRANSCRIPT_COMPLETIONS_KEY}:${normalized}`;
}

export function resetMeetingTranscriptCompletionTaskStorageForTests(): void {
  pendingStorageMutation = Promise.resolve();
}
