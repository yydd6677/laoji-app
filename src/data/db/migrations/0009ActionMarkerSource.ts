import type { MeetingDatabaseMigration } from './types';

export const ACTION_MARKER_SOURCE_V9_SQL = `
ALTER TABLE action_items
  ADD COLUMN source_marker_id TEXT REFERENCES markers(id) ON DELETE SET NULL;

CREATE INDEX idx_actions_marker_source
  ON action_items(meeting_id, source_marker_id)
  WHERE source_marker_id IS NOT NULL;
`;

export const actionMarkerSourceV9: MeetingDatabaseMigration = {
  version: 9,
  name: 'meeting-action-marker-source',
  async migrate(database) {
    await database.execAsync(ACTION_MARKER_SOURCE_V9_SQL);
  },
};
