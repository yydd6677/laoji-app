import type { MeetingDatabaseMigration } from './types';

export const TRANSCRIPT_OVERLAY_AND_SEARCH_VNEXT_V43_SQL = `
CREATE TABLE IF NOT EXISTS speaker_overlay_revisions (
  revision_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  overlay_revision INTEGER NOT NULL CHECK(overlay_revision >= 1),
  source_manifest_sha256 TEXT,
  model_revision TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  created_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  UNIQUE(transcript_revision_id, overlay_revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_overlay_active
  ON speaker_overlay_revisions(transcript_revision_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS speaker_overlay_assignments (
  revision_id TEXT NOT NULL REFERENCES speaker_overlay_revisions(revision_id) ON DELETE CASCADE,
  stable_segment_key TEXT NOT NULL,
  automatic_label TEXT,
  speaker_cluster_id TEXT,
  speaker_profile_id TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  PRIMARY KEY(revision_id, stable_segment_key)
);

CREATE TABLE IF NOT EXISTS speaker_manual_overrides (
  override_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  stable_segment_key TEXT NOT NULL,
  expected_transcript_revision TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK(length(trim(label)) > 0),
  speaker_profile_id TEXT,
  override_revision INTEGER NOT NULL CHECK(override_revision >= 1),
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
  source_correction_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  UNIQUE(meeting_id, stable_segment_key)
);

CREATE INDEX IF NOT EXISTS idx_speaker_manual_override_revision
  ON speaker_manual_overrides(meeting_id, expected_transcript_revision, needs_review, stable_segment_key);

CREATE TABLE IF NOT EXISTS meeting_search_documents (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL UNIQUE REFERENCES meeting_notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  transcript_text TEXT NOT NULL DEFAULT '',
  manual_note_text TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS meeting_search_fts USING fts5(
  title,
  transcript_text,
  manual_note_text,
  content='meeting_search_documents',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_ai AFTER INSERT ON meeting_search_documents BEGIN
  INSERT INTO meeting_search_fts(rowid, title, transcript_text, manual_note_text)
  VALUES (new.rowid, new.title, new.transcript_text, new.manual_note_text);
END;

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_ad AFTER DELETE ON meeting_search_documents BEGIN
  INSERT INTO meeting_search_fts(meeting_search_fts, rowid, title, transcript_text, manual_note_text)
  VALUES ('delete', old.rowid, old.title, old.transcript_text, old.manual_note_text);
END;

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_au AFTER UPDATE ON meeting_search_documents BEGIN
  INSERT INTO meeting_search_fts(meeting_search_fts, rowid, title, transcript_text, manual_note_text)
  VALUES ('delete', old.rowid, old.title, old.transcript_text, old.manual_note_text);
  INSERT INTO meeting_search_fts(rowid, title, transcript_text, manual_note_text)
  VALUES (new.rowid, new.title, new.transcript_text, new.manual_note_text);
END;

INSERT OR IGNORE INTO meeting_search_documents(meeting_id, title, transcript_text, manual_note_text, updated_at_ms)
SELECT meeting.id, meeting.title, '', COALESCE(note.content, ''), meeting.updated_at_ms
FROM meeting_notes meeting
LEFT JOIN manual_notes note ON note.meeting_id = meeting.id;

UPDATE meeting_search_documents AS search
SET title = COALESCE((SELECT meeting.title FROM meeting_notes meeting WHERE meeting.id = search.meeting_id), ''),
    manual_note_text = COALESCE((SELECT note.content FROM manual_notes note WHERE note.meeting_id = search.meeting_id), ''),
    transcript_text = COALESCE((
      SELECT group_concat(ordered.text, char(10)) FROM (
        SELECT segment.text
        FROM transcript_segments segment
        INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
        WHERE revision.meeting_id = search.meeting_id AND revision.is_active = 1
        ORDER BY segment.ordinal
      ) AS ordered
    ), ''),
    updated_at_ms = MAX(updated_at_ms, COALESCE((
      SELECT meeting.updated_at_ms FROM meeting_notes meeting WHERE meeting.id = search.meeting_id
    ), updated_at_ms));

INSERT INTO meeting_search_fts(meeting_search_fts) VALUES ('rebuild');
`;

