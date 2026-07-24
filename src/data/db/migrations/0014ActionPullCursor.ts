import type { MeetingDatabaseMigration } from './types';

export const ACTION_PULL_CURSOR_V14_SQL = `
CREATE TABLE meeting_action_pull_state (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  remote_meeting_id TEXT NOT NULL,
  cursor TEXT,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, remote_meeting_id)
);

CREATE INDEX idx_action_pull_scope
  ON meeting_action_pull_state(scope_key, updated_at_ms, meeting_id);
`;

export const actionPullCursorV14: MeetingDatabaseMigration = {
  version: 14,
  name: 'meeting-action-pull-cursor',
  async migrate(database) {
    await database.execAsync(ACTION_PULL_CURSOR_V14_SQL);
  },
};
