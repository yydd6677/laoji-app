import type { MeetingDatabaseMigration } from './types';

export const TRANSCRIPT_STABLE_IDENTITY_V47_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_segment_stable_identity
  ON transcript_segments(revision_id, stable_segment_key)
  WHERE stable_segment_key IS NOT NULL;
`;

export const transcriptStableIdentityV47: MeetingDatabaseMigration = {
  version: 47,
  name: 'transcript-stable-identity',
  async migrate(database) {
    await database.execAsync(TRANSCRIPT_STABLE_IDENTITY_V47_SQL);
  },
};
