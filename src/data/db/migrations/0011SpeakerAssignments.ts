import type { MeetingDatabaseMigration } from './types';

export const SPEAKER_ASSIGNMENTS_V11_SQL = `
CREATE TABLE speaker_clusters (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  source_cluster_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(transcript_revision_id, source_cluster_id)
);

CREATE INDEX idx_speaker_clusters_meeting
  ON speaker_clusters(meeting_id, transcript_revision_id);

CREATE TABLE speaker_corrections (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('segment', 'cluster', 'future_profile')),
  target_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  source_cluster_id TEXT,
  speaker_profile_id TEXT,
  display_name TEXT NOT NULL,
  consent_to_profile_update INTEGER NOT NULL DEFAULT 0
    CHECK(consent_to_profile_update IN (0, 1)),
  base_revision INTEGER NOT NULL,
  assignment_revision INTEGER NOT NULL,
  sync_state TEXT NOT NULL
    CHECK(sync_state IN ('local_only', 'pending', 'synced', 'failed', 'blocked')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(scope <> 'cluster' OR source_cluster_id IS NOT NULL),
  CHECK(
    scope <> 'future_profile'
    OR (speaker_profile_id IS NOT NULL AND consent_to_profile_update = 1)
  ),
  UNIQUE(meeting_id, assignment_revision)
);

CREATE INDEX idx_speaker_corrections_sync
  ON speaker_corrections(scope_key, sync_state, updated_at_ms);

CREATE TABLE speaker_assignments (
  id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES speaker_corrections(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  transcript_revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  speaker_cluster_id TEXT REFERENCES speaker_clusters(id) ON DELETE SET NULL,
  speaker_profile_id TEXT,
  display_name TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual', 'remote', 'reprocessed')),
  user_locked INTEGER NOT NULL DEFAULT 1 CHECK(user_locked IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(correction_id, segment_id)
);

CREATE INDEX idx_speaker_assignments_segment
  ON speaker_assignments(segment_id, assignment_revision DESC);

CREATE INDEX idx_speaker_assignments_meeting
  ON speaker_assignments(meeting_id, transcript_revision_id, assignment_revision);
`;

export const speakerAssignmentsV11: MeetingDatabaseMigration = {
  version: 11,
  name: 'speaker-assignments',
  async migrate(database) {
    await database.execAsync(SPEAKER_ASSIGNMENTS_V11_SQL);
  },
};
