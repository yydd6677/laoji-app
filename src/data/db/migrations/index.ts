import { meetingMemorySchemaV1 } from './0001MeetingMemorySchema';
import { meetingMemoryPhase1 } from './0002MeetingMemoryPhase1';
import { meetingContextV3 } from './0003MeetingContext';
import type { MeetingDatabaseMigration } from './types';

export const meetingDatabaseMigrations: readonly MeetingDatabaseMigration[] = [
  meetingMemorySchemaV1,
  meetingMemoryPhase1,
  meetingContextV3,
];

export { MEETING_MEMORY_SCHEMA_V1_SQL } from './0001MeetingMemorySchema';
export { MEETING_MEMORY_PHASE_1_SQL } from './0002MeetingMemoryPhase1';
export { MEETING_CONTEXT_V3_SQL } from './0003MeetingContext';
export type { MeetingDatabaseMigration } from './types';
