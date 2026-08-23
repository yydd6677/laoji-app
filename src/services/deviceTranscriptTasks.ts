import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import { ensureLocalMeetingServiceBinding } from './deviceAuthority';
import { ensureDeviceEpoch } from '../data/repositories/vnext/deviceAuthorityRepository';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import {
  createDeviceOperation,
  getLatestDeviceOperation,
  listPendingDeviceOperations,
  updateDeviceOperation,
  type DeviceOperationRecord,
} from '../data/repositories/vnext/deviceOperationsRepository';

/**
 * Compatibility facade for the old transcript-task callers.
 *
 * The durable owner is now SQLite `device_operations`. AsyncStorage is read
 * once only to promote records created by the previous build; it is never
 * written again and can therefore not become a second task owner.
 */
const LEGACY_STORAGE_KEY = '@laoji:deviceTranscriptTasks:v1';

export type DeviceTranscriptTaskState = 'pending' | 'failed';
export type DeviceTranscriptTaskPhase = 'queued' | 'running';

export interface DeviceTranscriptTaskRecord {
  meetingId: string;
  taskId: string;
  state: DeviceTranscriptTaskState;
  phase?: DeviceTranscriptTaskPhase;
  errorCode?: string;
  eventCursor: number;
  eventTotal: number | null;
  updatedAt: string;
}

type LegacyRecord = DeviceTranscriptTaskRecord;
type LegacyRegistry = Record<string, LegacyRecord>;
const listeners = new Set<(meetingId: string) => void>();

function notifyChanged(meetingId: string): void {
  listeners.forEach(listener => {
    try { listener(meetingId); } catch { /* observers cannot break the durable write */ }
  });
}

export function subscribeDeviceTranscriptTaskChanged(
  listener: (meetingId: string) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function validId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizedMeetingId(value: string): string {
  const result = value.trim().toLowerCase();
  if (!validId(result)) throw new Error('本机会议标识无效');
  return result;
}

function normalizedTaskId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 160 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('设备转写任务标识无效');
  }
  return result;
}

function operationId(meetingId: string, taskId: string): string {
  return `transcript:${meetingId}:${taskId}`;
}

async function operationMeetingId(meetingId: string): Promise<string> {
  const normalized = normalizedMeetingId(meetingId);
  return await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(normalized, 'guest')
    ?? normalized;
}

function toRecord(operation: DeviceOperationRecord): DeviceTranscriptTaskRecord | null {
  if (operation.remoteState === 'success' || operation.remoteState === 'cancelled') return null;
  const state: DeviceTranscriptTaskState = operation.remoteState === 'failure' ? 'failed' : 'pending';
  return {
    meetingId: operation.entityId,
    taskId: operation.generationId,
    state,
    phase: state === 'pending' && operation.remoteState === 'running' ? 'running' : state === 'pending' ? 'queued' : undefined,
    errorCode: state === 'failed' ? operation.errorCode ?? undefined : undefined,
    eventCursor: operation.progressDone ?? 0,
    eventTotal: operation.progressTotal,
    updatedAt: new Date(operation.updatedAtMs).toISOString(),
  };
}

async function readLegacyRegistry(): Promise<LegacyRegistry> {
  const raw = await getAppStorageItem(LEGACY_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const registry: LegacyRegistry = {};
    Object.entries(parsed).forEach(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const item = value as Partial<LegacyRecord>;
      try {
        const meetingId = normalizedMeetingId(typeof item.meetingId === 'string' ? item.meetingId : key);
        const taskId = normalizedTaskId(typeof item.taskId === 'string' ? item.taskId : '');
        const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : '';
        if (!Number.isFinite(Date.parse(updatedAt))) return;
        registry[meetingId] = {
          meetingId,
          taskId,
          state: item.state === 'failed' ? 'failed' : 'pending',
          phase: item.phase === 'running' ? 'running' : 'queued',
          errorCode: typeof item.errorCode === 'string' ? item.errorCode.slice(0, 80) : undefined,
          eventCursor: Number.isSafeInteger(item.eventCursor) && Number(item.eventCursor) >= 0
            ? Number(item.eventCursor)
            : 0,
          eventTotal: Number.isSafeInteger(item.eventTotal) && Number(item.eventTotal) >= 0
            ? Number(item.eventTotal)
            : null,
          updatedAt,
        };
      } catch {
        // Malformed compatibility data must never block the local meeting UI.
      }
    });
    return registry;
  } catch {
    return {};
  }
}

async function removeLegacyRecord(meetingId: string): Promise<void> {
  const registry = await readLegacyRegistry();
  if (!registry[meetingId]) return;
  delete registry[meetingId];
  if (Object.keys(registry).length === 0) {
    await removeAppStorageItem(LEGACY_STORAGE_KEY);
    return;
  }
  await setAppStorageItem(LEGACY_STORAGE_KEY, JSON.stringify(registry));
}

