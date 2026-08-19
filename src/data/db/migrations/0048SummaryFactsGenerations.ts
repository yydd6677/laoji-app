import type { MeetingDatabaseMigration } from './types';

/**
 * A source fingerprint identifies immutable input, not a single user intent.
 * A forced re-generation creates a new generation/document even when the
 * source, model and prompt revisions are unchanged.  Preserve idempotency on
 * the document primary key while allowing those immutable generations to
 * coexist and remain addressable from summary version history.
 */
export const SUMMARY_FACTS_GENERATIONS_V48_SQL = `
CREATE TABLE summary_fact_documents_v48 (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  summary_version_id TEXT REFERENCES summary_versions(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL,
  transcript_revision TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  prompt_revision TEXT NOT NULL,
  document_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

INSERT INTO summary_fact_documents_v48 (
  id, meeting_id, summary_version_id, source_fingerprint,
  transcript_revision, model_revision, prompt_revision,
  document_json, coverage_json, generated_at_ms, created_at_ms
)
SELECT
  id, meeting_id, summary_version_id, source_fingerprint,
  transcript_revision, model_revision, prompt_revision,
  document_json, coverage_json, generated_at_ms, created_at_ms
FROM summary_fact_documents;

DROP TABLE summary_fact_documents;
ALTER TABLE summary_fact_documents_v48 RENAME TO summary_fact_documents;

CREATE UNIQUE INDEX idx_summary_fact_document_version
  ON summary_fact_documents(summary_version_id)
  WHERE summary_version_id IS NOT NULL;

CREATE INDEX idx_summary_fact_document_meeting
  ON summary_fact_documents(meeting_id, generated_at_ms DESC, id);

CREATE INDEX idx_summary_fact_document_source_generation
  ON summary_fact_documents(
    meeting_id, source_fingerprint, model_revision, prompt_revision,
    generated_at_ms DESC, id
  );
`;

export const summaryFactsGenerationsV48: MeetingDatabaseMigration = {
  version: 48,
  name: 'summary-facts-generations',
  async migrate(database) {
    await database.execAsync(SUMMARY_FACTS_GENERATIONS_V48_SQL);
  },
};
