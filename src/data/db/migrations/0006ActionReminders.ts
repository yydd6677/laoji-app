import type { MeetingDatabaseMigration } from './types';

export const ACTION_REMINDERS_V6_SQL = `
ALTER TABLE action_items ADD COLUMN reminder_at_ms INTEGER;

CREATE INDEX idx_actions_reminder
  ON action_items(reminder_at_ms)
  WHERE reminder_at_ms IS NOT NULL;
`;

export const actionRemindersV6: MeetingDatabaseMigration = {
  version: 6,
  name: 'meeting-action-reminders',
  async migrate(database) {
    await database.execAsync(ACTION_REMINDERS_V6_SQL);
  },
};
