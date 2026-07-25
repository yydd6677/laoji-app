import type { MeetingDatabaseMigration } from './types';

export const MEETING_ACTION_COLLABORATION_V24_SQL = `
CREATE TABLE meeting_action_shares (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  action_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK(permission IN ('viewer','action_editor')),
  status TEXT NOT NULL CHECK(status IN (
    'pending','active','failed_retryable','blocked','revoking','revoked'
  )),
  remote_id TEXT,
  remote_revision INTEGER CHECK(remote_revision IS NULL OR remote_revision >= 1),
  invite_url TEXT,
  expected_action_remote_revision INTEGER
    CHECK(expected_action_remote_revision IS NULL OR expected_action_remote_revision >= 1),
  operation_id TEXT NOT NULL,
  pending_operation TEXT CHECK(pending_operation IN ('create','revoke')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  CHECK(
    (status = 'pending' AND pending_operation = 'create')
    OR
    (status = 'active' AND pending_operation IS NULL
      AND remote_id IS NOT NULL AND remote_revision IS NOT NULL AND invite_url IS NOT NULL)
    OR
    (status IN ('failed_retryable','blocked') AND pending_operation IS NOT NULL)
    OR
    (status = 'revoking' AND pending_operation = 'revoke'
      AND remote_id IS NOT NULL AND remote_revision IS NOT NULL)
    OR
    (status = 'revoked' AND pending_operation IS NULL
      AND remote_id IS NOT NULL AND remote_revision IS NOT NULL)
  )
);

CREATE INDEX idx_meeting_action_shares_action
  ON meeting_action_shares(scope_key, meeting_id, action_id, created_at_ms, id);

CREATE INDEX idx_meeting_action_shares_pending
  ON meeting_action_shares(scope_key, status, updated_at_ms, id);
`;

export const meetingActionCollaborationV24: MeetingDatabaseMigration = {
  version: 24,
  name: 'meeting-action-collaboration-v24',
  async migrate(database) {
    await database.execAsync(MEETING_ACTION_COLLABORATION_V24_SQL);
  },
};
