import type { CalEvent } from '../../types';
import { openScheduleDatabase, withScheduleDatabaseTransaction } from '../db/openScheduleDatabase';

type LocalScheduleRow = {
  id: string;
  event_json: string;
};

function normalize(event: CalEvent): CalEvent {
  return { ...event, id: String(event.id) };
}

export async function loadLocalScheduleEvents(): Promise<CalEvent[]> {
  const database = await openScheduleDatabase();
  const rows = await database.getAllAsync<LocalScheduleRow>(
    'SELECT id, event_json FROM local_schedule_events ORDER BY start_date, start_time, id',
  );
  return rows.flatMap(row => {
    try {
      const parsed = JSON.parse(row.event_json) as CalEvent;
      return parsed && typeof parsed === 'object' ? [normalize(parsed)] : [];
    } catch {
      return [];
    }
  });
}

export async function replaceLocalScheduleEvents(events: readonly CalEvent[]): Promise<void> {
  const normalized = events.map(normalize);
  await withScheduleDatabaseTransaction(async database => {
    await database.runAsync('DELETE FROM local_schedule_events');
    const now = Date.now();
    for (const event of normalized) {
      await database.runAsync(
        `INSERT INTO local_schedule_events (
          id, source_event_id, start_date, end_date, start_time, end_time,
          title, event_json, event_revision, draft_source_sha256,
          producer_revision, graph_schema_revision, deleted_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.sourceEventId ?? event.id,
        event.startDate,
        event.endDate ?? null,
        event.startTime ?? null,
        event.endTime ?? null,
        event.title,
        JSON.stringify(event),
        event.eventRevision ?? event.revision ?? 1,
        event.draftSourceSha256 ?? null,
        event.producerRevision ?? 'legacy-v1',
        event.graphSchemaRevision ?? 'mention-graph-v1',
        event.deletedAtMs ?? null,
        now,
        now,
      );
    }
  });
}

export async function upsertLocalScheduleEvent(event: CalEvent): Promise<void> {
  const normalized = normalize(event);
  await withScheduleDatabaseTransaction(async database => {
    const now = Date.now();
    await database.runAsync(
      `INSERT INTO local_schedule_events (
        id, source_event_id, start_date, end_date, start_time, end_time,
        title, event_json, event_revision, draft_source_sha256,
        producer_revision, graph_schema_revision, deleted_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_event_id = excluded.source_event_id,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        title = excluded.title,
        event_json = excluded.event_json,
        event_revision = excluded.event_revision,
        draft_source_sha256 = excluded.draft_source_sha256,
        producer_revision = excluded.producer_revision,
        graph_schema_revision = excluded.graph_schema_revision,
        deleted_at_ms = excluded.deleted_at_ms,
        updated_at_ms = excluded.updated_at_ms`,
      normalized.id,
      normalized.sourceEventId ?? normalized.id,
      normalized.startDate,
      normalized.endDate ?? null,
      normalized.startTime ?? null,
      normalized.endTime ?? null,
      normalized.title,
      JSON.stringify(normalized),
      normalized.eventRevision ?? normalized.revision ?? 1,
      normalized.draftSourceSha256 ?? null,
      normalized.producerRevision ?? 'legacy-v1',
      normalized.graphSchemaRevision ?? 'mention-graph-v1',
      normalized.deletedAtMs ?? null,
      now,
      now,
    );
  });
}

export async function deleteLocalScheduleEvent(eventId: string): Promise<void> {
  const normalizedId = String(eventId).trim();
  if (!normalizedId) throw new Error('日程标识不能为空');
  await withScheduleDatabaseTransaction(async database => {
    await database.runAsync('DELETE FROM local_schedule_events WHERE id = ?', normalizedId);
  });
}
