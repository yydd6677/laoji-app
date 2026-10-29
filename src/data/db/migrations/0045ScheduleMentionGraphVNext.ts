import type { MeetingDatabaseMigration } from './types';

/**
 * Schedule graph provenance. The event JSON remains the domain payload;
 * these columns make the source/revision fence queryable without parsing JSON
 * and allow a future MentionGraph producer to replace a draft atomically.
 */
export const SCHEDULE_MENTION_GRAPH_VNEXT_V45_SQL = `
CREATE TABLE IF NOT EXISTS meeting_search_documents_v45 (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL DEFAULT -1,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  UNIQUE(scope_key, meeting_id, source_kind, source_id, start_ms)
);

CREATE INDEX IF NOT EXISTS idx_meeting_search_documents_scope_v45
  ON meeting_search_documents_v45(scope_key, meeting_id, source_kind, source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS meeting_search_fts_v45 USING fts5(
  title,
  content,
  content='meeting_search_documents_v45',
  content_rowid='document_id',
  tokenize = 'trigram case_sensitive 0'
);

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_v45_ai
AFTER INSERT ON meeting_search_documents_v45 BEGIN
  INSERT INTO meeting_search_fts_v45(rowid, title, content)
  VALUES (new.document_id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_v45_ad
AFTER DELETE ON meeting_search_documents_v45 BEGIN
  INSERT INTO meeting_search_fts_v45(meeting_search_fts_v45, rowid, title, content)
  VALUES ('delete', old.document_id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS meeting_search_documents_v45_au
AFTER UPDATE OF title, content ON meeting_search_documents_v45 BEGIN
  INSERT INTO meeting_search_fts_v45(meeting_search_fts_v45, rowid, title, content)
  VALUES ('delete', old.document_id, old.title, old.content);
  INSERT INTO meeting_search_fts_v45(rowid, title, content)
  VALUES (new.document_id, new.title, new.content);
END;

CREATE INDEX IF NOT EXISTS idx_local_schedule_event_revision
  ON local_schedule_events(id, event_revision);

CREATE INDEX IF NOT EXISTS idx_local_schedule_source_hash
  ON local_schedule_events(draft_source_sha256, producer_revision)
  WHERE draft_source_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_local_schedule_deleted
  ON local_schedule_events(deleted_at_ms, start_date, id)
  WHERE deleted_at_ms IS NOT NULL;
`;

/**
 * Projection revisions share this migration but remain a separate SQL
 * constant so their restart/fencing contract can be replayed independently.
 */
export const NATIVE_PROJECTION_CHECKPOINTS_V45_SQL = `
CREATE TABLE IF NOT EXISTS native_projection_checkpoints (
  device_epoch_id TEXT NOT NULL REFERENCES device_epochs(epoch_id) ON DELETE CASCADE,
  surface_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
  view_revision INTEGER NOT NULL CHECK(view_revision >= 1),
  surface_instance_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(
    length(payload_sha256) = 71
    AND substr(payload_sha256, 1, 7) = 'sha256:'
    AND substr(payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(device_epoch_id, surface_key, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_native_projection_checkpoint_entity
  ON native_projection_checkpoints(entity_id, surface_key, accepted_at_ms DESC);
`;

export const scheduleMentionGraphVNext: MeetingDatabaseMigration = {
  version: 45,
  name: 'schedule-mention-graph-vnext',
  async migrate(database) {
    const hasColumn = async (column: string): Promise<boolean> => {
      const rows = await database.getAllAsync<{ name: string }>(
        'PRAGMA table_info(local_schedule_events)',
      );
      return rows.some(row => row.name === column);
    };

    if (!(await hasColumn('event_revision'))) {
      await database.execAsync(
        'ALTER TABLE local_schedule_events ADD COLUMN event_revision INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!(await hasColumn('draft_source_sha256'))) {
      await database.execAsync(
        'ALTER TABLE local_schedule_events ADD COLUMN draft_source_sha256 TEXT',
      );
    }
    if (!(await hasColumn('producer_revision'))) {
      await database.execAsync(
        "ALTER TABLE local_schedule_events ADD COLUMN producer_revision TEXT NOT NULL DEFAULT 'legacy-v1'",
      );
    }
    if (!(await hasColumn('graph_schema_revision'))) {
      await database.execAsync(
        "ALTER TABLE local_schedule_events ADD COLUMN graph_schema_revision TEXT NOT NULL DEFAULT 'mention-graph-v1'",
      );
    }
    if (!(await hasColumn('deleted_at_ms'))) {
      await database.execAsync(
        'ALTER TABLE local_schedule_events ADD COLUMN deleted_at_ms INTEGER',
      );
    }

    await database.execAsync(SCHEDULE_MENTION_GRAPH_VNEXT_V45_SQL);
    await database.execAsync(NATIVE_PROJECTION_CHECKPOINTS_V45_SQL);
  },
};
