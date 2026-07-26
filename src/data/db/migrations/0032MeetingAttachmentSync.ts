import type { MeetingDatabaseMigration } from './types';

export const MEETING_ATTACHMENT_SYNC_V32_SQL = `
ALTER TABLE meeting_attachments ADD COLUMN checksum_sha256 TEXT;
ALTER TABLE meeting_attachments ADD COLUMN remote_id TEXT;
ALTER TABLE meeting_attachments ADD COLUMN remote_revision INTEGER
  CHECK(remote_revision IS NULL OR remote_revision >= 1);
ALTER TABLE meeting_attachments ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'local'
  CHECK(sync_state IN ('local','pending','synced','failed_retryable','blocked'));
ALTER TABLE meeting_attachments ADD COLUMN pending_operation TEXT
  CHECK(pending_operation IN ('create','delete'));
ALTER TABLE meeting_attachments ADD COLUMN last_error_code TEXT;
ALTER TABLE meeting_attachments ADD COLUMN remote_updated_at_ms INTEGER
  CHECK(remote_updated_at_ms IS NULL OR remote_updated_at_ms >= 0);

CREATE UNIQUE INDEX idx_meeting_attachment_remote_v32
  ON meeting_attachments(scope_key, remote_id)
  WHERE remote_id IS NOT NULL;

CREATE INDEX idx_meeting_attachment_sync_v32
  ON meeting_attachments(scope_key, pending_operation, sync_state, updated_at_ms, id);

CREATE INDEX idx_meeting_attachment_outbox_v32
  ON sync_outbox(scope_key, aggregate_type, aggregate_id, status, created_at_ms)
  WHERE aggregate_type = 'meeting_attachment';
`;

export const meetingAttachmentSyncV32: MeetingDatabaseMigration = {
  version: 32,
  name: 'meeting-attachment-sync-v32',
  async migrate(database) {
    await database.execAsync(MEETING_ATTACHMENT_SYNC_V32_SQL);
  },
};
