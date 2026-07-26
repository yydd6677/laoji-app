import type { MeetingDatabaseMigration } from './types';

export const MEETING_TAG_CATALOG_SYNC_V28_SQL = `
CREATE TABLE meeting_tag_catalog_sync_state (
  scope_key TEXT PRIMARY KEY,
  remote_revision INTEGER NOT NULL DEFAULT 0 CHECK(remote_revision >= 0),
  remote_snapshot_json TEXT NOT NULL,
  acknowledged_local_snapshot_json TEXT NOT NULL,
  pulled_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_meeting_tag_catalog_outbox
  ON sync_outbox(scope_key, aggregate_type, status, next_attempt_at_ms, updated_at_ms)
  WHERE aggregate_type = 'meeting_tag_catalog';
`;

export const meetingTagCatalogSyncV28: MeetingDatabaseMigration = {
  version: 28,
  name: 'meeting-tag-catalog-sync',
  async migrate(database) {
    await database.execAsync(MEETING_TAG_CATALOG_SYNC_V28_SQL);
  },
};
