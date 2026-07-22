import type { MeetingDatabaseMigration } from './types';

export const MEETING_CONTEXT_V3_SQL = `
ALTER TABLE meeting_notes ADD COLUMN description TEXT;
ALTER TABLE meeting_notes ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE meeting_notes ADD COLUMN location TEXT;
ALTER TABLE meeting_notes ADD COLUMN mode TEXT;
ALTER TABLE meeting_notes ADD COLUMN client_request_id TEXT;
ALTER TABLE meeting_notes ADD COLUMN recorded_at_ms INTEGER;

CREATE UNIQUE INDEX idx_meeting_canonical_client_request_unique
  ON meeting_notes(scope_key, client_request_id)
  WHERE client_request_id IS NOT NULL
    AND COALESCE(entry_point, '') != 'legacy_store';

CREATE INDEX idx_meeting_recorded_at
  ON meeting_notes(scope_key, recorded_at_ms DESC, id DESC);
`;

export const meetingContextV3: MeetingDatabaseMigration = {
  version: 3,
  name: 'meeting-context-v3',
  async migrate(database) {
    await database.execAsync(MEETING_CONTEXT_V3_SQL);
  },
};
