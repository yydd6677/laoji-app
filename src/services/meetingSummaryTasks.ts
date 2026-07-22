import { TranscriptLine } from '../types';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const PENDING_SUMMARY_TASKS_KEY = '@laoji:pendingMeetingSummaryTasks:v1';
const GUEST_TASK_RETENTION_MS = 55 * 60 * 1000;
const ACCOUNT_TASK_RETENTION_MS = 23 * 60 * 60 * 1000;

export type MeetingSummaryTaskMode = 'guest' | 'authenticated';

export interface PendingMeetingSummaryTask {
  meetingId: string;
  taskId: string;
  mode: MeetingSummaryTaskMode;
  inputFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

type PendingSummaryTaskMap = Record<string, PendingMeetingSummaryTask>;

let pendingStorageMutation: Promise<void> = Promise.resolve();

function updateHash(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  return next;
}

export function meetingSummaryInputFingerprint(
  transcriptLines: TranscriptLine[],
  title?: string,
  meetingDate?: string,
): string {
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  let characterCount = 0;
  const feed = (value: unknown) => {
    const text = value == null ? '' : String(value);
    characterCount += text.length;
    primary = updateHash(primary, `${text}\u001f`);
    secondary = updateHash(secondary, `${text.length}:${text}\u001e`);
  };

  feed(title?.trim());
  feed(meetingDate?.trim());
  feed(transcriptLines.length);
  transcriptLines.forEach(line => {
    feed(line.id);
    feed(line.speaker_id);
    feed(line.speaker_label);
    feed(line.text.trim());
    feed(line.start_time);
    feed(line.end_time);
  });

  return `v1:${transcriptLines.length}:${characterCount}:${primary.toString(16).padStart(8, '0')}${secondary.toString(16).padStart(8, '0')}`;
}

export async function getPendingMeetingSummaryTask(
  storageScope: string,
  meetingId: string,
  nowMs = Date.now(),
): Promise<PendingMeetingSummaryTask | null> {
  await pendingStorageMutation.catch(() => {});
  const task = (await readPendingTasks(storageScope))[meetingId] ?? null;
  if (!task) return null;
  const createdAtMs = Date.parse(task.createdAt);
  const retentionMs = task.mode === 'guest' ? GUEST_TASK_RETENTION_MS : ACCOUNT_TASK_RETENTION_MS;
  if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs >= retentionMs) {
    await clearPendingMeetingSummaryTask(storageScope, meetingId);
    return null;
  }
  return task;
}

export async function listPendingMeetingSummaryTasks(
  storageScope: string,
): Promise<PendingMeetingSummaryTask[]> {
  await pendingStorageMutation.catch(() => {});
  return Object.values(await readPendingTasks(storageScope)).sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.meetingId.localeCompare(right.meetingId)
  ));
}

export async function savePendingMeetingSummaryTask(
  storageScope: string,
  task: Omit<PendingMeetingSummaryTask, 'createdAt' | 'updatedAt'> & Partial<Pick<PendingMeetingSummaryTask, 'createdAt'>>,
): Promise<PendingMeetingSummaryTask> {
  const now = new Date().toISOString();
  let saved: PendingMeetingSummaryTask | null = null;
  await mutatePendingTasks(storageScope, records => {
    const existing = records[task.meetingId];
    saved = {
      meetingId: task.meetingId,
      taskId: task.taskId,
      mode: task.mode,
      inputFingerprint: task.inputFingerprint,
      createdAt: existing?.taskId === task.taskId
        ? existing.createdAt
        : task.createdAt ?? now,
      updatedAt: now,
    };
    records[task.meetingId] = saved;
  });
  if (!saved) throw new Error('pending meeting summary task was not saved');
  return saved;
}

export async function clearPendingMeetingSummaryTask(storageScope: string, meetingId: string): Promise<void> {
  await mutatePendingTasks(storageScope, records => {
    delete records[meetingId];
  });
}

function mutatePendingTasks(storageScope: string, mutator: (records: PendingSummaryTaskMap) => void): Promise<void> {
  const storageKey = pendingTasksKey(storageScope);
  const operation = pendingStorageMutation
    .catch(() => {})
    .then(async () => {
      const records = await readPendingTasks(storageScope);
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

async function readPendingTasks(storageScope: string): Promise<PendingSummaryTaskMap> {
  const raw = await getAppStorageItem(pendingTasksKey(storageScope));
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pending meeting summary task registry is invalid');
  }

  const records: PendingSummaryTaskMap = {};
  Object.entries(parsed).forEach(([meetingId, value]) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Partial<PendingMeetingSummaryTask>;
    if (typeof item.taskId !== 'string' || !item.taskId) return;
    if (item.mode !== 'guest' && item.mode !== 'authenticated') return;
    if (typeof item.inputFingerprint !== 'string' || !item.inputFingerprint) return;
    records[meetingId] = {
      meetingId,
      taskId: item.taskId,
      mode: item.mode,
      inputFingerprint: item.inputFingerprint,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
    };
  });
  return records;
}

function pendingTasksKey(storageScope: string): string {
  const normalized = storageScope.trim();
  if (!normalized) throw new Error('meeting summary storage scope is required');
  return `${PENDING_SUMMARY_TASKS_KEY}:${normalized}`;
}

export function resetMeetingSummaryTaskStorageForTests(): void {
  pendingStorageMutation = Promise.resolve();
}
