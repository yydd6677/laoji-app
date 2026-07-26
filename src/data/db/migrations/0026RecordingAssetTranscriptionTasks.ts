import type { MeetingDatabaseMigration } from './types';

export const RECORDING_ASSET_TRANSCRIPTION_TASKS_V26_SQL = `
CREATE TABLE recording_asset_transcription_tasks (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  local_recording_asset_id TEXT REFERENCES recording_assets(id) ON DELETE SET NULL,
  client_recording_asset_id TEXT NOT NULL,
  remote_meeting_id TEXT NOT NULL,
  remote_recording_asset_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en','auto')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','queued','running','completed','failed_retryable','blocked')),
  remote_job_id TEXT,
  request_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(request_attempt_count >= 0),
  remote_attempt INTEGER NOT NULL DEFAULT 0 CHECK(remote_attempt >= 0),
  progress REAL CHECK(progress IS NULL OR (progress >= 0 AND progress <= 1)),
  result_revision_id TEXT,
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  next_attempt_at_ms INTEGER,
  remote_updated_at_ms INTEGER,
  content_synced_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE(scope_key, remote_recording_asset_id),
  UNIQUE(scope_key, client_request_id),
  UNIQUE(scope_key, remote_job_id)
);

CREATE INDEX idx_recording_asset_transcription_ready
  ON recording_asset_transcription_tasks(
    scope_key, status, next_attempt_at_ms, updated_at_ms, id
  );

CREATE INDEX idx_recording_asset_transcription_meeting
  ON recording_asset_transcription_tasks(
    scope_key, meeting_id, status, content_synced_at_ms, id
  );
`;

export const recordingAssetTranscriptionTasksV26: MeetingDatabaseMigration = {
  version: 26,
  name: 'recording-asset-transcription-tasks-v26',
  async migrate(database) {
    await database.execAsync(RECORDING_ASSET_TRANSCRIPTION_TASKS_V26_SQL);
  },
};
