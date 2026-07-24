import type { MeetingDatabaseMigration } from './types';

export const MEETING_SERIES_IDENTITY_V10_SQL = `
UPDATE meeting_occurrence_links
SET series_key = 'calendar:' || scope_key || ':' || calendar_source_event_id
WHERE series_key IS NULL
   OR series_key <> 'calendar:' || scope_key || ':' || calendar_source_event_id;
`;

export const meetingSeriesIdentityV10: MeetingDatabaseMigration = {
  version: 10,
  name: 'meeting-series-identity',
  async migrate(database) {
    await database.execAsync(MEETING_SERIES_IDENTITY_V10_SQL);
  },
};
