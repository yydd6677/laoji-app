import * as Crypto from 'expo-crypto';
import type { MeetingDatabaseMigration } from './types';

export const IMMUTABLE_SOURCES_AND_Q2_V42_SQL = `
CREATE TABLE IF NOT EXISTS manual_note_revisions (
  revision_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'plain',
  content_sha256 TEXT NOT NULL CHECK(
    length(content_sha256) = 71 AND content_sha256 GLOB 'sha256:[0-9a-f]*'
  ),
  migrated_current INTEGER NOT NULL DEFAULT 0 CHECK(migrated_current IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(meeting_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_vnext_manual_note_current
  ON manual_note_revisions(meeting_id, revision DESC, revision_id);

CREATE TABLE IF NOT EXISTS meeting_attachment_text_revisions (
  revision_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES meeting_attachments(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('text','extracted_text')),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(
    length(content_sha256) = 71 AND content_sha256 GLOB 'sha256:[0-9a-f]*'
  ),
  source_asset_sha256 TEXT,
  extractor_revision TEXT,
  migrated_current INTEGER NOT NULL DEFAULT 0 CHECK(migrated_current IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(attachment_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_vnext_attachment_text_current
  ON meeting_attachment_text_revisions(attachment_id, revision DESC, revision_id);

CREATE TABLE IF NOT EXISTS meeting_question_q2_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL CHECK(
    length(source_fingerprint) = 71 AND source_fingerprint GLOB 'sha256:[0-9a-f]*'
  ),
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(meeting_id, source_fingerprint)
);

CREATE TABLE IF NOT EXISTS meeting_question_q2_snapshot_sources (
  snapshot_id TEXT NOT NULL REFERENCES meeting_question_q2_snapshots(snapshot_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_type TEXT NOT NULL CHECK(source_type IN ('transcript','manual_note','attachment')),
  source_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(content_sha256 GLOB 'sha256:[0-9a-f]*'),
  PRIMARY KEY(snapshot_id, ordinal)
);

CREATE TABLE IF NOT EXISTS meeting_question_q2_threads (
  thread_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES meeting_question_q2_snapshots(snapshot_id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_q2_threads_meeting
  ON meeting_question_q2_threads(meeting_id, updated_at_ms DESC, thread_id);

CREATE TABLE IF NOT EXISTS meeting_question_q2_turns (
  turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES meeting_question_q2_threads(thread_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  current_operation_id TEXT REFERENCES device_operations(operation_id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0),
  answer_kind TEXT,
  answer TEXT,
  provider_revision TEXT NOT NULL,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(thread_id, request_id),
  UNIQUE(thread_id, ordinal)
);

CREATE TABLE IF NOT EXISTS meeting_question_q2_clauses (
  clause_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES meeting_question_q2_turns(turn_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  answer_start_utf8 INTEGER NOT NULL CHECK(answer_start_utf8 >= 0),
  answer_end_utf8 INTEGER NOT NULL CHECK(answer_end_utf8 >= answer_start_utf8),
  UNIQUE(turn_id, ordinal)
);

CREATE TABLE IF NOT EXISTS meeting_question_q2_citations (
  citation_id TEXT PRIMARY KEY,
  clause_id TEXT NOT NULL REFERENCES meeting_question_q2_clauses(clause_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_type TEXT NOT NULL CHECK(source_type IN ('transcript','manual_note','attachment')),
  source_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(
    length(content_sha256) = 71 AND content_sha256 GLOB 'sha256:[0-9a-f]*'
  ),
  source_start_utf8 INTEGER NOT NULL CHECK(source_start_utf8 >= 0),
  source_end_utf8 INTEGER NOT NULL CHECK(source_end_utf8 >= source_start_utf8),
  quote_sha256 TEXT NOT NULL CHECK(
    length(quote_sha256) = 71 AND quote_sha256 GLOB 'sha256:[0-9a-f]*'
  ),
  UNIQUE(clause_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_q2_turns_thread
  ON meeting_question_q2_turns(thread_id, ordinal, turn_id);
CREATE INDEX IF NOT EXISTS idx_q2_citations_clause
  ON meeting_question_q2_citations(clause_id, ordinal, citation_id);
`;

async function sha256(value: string): Promise<string> {
  return `sha256:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)}`;
}

export const immutableSourcesAndQuestionQ2: MeetingDatabaseMigration = {
  version: 42,
  name: 'immutable-sources-and-question-q2',
  async migrate(database) {
    // Expo SQLite can leave an ALTER TABLE committed when a later migration
    // step fails. Probe before adding columns so retrying the same migration
    // is safe after a process kill.
    const hasColumn = async (table: string, column: string): Promise<boolean> => {
      const rows = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
      return rows.some(row => row.name === column);
    };
    if (!(await hasColumn('manual_notes', 'active_revision_id'))) {
      await database.execAsync('ALTER TABLE manual_notes ADD COLUMN active_revision_id TEXT');
    }
    if (!(await hasColumn('meeting_attachments', 'active_text_revision_id'))) {
      await database.execAsync('ALTER TABLE meeting_attachments ADD COLUMN active_text_revision_id TEXT');
    }
    await database.execAsync(IMMUTABLE_SOURCES_AND_Q2_V42_SQL);
    const now = Date.now();
    const notes = await database.getAllAsync<{
      meeting_id: string;
      content: string;
      format: string;
      revision: number;
    }>('SELECT meeting_id, content, format, revision FROM manual_notes');
    for (const note of notes) {
      const revision = Math.max(1, Number(note.revision) || 1);
      const revisionId = `manual_note:${note.meeting_id}:${revision}`;
      const contentSha256 = await sha256(note.content);
      await database.runAsync(
        `INSERT OR IGNORE INTO manual_note_revisions (
          revision_id, meeting_id, revision, content, format, content_sha256,
          migrated_current, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        revisionId,
        note.meeting_id,
        revision,
        note.content,
        note.format || 'plain',
        contentSha256,
        now,
      );
      await database.runAsync(
        'UPDATE manual_notes SET active_revision_id = ? WHERE meeting_id = ?',
        revisionId,
        note.meeting_id,
      );
    }

    const attachments = await database.getAllAsync<{
      id: string;
      meeting_id: string;
      kind: string;
      text_content: string | null;
    }>(`SELECT id, meeting_id, kind, text_content FROM meeting_attachments WHERE kind = 'text'`);
    for (const attachment of attachments) {
      const content = attachment.text_content || '';
      const revisionId = `attachment_text:${attachment.id}:1`;
      await database.runAsync(
        `INSERT OR IGNORE INTO meeting_attachment_text_revisions (
          revision_id, attachment_id, meeting_id, revision, content_kind,
          content, content_sha256, migrated_current, created_at_ms
        ) VALUES (?, ?, ?, 1, 'text', ?, ?, 1, ?)`,
        revisionId,
        attachment.id,
        attachment.meeting_id,
        content,
        await sha256(content),
        now,
      );
      await database.runAsync(
        'UPDATE meeting_attachments SET active_text_revision_id = ? WHERE id = ?',
        revisionId,
        attachment.id,
      );
    }
  },
};
