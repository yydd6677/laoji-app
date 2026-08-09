import type { SQLiteDatabase } from 'expo-sqlite';
import type { CalEvent } from '../../types';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';

type LocalScheduleRow = {
  id: string;
  event_json: string;
};

function normalize(event: CalEvent): CalEvent {
  return { ...event, id: String(event.id) };
}

async function ensureTable(database: SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS local_schedule_events (
      id TEXT PRIMARY KEY,
      source_event_id TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      start_time TEXT,
      end_time TEXT,
      title TEXT NOT NULL DEFAULT '',
      event_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_schedule_date_runtime
      ON local_schedule_events(start_date, end_date, id);
  `);
}

export async function loadLocalScheduleEvents(): Promise<CalEvent[]> {
  const database = await openMeetingDatabase();
  await ensureTable(database);
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
  await withMeetingDatabaseTransaction(async database => {
    await ensureTable(database);
    await database.runAsync('DELETE FROM local_schedule_events');
    const now = Date.now();
    for (const event of normalized) {
      await database.runAsync(
        `INSERT INTO local_schedule_events (
          id, source_event_id, start_date, end_date, start_time, end_time,
          title, event_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.sourceEventId ?? event.id,
        event.startDate,
        event.endDate ?? null,
        event.startTime ?? null,
        event.endTime ?? null,
        event.title,
        JSON.stringify(event),
        now,
        now,
      );
    }
  });
}

export async function upsertLocalScheduleEvent(event: CalEvent): Promise<void> {
  const existing = await loadLocalScheduleEvents();
  const next = [...existing.filter(item => item.id !== event.id), normalize(event)];
  await replaceLocalScheduleEvents(next);
}

export async function deleteLocalScheduleEvent(eventId: string): Promise<void> {
  const existing = await loadLocalScheduleEvents();
  await replaceLocalScheduleEvents(existing.filter(item => item.id !== eventId));
}
