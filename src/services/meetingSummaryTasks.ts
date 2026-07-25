import { TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  meetingTemplateById,
  meetingTemplateKey,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryAttachmentItem,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingSummaryCarryForwardItem,
  type MeetingTemplate,
} from '../domain/meeting';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

const PENDING_SUMMARY_TASKS_KEY = '@laoji:pendingMeetingSummaryTasks:v1';
const GUEST_TASK_RETENTION_MS = 55 * 60 * 1000;
const ACCOUNT_TASK_RETENTION_MS = 23 * 60 * 60 * 1000;

export type MeetingSummaryTaskMode = 'guest' | 'authenticated';

export interface PendingMeetingSummaryTask {
  meetingId: string;
  taskId: string;
  mode: MeetingSummaryTaskMode;
  templateId: MeetingTemplate['id'];
  templateRevision: number;
  inputFingerprint: string;
  carryForward: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
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
  template: Pick<MeetingTemplate, 'id' | 'revision'> = DEFAULT_MEETING_TEMPLATE,
  carryForward: MeetingSummaryCarryForwardAuthorization | null = null,
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null = null,
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

  feed(meetingTemplateKey(template));
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

  if (carryForward) {
    feed(carryForward.requestId);
    feed(carryForward.items.length);
    carryForward.items.forEach(item => {
      feed(item.kind);
      feed(item.sourceMeetingId);
      feed(item.sourceItemId);
      feed(item.sourceTitle);
      feed(item.sourceOccurrenceDate);
      feed(item.content);
      feed(item.assignee);
      feed(item.dueAt);
    });
  }

  if (attachmentAuthorization) {
    feed(attachmentAuthorization.requestId);
    feed(attachmentAuthorization.items.length);
    attachmentAuthorization.items.forEach(item => {
      feed(item.attachmentId);
      feed(item.kind);
      feed(item.positionMs);
      feed(item.content);
      feed(item.contentSha256);
      feed(item.updatedAtMs);
    });
  }

  const version = attachmentAuthorization ? 'v4' : carryForward ? 'v3' : 'v2';
  return `${version}:${transcriptLines.length}:${characterCount}:${primary.toString(16).padStart(8, '0')}${secondary.toString(16).padStart(8, '0')}`;
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
      templateId: task.templateId,
      templateRevision: task.templateRevision,
      inputFingerprint: task.inputFingerprint,
      carryForward: task.carryForward,
      attachmentAuthorization: task.attachmentAuthorization,
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
    const template = meetingTemplateById(item.templateId, item.templateRevision)
      ?? DEFAULT_MEETING_TEMPLATE;
    const carryForward = parseCarryForwardAuthorization(item.carryForward);
    if (item.carryForward != null && !carryForward) return;
    const attachmentAuthorization = parseAttachmentAuthorization(item.attachmentAuthorization);
    if (item.attachmentAuthorization != null && !attachmentAuthorization) return;
    records[meetingId] = {
      meetingId,
      taskId: item.taskId,
      mode: item.mode,
      templateId: template.id,
      templateRevision: template.revision,
      inputFingerprint: item.inputFingerprint,
      carryForward,
      attachmentAuthorization,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
    };
  });
  return records;
}

function pendingText(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum || /\u0000/.test(normalized)) return null;
  return normalized;
}

function parseCarryForwardItem(value: unknown): MeetingSummaryCarryForwardItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<MeetingSummaryCarryForwardItem>;
  if (item.kind !== 'decision' && item.kind !== 'action') return null;
  const sourceMeetingId = pendingText(item.sourceMeetingId, 160);
  const sourceItemId = pendingText(item.sourceItemId, 512);
  const sourceTitle = pendingText(item.sourceTitle, 255, true);
  const content = pendingText(item.content, 2_000);
  if (!sourceMeetingId || !sourceItemId || sourceTitle === null || !content) return null;
  if (typeof item.sourceOccurrenceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.sourceOccurrenceDate)) {
    return null;
  }
  const assignee = item.assignee == null ? null : pendingText(item.assignee, 200);
  if (item.assignee != null && assignee === null) return null;
  const dueAt = item.dueAt == null ? null : pendingText(item.dueAt, 80);
  if (dueAt && !Number.isFinite(Date.parse(dueAt))) return null;
  return {
    kind: item.kind,
    sourceMeetingId,
    sourceItemId,
    sourceTitle,
    sourceOccurrenceDate: item.sourceOccurrenceDate,
    content,
    assignee,
    dueAt,
  };
}

function parseCarryForwardAuthorization(value: unknown): MeetingSummaryCarryForwardAuthorization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const authorization = value as Partial<MeetingSummaryCarryForwardAuthorization>;
  const requestId = pendingText(authorization.requestId, 96);
  if (!requestId || requestId.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(requestId)) return null;
  if (!Array.isArray(authorization.items) || authorization.items.length < 1 || authorization.items.length > 8) {
    return null;
  }
  const items = authorization.items.map(parseCarryForwardItem);
  if (items.some(item => item === null)) return null;
  const resolved = items as MeetingSummaryCarryForwardItem[];
  const identities = resolved.map(item => `${item.kind}\u0000${item.sourceMeetingId}\u0000${item.sourceItemId}`);
  if (new Set(identities).size !== identities.length) return null;
  return { requestId, items: resolved };
}

function parseAttachmentItem(value: unknown): MeetingSummaryAttachmentItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<MeetingSummaryAttachmentItem>;
  const attachmentId = pendingText(item.attachmentId, 512);
  const content = pendingText(item.content, 2_000);
  const contentSha256 = pendingText(item.contentSha256, 71);
  if (
    !attachmentId
    || item.kind !== 'text'
    || !Number.isSafeInteger(item.positionMs)
    || Number(item.positionMs) < 0
    || !content
    || !contentSha256
    || !/^sha256:[0-9a-f]{64}$/.test(contentSha256)
    || !Number.isSafeInteger(item.updatedAtMs)
    || Number(item.updatedAtMs) < 0
  ) return null;
  return {
    attachmentId,
    kind: 'text',
    positionMs: Number(item.positionMs),
    content,
    contentSha256,
    updatedAtMs: Number(item.updatedAtMs),
  };
}

function parseAttachmentAuthorization(value: unknown): MeetingSummaryAttachmentAuthorization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const authorization = value as Partial<MeetingSummaryAttachmentAuthorization>;
  const requestId = pendingText(authorization.requestId, 96);
  if (!requestId || requestId.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(requestId)) return null;
  if (!Array.isArray(authorization.items) || authorization.items.length < 1 || authorization.items.length > 12) {
    return null;
  }
  const items = authorization.items.map(parseAttachmentItem);
  if (items.some(item => item === null)) return null;
  const resolved = items as MeetingSummaryAttachmentItem[];
  if (
    new Set(resolved.map(item => item.attachmentId)).size !== resolved.length
    || resolved.reduce((total, item) => total + item.content.length, 0) > 12_000
  ) return null;
  return { requestId, items: resolved };
}

function pendingTasksKey(storageScope: string): string {
  const normalized = storageScope.trim();
  if (!normalized) throw new Error('meeting summary storage scope is required');
  return `${PENDING_SUMMARY_TASKS_KEY}:${normalized}`;
}

export function resetMeetingSummaryTaskStorageForTests(): void {
  pendingStorageMutation = Promise.resolve();
}
