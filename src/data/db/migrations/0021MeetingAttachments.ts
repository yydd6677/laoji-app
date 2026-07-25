import type { MeetingDatabaseMigration } from './types';

export const MEETING_ATTACHMENTS_V21_SQL = `
CREATE TABLE meeting_attachments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  marker_id TEXT REFERENCES markers(id) ON DELETE SET NULL,
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('text','image')),
  text_content TEXT,
  local_uri TEXT,
  mime_type TEXT,
  file_name TEXT,
  byte_size INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE,
  CHECK(
    (kind = 'text' AND text_content IS NOT NULL AND local_uri IS NULL
      AND mime_type IS NULL AND file_name IS NULL AND byte_size IS NULL)
    OR
    (kind = 'image' AND text_content IS NULL AND local_uri IS NOT NULL
      AND mime_type IS NOT NULL AND file_name IS NOT NULL AND byte_size IS NOT NULL)
  )
);

CREATE INDEX idx_meeting_attachments_timeline
  ON meeting_attachments(scope_key, meeting_id, position_ms, created_at_ms, id);

CREATE INDEX idx_meeting_attachments_marker
  ON meeting_attachments(scope_key, marker_id, created_at_ms, id);
`;

export const meetingAttachmentsV21: MeetingDatabaseMigration = {
  version: 21,
  name: 'meeting-attachments-v21',
  async migrate(database) {
    await database.execAsync(MEETING_ATTACHMENTS_V21_SQL);
  },
};
