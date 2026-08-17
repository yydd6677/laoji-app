import type { MeetingDatabaseMigration } from './types';

export const SUMMARY_FACTS_V3_SQL = `
CREATE TABLE summary_fact_documents (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  summary_version_id TEXT REFERENCES summary_versions(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL,
  transcript_revision TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  prompt_revision TEXT NOT NULL,
  document_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(meeting_id, source_fingerprint, model_revision, prompt_revision)
);

CREATE UNIQUE INDEX idx_summary_fact_document_version
  ON summary_fact_documents(summary_version_id)
  WHERE summary_version_id IS NOT NULL;

CREATE INDEX idx_summary_fact_document_meeting
  ON summary_fact_documents(meeting_id, generated_at_ms DESC, id);

CREATE TABLE summary_view_preferences (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL CHECK(template_id IN ('general','one_on_one','project_sync','interview')),
  template_revision INTEGER NOT NULL CHECK(template_revision = 3),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE summary_view_overrides (
  version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL CHECK(template_id IN ('general','one_on_one','project_sync','interview')),
  stable_block_key TEXT NOT NULL,
  replacement_kind TEXT NOT NULL CHECK(replacement_kind IN ('paragraph','bullet_group')),
  replacement_text TEXT NOT NULL,
  user_edited_at_ms INTEGER NOT NULL,
  PRIMARY KEY(version_id, template_id, stable_block_key)
);

CREATE TABLE summary_v3_upgrade_tasks (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','failure')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  remote_task_id TEXT,
  next_attempt_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX idx_summary_v3_upgrade_ready
  ON summary_v3_upgrade_tasks(status, next_attempt_at_ms, updated_at_ms, meeting_id);

INSERT OR IGNORE INTO summary_v3_upgrade_tasks (
  meeting_id, status, attempt_count, remote_task_id, next_attempt_at_ms,
  last_error_code, created_at_ms, updated_at_ms, completed_at_ms
)
SELECT DISTINCT version.meeting_id, 'pending', 0, NULL, NULL, NULL,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       NULL
FROM summary_versions version
WHERE version.status IN ('ready','stale')
  AND EXISTS (
    SELECT 1 FROM transcript_revisions transcript
    WHERE transcript.meeting_id = version.meeting_id
      AND transcript.is_active = 1
      AND transcript.status = 'ready'
  );
`;

export const summaryFactsV3: MeetingDatabaseMigration = {
  version: 39,
  name: 'summary-facts-v3',
  async migrate(database) {
    await database.execAsync(SUMMARY_FACTS_V3_SQL);
  },
};
