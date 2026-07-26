import type { MeetingDatabaseMigration } from './types';

export const TRANSCRIPT_REPROCESS_TASKS_V31_SQL = `
ALTER TABLE recording_asset_transcription_tasks
  ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'initial'
  CHECK(request_kind IN ('initial','reprocessed'));

ALTER TABLE recording_asset_transcription_tasks
  ADD COLUMN request_generation INTEGER NOT NULL DEFAULT 0
  CHECK(request_generation >= 0);

ALTER TABLE recording_asset_transcription_tasks
  ADD COLUMN request_batch_id TEXT;

ALTER TABLE recording_asset_transcription_tasks
  ADD COLUMN source_transcript_revision_id TEXT;

CREATE TABLE recording_asset_transcription_task_history_v31 (
  task_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  local_recording_asset_id TEXT,
  client_recording_asset_id TEXT NOT NULL,
  remote_meeting_id TEXT NOT NULL,
  remote_recording_asset_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('zh','en','auto')),
  request_kind TEXT NOT NULL CHECK(request_kind IN ('initial','reprocessed')),
  request_generation INTEGER NOT NULL CHECK(request_generation >= 0),
  request_batch_id TEXT,
  source_transcript_revision_id TEXT,
  status TEXT NOT NULL,
  remote_job_id TEXT,
  remote_attempt INTEGER NOT NULL CHECK(remote_attempt >= 0),
  result_revision_id TEXT,
  error_code TEXT,
  content_synced_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  archived_at_ms INTEGER NOT NULL,
  PRIMARY KEY(scope_key, task_id, request_generation),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_recording_transcription_history_meeting_v31
  ON recording_asset_transcription_task_history_v31(
    scope_key, meeting_id, request_generation, task_id
  );

CREATE INDEX idx_recording_transcription_batch_v31
  ON recording_asset_transcription_tasks(
    scope_key, remote_meeting_id, request_batch_id, status, content_synced_at_ms
  );
`;

export const transcriptReprocessTasksV31: MeetingDatabaseMigration = {
  version: 31,
  name: 'transcript-reprocess-tasks-v31',
  async migrate(database) {
    await database.execAsync(TRANSCRIPT_REPROCESS_TASKS_V31_SQL);
  },
};
