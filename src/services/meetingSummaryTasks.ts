import { TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  meetingTemplateById,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryAttachmentItem,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingSummaryCarryForwardItem,
  type MeetingTemplate,
} from '../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../data/db/openDatabase';

const GUEST_TASK_RETENTION_MS = 55 * 60 * 1000;

export type MeetingSummaryTaskMode = 'guest';

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

type PendingSummaryTaskRow = {
  meeting_id: string;
  task_id: string;
  mode: string;
  template_id: string;
  template_revision: number;
  input_fingerprint: string;
  carry_forward_json: string | null;
  attachment_authorization_json: string | null;
  created_at: string;
  updated_at: string;
};

async function ensurePendingTaskTable(): Promise<void> {
  const database = await openMeetingDatabase();
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS device_summary_task_intents (
      storage_scope TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode = 'guest'),
      template_id TEXT NOT NULL CHECK(template_id = 'general'),
      template_revision INTEGER NOT NULL CHECK(template_revision = 3),
      input_fingerprint TEXT NOT NULL,
      carry_forward_json TEXT,
      attachment_authorization_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(storage_scope, meeting_id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_summary_task_intents_ready
      ON device_summary_task_intents(storage_scope, updated_at, meeting_id);
  `);
}

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
  manualNote: { content: string; revision: number } | null = null,
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

  // The retired presentation template must not fork the generation identity.
  // `template` remains in the signature for compatibility with released task
  // records; every accepted legacy value projects to the same current result.
  void template;
  feed('adaptive-summary-current');
  feed(title?.trim());
  feed(meetingDate?.trim());
  feed(transcriptLines.length);
  transcriptLines.forEach(line => {
    feed(line.id);
    feed(line.recordingAssetId);
    feed(line.recording_asset_id ?? line.recordingAssetRemoteId);
    feed(line.transcription_job_id ?? line.transcriptionJobId);
    feed(line.speaker_id);
    feed(line.speaker_label);
    feed(line.text.trim());
    feed(line.start_time);
    feed(line.end_time);
  });

  if (manualNote) {
    feed(manualNote.revision);
    feed(manualNote.content);
  }

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
      if (item.kind === 'text') {
        feed(item.content);
        feed(item.contentSha256);
      } else {
        feed(item.remoteAttachmentId);
        feed(item.remoteRevision);
        feed(item.mimeType);
        feed(item.byteSize);
        feed(item.checksumSha256);
      }
      feed(item.updatedAtMs);
    });
  }

  const version = 'v8';
  return `${version}:${transcriptLines.length}:${characterCount}:${primary.toString(16).padStart(8, '0')}${secondary.toString(16).padStart(8, '0')}`;
}

/**
 * Local recovery identity for the Facts V3 source contract.
 *
 * Templates are deterministic local projections of one immutable fact
 * document, so changing a template must never create another remote task.
 * Keep this identity aligned with summarySourceRevision: transcript evidence,
 * the current manual note, and explicitly authorized attachment revisions.
 */
export function meetingSummaryFactsInputFingerprint(
  transcriptLines: TranscriptLine[],
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null = null,
  manualNote: { content: string; revision: number } | null = null,
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

  feed('facts-v3-source-v1');
  feed(transcriptLines.length);
  transcriptLines.forEach(line => {
    feed(line.id);
    feed(line.text);
    feed(line.start_time);
    feed(line.end_time);
    feed(line.speaker_label);
  });
  if (manualNote) {
    feed(manualNote.revision);
    feed(manualNote.content);
  }
  for (const item of attachmentAuthorization?.items ?? []) {
    feed(item.attachmentId);
    feed(item.updatedAtMs);
    feed(item.positionMs);
    feed(item.kind);
    feed(item.kind === 'text' ? item.contentSha256 : item.checksumSha256);
  }

  return `facts-v3-source-v1:${transcriptLines.length}:${characterCount}:${primary.toString(16).padStart(8, '0')}${secondary.toString(16).padStart(8, '0')}`;
}

export async function getPendingMeetingSummaryTask(
  storageScope: string,
  meetingId: string,
  nowMs = Date.now(),
): Promise<PendingMeetingSummaryTask | null> {
  const task = (await readPendingTasks(storageScope))[meetingId.trim()] ?? null;
  if (!task) return null;
  const createdAtMs = Date.parse(task.createdAt);
  if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs >= GUEST_TASK_RETENTION_MS) {
    await clearPendingMeetingSummaryTask(storageScope, meetingId);
    return null;
  }
  return task;
}

export async function listPendingMeetingSummaryTasks(
  storageScope: string,
): Promise<PendingMeetingSummaryTask[]> {
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
  const scope = normalizeStorageScope(storageScope);
  const meeting = normalizeMeetingId(task.meetingId);
  await ensurePendingTaskTable();
  const saved = await withMeetingDatabaseTransaction(async database => {
    const existing = await database.getFirstAsync<{ task_id: string; created_at: string }>(
      `SELECT task_id, created_at FROM device_summary_task_intents
        WHERE storage_scope = ? AND meeting_id = ?`,
      scope,
      meeting,
    );
    const createdAt = existing?.task_id === task.taskId ? existing.created_at : task.createdAt ?? now;
    await database.runAsync(
      `INSERT INTO device_summary_task_intents (
         storage_scope, meeting_id, task_id, mode, template_id, template_revision,
         input_fingerprint, carry_forward_json, attachment_authorization_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(storage_scope, meeting_id) DO UPDATE SET
         task_id = excluded.task_id,
         mode = excluded.mode,
         template_id = excluded.template_id,
         template_revision = excluded.template_revision,
         input_fingerprint = excluded.input_fingerprint,
         carry_forward_json = excluded.carry_forward_json,
         attachment_authorization_json = excluded.attachment_authorization_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      scope,
      meeting,
      task.taskId,
      task.mode,
      task.templateId,
      task.templateRevision,
      task.inputFingerprint,
      task.carryForward ? JSON.stringify(task.carryForward) : null,
      task.attachmentAuthorization ? JSON.stringify(task.attachmentAuthorization) : null,
      createdAt,
      now,
    );
    return {
      meetingId: meeting,
      taskId: task.taskId,
      mode: task.mode,
      templateId: task.templateId,
      templateRevision: task.templateRevision,
      inputFingerprint: task.inputFingerprint,
      carryForward: task.carryForward,
      attachmentAuthorization: task.attachmentAuthorization,
      createdAt,
      updatedAt: now,
    } satisfies PendingMeetingSummaryTask;
  });
  return saved;
}

