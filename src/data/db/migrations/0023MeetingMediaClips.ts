import type { MeetingDatabaseMigration } from './types';

export const MEETING_MEDIA_CLIPS_V23_SQL = `
CREATE TABLE meeting_media_clips (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  source_recording_asset_id TEXT REFERENCES recording_assets(id) ON DELETE SET NULL,
  source_recording_checksum_sha256 TEXT,
  source_recording_updated_at_ms INTEGER NOT NULL CHECK(source_recording_updated_at_ms >= 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('marker','transcript')),
  source_marker_id TEXT REFERENCES markers(id) ON DELETE SET NULL,
  source_segment_id TEXT,
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  include_speaker INTEGER NOT NULL CHECK(include_speaker IN (0,1)),
  include_text INTEGER NOT NULL CHECK(include_text IN (0,1)),
  speaker_text TEXT,
  transcript_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed','deleting')),
  local_uri TEXT,
  mime_type TEXT,
  file_name TEXT,
  byte_size INTEGER,
  checksum_sha256 TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  CHECK(include_speaker = 0 OR speaker_text IS NOT NULL),
  CHECK(include_text = 0 OR transcript_text IS NOT NULL),
  CHECK(
    (status = 'ready' AND local_uri IS NOT NULL AND mime_type = 'audio/wav'
      AND file_name IS NOT NULL AND byte_size IS NOT NULL AND byte_size > 44
      AND checksum_sha256 GLOB 'sha256:[0-9a-f]*' AND length(checksum_sha256) = 71
      AND error_code IS NULL)
    OR
    (status != 'ready' AND local_uri IS NULL AND mime_type IS NULL
      AND file_name IS NULL AND byte_size IS NULL AND checksum_sha256 IS NULL)
  )
);

CREATE INDEX idx_meeting_media_clips_timeline
  ON meeting_media_clips(scope_key, meeting_id, start_ms, created_at_ms, id);

CREATE INDEX idx_meeting_media_clips_recording
  ON meeting_media_clips(scope_key, source_recording_asset_id, status, id);
`;

export const meetingMediaClipsV23: MeetingDatabaseMigration = {
  version: 23,
  name: 'meeting-media-clips-v23',
  async migrate(database) {
    await database.execAsync(MEETING_MEDIA_CLIPS_V23_SQL);
  },
};
