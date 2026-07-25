import type { MeetingDatabaseMigration } from './types';

export const RECORDING_MERGE_RECOVERY_V19_SQL = `
CREATE TABLE meeting_recording_merge_tasks (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  detached_history_id TEXT NOT NULL
    REFERENCES meeting_occurrence_detached_history(id) ON DELETE CASCADE,
  source_meeting_id TEXT NOT NULL,
  source_recording_asset_id TEXT NOT NULL,
  target_meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  target_recording_asset_id TEXT NOT NULL,
  source_asset_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','failed','completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK(retryable IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE(scope_key, detached_history_id, source_recording_asset_id),
  UNIQUE(scope_key, target_recording_asset_id)
);

CREATE INDEX idx_recording_merge_target_state
  ON meeting_recording_merge_tasks(scope_key, target_meeting_id, status, created_at_ms, id);

CREATE INDEX idx_recording_merge_source
  ON meeting_recording_merge_tasks(scope_key, source_meeting_id, source_recording_asset_id);
`;

export const recordingMergeRecoveryV19: MeetingDatabaseMigration = {
  version: 19,
  name: 'recording-merge-recovery-v19',
  async migrate(database) {
    await database.execAsync(RECORDING_MERGE_RECOVERY_V19_SQL);
  },
};
