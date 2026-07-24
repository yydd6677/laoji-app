import type { MeetingDatabaseMigration } from './types';

export const OCCURRENCE_LINK_SYNC_V15_SQL = `
ALTER TABLE meeting_occurrence_links ADD COLUMN remote_id TEXT;
ALTER TABLE meeting_occurrence_links ADD COLUMN remote_revision INTEGER;
ALTER TABLE meeting_occurrence_links ADD COLUMN client_updated_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_occurrence_links ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'local_only';
ALTER TABLE meeting_occurrence_links ADD COLUMN last_sync_error_code TEXT;
ALTER TABLE meeting_occurrence_links ADD COLUMN synced_at_ms INTEGER;

CREATE UNIQUE INDEX idx_occurrence_remote_identity_unique
  ON meeting_occurrence_links(scope_key, remote_id)
  WHERE remote_id IS NOT NULL;

CREATE INDEX idx_occurrence_sync_state
  ON meeting_occurrence_links(scope_key, sync_state, client_updated_at_ms);
`;

export const occurrenceLinkSyncV15: MeetingDatabaseMigration = {
  version: 15,
  name: 'occurrence-link-sync-v15',
  async migrate(database) {
    await database.execAsync(OCCURRENCE_LINK_SYNC_V15_SQL);
  },
};