export const transcriptOverlayAndSearchVNext: MeetingDatabaseMigration = {
  version: 43,
  name: 'transcript-overlay-and-search-vnext',
  async migrate(database) {
    const hasColumn = async (table: string, column: string): Promise<boolean> => {
      const rows = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
      return rows.some(row => row.name === column);
    };
    if (!(await hasColumn('transcript_revisions', 'source_manifest_sha256'))) {
      await database.execAsync('ALTER TABLE transcript_revisions ADD COLUMN source_manifest_sha256 TEXT');
    }
    if (!(await hasColumn('transcript_revisions', 'text_final_at_ms'))) {
      await database.execAsync('ALTER TABLE transcript_revisions ADD COLUMN text_final_at_ms INTEGER');
    }
    if (!(await hasColumn('transcript_segments', 'stable_segment_key'))) {
      await database.execAsync('ALTER TABLE transcript_segments ADD COLUMN stable_segment_key TEXT');
    }
    if (!(await hasColumn('transcript_segments', 'segment_revision'))) {
      await database.execAsync('ALTER TABLE transcript_segments ADD COLUMN segment_revision INTEGER');
    }
    if (!(await hasColumn('transcript_segments', 'text_state'))) {
      await database.execAsync('ALTER TABLE transcript_segments ADD COLUMN text_state TEXT');
    }
    await database.execAsync(`
      UPDATE transcript_revisions
      SET text_final_at_ms = finalized_at_ms
      WHERE text_final_at_ms IS NULL AND status = 'ready';
      UPDATE transcript_segments
      SET stable_segment_key = COALESCE(NULLIF(source_segment_id, ''), id),
          segment_revision = COALESCE(segment_revision, 1),
          text_state = COALESCE(text_state, CASE WHEN is_final = 1 THEN 'final' ELSE 'partial' END)
      WHERE stable_segment_key IS NULL OR segment_revision IS NULL OR text_state IS NULL;
    `);
    await database.execAsync(TRANSCRIPT_OVERLAY_AND_SEARCH_VNEXT_V43_SQL);
    await database.execAsync(`
      INSERT OR IGNORE INTO speaker_overlay_revisions(
        revision_id, meeting_id, transcript_revision_id, overlay_revision,
        source_manifest_sha256, model_revision, status, created_at_ms, activated_at_ms
      )
      SELECT 'migrated-overlay:' || revision.id, revision.meeting_id, revision.id, 1,
             revision.source_manifest_sha256, revision.source_model, 'active',
             revision.created_at_ms, COALESCE(revision.text_final_at_ms, revision.finalized_at_ms, revision.created_at_ms)
      FROM transcript_revisions revision
      WHERE EXISTS (
        SELECT 1 FROM transcript_segments segment
        WHERE segment.revision_id = revision.id
          AND (segment.speaker_label IS NOT NULL OR segment.speaker_cluster_id IS NOT NULL)
      );

      INSERT OR IGNORE INTO speaker_overlay_assignments(
        revision_id, stable_segment_key, automatic_label,
        speaker_cluster_id, speaker_profile_id, confidence
      )
      SELECT 'migrated-overlay:' || segment.revision_id,
             segment.stable_segment_key, segment.speaker_label,
             segment.speaker_cluster_id, segment.speaker_profile_id, segment.confidence
      FROM transcript_segments segment
      WHERE segment.stable_segment_key IS NOT NULL
        AND (segment.speaker_label IS NOT NULL OR segment.speaker_cluster_id IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM speaker_overlay_revisions overlay
          WHERE overlay.revision_id = 'migrated-overlay:' || segment.revision_id
        );

      INSERT OR IGNORE INTO speaker_manual_overrides(
        override_id, meeting_id, stable_segment_key, expected_transcript_revision,
        label, speaker_profile_id, override_revision, needs_review,
        source_correction_id, created_at_ms, updated_at_ms
      )
      SELECT 'migrated-manual:' || assignment.id, assignment.meeting_id,
             segment.stable_segment_key, assignment.transcript_revision_id,
             assignment.display_name, assignment.speaker_profile_id,
             MAX(1, assignment.assignment_revision),
             CASE WHEN segment.revision_id = assignment.transcript_revision_id THEN 0 ELSE 1 END,
             assignment.correction_id, assignment.created_at_ms, assignment.created_at_ms
      FROM speaker_assignments assignment
      INNER JOIN transcript_segments segment ON segment.id = assignment.segment_id
      WHERE segment.stable_segment_key IS NOT NULL;
    `);
  },
};
