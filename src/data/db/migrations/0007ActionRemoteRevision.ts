import type { MeetingDatabaseMigration } from './types';

export const ACTION_REMOTE_REVISION_V7_SQL = `
ALTER TABLE action_items ADD COLUMN remote_revision INTEGER;

CREATE INDEX idx_actions_remote_revision
  ON action_items(meeting_id, remote_revision)
  WHERE remote_revision IS NOT NULL;
`;

export const actionRemoteRevisionV7: MeetingDatabaseMigration = {
  version: 7,
  name: 'meeting-action-remote-revision',
  async migrate(database) {
    await database.execAsync(ACTION_REMOTE_REVISION_V7_SQL);
  },
};
