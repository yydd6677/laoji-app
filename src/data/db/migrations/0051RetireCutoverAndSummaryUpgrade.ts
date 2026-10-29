import type { MeetingDatabaseMigration } from './types';

/**
 * Remove transition-only state after the current device protocols became the
 * sole runtime paths. Historical migrations remain immutable so existing
 * databases can still advance through every released schema version.
 */
export const RETIRE_CUTOVER_AND_SUMMARY_UPGRADE_V51_SQL = `
UPDATE meeting_notes SET mode = 'offline' WHERE mode IN ('whisper', 'qwen');

UPDATE meeting_notes
   SET current_summary_version_id = (
     SELECT facts.summary_version_id
       FROM summary_fact_documents facts
       JOIN summary_versions version ON version.id = facts.summary_version_id
      WHERE facts.meeting_id = meeting_notes.id
        AND facts.summary_version_id IS NOT NULL
        AND version.status IN ('ready', 'stale')
      ORDER BY facts.generated_at_ms DESC, facts.id DESC
      LIMIT 1
   )
 WHERE current_summary_version_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM summary_fact_documents current_facts
      WHERE current_facts.summary_version_id = meeting_notes.current_summary_version_id
   );

UPDATE processing_stages
   SET status = 'none', progress = NULL, job_id = NULL,
       input_fingerprint = NULL, error_code = NULL,
       user_message_key = NULL, retryable = 0, next_retry_at_ms = NULL
 WHERE stage = 'summary'
   AND NOT EXISTS (
     SELECT 1
       FROM meeting_notes meeting
       JOIN summary_fact_documents facts
         ON facts.summary_version_id = meeting.current_summary_version_id
      WHERE meeting.id = processing_stages.meeting_id
   );

DELETE FROM summary_view_overrides
 WHERE template_id != 'general';

CREATE TABLE IF NOT EXISTS device_summary_task_intents (
  storage_scope TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode = 'guest'),
  template_id TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  input_fingerprint TEXT NOT NULL,
  carry_forward_json TEXT,
  attachment_authorization_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(storage_scope, meeting_id)
);

CREATE TABLE device_summary_task_intents_v51 (
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

INSERT OR REPLACE INTO device_summary_task_intents_v51 (
  storage_scope, meeting_id, task_id, mode, template_id, template_revision,
  input_fingerprint, carry_forward_json, attachment_authorization_json,
  created_at, updated_at
)
SELECT storage_scope, meeting_id, task_id, mode, template_id, template_revision,
       input_fingerprint, carry_forward_json, attachment_authorization_json,
       created_at, updated_at
  FROM device_summary_task_intents
 WHERE mode = 'guest' AND template_id = 'general' AND template_revision = 3;

DROP TABLE device_summary_task_intents;
ALTER TABLE device_summary_task_intents_v51 RENAME TO device_summary_task_intents;
CREATE INDEX idx_device_summary_task_intents_ready
  ON device_summary_task_intents(storage_scope, updated_at, meeting_id);

DROP TABLE IF EXISTS summary_view_preferences;
DROP TABLE IF EXISTS summary_v3_upgrade_tasks;
DROP TABLE IF EXISTS vnext_cutover_tombstones;
`;

export const retireCutoverAndSummaryUpgradeV51: MeetingDatabaseMigration = {
  version: 51,
  name: 'retire-cutover-and-summary-upgrade',
  async migrate(database) {
    await database.execAsync(RETIRE_CUTOVER_AND_SUMMARY_UPGRADE_V51_SQL);
  },
};
