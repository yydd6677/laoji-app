import type {
  MeetingQuestionCitation,
  MeetingQuestionThread,
  MeetingQuestionTurn,
  ScopeKey,
} from '../../domain/meeting';
import type { SQLiteDatabase } from 'expo-sqlite';
import { assertScopeKey } from '../../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';

type ThreadRow = {
  id: string;
  meeting_id: string;
  input_fingerprint: string;
  transcript_revision_id: string;
  summary_version_id: string | null;
  manual_note_revision: number | null;
  include_manual_note: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type TurnRow = {
  id: string;
  request_id: string;
  remote_turn_id: string | null;
  ordinal: number;
  question: string;
  answer_scope: MeetingQuestionTurn['answerScope'];
  answer_kind: MeetingQuestionTurn['answerKind'];
  answer: string;
  created_at_ms: number;
  completed_at_ms: number;
};

type CitationRow = {
  id: string;
  turn_id: string;
  kind: MeetingQuestionCitation['kind'];
  segment_id: string | null;
  section_id: string | null;
  manual_note_revision: number | null;
  start_ms: number | null;
  end_ms: number | null;
  source_label: string;
  source_excerpt: string;
  ordinal: number;
};

export interface NewMeetingQuestionThread {
  id: string;
  meetingId: string;
  scopeKey: ScopeKey;
  inputFingerprint: string;
  transcriptRevisionId: string;
  summaryVersionId: string | null;
  manualNoteRevision: number | null;
  includeManualNote: boolean;
  createdAtMs: number;
}

export interface SaveMeetingQuestionTurnInput {
  threadId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  turn: MeetingQuestionTurn;
}

function assertId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function assertText(value: string, label: string, maximum: number): string {
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function assertTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function citationFromRow(row: CitationRow): MeetingQuestionCitation {
  if (row.kind === 'transcript') {
    if (!row.segment_id || row.start_ms === null || row.end_ms === null) {
      throw new Error('问答引用记录已损坏');
    }
    return {
      id: row.id,
      kind: 'transcript',
      segmentId: row.segment_id,
      startMs: row.start_ms,
      endMs: row.end_ms,
      sourceLabel: row.source_label,
      sourceExcerpt: row.source_excerpt,
    };
  }
  if (row.kind === 'summary') {
    if (!row.section_id) throw new Error('问答引用记录已损坏');
    return {
      id: row.id,
      kind: 'summary',
      sectionId: row.section_id,
      sourceLabel: row.source_label,
      sourceExcerpt: row.source_excerpt,
    };
  }
  if (row.manual_note_revision === null) throw new Error('问答引用记录已损坏');
  return {
    id: row.id,
    kind: 'manual_note',
    manualNoteRevision: row.manual_note_revision,
    sourceLabel: row.source_label,
    sourceExcerpt: row.source_excerpt,
  };
}

async function projectThread(
  row: ThreadRow,
  database?: SQLiteDatabase,
): Promise<MeetingQuestionThread> {
  const activeDatabase = database ?? await openMeetingDatabase();
  const [turnRows, citationRows] = await Promise.all([
    activeDatabase.getAllAsync<TurnRow>(
      `SELECT id, request_id, remote_turn_id, ordinal, question, answer_scope, answer_kind,
              answer, created_at_ms, completed_at_ms
       FROM meeting_question_turns
       WHERE thread_id = ?
       ORDER BY ordinal, id`,
      row.id,
    ),
    activeDatabase.getAllAsync<CitationRow>(
      `SELECT citation.*
       FROM meeting_question_citations citation
       INNER JOIN meeting_question_turns turn ON turn.id = citation.turn_id
       WHERE turn.thread_id = ?
       ORDER BY turn.ordinal, citation.ordinal, citation.id`,
      row.id,
    ),
  ]);
  const citations = new Map<string, MeetingQuestionCitation[]>();
  citationRows.forEach(citation => {
    const values = citations.get(citation.turn_id) ?? [];
    values.push(citationFromRow(citation));
    citations.set(citation.turn_id, values);
  });
  return {
    id: row.id,
    meetingId: row.meeting_id,
    inputFingerprint: row.input_fingerprint,
    transcriptRevisionId: row.transcript_revision_id,
    summaryVersionId: row.summary_version_id,
    manualNoteRevision: row.manual_note_revision,
    includeManualNote: row.include_manual_note === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    turns: turnRows.map(turn => ({
      id: turn.id,
      requestId: turn.request_id,
      remoteTurnId: turn.remote_turn_id,
      ordinal: turn.ordinal,
      question: turn.question,
      answerScope: turn.answer_scope,
      answerKind: turn.answer_kind,
      answer: turn.answer,
      citations: citations.get(turn.id) ?? [],
      createdAtMs: turn.created_at_ms,
      completedAtMs: turn.completed_at_ms,
    })),
  };
}

export async function findLatestMeetingQuestionThread(input: {
  meetingId: string;
  scopeKey: ScopeKey;
  inputFingerprint: string;
  includeManualNote: boolean;
}): Promise<MeetingQuestionThread | null> {
  assertScopeKey(input.scopeKey);
  const meetingId = assertId(input.meetingId, '会议标识');
  const fingerprint = input.inputFingerprint.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error('问答证据标识无效');
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<ThreadRow>(
    `SELECT thread.*
     FROM meeting_question_threads thread
     INNER JOIN meeting_notes meeting
       ON meeting.id = thread.meeting_id AND meeting.scope_key = thread.scope_key
     WHERE thread.meeting_id = ? AND thread.scope_key = ?
       AND thread.input_fingerprint = ? AND thread.include_manual_note = ?
     ORDER BY thread.updated_at_ms DESC, thread.created_at_ms DESC, thread.id DESC
     LIMIT 1`,
    meetingId,
    input.scopeKey,
    fingerprint,
    input.includeManualNote ? 1 : 0,
  );
  return row ? projectThread(row, database) : null;
}

export async function createMeetingQuestionThread(
  input: NewMeetingQuestionThread,
): Promise<MeetingQuestionThread> {
  assertScopeKey(input.scopeKey);
  const id = assertId(input.id, '问答记录标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const transcriptRevisionId = assertId(input.transcriptRevisionId, '文字记录版本');
  const summaryVersionId = input.summaryVersionId
    ? assertId(input.summaryVersionId, '整理结果版本')
    : null;
  const fingerprint = input.inputFingerprint.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error('问答证据标识无效');
  const createdAtMs = assertTime(input.createdAtMs, '问答记录时间');
  if (input.includeManualNote !== (input.manualNoteRevision !== null)) {
    throw new Error('问答笔记范围无效');
  }
  if (input.manualNoteRevision !== null) assertTime(input.manualNoteRevision, '笔记版本');

  const row = await withMeetingDatabaseTransaction(async database => {
    const evidence = await database.getFirstAsync<{
      transcript_revision_id: string;
      summary_version_id: string | null;
      manual_note_revision: number;
    }>(
      `SELECT transcript.id AS transcript_revision_id,
              summary.id AS summary_version_id,
              note.revision AS manual_note_revision
       FROM meeting_notes meeting
       INNER JOIN transcript_revisions transcript
         ON transcript.meeting_id = meeting.id AND transcript.is_active = 1
       INNER JOIN manual_notes note ON note.meeting_id = meeting.id
       LEFT JOIN summary_versions summary
         ON summary.id = meeting.current_summary_version_id AND summary.meeting_id = meeting.id
       WHERE meeting.id = ? AND meeting.scope_key = ?`,
      meetingId,
      input.scopeKey,
    );
    if (!evidence || evidence.transcript_revision_id !== transcriptRevisionId) {
      throw new Error('文字记录已更新，请重新开始问答');
    }
    if (evidence.summary_version_id !== summaryVersionId) {
      throw new Error('整理结果已更新，请重新开始问答');
    }
    if (
      input.includeManualNote
      && evidence.manual_note_revision !== input.manualNoteRevision
    ) {
      throw new Error('我的笔记已更新，请重新开始问答');
    }
    await database.runAsync(
      `INSERT INTO meeting_question_threads (
         id, meeting_id, scope_key, input_fingerprint, transcript_revision_id,
         summary_version_id, manual_note_revision, include_manual_note,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      meetingId,
      input.scopeKey,
      fingerprint,
      transcriptRevisionId,
      summaryVersionId,
      input.manualNoteRevision,
      input.includeManualNote ? 1 : 0,
      createdAtMs,
      createdAtMs,
    );
    return database.getFirstAsync<ThreadRow>(
      'SELECT * FROM meeting_question_threads WHERE id = ?',
      id,
    );
  });
  if (!row) throw new Error('问答记录未能保存');
  return projectThread(row);
}

export async function saveMeetingQuestionTurn(
  input: SaveMeetingQuestionTurnInput,
): Promise<MeetingQuestionThread> {
  assertScopeKey(input.scopeKey);
  const threadId = assertId(input.threadId, '问答记录标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const turnId = assertId(input.turn.id, '问答轮次标识');
  const requestId = assertId(input.turn.requestId, '问答请求标识');
  const remoteTurnId = input.turn.remoteTurnId
    ? assertId(input.turn.remoteTurnId, '远端问答轮次标识')
    : null;
  const question = assertText(input.turn.question, '问题', 2_000);
  const answer = assertText(input.turn.answer, '回答', 20_000);
  const createdAtMs = assertTime(input.turn.createdAtMs, '提问时间');
  const completedAtMs = assertTime(input.turn.completedAtMs, '回答时间');
  if (completedAtMs < createdAtMs) throw new Error('问答时间顺序无效');
  if (!Number.isSafeInteger(input.turn.ordinal) || input.turn.ordinal < 0) {
    throw new Error('问答轮次无效');
  }
  if (
    input.turn.answerScope === 'meeting'
    && input.turn.answerKind === 'answer'
    && input.turn.citations.length === 0
  ) {
    throw new Error('回答缺少会议来源');
  }
  if (
    input.turn.answerScope === 'meeting'
    &&
    input.turn.answerKind === 'insufficient'
    && (answer !== '当前会议记录中没有足够信息' || input.turn.citations.length !== 0)
  ) {
    throw new Error('无来源回答格式无效');
  }
  if (
    input.turn.answerScope === 'general'
    && (input.turn.answerKind !== 'answer' || input.turn.citations.length !== 0)
  ) {
    throw new Error('普通回答格式无效');
  }
  if (input.turn.citations.length > 20) throw new Error('回答引用数量过多');

  const row = await withMeetingDatabaseTransaction(async database => {
    const thread = await database.getFirstAsync<ThreadRow>(
      `SELECT thread.*
       FROM meeting_question_threads thread
       INNER JOIN meeting_notes meeting
         ON meeting.id = thread.meeting_id AND meeting.scope_key = thread.scope_key
       WHERE thread.id = ? AND thread.meeting_id = ? AND thread.scope_key = ?`,
      threadId,
      meetingId,
      input.scopeKey,
    );
    if (!thread) throw new Error('问答记录已不可用');
    const existing = await database.getFirstAsync<TurnRow>(
      'SELECT * FROM meeting_question_turns WHERE thread_id = ? AND request_id = ?',
      threadId,
      requestId,
    );
    if (existing) {
      if (
        existing.id !== turnId
        || existing.ordinal !== input.turn.ordinal
        || existing.question !== question
        || existing.answer_scope !== input.turn.answerScope
        || existing.answer_kind !== input.turn.answerKind
        || existing.answer !== answer
      ) {
        throw new Error('同一问答请求返回了不同内容');
      }
      return thread;
    }
    const count = Number((await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM meeting_question_turns WHERE thread_id = ?',
      threadId,
    ))?.count ?? 0);
    if (count !== input.turn.ordinal) throw new Error('问答记录已在其他位置更新');

    const citationIds = new Set<string>();
    for (let ordinal = 0; ordinal < input.turn.citations.length; ordinal += 1) {
      const citation = input.turn.citations[ordinal];
      assertId(citation.id, '问答引用标识');
      if (citationIds.has(citation.id)) throw new Error('回答包含重复引用');
      citationIds.add(citation.id);
      assertText(citation.sourceLabel, '引用名称', 200);
      assertText(citation.sourceExcerpt, '引用内容', 2_000);
      if (citation.kind === 'transcript') {
        const segment = await database.getFirstAsync<{ start_ms: number; end_ms: number }>(
          `SELECT segment.start_ms, segment.end_ms
           FROM transcript_segments segment
           WHERE segment.id = ? AND segment.meeting_id = ?
             AND segment.revision_id = ?`,
          assertId(citation.segmentId, '文字记录片段'),
          meetingId,
          thread.transcript_revision_id,
        );
        if (
          !segment
          || segment.start_ms !== assertTime(citation.startMs, '引用开始时间')
          || segment.end_ms !== assertTime(citation.endMs, '引用结束时间')
        ) {
          throw new Error('回答引用不属于锁定的文字记录');
        }
      } else if (citation.kind === 'summary') {
        if (!thread.summary_version_id) throw new Error('回答引用了未纳入的整理结果');
        const section = await database.getFirstAsync<{ id: string }>(
          'SELECT id FROM summary_sections WHERE id = ? AND version_id = ?',
          assertId(citation.sectionId, '整理结果段落'),
          thread.summary_version_id,
        );
        if (!section) throw new Error('回答引用不属于锁定的整理结果');
      } else if (
        !thread.include_manual_note
        || thread.manual_note_revision !== assertTime(citation.manualNoteRevision, '笔记版本')
      ) {
        throw new Error('回答引用了未授权的我的笔记');
      }
    }

    await database.runAsync(
      `INSERT INTO meeting_question_turns (
         id, thread_id, request_id, remote_turn_id, ordinal, question,
         answer_scope, answer_kind, answer, created_at_ms, completed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turnId,
      threadId,
      requestId,
      remoteTurnId,
      input.turn.ordinal,
      question,
      input.turn.answerScope,
      input.turn.answerKind,
      answer,
      createdAtMs,
      completedAtMs,
    );
    for (let ordinal = 0; ordinal < input.turn.citations.length; ordinal += 1) {
      const citation = input.turn.citations[ordinal];
      await database.runAsync(
        `INSERT INTO meeting_question_citations (
           id, turn_id, kind, segment_id, section_id, manual_note_revision,
           start_ms, end_ms, source_label, source_excerpt, ordinal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        citation.id,
        turnId,
        citation.kind,
        citation.kind === 'transcript' ? citation.segmentId : null,
        citation.kind === 'summary' ? citation.sectionId : null,
        citation.kind === 'manual_note' ? citation.manualNoteRevision : null,
        citation.kind === 'transcript' ? citation.startMs : null,
        citation.kind === 'transcript' ? citation.endMs : null,
        citation.sourceLabel,
        citation.sourceExcerpt,
        ordinal,
      );
    }
    const threadUpdatedAtMs = Math.max(completedAtMs, thread.created_at_ms);
    await database.runAsync(
      `UPDATE meeting_question_threads
       SET updated_at_ms = ?
       WHERE id = ? AND updated_at_ms <= ?`,
      threadUpdatedAtMs,
      threadId,
      threadUpdatedAtMs,
    );
    return database.getFirstAsync<ThreadRow>(
      'SELECT * FROM meeting_question_threads WHERE id = ?',
      threadId,
    );
  });
  if (!row) throw new Error('问答结果未能保存');
  return projectThread(row);
}
