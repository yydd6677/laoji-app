import type { MeetingDatabaseMigration } from './types';

export const MEETING_MARKER_SYNC_V34_SQL = `
CREATE TABLE meeting_marker_sync_state (
  scope_key TEXT NOT NULL,
  marker_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  remote_id TEXT,
  remote_revision INTEGER CHECK(remote_revision IS NULL OR remote_revision >= 1),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','deleted')),
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'important' CHECK(kind = 'important'),
  client_created_at_ms INTEGER NOT NULL CHECK(client_created_at_ms >= 0),
  client_updated_at_ms INTEGER NOT NULL CHECK(client_updated_at_ms >= client_created_at_ms),
  sync_state TEXT NOT NULL DEFAULT 'local'
    CHECK(sync_state IN ('local','pending','synced','failed_retryable','blocked')),
  pending_operation TEXT CHECK(pending_operation IN ('create','delete')),
  last_error_code TEXT,
  remote_updated_at_ms INTEGER CHECK(remote_updated_at_ms IS NULL OR remote_updated_at_ms >= 0),
  deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= client_created_at_ms),
  PRIMARY KEY(scope_key, marker_id),
  UNIQUE(scope_key, remote_id),
  FOREIGN KEY(meeting_id, scope_key)
    REFERENCES meeting_notes(id, scope_key) ON DELETE CASCADE
);

CREATE INDEX idx_meeting_marker_sync_meeting_v34
  ON meeting_marker_sync_state(scope_key, meeting_id, lifecycle, position_ms, marker_id);

CREATE INDEX idx_meeting_marker_sync_pending_v34
  ON meeting_marker_sync_state(scope_key, pending_operation, sync_state, client_updated_at_ms, marker_id);

CREATE INDEX idx_meeting_marker_outbox_v34
  ON sync_outbox(scope_key, aggregate_type, aggregate_id, status, created_at_ms)
  WHERE aggregate_type = 'meeting_marker';

INSERT INTO meeting_marker_sync_state (
  scope_key, marker_id, meeting_id, remote_id, remote_revision,
  lifecycle, position_ms, label, kind,
  client_created_at_ms, client_updated_at_ms,
  sync_state, pending_operation, last_error_code,
  remote_updated_at_ms, deleted_at_ms
)
SELECT
  meeting.scope_key, marker.id, marker.meeting_id, NULL, NULL,
  'active', marker.position_ms, marker.label, marker.kind,
  marker.created_at_ms, marker.updated_at_ms,
  CASE WHEN meeting.scope_key = 'guest' THEN 'local' ELSE 'pending' END,
  CASE WHEN meeting.scope_key = 'guest' THEN NULL ELSE 'create' END,
  NULL, NULL, NULL
FROM markers marker
INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id;
`;

export const meetingMarkerSyncV34: MeetingDatabaseMigration = {
  version: 34,
  name: 'meeting-marker-sync-v34',
  async migrate(database) {
    await database.execAsync(MEETING_MARKER_SYNC_V34_SQL);
  },
};
