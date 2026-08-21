import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';
import { sha256Text } from './immutableSourceRepository';

export type Q2SourceType = 'transcript' | 'manual_note' | 'attachment';
export type Q2AnswerKind = 'answer' | 'not_stated' | 'cannot_confirm';
// source.stream.v2 accepts this many immutable items. A long meeting can have
// thousands of short stable transcript fragments even when its text is small.
export const MAX_Q2_SNAPSHOT_SOURCES = 50_000;

export class Q2ActivationFenceError extends Error {
  constructor() {
    super('Q2 来源已更新，旧回答未激活');
    this.name = 'Q2ActivationFenceError';
  }
}

export type Q2ManualNoteActivationFence =
  | { mode: 'included'; revision: number }
  | { mode: 'absent' }
  | { mode: 'excluded' };

export interface Q2StoredActivationFence {
  deviceEpochId: string;
  bindingId: string;
  bindingGeneration: string;
  bindingRevision: number;
  bindingCancelRevision: number;
  manualNote: Q2ManualNoteActivationFence;
  attachmentSelectionSha256: string;
}

export interface Q2ActivationFence extends Q2StoredActivationFence {
  meetingId: string;
  sourceFingerprint: string;
  transcriptRevisionId: string;
}

export interface Q2SnapshotSource {
  sourceType: Q2SourceType;
  sourceId: string;
  sourceRevisionId: string;
  contentSha256: string;
}

export interface Q2SnapshotRecord {
  snapshotId: string;
  meetingId: string;
  sourceFingerprint: string;
  transcriptRevisionId: string;
  sources: readonly Q2SnapshotSource[];
  createdAtMs: number;
}

