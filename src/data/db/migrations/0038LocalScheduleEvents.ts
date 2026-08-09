import type { MeetingDatabaseMigration } from './types';

export const LOCAL_SCHEDULE_EVENTS_V38_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_local_schedule_date_v38
  ON local_schedule_events(start_date, end_date, id);
`;

export const localScheduleEventsV38: MeetingDatabaseMigration = {
  version: 38,
  name: 'local-schedule-events-v38',
  async migrate(database) {
    await database.execAsync(LOCAL_SCHEDULE_EVENTS_V38_SQL);
  },
};
