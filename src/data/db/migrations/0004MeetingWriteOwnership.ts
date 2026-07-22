import type { MeetingDatabaseMigration } from './types';

export const MEETING_WRITE_OWNERSHIP_V4_SQL = `
CREATE TABLE meeting_scope_write_state (
  scope_key TEXT PRIMARY KEY,
  write_owner TEXT NOT NULL CHECK(write_owner IN ('legacy','canonical')),
  canonical_revision INTEGER NOT NULL DEFAULT 0 CHECK(canonical_revision >= 0),
  legacy_mirror_revision INTEGER NOT NULL DEFAULT 0 CHECK(legacy_mirror_revision >= 0),
  legacy_mirror_status TEXT NOT NULL DEFAULT 'clean'
    CHECK(legacy_mirror_status IN ('clean','pending','failed')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL,
  CHECK(legacy_mirror_revision <= canonical_revision),
  CHECK(
    (write_owner = 'canonical' AND canonical_revision >= 1)
    OR (
      write_owner = 'legacy'
      AND canonical_revision = 0
      AND legacy_mirror_revision = 0
      AND legacy_mirror_status = 'clean'
    )
  )
);
`;

export const meetingWriteOwnershipV4: MeetingDatabaseMigration = {
  version: 4,
  name: 'meeting-write-ownership',
  async migrate(database) {
    await database.execAsync(MEETING_WRITE_OWNERSHIP_V4_SQL);
  },
};
