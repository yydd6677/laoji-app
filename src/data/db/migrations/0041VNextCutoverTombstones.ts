import type { MeetingDatabaseMigration } from './types';

export const VNEXT_CUTOVER_TOMBSTONES_V41_SQL = `
CREATE TABLE IF NOT EXISTS vnext_cutover_tombstones (
  capability TEXT PRIMARY KEY,
  barrier_state TEXT NOT NULL CHECK(barrier_state IN ('open','draining','closed')),
  last_legacy_submit_at_ms INTEGER,
  legacy_submit_count INTEGER NOT NULL DEFAULT 0 CHECK(legacy_submit_count >= 0),
  last_legacy_read_at_ms INTEGER,
  legacy_reader_removed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vnext_cutover_draining
  ON vnext_cutover_tombstones(barrier_state, updated_at_ms, capability);
`;

export const vnextCutoverTombstones: MeetingDatabaseMigration = {
  version: 41,
  name: 'vnext-cutover-tombstones',
  async migrate(database) {
    await database.execAsync(VNEXT_CUTOVER_TOMBSTONES_V41_SQL);
  },
};
