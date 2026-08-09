import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const STORAGE_KEY = '@laoji:deviceTranscriptTasks:v1';
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeviceTranscriptTaskState = 'pending' | 'failed';

export interface DeviceTranscriptTaskRecord {
  meetingId: string;
  taskId: string;
  state: DeviceTranscriptTaskState;
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

function mutate(mutator: (records: Registry) => void): Promise<void> {
  const operation = mutation
    .catch(() => undefined)
    .then(async () => {
      const records = await readRegistry();
      mutator(records);
      await writeRegistry(records);
    });
  mutation = operation.then(() => undefined, () => undefined);
  return operation;
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
  return mutate(records => {
    records[normalizedMeetingIdValue] = {
      meetingId: normalizedMeetingIdValue,
      taskId: normalizedTaskIdValue,
      state: 'pending',
      updatedAt,
    };
  });
}

export function markDeviceTranscriptTaskFailed(meetingId: string, errorCode?: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const updatedAt = new Date().toISOString();
  return mutate(records => {
    const existing = records[normalized];
    if (!existing) return;
    records[normalized] = {
      ...existing,
      state: 'failed',
      errorCode: errorCode?.trim().slice(0, 80) || undefined,
      updatedAt,
    };
  });
}

export function clearDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  return mutate(records => { delete records[normalized]; });
}