export async function clearPendingMeetingSummaryTask(storageScope: string, meetingId: string): Promise<void> {
  const scope = normalizeStorageScope(storageScope);
  const meeting = normalizeMeetingId(meetingId);
  await ensurePendingTaskTable();
  await withMeetingDatabaseTransaction(database => database.runAsync(
    `DELETE FROM device_summary_task_intents WHERE storage_scope = ? AND meeting_id = ?`,
    scope,
    meeting,
  ));
}

async function readPendingTasks(storageScope: string): Promise<PendingSummaryTaskMap> {
  const scope = normalizeStorageScope(storageScope);
  await ensurePendingTaskTable();
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<PendingSummaryTaskRow>(
    `SELECT meeting_id, task_id, mode, template_id, template_revision,
            input_fingerprint, carry_forward_json, attachment_authorization_json,
            created_at, updated_at
       FROM device_summary_task_intents
      WHERE storage_scope = ? ORDER BY created_at, meeting_id`,
    scope,
  );
  return rows.reduce<PendingSummaryTaskMap>((result, row) => {
    const parsed = pendingTaskFromRow(row);
    if (parsed) result[parsed.meetingId] = parsed;
    return result;
  }, {});
}

function normalizeStorageScope(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('meeting summary storage scope is invalid');
  }
  return normalized;
}

function normalizeMeetingId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('meeting summary meeting ID is invalid');
  }
  return normalized;
}

function pendingTaskFromRow(row: PendingSummaryTaskRow): PendingMeetingSummaryTask | null {
  if (!row.task_id || row.mode !== 'guest' || !row.input_fingerprint) return null;
  const template = meetingTemplateById(row.template_id, Number(row.template_revision));
  if (!template) return null;
  let carryForward: MeetingSummaryCarryForwardAuthorization | null = null;
  let attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null = null;
  try {
    if (row.carry_forward_json) {
      carryForward = parseCarryForwardAuthorization(JSON.parse(row.carry_forward_json));
      if (!carryForward) return null;
    }
    if (row.attachment_authorization_json) {
      attachmentAuthorization = parseAttachmentAuthorization(JSON.parse(row.attachment_authorization_json));
      if (!attachmentAuthorization) return null;
    }
  } catch {
    return null;
  }
  return {
    meetingId: row.meeting_id,
    taskId: row.task_id,
    mode: row.mode,
    templateId: template.id,
    templateRevision: template.revision,
    inputFingerprint: row.input_fingerprint,
    carryForward,
    attachmentAuthorization,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  const item = value as Record<string, unknown>;
  const attachmentId = pendingText(item.attachmentId, 512);
  if (
    !attachmentId
    || !Number.isSafeInteger(item.positionMs)
    || Number(item.positionMs) < 0
    || !Number.isSafeInteger(item.updatedAtMs)
    || Number(item.updatedAtMs) < 0
  ) return null;
  const common = {
    attachmentId,
    positionMs: Number(item.positionMs),
    updatedAtMs: Number(item.updatedAtMs),
  };
  if (item.kind === 'text') {
    const content = pendingText(item.content, 2_000);
    const contentSha256 = pendingText(item.contentSha256, 71);
    if (!content || !contentSha256 || !/^sha256:[0-9a-f]{64}$/.test(contentSha256)) return null;
    return { ...common, kind: 'text', content, contentSha256 };
  }
  if (item.kind === 'image') {
    const remoteAttachmentId = pendingText(item.remoteAttachmentId, 160);
    const mimeType = pendingText(item.mimeType, 160)?.toLowerCase() ?? null;
    const checksumSha256 = pendingText(item.checksumSha256, 71);
    if (
      !remoteAttachmentId
      || !Number.isSafeInteger(item.remoteRevision)
      || Number(item.remoteRevision) < 1
      || !mimeType
      || !['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(mimeType)
      || !Number.isSafeInteger(item.byteSize)
      || Number(item.byteSize) < 1
      || Number(item.byteSize) > 25 * 1024 * 1024
      || !checksumSha256
      || !/^sha256:[0-9a-f]{64}$/.test(checksumSha256)
    ) return null;
    return {
      ...common,
      kind: 'image',
      remoteAttachmentId,
      remoteRevision: Number(item.remoteRevision),
      mimeType,
      byteSize: Number(item.byteSize),
      checksumSha256,
    };
  }
  return null;
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
    || resolved.filter(item => item.kind === 'image').length > 4
    || resolved.reduce(
      (total, item) => total + (item.kind === 'text' ? item.content.length : 0),
      0,
    ) > 12_000
    || resolved.reduce(
      (total, item) => total + (item.kind === 'image' ? item.byteSize : 0),
      0,
    ) > 40 * 1024 * 1024
  ) return null;
  return { requestId, items: resolved };
}