export interface Q2ThreadRecord {
  threadId: string;
  meetingId: string;
  snapshotId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Q2CitationInput extends Q2SnapshotSource {
  citationId: string;
  sourceStartUtf8: number;
  sourceEndUtf8: number;
  quoteSha256: string;
}

export interface Q2ClauseInput {
  clauseId: string;
  answerStartUtf8: number;
  answerEndUtf8: number;
  citations: readonly Q2CitationInput[];
}

export interface Q2ClauseRecord extends Q2ClauseInput {}

export interface Q2TurnRecord {
  turnId: string;
  threadId: string;
  requestId: string;
  currentOperationId: string | null;
  ordinal: number;
  question: string;
  answerKind: Q2AnswerKind | null;
  answer: string | null;
  providerRevision: string;
  activationFence: Q2StoredActivationFence | null;
  completedAtMs: number | null;
  createdAtMs: number;
  clauses: readonly Q2ClauseRecord[];
}

type SnapshotRow = {
  snapshot_id: string;
  meeting_id: string;
  source_fingerprint: string;
  transcript_revision_id: string;
  created_at_ms: number;
};

type ThreadRow = {
  thread_id: string;
  meeting_id: string;
  snapshot_id: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type TurnRow = {
  turn_id: string;
  thread_id: string;
  request_id: string;
  current_operation_id: string | null;
  ordinal: number;
  question: string;
  answer_kind: Q2AnswerKind | null;
  answer: string | null;
  provider_revision: string;
  activation_device_epoch_id: string | null;
  activation_binding_id: string | null;
  activation_binding_generation: string | null;
  activation_binding_revision: number | null;
  activation_binding_cancel_revision: number | null;
  activation_manual_note_mode: Q2ManualNoteActivationFence['mode'] | null;
  activation_manual_note_revision: number | null;
  activation_attachment_selection_sha256: string | null;
  completed_at_ms: number | null;
  created_at_ms: number;
};

type ClauseRow = {
  clause_id: string;
  turn_id: string;
  ordinal: number;
  answer_start_utf8: number;
  answer_end_utf8: number;
  citation_id: string | null;
  citation_ordinal: number | null;
  source_type: Q2SourceType | null;
  source_id: string | null;
  source_revision_id: string | null;
  content_sha256: string | null;
  source_start_utf8: number | null;
  source_end_utf8: number | null;
  quote_sha256: string | null;
};

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} 无效`);
  }
  return normalized;
}

function sha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field} 无效`);
  return normalized;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 无效`);
  return value;
}

function normalizedActivationFence(input: Q2ActivationFence): Q2ActivationFence {
  const manualNote = input.manualNote.mode === 'included'
    ? { mode: 'included' as const, revision: nonNegative(input.manualNote.revision, 'activationManualNoteRevision') }
    : input.manualNote.mode === 'absent'
      ? { mode: 'absent' as const }
      : { mode: 'excluded' as const };
  const bindingRevision = nonNegative(input.bindingRevision, 'activationBindingRevision');
  if (bindingRevision < 1) throw new Error('activationBindingRevision 无效');
  return {
    meetingId: identifier(input.meetingId, 'activationMeetingId'),
    sourceFingerprint: sha256(input.sourceFingerprint, 'activationSourceFingerprint'),
    transcriptRevisionId: identifier(input.transcriptRevisionId, 'activationTranscriptRevisionId'),
    deviceEpochId: identifier(input.deviceEpochId, 'activationDeviceEpochId'),
    bindingId: identifier(input.bindingId, 'activationBindingId'),
    bindingGeneration: identifier(input.bindingGeneration, 'activationBindingGeneration'),
    bindingRevision,
    bindingCancelRevision: nonNegative(
      input.bindingCancelRevision,
      'activationBindingCancelRevision',
    ),
    manualNote,
    attachmentSelectionSha256: sha256(
      input.attachmentSelectionSha256,
      'activationAttachmentSelectionSha256',
    ),
  };
}

function sameStoredActivationFence(row: TurnRow, fence: Q2ActivationFence): boolean {
  return row.activation_device_epoch_id === fence.deviceEpochId
    && row.activation_binding_id === fence.bindingId
    && row.activation_binding_generation === fence.bindingGeneration
    && Number(row.activation_binding_revision) === fence.bindingRevision
    && Number(row.activation_binding_cancel_revision) === fence.bindingCancelRevision
    && row.activation_manual_note_mode === fence.manualNote.mode
    && row.activation_attachment_selection_sha256 === fence.attachmentSelectionSha256
    && (
      fence.manualNote.mode !== 'included'
        ? row.activation_manual_note_revision === null
        : Number(row.activation_manual_note_revision) === fence.manualNote.revision
    );
}

function turnFromRow(row: TurnRow | null, clauses: readonly Q2ClauseRecord[] = []): Q2TurnRecord | null {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    requestId: row.request_id,
    currentOperationId: row.current_operation_id,
    ordinal: Number(row.ordinal),
    question: row.question,
    answerKind: row.answer_kind,
    answer: row.answer,
    providerRevision: row.provider_revision,
    activationFence: activationFenceFromRow(row),
    completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
    createdAtMs: Number(row.created_at_ms),
    clauses,
  };
}

function activationFenceFromRow(row: TurnRow): Q2StoredActivationFence | null {
  const mode = row.activation_manual_note_mode;
  if (
    row.activation_device_epoch_id === null
    || row.activation_binding_id === null
    || row.activation_binding_generation === null
    || row.activation_binding_revision === null
    || row.activation_binding_cancel_revision === null
    || row.activation_attachment_selection_sha256 === null
    || !/^sha256:[0-9a-f]{64}$/.test(row.activation_attachment_selection_sha256)
    || !['included', 'absent', 'excluded'].includes(mode ?? '')
  ) return null;
  if (mode === 'included' && row.activation_manual_note_revision === null) return null;
  const storedMode = mode as Q2ManualNoteActivationFence['mode'];
  return {
    deviceEpochId: row.activation_device_epoch_id,
    bindingId: row.activation_binding_id,
    bindingGeneration: row.activation_binding_generation,
    bindingRevision: Number(row.activation_binding_revision),
    bindingCancelRevision: Number(row.activation_binding_cancel_revision),
    attachmentSelectionSha256: row.activation_attachment_selection_sha256,
    manualNote: storedMode === 'included'
      ? { mode: storedMode, revision: Number(row.activation_manual_note_revision) }
      : { mode: storedMode },
  };
}

async function readSources(snapshotId: string): Promise<Q2SnapshotSource[]> {
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<{
    source_type: Q2SourceType;
    source_id: string;
    source_revision_id: string;
    content_sha256: string;
  }>(
    `SELECT source_type, source_id, source_revision_id, content_sha256
       FROM meeting_question_q2_snapshot_sources
      WHERE snapshot_id = ? ORDER BY ordinal`,
    snapshotId,
  );
  return rows.map(row => ({
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceRevisionId: row.source_revision_id,
    contentSha256: row.content_sha256,
  }));
}

export async function getQ2Snapshot(snapshotId: string): Promise<Q2SnapshotRecord | null> {
  const normalized = identifier(snapshotId, 'snapshotId');
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<SnapshotRow>(
    `SELECT snapshot_id, meeting_id, source_fingerprint, transcript_revision_id, created_at_ms
       FROM meeting_question_q2_snapshots WHERE snapshot_id = ?`,
    normalized,
  );
  if (!row) return null;
  return {
    snapshotId: row.snapshot_id,
    meetingId: row.meeting_id,
    sourceFingerprint: row.source_fingerprint,
    transcriptRevisionId: row.transcript_revision_id,
    sources: await readSources(normalized),
    createdAtMs: Number(row.created_at_ms),
  };
}

/** Read one immutable Q2 thread, including only its own completed/pending turns. */
export async function getQ2Thread(threadId: string): Promise<Q2ThreadRecord & { turns: readonly Q2TurnRecord[] } | null> {
  const normalized = identifier(threadId, 'threadId');
  const database = await openMeetingDatabase();
  const thread = await database.getFirstAsync<ThreadRow>(
    `SELECT thread_id, meeting_id, snapshot_id, created_at_ms, updated_at_ms
       FROM meeting_question_q2_threads WHERE thread_id = ?`,
    normalized,
  );
  if (!thread) return null;
  const turnRows = await database.getAllAsync<TurnRow>(
    `SELECT turn_id, thread_id, request_id, current_operation_id, ordinal, question,
            answer_kind, answer, provider_revision,
            activation_device_epoch_id, activation_binding_id,
            activation_binding_generation, activation_binding_revision,
            activation_binding_cancel_revision, activation_manual_note_mode,
            activation_manual_note_revision, activation_attachment_selection_sha256,
            completed_at_ms, created_at_ms
       FROM meeting_question_q2_turns
      WHERE thread_id = ? ORDER BY ordinal, turn_id`,
    normalized,
  );
  const clauseRows = await database.getAllAsync<ClauseRow>(
    `SELECT clause.clause_id, clause.turn_id, clause.ordinal,
            clause.answer_start_utf8, clause.answer_end_utf8,
            citation.citation_id, citation.ordinal AS citation_ordinal,
            citation.source_type, citation.source_id, citation.source_revision_id,
            citation.content_sha256, citation.source_start_utf8,
            citation.source_end_utf8, citation.quote_sha256
       FROM meeting_question_q2_clauses clause
       LEFT JOIN meeting_question_q2_citations citation
         ON citation.clause_id = clause.clause_id
      WHERE clause.turn_id IN (
        SELECT turn_id FROM meeting_question_q2_turns WHERE thread_id = ?
      )
      ORDER BY clause.ordinal, citation.ordinal`,
    normalized,
  );
  const clausesByTurn = new Map<string, Q2ClauseRecord[]>();
  const clauseByKey = new Map<string, Q2ClauseRecord>();
  for (const row of clauseRows) {
    const key = `${row.turn_id}:${row.clause_id}`;
    let clause = clauseByKey.get(key);
    if (!clause) {
      clause = {
        clauseId: row.clause_id,
        answerStartUtf8: Number(row.answer_start_utf8),
        answerEndUtf8: Number(row.answer_end_utf8),
        citations: [],
      };
      clauseByKey.set(key, clause);
      const turnClauses = clausesByTurn.get(row.turn_id) ?? [];
      turnClauses.push(clause);
      clausesByTurn.set(row.turn_id, turnClauses);
    }
    if (row.citation_id !== null) {
      const citation: Q2CitationInput = {
        citationId: row.citation_id,
        sourceType: row.source_type!,
        sourceId: row.source_id!,
        sourceRevisionId: row.source_revision_id!,
        contentSha256: row.content_sha256!,
        sourceStartUtf8: Number(row.source_start_utf8),
        sourceEndUtf8: Number(row.source_end_utf8),
        quoteSha256: row.quote_sha256!,
      };
      clause.citations = [...clause.citations, citation];
    }
  }
  const turns = turnRows.map(row => turnFromRow(row, clausesByTurn.get(row.turn_id) ?? [])!);
  return {
    threadId: thread.thread_id,
    meetingId: thread.meeting_id,
    snapshotId: thread.snapshot_id,
    createdAtMs: Number(thread.created_at_ms),
    updatedAtMs: Number(thread.updated_at_ms),
    turns,
  };
}

export async function findLatestQ2Thread(input: {
  meetingId: string;
  sourceFingerprint: string;
}): Promise<(Q2ThreadRecord & { turns: readonly Q2TurnRecord[] }) | null> {
  const meetingId = identifier(input.meetingId, 'meetingId');
  const sourceFingerprint = sha256(input.sourceFingerprint, 'sourceFingerprint');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<{ thread_id: string }>(
    `SELECT thread.thread_id
       FROM meeting_question_q2_threads thread
       INNER JOIN meeting_question_q2_snapshots snapshot
         ON snapshot.snapshot_id = thread.snapshot_id
      WHERE thread.meeting_id = ? AND snapshot.source_fingerprint = ?
      ORDER BY thread.updated_at_ms DESC, thread.thread_id DESC`,
    meetingId,
    sourceFingerprint,
  );
  for (const row of rows) {
    const thread = await getQ2Thread(row.thread_id);
    if (thread) return thread;
  }
  return null;
}

/**
 * Return every Q2 thread for one meeting that still owns a live local
 * operation. Recovery must not be scoped only to the currently selected
 * source fingerprint: a source edit can make the old thread unreachable while
 * its durable Task is still running or already completed remotely.
 */
export async function findPendingQ2ThreadsForMeeting(
  meetingIdValue: string,
): Promise<Array<Q2ThreadRecord & { turns: readonly Q2TurnRecord[] }>> {
  const meetingId = identifier(meetingIdValue, 'meetingId');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<{ thread_id: string }>(
    `SELECT DISTINCT thread.thread_id
       FROM meeting_question_q2_threads thread
       INNER JOIN meeting_question_q2_turns turn ON turn.thread_id = thread.thread_id
       INNER JOIN device_operations operation
         ON operation.operation_id = turn.current_operation_id
      WHERE thread.meeting_id = ?
        AND turn.completed_at_ms IS NULL
        AND operation.remote_state IN ('queued', 'running')
      ORDER BY thread.updated_at_ms, thread.thread_id`,
    meetingId,
  );
  const result: Array<Q2ThreadRecord & { turns: readonly Q2TurnRecord[] }> = [];
  for (const row of rows) {
    const thread = await getQ2Thread(row.thread_id);
    if (thread) result.push(thread);
  }
  return result;
}

/**
 * Recover the explicit attachment selection owned by the newest Q2 snapshot.
 * The snapshot stores identities and hashes only; the caller must re-resolve
 * each ID through the current local attachment aggregate before reuse.
 */
export async function findLatestQ2AttachmentIds(meetingIdValue: string): Promise<string[]> {
  const meetingId = identifier(meetingIdValue, 'meetingId');
  const database = await openMeetingDatabase();
  const latest = await database.getFirstAsync<{ snapshot_id: string }>(
    `SELECT thread.snapshot_id
       FROM meeting_question_q2_threads thread
       INNER JOIN meeting_notes meeting ON meeting.id = thread.meeting_id
      WHERE thread.meeting_id = ? AND meeting.lifecycle <> 'deleted'
      ORDER BY thread.updated_at_ms DESC, thread.created_at_ms DESC, thread.thread_id DESC
      LIMIT 1`,
    meetingId,
  );
  if (!latest) return [];
  const rows = await database.getAllAsync<{ source_id: string }>(
    `SELECT source_id
       FROM meeting_question_q2_snapshot_sources
      WHERE snapshot_id = ? AND source_type = 'attachment'
      ORDER BY ordinal`,
    latest.snapshot_id,
  );
  const prefix = 'attachment:';
  const ids = rows.map(row => (
    row.source_id.startsWith(prefix) ? row.source_id.slice(prefix.length) : ''
  ));
  if (ids.some(value => !value) || new Set(ids).size !== ids.length) return [];
  return ids;
}

export async function createQ2Snapshot(input: {
  snapshotId: string;
  meetingId: string;
  sourceFingerprint: string;
  transcriptRevisionId: string;
  sources: readonly Q2SnapshotSource[];
  createdAtMs?: number;
}): Promise<Q2SnapshotRecord> {
  const snapshotId = identifier(input.snapshotId, 'snapshotId');
  const meetingId = identifier(input.meetingId, 'meetingId');
  const transcriptRevisionId = identifier(input.transcriptRevisionId, 'transcriptRevisionId');
  const sourceFingerprint = sha256(input.sourceFingerprint, 'sourceFingerprint');
  const createdAtMs = nonNegative(input.createdAtMs ?? Date.now(), 'createdAtMs');
  if (input.sources.length < 1 || input.sources.length > MAX_Q2_SNAPSHOT_SOURCES) {
    throw new Error('Q2 来源数量无效');
  }
  const sources = input.sources.map(source => ({
    sourceType: source.sourceType,
    sourceId: identifier(source.sourceId, 'sourceId'),
    sourceRevisionId: identifier(source.sourceRevisionId, 'sourceRevisionId'),
    contentSha256: sha256(source.contentSha256, 'contentSha256'),
  }));
  await withMeetingDatabaseTransaction(async database => {
    const existing = await database.getFirstAsync<SnapshotRow>(
      `SELECT snapshot_id, meeting_id, source_fingerprint, transcript_revision_id, created_at_ms
         FROM meeting_question_q2_snapshots WHERE snapshot_id = ?`,
      snapshotId,
    );
    if (existing) {
      if (existing.meeting_id !== meetingId || existing.source_fingerprint !== sourceFingerprint
        || existing.transcript_revision_id !== transcriptRevisionId) {
        throw new Error('Q2 snapshot ID 已绑定其他来源');
      }
      const existingSources = await database.getAllAsync<{
        source_type: Q2SourceType;
        source_id: string;
        source_revision_id: string;
        content_sha256: string;
      }>(
        `SELECT source_type, source_id, source_revision_id, content_sha256
           FROM meeting_question_q2_snapshot_sources
          WHERE snapshot_id = ? ORDER BY ordinal`,
        snapshotId,
      );
      if (existingSources.length !== sources.length || existingSources.some((source, index) => {
        const expected = sources[index];
        return source.source_type !== expected.sourceType
          || source.source_id !== expected.sourceId
          || source.source_revision_id !== expected.sourceRevisionId
          || source.content_sha256 !== expected.contentSha256;
      })) {
        throw new Error('Q2 snapshot ID 已绑定不同来源');
      }
      return;
    }
    await database.runAsync(
      `INSERT INTO meeting_question_q2_snapshots (
         snapshot_id, meeting_id, source_fingerprint, transcript_revision_id, created_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
      snapshotId,
      meetingId,
      sourceFingerprint,
      transcriptRevisionId,
      createdAtMs,
    );
    for (let ordinal = 0; ordinal < sources.length; ordinal += 1) {
      const source = sources[ordinal];
      await database.runAsync(
        `INSERT INTO meeting_question_q2_snapshot_sources (
           snapshot_id, ordinal, source_type, source_id, source_revision_id, content_sha256
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        snapshotId,
        ordinal,
        source.sourceType,
        source.sourceId,
        source.sourceRevisionId,
        source.contentSha256,
      );
    }
  });
  const result = await getQ2Snapshot(snapshotId);
  if (!result) throw new Error('Q2 snapshot 创建失败');
  return result;
}

export async function createQ2Thread(input: {
  threadId: string;
  meetingId: string;
  snapshotId: string;
  nowMs?: number;
}): Promise<Q2ThreadRecord> {
  const threadId = identifier(input.threadId, 'threadId');
  const meetingId = identifier(input.meetingId, 'meetingId');
  const snapshotId = identifier(input.snapshotId, 'snapshotId');
  const nowMs = nonNegative(input.nowMs ?? Date.now(), 'nowMs');
  return withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `INSERT OR IGNORE INTO meeting_question_q2_threads (
         thread_id, meeting_id, snapshot_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
      threadId,
      meetingId,
      snapshotId,
      nowMs,
      nowMs,
    );
    const row = await database.getFirstAsync<ThreadRow>(
      `SELECT thread_id, meeting_id, snapshot_id, created_at_ms, updated_at_ms
         FROM meeting_question_q2_threads WHERE thread_id = ?`,
      threadId,
    );
    if (!row || row.meeting_id !== meetingId || row.snapshot_id !== snapshotId) {
      throw new Error('Q2 thread ID 已绑定其他 snapshot');
    }
    return {
      threadId: row.thread_id,
      meetingId: row.meeting_id,
      snapshotId: row.snapshot_id,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  });
}

