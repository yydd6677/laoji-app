import type { MeetingDatabaseMigration } from './types';

export const SUMMARY_VERSION_SYNC_V37_SQL = `
CREATE TABLE meeting_summary_remote_versions (
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  local_version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  remote_version_id TEXT NOT NULL,
  remote_status TEXT NOT NULL CHECK(remote_status IN ('ready','stale')),
  generated_document_sha256 TEXT NOT NULL,
  remote_created_at_ms INTEGER NOT NULL CHECK(remote_created_at_ms >= 0),
  remote_completed_at_ms INTEGER NOT NULL CHECK(remote_completed_at_ms >= 0),
  remote_updated_at_ms INTEGER NOT NULL CHECK(remote_updated_at_ms >= 0),
  PRIMARY KEY(scope_key, remote_version_id),
  UNIQUE(scope_key, local_version_id),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_summary_remote_versions_meeting_v37
  ON meeting_summary_remote_versions(
    scope_key, meeting_id, remote_created_at_ms DESC, remote_version_id
  );

CREATE TABLE meeting_summary_remote_sections (
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  local_version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  local_section_id TEXT NOT NULL REFERENCES summary_sections(id) ON DELETE CASCADE,
  remote_version_id TEXT NOT NULL,
  remote_section_id TEXT NOT NULL,
  remote_revision INTEGER NOT NULL CHECK(remote_revision >= 1),
  remote_user_text TEXT,
  remote_generated_citation_ids_json TEXT NOT NULL DEFAULT '[]',
  remote_visible_citation_ids_json TEXT NOT NULL DEFAULT '[]',
  remote_client_updated_at_ms INTEGER NOT NULL CHECK(remote_client_updated_at_ms >= 0),
  remote_updated_at_ms INTEGER NOT NULL CHECK(remote_updated_at_ms >= 0),
  PRIMARY KEY(scope_key, remote_version_id, remote_section_id),
  UNIQUE(scope_key, local_section_id),
  FOREIGN KEY(scope_key, remote_version_id)
    REFERENCES meeting_summary_remote_versions(scope_key, remote_version_id) ON DELETE CASCADE,
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_summary_remote_sections_local_v37
  ON meeting_summary_remote_sections(scope_key, local_version_id, local_section_id);

CREATE TABLE meeting_summary_remote_citations (
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  local_section_id TEXT NOT NULL REFERENCES summary_sections(id) ON DELETE CASCADE,
  local_citation_id TEXT NOT NULL REFERENCES summary_citations(id) ON DELETE CASCADE,
  remote_version_id TEXT NOT NULL,
  remote_section_id TEXT NOT NULL,
  remote_citation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(scope_key, remote_version_id, remote_section_id, remote_citation_id),
  UNIQUE(scope_key, local_citation_id),
  FOREIGN KEY(scope_key, remote_version_id, remote_section_id)
    REFERENCES meeting_summary_remote_sections(
      scope_key, remote_version_id, remote_section_id
    ) ON DELETE CASCADE,
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_summary_remote_citations_local_v37
  ON meeting_summary_remote_citations(scope_key, local_section_id, ordinal, local_citation_id);

CREATE TABLE meeting_summary_current_sync (
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  local_version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  remote_version_id TEXT NOT NULL,
  remote_revision INTEGER NOT NULL CHECK(remote_revision >= 1),
  remote_client_updated_at_ms INTEGER NOT NULL CHECK(remote_client_updated_at_ms >= 0),
  remote_updated_at_ms INTEGER NOT NULL CHECK(remote_updated_at_ms >= 0),
  PRIMARY KEY(scope_key, meeting_id),
  FOREIGN KEY(scope_key, remote_version_id)
    REFERENCES meeting_summary_remote_versions(scope_key, remote_version_id) ON DELETE CASCADE,
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_summary_section_outbox_v37
  ON sync_outbox(scope_key, aggregate_type, aggregate_id, status, created_at_ms)
  WHERE aggregate_type = 'summary_section';

CREATE INDEX idx_summary_current_outbox_v37
  ON sync_outbox(scope_key, aggregate_type, aggregate_id, status, created_at_ms)
  WHERE aggregate_type = 'summary_current';
`;

export const summaryVersionSyncV37: MeetingDatabaseMigration = {
  version: 37,
  name: 'summary-version-sync-v37',
  async migrate(database) {
    await database.execAsync(SUMMARY_VERSION_SYNC_V37_SQL);
  },
};
