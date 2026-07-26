import type { MeetingDatabaseMigration } from './types';

export const TRANSCRIPT_RECORDING_PROVENANCE_V25_SQL = `
ALTER TABLE transcript_segments ADD COLUMN source_recording_asset_id TEXT
  REFERENCES recording_assets(id) ON DELETE SET NULL;
ALTER TABLE transcript_segments ADD COLUMN source_recording_asset_remote_id TEXT;
ALTER TABLE transcript_segments ADD COLUMN source_transcription_job_id TEXT;

CREATE INDEX idx_transcript_segment_recording_asset
  ON transcript_segments(meeting_id, source_recording_asset_id, revision_id, ordinal);

CREATE INDEX idx_transcript_segment_remote_recording_asset
  ON transcript_segments(meeting_id, source_recording_asset_remote_id, revision_id, ordinal)
  WHERE source_recording_asset_remote_id IS NOT NULL;

UPDATE transcript_segments
SET source_recording_asset_id = (
      SELECT asset.id
      FROM recording_assets asset
      WHERE asset.meeting_id = transcript_segments.meeting_id
      LIMIT 1
    ),
    source_recording_asset_remote_id = (
      SELECT asset.remote_asset_id
      FROM recording_assets asset
      WHERE asset.meeting_id = transcript_segments.meeting_id
      LIMIT 1
    )
WHERE source_recording_asset_id IS NULL
  AND (
    SELECT COUNT(*)
    FROM recording_assets asset
    WHERE asset.meeting_id = transcript_segments.meeting_id
  ) = 1;
`;

export const transcriptRecordingProvenanceV25: MeetingDatabaseMigration = {
  version: 25,
  name: 'transcript-recording-provenance-v25',
  async migrate(database) {
    await database.execAsync(TRANSCRIPT_RECORDING_PROVENANCE_V25_SQL);
  },
};
