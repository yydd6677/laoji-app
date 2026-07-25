import type { MeetingDatabaseMigration } from './types';

export const MEETING_ROOT_PULL_CURSOR_V17_SQL = `
CREATE TABLE meeting_root_pull_state (
  scope_key TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_meeting_root_pull_updated
  ON meeting_root_pull_state(updated_at_ms, scope_key);
`;

export const meetingRootPullCursorV17: MeetingDatabaseMigration = {
  version: 17,
  name: 'meeting-root-pull-cursor',
  async migrate(database) {
    await database.execAsync(MEETING_ROOT_PULL_CURSOR_V17_SQL);
  },
};