export async function appendPendingQ2Turn(input: {
  turnId: string;
  threadId: string;
  requestId: string;
  operationId: string;
  ordinal: number;
  question: string;
  providerRevision: string;
  activationFence: Q2ActivationFence;
  createdAtMs?: number;
}): Promise<Q2TurnRecord> {
  const turnId = identifier(input.turnId, 'turnId');
  const threadId = identifier(input.threadId, 'threadId');
  const requestId = identifier(input.requestId, 'requestId');
  const operationId = identifier(input.operationId, 'operationId');
  const question = input.question.trim();
  if (!question || question.length > 2_000 || /\u0000/.test(question)) throw new Error('Q2 问题无效');
  const providerRevision = identifier(input.providerRevision, 'providerRevision');
  const activationFence = normalizedActivationFence(input.activationFence);
  const ordinal = nonNegative(input.ordinal, 'ordinal');
  const createdAtMs = nonNegative(input.createdAtMs ?? Date.now(), 'createdAtMs');
  return withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `INSERT OR IGNORE INTO meeting_question_q2_turns (
         turn_id, thread_id, request_id, current_operation_id, ordinal,
         question, provider_revision, activation_device_epoch_id,
         activation_binding_id, activation_binding_generation,
         activation_binding_revision, activation_binding_cancel_revision,
         activation_manual_note_mode, activation_manual_note_revision,
         activation_attachment_selection_sha256, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turnId,
      threadId,
      requestId,
      operationId,
      ordinal,
      question,
      providerRevision,
      activationFence.deviceEpochId,
      activationFence.bindingId,
      activationFence.bindingGeneration,
      activationFence.bindingRevision,
      activationFence.bindingCancelRevision,
      activationFence.manualNote.mode,
      activationFence.manualNote.mode === 'included' ? activationFence.manualNote.revision : null,
      activationFence.attachmentSelectionSha256,
      createdAtMs,
    );
    const row = await database.getFirstAsync<TurnRow>(
      `SELECT turn_id, thread_id, request_id, current_operation_id, ordinal, question,
              answer_kind, answer, provider_revision,
              activation_device_epoch_id, activation_binding_id,
              activation_binding_generation, activation_binding_revision,
              activation_binding_cancel_revision, activation_manual_note_mode,
              activation_manual_note_revision, activation_attachment_selection_sha256,
              completed_at_ms, created_at_ms
         FROM meeting_question_q2_turns WHERE thread_id = ? AND request_id = ?`,
      threadId,
      requestId,
    );
    if (!row || row.question !== question || row.current_operation_id !== operationId
      || Number(row.ordinal) !== ordinal || row.provider_revision !== providerRevision
      || !sameStoredActivationFence(row, activationFence)) {
      throw new Error('Q2 request ID 已绑定其他问题');
    }
    await database.runAsync(
      'UPDATE meeting_question_q2_threads SET updated_at_ms = MAX(updated_at_ms, ?) WHERE thread_id = ?',
      createdAtMs,
      threadId,
    );
    return turnFromRow(row)!;
  });
}

/** Move an unfinished turn to a new device operation after a retry. */
export async function rebindPendingQ2Turn(input: {
  turnId: string;
  expectedOperationId: string;
  newOperationId: string;
  newProviderRevision: string;
  activationFence: Q2ActivationFence;
}): Promise<boolean> {
  const turnId = identifier(input.turnId, 'turnId');
  const expectedOperationId = identifier(input.expectedOperationId, 'expectedOperationId');
  const newOperationId = identifier(input.newOperationId, 'newOperationId');
  const newProviderRevision = identifier(input.newProviderRevision, 'newProviderRevision');
  const activationFence = normalizedActivationFence(input.activationFence);
  return withMeetingDatabaseTransaction(async database => {
    const updated = await database.runAsync(
      `UPDATE meeting_question_q2_turns
          SET current_operation_id = ?, provider_revision = ?,
              activation_device_epoch_id = ?, activation_binding_id = ?,
              activation_binding_generation = ?, activation_binding_revision = ?,
              activation_binding_cancel_revision = ?, activation_manual_note_mode = ?,
              activation_manual_note_revision = ?, activation_attachment_selection_sha256 = ?
        WHERE turn_id = ? AND current_operation_id = ? AND completed_at_ms IS NULL`,
      newOperationId,
      newProviderRevision,
      activationFence.deviceEpochId,
      activationFence.bindingId,
      activationFence.bindingGeneration,
      activationFence.bindingRevision,
      activationFence.bindingCancelRevision,
      activationFence.manualNote.mode,
      activationFence.manualNote.mode === 'included' ? activationFence.manualNote.revision : null,
      activationFence.attachmentSelectionSha256,
      turnId,
      expectedOperationId,
    );
    return Number(updated.changes) === 1;
  });
}

export async function commitQ2Turn(input: {
  turnId: string;
  expectedOperationId: string;
  activationFence: Q2ActivationFence;
  answerKind: Q2AnswerKind;
  answer: string;
  clauses: readonly Q2ClauseInput[];
  completedAtMs?: number;
}): Promise<boolean> {
  const turnId = identifier(input.turnId, 'turnId');
  const expectedOperationId = identifier(input.expectedOperationId, 'expectedOperationId');
  const activationFence = normalizedActivationFence(input.activationFence);
  const answer = input.answer.trim();
  if (!answer || answer.length > 20_000 || /\u0000/.test(answer)) throw new Error('Q2 回答无效');
  if (input.answerKind === 'answer' && input.clauses.length === 0) {
    throw new Error('Q2 有依据回答必须包含引用分句');
  }
  if (input.answerKind !== 'answer' && input.clauses.length > 0) {
    throw new Error('Q2 未提及结果不能包含引用分句');
  }
  const completedAtMs = nonNegative(input.completedAtMs ?? Date.now(), 'completedAtMs');
  return withMeetingDatabaseTransaction(async database => {
    const turn = await database.getFirstAsync<TurnRow & {
      meeting_id: string;
      snapshot_id: string;
      source_fingerprint: string;
      transcript_revision_id: string;
      lifecycle: string;
      operation_device_epoch_id: string | null;
      operation_capability: string | null;
      operation_entity_id: string | null;
      operation_input_sha256: string | null;
      operation_state: string | null;
      current_epoch_id: string | null;
      binding_device_epoch_id: string | null;
      binding_id: string | null;
      binding_generation: string | null;
      binding_revision: number | null;
      binding_state: string | null;
      binding_cancel_revision: number | null;
    }>(
      `SELECT turn.turn_id, turn.thread_id, turn.request_id, turn.current_operation_id,
              turn.ordinal, turn.question, turn.answer_kind, turn.answer,
              turn.provider_revision, turn.completed_at_ms, turn.created_at_ms,
              turn.activation_device_epoch_id, turn.activation_binding_id,
              turn.activation_binding_generation, turn.activation_binding_revision,
              turn.activation_binding_cancel_revision, turn.activation_manual_note_mode,
              turn.activation_manual_note_revision,
              turn.activation_attachment_selection_sha256,
              thread.meeting_id, thread.snapshot_id, snapshot.source_fingerprint,
              snapshot.transcript_revision_id, meeting.lifecycle,
              operation.device_epoch_id AS operation_device_epoch_id,
              operation.capability AS operation_capability,
              operation.entity_id AS operation_entity_id,
              operation.input_sha256 AS operation_input_sha256,
              operation.remote_state AS operation_state,
              authority.current_epoch_id,
              binding.device_epoch_id AS binding_device_epoch_id,
              binding.binding_id, binding.binding_generation, binding.binding_revision,
              binding.state AS binding_state,
              binding.cancel_revision AS binding_cancel_revision
         FROM meeting_question_q2_turns turn
         INNER JOIN meeting_question_q2_threads thread ON thread.thread_id = turn.thread_id
         INNER JOIN meeting_question_q2_snapshots snapshot ON snapshot.snapshot_id = thread.snapshot_id
         INNER JOIN meeting_notes meeting ON meeting.id = thread.meeting_id
         LEFT JOIN device_operations operation ON operation.operation_id = turn.current_operation_id
         LEFT JOIN device_authority_state authority ON authority.singleton_id = 1
         LEFT JOIN meeting_service_bindings binding ON binding.meeting_id = thread.meeting_id
        WHERE turn.turn_id = ?`,
      turnId,
    );
    if (!turn || turn.current_operation_id !== expectedOperationId || turn.completed_at_ms !== null) return false;
    const activeTranscript = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM transcript_revisions
        WHERE meeting_id = ? AND is_active = 1
        ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
      activationFence.meetingId,
    );
    const identityCurrent = sameStoredActivationFence(turn, activationFence)
      && turn.meeting_id === activationFence.meetingId
      && turn.lifecycle !== 'deleted'
      && turn.source_fingerprint === activationFence.sourceFingerprint
      && turn.transcript_revision_id === activationFence.transcriptRevisionId
      && activeTranscript?.id === activationFence.transcriptRevisionId
      && turn.operation_device_epoch_id === activationFence.deviceEpochId
      && turn.operation_capability === 'question_reader_v2'
      && turn.operation_entity_id === activationFence.meetingId
      && turn.operation_input_sha256 === activationFence.sourceFingerprint
      && turn.operation_state === 'running'
      && turn.current_epoch_id === activationFence.deviceEpochId
      && turn.binding_device_epoch_id === activationFence.deviceEpochId
      && turn.binding_id === activationFence.bindingId
      && turn.binding_generation === activationFence.bindingGeneration
      && Number(turn.binding_revision) === activationFence.bindingRevision
      && turn.binding_state === 'active'
      && Number(turn.binding_cancel_revision) === activationFence.bindingCancelRevision;
    if (!identityCurrent) throw new Q2ActivationFenceError();

    const manualNote = await database.getFirstAsync<{
      content: string;
      revision: number;
      active_revision_id: string | null;
      content_sha256: string | null;
    }>(
      `SELECT note.content, note.revision, note.active_revision_id,
              immutable.content_sha256
         FROM manual_notes note
         LEFT JOIN manual_note_revisions immutable
           ON immutable.revision_id = note.active_revision_id
        WHERE note.meeting_id = ?`,
      activationFence.meetingId,
    );
    if (activationFence.manualNote.mode === 'included') {
      const source = await database.getFirstAsync<{
        source_revision_id: string;
        content_sha256: string;
      }>(
        `SELECT source_revision_id, content_sha256
           FROM meeting_question_q2_snapshot_sources
          WHERE snapshot_id = ? AND source_type = 'manual_note'
          ORDER BY ordinal LIMIT 1`,
        turn.snapshot_id,
      );
      if (
        !manualNote
        || Number(manualNote.revision) !== activationFence.manualNote.revision
        || manualNote.active_revision_id === null
        || manualNote.content_sha256 === null
        || source?.source_revision_id !== `manual_note:${activationFence.manualNote.revision}`
        || source.content_sha256 !== manualNote.content_sha256
      ) throw new Q2ActivationFenceError();
    } else if (activationFence.manualNote.mode === 'absent' && manualNote?.content.trim()) {
      throw new Q2ActivationFenceError();
    }
    const attachmentSources = await database.getAllAsync<{
      source_id: string;
      source_revision_id: string;
      content_sha256: string;
    }>(
      `SELECT source_id, source_revision_id, content_sha256
         FROM meeting_question_q2_snapshot_sources
        WHERE snapshot_id = ? AND source_type = 'attachment'
        ORDER BY ordinal`,
      turn.snapshot_id,
    );
    const seenAttachmentIds = new Set<string>();
    for (const source of attachmentSources) {
      const prefix = 'attachment:';
      const attachmentId = source.source_id.startsWith(prefix)
        ? source.source_id.slice(prefix.length)
        : '';
      if (!attachmentId || seenAttachmentIds.has(attachmentId)) {
        throw new Q2ActivationFenceError();
      }
      seenAttachmentIds.add(attachmentId);
      const current = await database.getFirstAsync<{
        active_text_revision_id: string | null;
        pending_operation: string | null;
        text_content: string | null;
        immutable_content: string | null;
        content_sha256: string | null;
      }>(
        `SELECT attachment.active_text_revision_id, attachment.pending_operation,
                attachment.text_content, immutable.content AS immutable_content,
                immutable.content_sha256
           FROM meeting_attachments attachment
           LEFT JOIN meeting_attachment_text_revisions immutable
             ON immutable.revision_id = attachment.active_text_revision_id
          WHERE attachment.id = ? AND attachment.meeting_id = ?
            AND attachment.kind = 'text'`,
        attachmentId,
        activationFence.meetingId,
      );
      if (
        !current
        || current.pending_operation === 'delete'
        || current.active_text_revision_id !== source.source_revision_id
        || current.text_content === null
        || current.immutable_content === null
        || current.text_content !== current.immutable_content
        || current.content_sha256 !== source.content_sha256
        || await sha256Text(current.text_content) !== source.content_sha256
      ) throw new Q2ActivationFenceError();
    }
    for (let clauseOrdinal = 0; clauseOrdinal < input.clauses.length; clauseOrdinal += 1) {
      const clause = input.clauses[clauseOrdinal];
      const clauseId = identifier(clause.clauseId, 'clauseId');
      // Provider clause/citation IDs are scoped only to one response and are
      // commonly reused as c1/cite1. The local schema uses global primary
      // keys, so namespace them by the immutable turn before persistence.
      const persistedClauseId = identifier(
        `q2-clause:${turnId}:${clauseOrdinal}:${clauseId}`,
        'persistedClauseId',
      );
      const answerStart = nonNegative(clause.answerStartUtf8, 'answerStartUtf8');
      const answerEnd = nonNegative(clause.answerEndUtf8, 'answerEndUtf8');
      if (answerEnd < answerStart) throw new Error('Q2 分句范围无效');
      if (clause.citations.length < 1 || clause.citations.length > 8) {
        throw new Error('Q2 分句引用数量无效');
      }
      await database.runAsync(
        `INSERT INTO meeting_question_q2_clauses (
           clause_id, turn_id, ordinal, answer_start_utf8, answer_end_utf8
         ) VALUES (?, ?, ?, ?, ?)`,
        persistedClauseId,
        turnId,
        clauseOrdinal,
        answerStart,
        answerEnd,
      );
      for (let citationOrdinal = 0; citationOrdinal < clause.citations.length; citationOrdinal += 1) {
        const citation = clause.citations[citationOrdinal];
        const citationId = identifier(citation.citationId, 'citationId');
        const persistedCitationId = identifier(
          `q2-citation:${turnId}:${clauseOrdinal}:${citationOrdinal}:${citationId}`,
          'persistedCitationId',
        );
        const sourceStart = nonNegative(citation.sourceStartUtf8, 'sourceStartUtf8');
        const sourceEnd = nonNegative(citation.sourceEndUtf8, 'sourceEndUtf8');
        if (sourceEnd < sourceStart) throw new Error('Q2 引用范围无效');
        const contentSha256 = sha256(citation.contentSha256, 'contentSha256');
        const allowedSource = await database.getFirstAsync<{ allowed: number }>(
          `SELECT 1 AS allowed
             FROM meeting_question_q2_threads thread
             INNER JOIN meeting_question_q2_snapshot_sources source
               ON source.snapshot_id = thread.snapshot_id
            WHERE thread.thread_id = ? AND source.source_type = ? AND source.source_id = ?
              AND source.source_revision_id = ? AND source.content_sha256 = ?
            LIMIT 1`,
          turn.thread_id,
          citation.sourceType,
          identifier(citation.sourceId, 'sourceId'),
          identifier(citation.sourceRevisionId, 'sourceRevisionId'),
          contentSha256,
        );
        if (!allowedSource) throw new Error('Q2 引用不属于当前来源快照');
        await database.runAsync(
          `INSERT INTO meeting_question_q2_citations (
             citation_id, clause_id, ordinal, source_type, source_id, source_revision_id,
             content_sha256, source_start_utf8, source_end_utf8, quote_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          persistedCitationId,
          persistedClauseId,
          citationOrdinal,
          citation.sourceType,
          identifier(citation.sourceId, 'sourceId'),
          identifier(citation.sourceRevisionId, 'sourceRevisionId'),
          contentSha256,
          sourceStart,
          sourceEnd,
          sha256(citation.quoteSha256, 'quoteSha256'),
        );
      }
    }
    const updated = await database.runAsync(
      `UPDATE meeting_question_q2_turns
          SET answer_kind = ?, answer = ?, completed_at_ms = ?
        WHERE turn_id = ? AND current_operation_id = ? AND completed_at_ms IS NULL`,
      input.answerKind,
      answer,
      completedAtMs,
      turnId,
      expectedOperationId,
    );
    if (Number(updated.changes) !== 1) throw new Error('Q2 回答提交发生竞争');
    await database.runAsync(
      'UPDATE meeting_question_q2_threads SET updated_at_ms = MAX(updated_at_ms, ?) WHERE thread_id = ?',
      completedAtMs,
      turn.thread_id,
    );
    return true;
  });
}
