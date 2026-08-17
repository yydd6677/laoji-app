import type { MeetingDatabaseMigration } from './types';

/**
 * Stage 4 schedule provenance. The event JSON remains the domain payload;
 * these columns make the source/revision fence queryable without parsing JSON
 * and allow a future MentionGraph producer to replace a draft atomically.
 */
export const SCHEDULE_MENTION_GRAPH_VNEXT_V45_SQL = `
CREATE INDEX IF NOT EXISTS idx_local_schedule_event_revision
  ON local_schedule_events(id, event_revision);

CREATE INDEX IF NOT EXISTS idx_local_schedule_source_hash
  ON local_schedule_events(draft_source_sha256, producer_revision)
  WHERE draft_source_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_local_schedule_deleted
  ON local_schedule_events(deleted_at_ms, start_date, id)
  WHERE deleted_at_ms IS NOT NULL;
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
  },
};

