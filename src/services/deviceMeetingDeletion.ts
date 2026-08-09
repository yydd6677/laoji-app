import { DeviceApiError, deleteMeetingBinding } from './deviceApi';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { clearDeviceTranscriptTask } from './deviceTranscriptTasks';

/**
 * The phone owns meeting deletion.  This small registry is only a durable
 * notification queue for service-side cleanup; it never stores a title,
 * transcript, audio URI or other meeting content.
 */
const OUTBOX_KEY = '@laoji:deviceMeetingDeletionOutbox:v1';
const MAX_RECORD_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

export interface DeviceMeetingDeletionRecord {
  meetingId: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastErrorCode?: string;
}

type Registry = Record<string, DeviceMeetingDeletionRecord>;

let mutation = Promise.resolve();
let drain: Promise<void> | null = null;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizedMeetingId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isUuid(normalized)) throw new Error('本机会议标识无效');
  return normalized;
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(8, Math.floor(attempts) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, 30_000 * (2 ** exponent));
}

async function readRegistry(): Promise<Registry> {
  const raw = await getAppStorageItem(OUTBOX_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A damaged cleanup queue must not block the app.  The meeting is already
    // locally deleted, so discard only this metadata registry.
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const now = Date.now();
  const records: Registry = {};
  Object.entries(parsed).forEach(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Partial<DeviceMeetingDeletionRecord>;
    try {
      const meetingId = normalizedMeetingId(typeof item.meetingId === 'string' ? item.meetingId : key);
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
      const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs) || now - createdAtMs > MAX_RECORD_AGE_MS) return;
      const attempts = Number.isSafeInteger(item.attempts) && Number(item.attempts) >= 0
        ? Number(item.attempts)
        : 0;
      records[meetingId] = {
        meetingId,
        createdAt,
        updatedAt,
        attempts,
        nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : undefined,
        lastErrorCode: typeof item.lastErrorCode === 'string' ? item.lastErrorCode.slice(0, 80) : undefined,
      };
    } catch {
      // Ignore malformed rows rather than making an otherwise local-first app
      // unusable because a stale cleanup hint was corrupted.
    }
  });
  return records;
}

async function writeRegistry(records: Registry): Promise<void> {
  if (Object.keys(records).length === 0) {
    await removeAppStorageItem(OUTBOX_KEY);
    return;
  }
  await setAppStorageItem(OUTBOX_KEY, JSON.stringify(records));
}

function mutate(mutator: (records: Registry) => void): Promise<void> {
  const operation = mutation
    .catch(() => undefined)
    .then(async () => {
      const records = await readRegistry();
      mutator(records);
      await writeRegistry(records);
    });
  mutation = operation;
  return operation;
}

export async function enqueueDeviceMeetingDeletion(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  await clearDeviceTranscriptTask(normalized).catch(() => undefined);
  const now = new Date().toISOString();
  await mutate(records => {
    const existing = records[normalized];
    records[normalized] = {
      meetingId: normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      attempts: existing?.attempts ?? 0,
      nextAttemptAt: existing?.nextAttemptAt,
      lastErrorCode: existing?.lastErrorCode,
    };
  });
  diagnosticAudit('device_delete_outbox_enqueued', { meeting_id_suffix: normalized.slice(-8) });
}

export async function listDeviceMeetingDeletions(nowMs = Date.now()): Promise<DeviceMeetingDeletionRecord[]> {
  await mutation.catch(() => undefined);
  const records = await readRegistry();
  // Persist age-based pruning so old failed cleanup hints cannot grow without
  // bound.  A tombstone older than the local recycle-bin horizon is no longer
  // useful to a fresh device epoch.
  const before = Object.keys(records).length;
  const fresh = Object.fromEntries(Object.entries(records).filter(([, item]) => {
    const createdAtMs = Date.parse(item.createdAt);
    return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= MAX_RECORD_AGE_MS;
  })) as Registry;
  if (Object.keys(fresh).length !== before) await writeRegistry(fresh);
  return Object.values(fresh).sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.meetingId.localeCompare(right.meetingId)
  ));
}

function isAlreadyGone(error: unknown): boolean {
  return error instanceof DeviceApiError && [404, 409].includes(error.status);
}

async function recordFailure(item: DeviceMeetingDeletionRecord, error: unknown): Promise<void> {
  const code = error instanceof DeviceApiError
    ? error.code || `HTTP_${error.status}`
    : error instanceof Error ? error.name : 'UNKNOWN';
  const attempts = Math.min(Number.MAX_SAFE_INTEGER, item.attempts + 1);
  const next = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
  await mutate(records => {
    const current = records[item.meetingId];
    if (!current || current.createdAt !== item.createdAt) return;
    records[item.meetingId] = {
      ...current,
      attempts,
      updatedAt: new Date().toISOString(),
      nextAttemptAt: next,
      lastErrorCode: code,
    };
  });
  diagnosticWarn('[device-delete] remote cleanup deferred', { code });
}

async function removeCompleted(item: DeviceMeetingDeletionRecord): Promise<void> {
  await mutate(records => {
    if (records[item.meetingId]?.createdAt === item.createdAt) delete records[item.meetingId];
  });
  diagnosticAudit('device_delete_outbox_completed', { meeting_id_suffix: item.meetingId.slice(-8) });
}

/**
 * Drain due cleanup hints.  A failed request remains durable and is retried
 * with bounded backoff on the next foreground/startup pass.  This function is
 * intentionally best effort and never belongs in a user-facing delete await.
 */
export async function drainDeviceMeetingDeletionOutbox(force = false): Promise<void> {
  if (drain) return drain;
  drain = (async () => {
    const now = Date.now();
    const items = await listDeviceMeetingDeletions(now);
    for (const item of items.slice(0, 8)) {
      if (!force && item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) continue;
      try {
        await deleteMeetingBinding(item.meetingId);
        await removeCompleted(item);
      } catch (error) {
        if (isAlreadyGone(error)) await removeCompleted(item);
        else await recordFailure(item, error);
      }
    }
  })().catch(error => {
    diagnosticWarn('[device-delete] outbox drain failed', error);
  }).finally(() => {
    drain = null;
  });
  return drain;
}

export async function clearDeviceMeetingDeletionOutbox(): Promise<void> {
  await mutate(records => {
    Object.keys(records).forEach(key => delete records[key]);
  });
}
