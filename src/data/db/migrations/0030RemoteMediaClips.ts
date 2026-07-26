import type { MeetingDatabaseMigration } from './types';

export const REMOTE_MEDIA_CLIPS_V30_SQL = `
ALTER TABLE meeting_media_clips
  ADD COLUMN export_mode TEXT NOT NULL DEFAULT 'local_wav'
  CHECK(export_mode IN ('local_wav','remote_async'));

ALTER TABLE meeting_media_clips
  ADD COLUMN source_recording_remote_asset_id TEXT;

ALTER TABLE meeting_media_clips
  ADD COLUMN remote_job_id TEXT;

ALTER TABLE meeting_media_clips
  ADD COLUMN remote_job_attempt INTEGER NOT NULL DEFAULT 0
  CHECK(remote_job_attempt >= 0);

ALTER TABLE meeting_media_clips
  ADD COLUMN remote_job_updated_at_ms INTEGER
  CHECK(remote_job_updated_at_ms IS NULL OR remote_job_updated_at_ms >= 0);

CREATE UNIQUE INDEX idx_meeting_media_clips_remote_job
  ON meeting_media_clips(scope_key, remote_job_id)
  WHERE remote_job_id IS NOT NULL;
`;

export const remoteMediaClipsV30: MeetingDatabaseMigration = {
  version: 30,
  name: 'remote-media-clips-v30',
  async migrate(database) {
    await database.execAsync(REMOTE_MEDIA_CLIPS_V30_SQL);
  },
};