async function promoteLegacy(meetingId: string): Promise<DeviceTranscriptTaskRecord | null> {
  const registry = await readLegacyRegistry();
  const legacy = registry[meetingId];
  if (!legacy) return null;
  await rememberDeviceTranscriptTask(legacy.meetingId, legacy.taskId);
  const entityId = await operationMeetingId(meetingId);
  const current = await getLatestDeviceOperation('transcript', entityId);
  if (legacy.state === 'failed' && current && current.remoteState !== 'failure') {
    await updateDeviceOperation({
      operationId: current.operationId,
      expectedRevision: current.operationRevision,
      state: 'failure',
      errorCode: legacy.errorCode ?? null,
      nowMs: Date.parse(legacy.updatedAt) || Date.now(),
    });
  } else if (legacy.state === 'pending' && legacy.phase === 'running' && current && current.remoteState === 'queued') {
    await updateDeviceOperation({
      operationId: current.operationId,
      expectedRevision: current.operationRevision,
      state: 'running',
      nowMs: Date.parse(legacy.updatedAt) || Date.now(),
    });
  }
  await removeLegacyRecord(meetingId).catch(() => undefined);
  const promoted = await getLatestDeviceOperation('transcript', entityId);
  const record = promoted ? toRecord(promoted) : null;
  return record ? { ...record, meetingId } : null;
}

export async function getDeviceTranscriptTask(meetingId: string): Promise<DeviceTranscriptTaskRecord | null> {
  const normalized = normalizedMeetingId(meetingId);
  const operation = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (operation) {
    const record = toRecord(operation);
    return record ? { ...record, meetingId: normalized } : null;
  }
  return promoteLegacy(normalized);
}

/**
 * Returns every transcript task recoverable by this installation, including
 * tasks whose meeting card is temporarily absent from the rendered list.
 */
export async function listPendingDeviceTranscriptTasks(
  limit = 64,
): Promise<readonly DeviceTranscriptTaskRecord[]> {
  const identity = await getOrCreateDeviceIdentity();
  const operations = await listPendingDeviceOperations({
    capability: 'transcript',
    scopeKey: 'guest',
    deviceEpochId: identity.epochId,
    limit,
  });
  const records = await Promise.all(operations.map(async operation => {
    const record = toRecord(operation);
    if (record?.state !== 'pending') return null;
    const aggregate = await sqliteMeetingNoteRepository.get(operation.entityId, 'guest');
    return {
      ...record,
      meetingId: aggregate?.note.legacySourceId?.trim() || operation.entityId,
    } satisfies DeviceTranscriptTaskRecord;
  }));
  return records.filter((record): record is DeviceTranscriptTaskRecord => record !== null);
}

export async function rememberDeviceTranscriptTask(meetingId: string, taskId: string): Promise<void> {
  const normalizedMeetingIdValue = normalizedMeetingId(meetingId);
  const normalizedTaskIdValue = normalizedTaskId(taskId);
  const identity = await getOrCreateDeviceIdentity();
  await ensureDeviceEpoch(identity.epochId);
  const binding = await ensureLocalMeetingServiceBinding(normalizedMeetingIdValue);
  const entityId = binding.meetingId;
  const current = await getLatestDeviceOperation('transcript', entityId);
  if (current?.generationId === normalizedTaskIdValue) return;
  await createDeviceOperation({
    operationId: operationId(entityId, normalizedTaskIdValue),
    deviceEpochId: identity.epochId,
    capability: 'transcript',
    entityId,
    entityRevision: 1,
    input: normalizedTaskIdValue,
    generationId: normalizedTaskIdValue,
    predecessorOperationId: current?.operationId ?? null,
    creationReason: current ? 'retry' : 'original',
  });
  notifyChanged(normalizedMeetingIdValue);
}

export async function markDeviceTranscriptTaskProgress(
  meetingId: string,
  phase: DeviceTranscriptTaskPhase,
): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return;
  if ((phase === 'running' && existing.remoteState === 'running')
    || (phase === 'queued' && existing.remoteState === 'queued')) return;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: phase === 'running' ? 'running' : 'queued',
  });
  if (updated) notifyChanged(normalized);
}

export async function advanceDeviceTranscriptEventCursor(
  meetingId: string,
  taskId: string,
  expectedCursor: number,
  nextCursor: number,
  eventTotal: number,
): Promise<boolean> {
  const normalized = normalizedMeetingId(meetingId);
  const normalizedTask = normalizedTaskId(taskId);
  if (
    !Number.isSafeInteger(expectedCursor) || expectedCursor < 0
    || !Number.isSafeInteger(nextCursor) || nextCursor < expectedCursor
    || !Number.isSafeInteger(eventTotal) || eventTotal < nextCursor
  ) throw new Error('设备转写事件游标无效');
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.generationId !== normalizedTask) return false;
  const current = existing.progressDone ?? 0;
  if (current >= nextCursor) return true;
  if (current !== expectedCursor || ['success', 'failure', 'cancelled'].includes(existing.remoteState ?? '')) {
    return false;
  }
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'running',
    progressDone: nextCursor,
    progressTotal: Math.max(eventTotal, existing.progressTotal ?? 0),
  });
  if (updated) notifyChanged(normalized);
  return updated !== null;
}

export async function markDeviceTranscriptTaskFailed(meetingId: string, errorCode?: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'failure',
    errorCode: errorCode?.trim().slice(0, 80) || null,
  });
  if (updated) notifyChanged(normalized);
}

export async function cancelDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'cancelled',
  });
  if (updated) notifyChanged(normalized);
}

/** Marks the durable operation successful; it is retained for idempotent replay. */
export async function clearDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') {
    await removeLegacyRecord(normalized).catch(() => undefined);
    return;
  }
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'success',
  });
  if (updated) notifyChanged(normalized);
}
