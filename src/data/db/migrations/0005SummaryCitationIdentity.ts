import type { MeetingDatabaseMigration } from './types';

export const SUMMARY_CITATION_IDENTITY_V5_SQL = `
ALTER TABLE transcript_segments ADD COLUMN source_segment_id TEXT;

CREATE UNIQUE INDEX idx_transcript_revision_source_segment
  ON transcript_segments(revision_id, source_segment_id)
  WHERE source_segment_id IS NOT NULL;
`;

export const summaryCitationIdentityV5: MeetingDatabaseMigration = {
  version: 5,
  name: 'summary-citation-segment-identity',
  async migrate(database) {
    await database.execAsync(SUMMARY_CITATION_IDENTITY_V5_SQL);
  },
};
