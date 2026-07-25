import type { MeetingDatabaseMigration } from './types';

export const MEETING_QUESTIONS_V22_SQL = `
CREATE TABLE meeting_question_threads (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL CHECK(input_fingerprint GLOB 'sha256:[0-9a-f]*'),
  transcript_revision_id TEXT NOT NULL,
  summary_version_id TEXT,
  manual_note_revision INTEGER,
  include_manual_note INTEGER NOT NULL CHECK(include_manual_note IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  CHECK(
    (include_manual_note = 1 AND manual_note_revision IS NOT NULL AND manual_note_revision >= 0)
    OR
    (include_manual_note = 0 AND manual_note_revision IS NULL)
  )
);

CREATE INDEX idx_meeting_question_threads_current
  ON meeting_question_threads(
    scope_key, meeting_id, input_fingerprint, include_manual_note, updated_at_ms DESC, id
  );

CREATE TABLE meeting_question_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES meeting_question_threads(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  remote_turn_id TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0),
  answer_kind TEXT NOT NULL CHECK(answer_kind IN ('answer','insufficient')),
  answer TEXT NOT NULL CHECK(length(trim(answer)) > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  completed_at_ms INTEGER NOT NULL CHECK(completed_at_ms >= created_at_ms),
  UNIQUE(thread_id, request_id),
  UNIQUE(thread_id, ordinal)
);

CREATE INDEX idx_meeting_question_turns_thread
  ON meeting_question_turns(thread_id, ordinal, id);

CREATE TABLE meeting_question_citations (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES meeting_question_turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('transcript','summary','manual_note')),
  segment_id TEXT,
  section_id TEXT,
  manual_note_revision INTEGER,
  start_ms INTEGER,
  end_ms INTEGER,
  source_label TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  UNIQUE(turn_id, ordinal),
  CHECK(
    (kind = 'transcript' AND segment_id IS NOT NULL AND section_id IS NULL
      AND manual_note_revision IS NULL AND start_ms IS NOT NULL AND start_ms >= 0
      AND end_ms IS NOT NULL AND end_ms >= start_ms)
    OR
    (kind = 'summary' AND segment_id IS NULL AND section_id IS NOT NULL
      AND manual_note_revision IS NULL AND start_ms IS NULL AND end_ms IS NULL)
    OR
    (kind = 'manual_note' AND segment_id IS NULL AND section_id IS NULL
      AND manual_note_revision IS NOT NULL AND manual_note_revision >= 0
      AND start_ms IS NULL AND end_ms IS NULL)
  )
);

CREATE INDEX idx_meeting_question_citations_turn
  ON meeting_question_citations(turn_id, ordinal, id);
`;

export const meetingQuestionsV22: MeetingDatabaseMigration = {
  version: 22,
  name: 'meeting-questions-v22',
  async migrate(database) {
    await database.execAsync(MEETING_QUESTIONS_V22_SQL);
  },
};
