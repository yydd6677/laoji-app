import { meetingMemorySchemaV1 } from './0001MeetingMemorySchema';
import type { MeetingDatabaseMigration } from './types';

export const meetingDatabaseMigrations: readonly MeetingDatabaseMigration[] = [
  meetingMemorySchemaV1,
];

export { MEETING_MEMORY_SCHEMA_V1_SQL } from './0001MeetingMemorySchema';
export type { MeetingDatabaseMigration } from './types';
