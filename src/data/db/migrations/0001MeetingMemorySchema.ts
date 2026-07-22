import type { MeetingDatabaseMigration } from './types';

export const MEETING_MEMORY_SCHEMA_V1_SQL = `
CREATE TABLE meeting_notes (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  remote_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('calendar','ad_hoc','file_import','share_intent')),
  entry_point TEXT,
  title TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','ended','deleted')),
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  current_summary_version_id TEXT,
  remote_revision INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'local',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(scope_key, remote_id)
);

CREATE TABLE meeting_occurrence_links (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  calendar_source_event_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  calendar_revision INTEGER,
  recurrence_segment_id TEXT,
  series_key TEXT,
  link_state TEXT NOT NULL DEFAULT 'active',
  linked_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, calendar_source_event_id, occurrence_date)
);

CREATE INDEX idx_occurrence_series
  ON meeting_occurrence_links(scope_key, series_key, occurrence_date);

CREATE TABLE meeting_schedule_snapshots (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL DEFAULT '',
  planned_start_ms INTEGER,
  planned_end_ms INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  timezone_id TEXT,
  location TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  captured_event_revision INTEGER,
  captured_at_ms INTEGER NOT NULL
);

CREATE TABLE manual_notes (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'plain',
  revision INTEGER NOT NULL DEFAULT 0,
  base_remote_revision INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  last_saved_at_ms INTEGER NOT NULL,
  user_edited_at_ms INTEGER
);

CREATE TABLE recording_assets (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary',
  origin TEXT NOT NULL CHECK(origin IN ('captured','imported','recovered')),
  local_uri TEXT,
  remote_asset_id TEXT,
  mime_type TEXT,
  file_name TEXT,
  byte_size INTEGER,
  duration_ms INTEGER,
  checksum_sha256 TEXT,
  waveform_json TEXT,
  local_state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_recording_meeting ON recording_assets(meeting_id, role);

CREATE TABLE processing_stages (
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('capture','upload','transcript','summary','speaker')),
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  progress REAL,
  job_id TEXT,
  input_fingerprint TEXT,
  error_code TEXT,
  user_message_key TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(meeting_id, stage)
);

CREATE TABLE transcript_revisions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('realtime_draft','final','reprocessed')),
  status TEXT NOT NULL,
  source_provider TEXT,
  source_model TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER
);

CREATE INDEX idx_transcript_revision_active
  ON transcript_revisions(meeting_id, is_active, created_at_ms);

CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_cluster_id TEXT,
  speaker_profile_id TEXT,
  speaker_label TEXT,
  speaker_label_override TEXT,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  confidence REAL,
  is_final INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(revision_id, ordinal)
);

CREATE INDEX idx_transcript_timeline
  ON transcript_segments(meeting_id, revision_id, start_ms, ordinal);

CREATE TABLE transcript_words (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  UNIQUE(segment_id, ordinal)
);

CREATE TABLE summary_versions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  input_fingerprint TEXT NOT NULL,
  transcript_revision_id TEXT REFERENCES transcript_revisions(id),
  manual_note_revision INTEGER NOT NULL,
  schedule_snapshot_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','generating','ready','failed','stale')),
  generated_by TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  supersedes_version_id TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX idx_summary_meeting_versions
  ON summary_versions(meeting_id, created_at_ms DESC);

CREATE TABLE summary_sections (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  generated_text TEXT NOT NULL DEFAULT '',
  user_text TEXT,
  ordinal INTEGER NOT NULL,
  user_edited_at_ms INTEGER,
  UNIQUE(version_id, stable_key)
);

CREATE TABLE summary_citations (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES summary_sections(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  quote_hash TEXT,
  ordinal INTEGER NOT NULL
);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  remote_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','dismissed')),
  assignee_text TEXT,
  due_at_ms INTEGER,
  reminder_notification_id TEXT,
  followup_event_source_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('generated','manual','marker')),
  source_summary_version_id TEXT,
  source_segment_id TEXT,
  source_start_ms INTEGER,
  generation_fingerprint TEXT,
  user_edited_at_ms INTEGER,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_actions_due
  ON action_items(meeting_id, status, due_at_ms);

CREATE TABLE action_item_citations (
  action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  quote_hash TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(action_item_id, segment_id, ordinal)
);

CREATE TABLE markers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  nearest_segment_id TEXT,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'important',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_markers_timeline ON markers(meeting_id, position_ms);

CREATE TABLE sync_outbox (
  operation_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  base_revision INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_outbox_ready
  ON sync_outbox(scope_key, status, next_attempt_at_ms, created_at_ms);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  local_revision INTEGER,
  remote_revision INTEGER,
  local_payload_json TEXT NOT NULL,
  remote_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved',
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE INDEX idx_conflicts_unresolved
  ON sync_conflicts(scope_key, status, created_at_ms);

CREATE TABLE migration_runs (
  migration_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  phase TEXT NOT NULL,
  source_hash TEXT,
  imported_counts_json TEXT,
  last_error TEXT,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
`;

export const meetingMemorySchemaV1: MeetingDatabaseMigration = {
  version: 1,
  name: 'meeting-memory-schema-v1',
  async migrate(database) {
    await database.execAsync(MEETING_MEMORY_SCHEMA_V1_SQL);
  },
};
