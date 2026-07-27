import type { MeetingDatabaseMigration } from './types';

export const MEETING_LIST_ORDER_V33_SQL = `
CREATE TABLE meeting_list_order (
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(scope_key, meeting_id),
  FOREIGN KEY(meeting_id) REFERENCES meeting_notes(id) ON DELETE CASCADE
);

CREATE INDEX idx_meeting_list_order_position_v33
  ON meeting_list_order(scope_key, position, meeting_id);
`;

export const meetingListOrderV33: MeetingDatabaseMigration = {
  version: 33,
  name: 'meeting-list-order-v33',
  async migrate(database) {
    await database.execAsync(MEETING_LIST_ORDER_V33_SQL);
  },
};
