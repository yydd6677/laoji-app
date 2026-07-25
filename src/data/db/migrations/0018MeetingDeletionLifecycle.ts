import type { MeetingDatabaseMigration } from './types';

export const MEETING_DELETION_LIFECYCLE_V18_SQL = `
ALTER TABLE meeting_notes ADD COLUMN deleted_from_lifecycle TEXT
  CHECK(deleted_from_lifecycle IS NULL OR deleted_from_lifecycle IN ('draft','active','ended'));

CREATE INDEX idx_meeting_deleted_retention
  ON meeting_notes(scope_key, deleted_at_ms DESC, id DESC)
  WHERE lifecycle = 'deleted';
`;

export const meetingDeletionLifecycleV18: MeetingDatabaseMigration = {
  version: 18,
  name: 'meeting-deletion-lifecycle-v18',
  async migrate(database) {
    await database.execAsync(MEETING_DELETION_LIFECYCLE_V18_SQL);
  },
};
