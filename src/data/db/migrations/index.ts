import { meetingMemorySchemaV1 } from './0001MeetingMemorySchema';
import { meetingMemoryPhase1 } from './0002MeetingMemoryPhase1';
import { meetingContextV3 } from './0003MeetingContext';
import { meetingWriteOwnershipV4 } from './0004MeetingWriteOwnership';
import type { MeetingDatabaseMigration } from './types';

export const meetingDatabaseMigrations: readonly MeetingDatabaseMigration[] = [
  meetingMemorySchemaV1,
  meetingMemoryPhase1,
  meetingContextV3,
  meetingWriteOwnershipV4,
];

export { MEETING_MEMORY_SCHEMA_V1_SQL } from './0001MeetingMemorySchema';
export { MEETING_MEMORY_PHASE_1_SQL } from './0002MeetingMemoryPhase1';
export { MEETING_CONTEXT_V3_SQL } from './0003MeetingContext';
export { MEETING_WRITE_OWNERSHIP_V4_SQL } from './0004MeetingWriteOwnership';
export type { MeetingDatabaseMigration } from './types';
