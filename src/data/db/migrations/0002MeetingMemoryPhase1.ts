import type { MeetingDatabaseMigration } from './types';

export const MEETING_MEMORY_PHASE_1_SQL = `
ALTER TABLE meeting_notes ADD COLUMN legacy_source_id TEXT;
ALTER TABLE recording_assets ADD COLUMN native_session_id TEXT;
ALTER TABLE recording_assets ADD COLUMN last_verified_at_ms INTEGER;

CREATE UNIQUE INDEX idx_meeting_legacy_source_unique
  ON meeting_notes(scope_key, legacy_source_id)
  WHERE legacy_source_id IS NOT NULL;

CREATE UNIQUE INDEX idx_recording_primary_unique
  ON recording_assets(meeting_id)
  WHERE role = 'primary';

CREATE UNIQUE INDEX idx_recording_native_session_unique
  ON recording_assets(native_session_id)
  WHERE native_session_id IS NOT NULL;

CREATE UNIQUE INDEX idx_transcript_active_unique
  ON transcript_revisions(meeting_id)
  WHERE is_active = 1;
`;

export const meetingMemoryPhase1: MeetingDatabaseMigration = {
  version: 2,
  name: 'meeting-memory-phase-1-invariants',
  async migrate(database) {
    await database.execAsync(MEETING_MEMORY_PHASE_1_SQL);
  },
};
