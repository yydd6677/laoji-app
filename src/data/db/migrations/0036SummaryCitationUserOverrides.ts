import type { MeetingDatabaseMigration } from './types';

export const SUMMARY_CITATION_USER_OVERRIDES_V36_SQL = `
ALTER TABLE summary_citations
  ADD COLUMN user_removed_at_ms INTEGER
  CHECK(user_removed_at_ms IS NULL OR user_removed_at_ms >= 0);

CREATE INDEX idx_summary_citation_visibility_v36
  ON summary_citations(section_id, user_removed_at_ms, ordinal, id);
`;

export const summaryCitationUserOverridesV36: MeetingDatabaseMigration = {
  version: 36,
  name: 'summary-citation-user-overrides-v36',
  async migrate(database) {
    await database.execAsync(SUMMARY_CITATION_USER_OVERRIDES_V36_SQL);
  },
};
