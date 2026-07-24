import type { MeetingDatabaseMigration } from './types';

export const OCCURRENCE_DETACHED_HISTORY_V16_SQL = `
CREATE TABLE meeting_occurrence_detached_history (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  local_meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE RESTRICT,
  conflict_id TEXT NOT NULL REFERENCES sync_conflicts(id) ON DELETE RESTRICT,
  calendar_source_event_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  remote_meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE RESTRICT,
  remote_meeting_remote_id TEXT NOT NULL,
  link_payload_json TEXT NOT NULL,
  schedule_snapshot_json TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution IN ('keep_local_independent_use_remote')),
  detached_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, conflict_id)
);

CREATE INDEX idx_occurrence_detached_identity
  ON meeting_occurrence_detached_history(scope_key, calendar_source_event_id, occurrence_date);

CREATE INDEX idx_occurrence_detached_local_meeting
  ON meeting_occurrence_detached_history(scope_key, local_meeting_id, detached_at_ms);
`;

export const occurrenceDetachedHistoryV16: MeetingDatabaseMigration = {
  version: 16,
  name: 'occurrence-detached-history-v16',
  async migrate(database) {
    await database.execAsync(OCCURRENCE_DETACHED_HISTORY_V16_SQL);
  },
};
