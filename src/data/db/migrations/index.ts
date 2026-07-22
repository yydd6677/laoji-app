import { meetingMemorySchemaV1 } from './0001MeetingMemorySchema';
import { meetingMemoryPhase1 } from './0002MeetingMemoryPhase1';
import type { MeetingDatabaseMigration } from './types';

export const meetingDatabaseMigrations: readonly MeetingDatabaseMigration[] = [
  meetingMemorySchemaV1,
  meetingMemoryPhase1,
];

export { MEETING_MEMORY_SCHEMA_V1_SQL } from './0001MeetingMemorySchema';
export { MEETING_MEMORY_PHASE_1_SQL } from './0002MeetingMemoryPhase1';
export type { MeetingDatabaseMigration } from './types';
