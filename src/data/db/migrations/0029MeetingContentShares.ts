import type { MeetingDatabaseMigration } from './types';

export const MEETING_CONTENT_SHARES_V29_SQL = `
CREATE TABLE meeting_content_shares (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  content_scope_json TEXT NOT NULL,
  frozen_payload_json TEXT,
  follow_latest_summary INTEGER NOT NULL DEFAULT 0
    CHECK(follow_latest_summary IN (0,1)),
  source_summary_version_id TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'pending','active','failed_retryable','blocked','revoking','revoked'
  )),
  remote_id TEXT,
  remote_revision INTEGER CHECK(remote_revision IS NULL OR remote_revision >= 1),
  invite_url TEXT,
  operation_id TEXT,
  pending_operation TEXT CHECK(pending_operation IN ('create','revoke')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  CHECK(
    (status = 'pending' AND pending_operation = 'create'
      AND operation_id IS NOT NULL AND frozen_payload_json IS NOT NULL)
    OR
    (status = 'active' AND pending_operation IS NULL
      AND remote_id IS NOT NULL AND remote_revision IS NOT NULL AND invite_url IS NOT NULL)
    OR
    (status IN ('failed_retryable','blocked') AND pending_operation IS NOT NULL
      AND operation_id IS NOT NULL)
    OR
    (status = 'revoking' AND pending_operation = 'revoke'
      AND operation_id IS NOT NULL AND remote_id IS NOT NULL AND remote_revision IS NOT NULL)
    OR
    (status = 'revoked' AND pending_operation IS NULL
      AND remote_id IS NOT NULL AND remote_revision IS NOT NULL)
  )
);

CREATE INDEX idx_meeting_content_shares_meeting
  ON meeting_content_shares(scope_key, meeting_id, created_at_ms, id);

CREATE INDEX idx_meeting_content_shares_pending
  ON meeting_content_shares(scope_key, status, updated_at_ms, id);
`;

export const meetingContentSharesV29: MeetingDatabaseMigration = {
  version: 29,
  name: 'meeting-content-shares-v29',
  async migrate(database) {
    await database.execAsync(MEETING_CONTENT_SHARES_V29_SQL);
  },
};
