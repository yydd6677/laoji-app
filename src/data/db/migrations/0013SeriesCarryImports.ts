import type { MeetingDatabaseMigration } from './types';

export const SERIES_CARRY_IMPORTS_V13_SQL = `
CREATE TABLE meeting_series_carry_imports (
  target_meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  source_meeting_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('decision','action')),
  source_item_id TEXT NOT NULL,
  source_occurrence_date TEXT NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  content_snapshot TEXT NOT NULL,
  assignee_snapshot TEXT,
  due_at_ms INTEGER,
  source_segment_id TEXT,
  source_start_ms INTEGER,
  imported_at_ms INTEGER NOT NULL,
  PRIMARY KEY(target_meeting_id, source_kind, source_item_id)
);

CREATE INDEX idx_series_carry_import_source
  ON meeting_series_carry_imports(source_meeting_id, source_kind, source_item_id);
`;

export const seriesCarryImportsV13: MeetingDatabaseMigration = {
  version: 13,
  name: 'series-carry-imports',
  async migrate(database) {
    await database.execAsync(SERIES_CARRY_IMPORTS_V13_SQL);
  },
};
