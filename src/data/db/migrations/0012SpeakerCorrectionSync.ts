import type { MeetingDatabaseMigration } from './types';

export const SPEAKER_CORRECTION_SYNC_V12_SQL = `
ALTER TABLE transcript_revisions ADD COLUMN remote_id TEXT;

ALTER TABLE speaker_corrections ADD COLUMN remote_assignment_revision INTEGER;
ALTER TABLE speaker_corrections ADD COLUMN last_sync_error_code TEXT;
ALTER TABLE speaker_corrections ADD COLUMN synced_at_ms INTEGER;

CREATE INDEX idx_speaker_corrections_meeting_revision
  ON speaker_corrections(meeting_id, assignment_revision);

CREATE UNIQUE INDEX idx_transcript_revision_remote_identity
  ON transcript_revisions(meeting_id, remote_id)
  WHERE remote_id IS NOT NULL;
`;

export const speakerCorrectionSyncV12: MeetingDatabaseMigration = {
  version: 12,
  name: 'speaker-correction-sync',
  async migrate(database) {
    await database.execAsync(SPEAKER_CORRECTION_SYNC_V12_SQL);
  },
};
