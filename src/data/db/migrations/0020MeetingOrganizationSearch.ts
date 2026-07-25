import type { MeetingDatabaseMigration } from './types';

export const MEETING_ORGANIZATION_SEARCH_V20_SQL = `
CREATE UNIQUE INDEX idx_meeting_note_id_scope_v20
  ON meeting_notes(id, scope_key);

CREATE TABLE meeting_tags (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, normalized_name),
  UNIQUE(id, scope_key)
);

CREATE TABLE meeting_tag_links (
  meeting_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(meeting_id, tag_id),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  FOREIGN KEY(tag_id, scope_key)
    REFERENCES meeting_tags(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_meeting_tag_links_scope_tag
  ON meeting_tag_links(scope_key, tag_id, meeting_id);

CREATE INDEX idx_meeting_tag_links_scope_meeting
  ON meeting_tag_links(scope_key, meeting_id, tag_id);

CREATE VIRTUAL TABLE meeting_search_fts USING fts5(
  scope_key UNINDEXED,
  meeting_id UNINDEXED,
  source_kind UNINDEXED,
  source_id UNINDEXED,
  start_ms UNINDEXED,
  title,
  content,
  tokenize = 'trigram case_sensitive 0'
);
`;

export const meetingOrganizationSearchV20: MeetingDatabaseMigration = {
  version: 20,
  name: 'meeting-organization-search-v20',
  async migrate(database) {
    await database.execAsync(MEETING_ORGANIZATION_SEARCH_V20_SQL);
  },
};
