import type { MeetingDatabaseMigration } from './types';

export const MEETING_RETENTION_CLEANUP_V27_SQL = `
CREATE TABLE meeting_retention_cleanup_jobs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  canonical_meeting_id TEXT NOT NULL,
  navigation_meeting_id TEXT NOT NULL,
  local_uris_json TEXT NOT NULL DEFAULT '[]',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, canonical_meeting_id)
);

CREATE INDEX idx_meeting_retention_cleanup_scope
  ON meeting_retention_cleanup_jobs(scope_key, updated_at_ms, id);
`;

export const meetingRetentionCleanupV27: MeetingDatabaseMigration = {
  version: 27,
  name: 'meeting-retention-cleanup-v27',
  async migrate(database) {
    await database.execAsync(MEETING_RETENTION_CLEANUP_V27_SQL);
  },
};
