import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { MeetingSummaryActionCandidate, ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';
import { meetingActionRecordToCandidate } from './meetingContentProjection';
import {
  meetingActionSyncConflictView,
  type MeetingActionSyncConflictView,
} from './meetingActionConflicts';

export interface MeetingActionsState {
  canonicalMeetingId: string;
  actions: readonly MeetingSummaryActionCandidate[];
  conflicts: readonly MeetingActionSyncConflictView[];
}

/** Reads meeting-global actions without requiring an active Summary version. */
export async function loadMeetingActions(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingActionsState> {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new Error('meeting actions are unavailable');
  }
  const [actions, conflicts] = await Promise.all([
    sqliteMeetingNoteRepository.listMeetingActions(aggregate.note.id, scopeKey),
    sqliteMeetingNoteRepository.listMeetingActionSyncConflicts(aggregate.note.id, scopeKey),
  ]);
  const actionsById = new Map(actions.map(action => [action.id, action] as const));
  return {
    canonicalMeetingId: aggregate.note.id,
    actions: actions.map(meetingActionRecordToCandidate),
    conflicts: conflicts.flatMap(conflict => {
      const action = actionsById.get(conflict.actionId);
      return action ? [meetingActionSyncConflictView(action, conflict)] : [];
    }),
  };
}
