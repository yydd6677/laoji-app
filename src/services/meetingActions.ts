import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { MeetingSummaryActionCandidate, ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';
import { meetingActionRecordToCandidate } from './meetingContentProjection';

export interface MeetingActionsState {
  canonicalMeetingId: string;
  actions: readonly MeetingSummaryActionCandidate[];
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
  const actions = await sqliteMeetingNoteRepository.listMeetingActions(aggregate.note.id, scopeKey);
  return {
    canonicalMeetingId: aggregate.note.id,
    actions: actions.map(meetingActionRecordToCandidate),
  };
}
