import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const STORAGE_KEY = '@laoji:deviceTranscriptTasks:v1';
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeviceTranscriptTaskState = 'pending' | 'failed';
export type DeviceTranscriptTaskPhase = 'queued' | 'running';

export interface DeviceTranscriptTaskRecord {
  meetingId: string;
  taskId: string;
  state: DeviceTranscriptTaskState;
  phase?: DeviceTranscriptTaskPhase;
  errorCode?: string;
  updatedAt: string;
}

type Registry = Record<string, DeviceTranscriptTaskRecord>;

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

async function readRegistry(): Promise<Registry> {
  const raw = await getAppStorageItem(STORAGE_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const now = Date.now();
  const records: Registry = {};
  Object.entries(parsed).forEach(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Partial<DeviceTranscriptTaskRecord>;
    try {
      const meetingId = normalizedMeetingId(typeof item.meetingId === 'string' ? item.meetingId : key);
      const taskId = normalizedTaskId(typeof item.taskId === 'string' ? item.taskId : '');
      const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : '';
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > MAX_RECORD_AGE_MS) return;
      const state = item.state === 'failed' ? 'failed' : item.state === 'pending' ? 'pending' : null;
      if (!state) return;
      records[meetingId] = {
        meetingId,
        taskId,
        state,
        phase: state === 'pending' && item.phase === 'running' ? 'running' : state === 'pending' ? 'queued' : undefined,
        errorCode: typeof item.errorCode === 'string' ? item.errorCode.slice(0, 80) : undefined,
        updatedAt,
      };
    } catch {
      // A stale task hint must never block the local meeting list.
    }
  });
  return records;
}

async function writeRegistry(records: Registry): Promise<void> {
  if (Object.keys(records).length === 0) {
    await removeAppStorageItem(STORAGE_KEY);
    return;
  }
  await setAppStorageItem(STORAGE_KEY, JSON.stringify(records));
}

let mutation: Promise<void> = Promise.resolve();
const listeners = new Set<(meetingId: string) => void>();

function notifyChanged(meetingId: string): void {
  listeners.forEach(listener => {
    try {
      listener(meetingId);
    } catch {
      // A presentation listener must never break the durable registry write.
    }
  });
}

function mutate(
  meetingId: string,
  mutator: (records: Registry) => boolean,
): Promise<void> {
  const operation = mutation
    .catch(() => undefined)
    .then(async () => {
      const records = await readRegistry();
      if (!mutator(records)) return;
      await writeRegistry(records);
      notifyChanged(meetingId);
    });
  mutation = operation.then(() => undefined, () => undefined);
  return operation;
}

export function subscribeDeviceTranscriptTaskChanged(
  listener: (meetingId: string) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getDeviceTranscriptTask(meetingId: string): Promise<DeviceTranscriptTaskRecord | null> {
  const normalized = normalizedMeetingId(meetingId);
  await mutation.catch(() => undefined);
  const record = (await readRegistry())[normalized];
  return record ? { ...record } : null;
}

export function rememberDeviceTranscriptTask(meetingId: string, taskId: string): Promise<void> {
  const normalizedMeetingIdValue = normalizedMeetingId(meetingId);
  const normalizedTaskIdValue = normalizedTaskId(taskId);
  const updatedAt = new Date().toISOString();
  return mutate(normalizedMeetingIdValue, records => {
    const current = records[normalizedMeetingIdValue];
    if (
      current?.taskId === normalizedTaskIdValue
      && current.state === 'pending'
    ) return false;
    records[normalizedMeetingIdValue] = {
      meetingId: normalizedMeetingIdValue,
      taskId: normalizedTaskIdValue,
      state: 'pending',
      phase: 'queued',
      updatedAt,
    };
    return true;
  });
}

export function markDeviceTranscriptTaskProgress(
  meetingId: string,
  phase: DeviceTranscriptTaskPhase,
): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const updatedAt = new Date().toISOString();
  return mutate(normalized, records => {
    const existing = records[normalized];
    if (!existing || existing.state !== 'pending' || existing.phase === phase) return false;
    records[normalized] = {
      ...existing,
      phase,
      updatedAt,
    };
    return true;
  });
}

export function markDeviceTranscriptTaskFailed(meetingId: string, errorCode?: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const updatedAt = new Date().toISOString();
  return mutate(normalized, records => {
    const existing = records[normalized];
    if (!existing) return false;
    const nextErrorCode = errorCode?.trim().slice(0, 80) || undefined;
    if (existing.state === 'failed' && existing.errorCode === nextErrorCode) return false;
    records[normalized] = {
      ...existing,
      state: 'failed',
      phase: undefined,
      errorCode: nextErrorCode,
      updatedAt,
    };
    return true;
  });
}

export function clearDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  return mutate(normalized, records => {
    if (!records[normalized]) return false;
    delete records[normalized];
    return true;
  });
}
