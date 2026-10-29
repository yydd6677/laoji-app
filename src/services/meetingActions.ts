import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { MeetingSummaryActionCandidate, ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';
import { meetingActionRecordToCandidate } from './meetingContentProjection';

export interface MeetingActionsState {
  canonicalMeetingId: string;
  actions: readonly MeetingSummaryActionCandidate[];
}

/** Generated facts supply presentation only; mutable identity/state has one
 * owner in action_items. A projection must never resurrect or reset a row. */
export function mergeCanonicalMeetingActions(
  canonical: readonly MeetingSummaryActionCandidate[],
  projected: readonly MeetingSummaryActionCandidate[],
): readonly MeetingSummaryActionCandidate[] {
  return canonical.map(action => {
    const matches = projected.filter(candidate => candidate.content.trim() === action.content.trim());
    const metadata = matches.find(candidate => candidate.id === action.id || candidate.canonicalId === action.id
      || candidate.id === action.canonicalId) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!metadata) return action;
    return {
      ...action,
      dueText: action.dueText ?? (action.dueAtMs === null ? metadata.dueText : null),
      scheduleFit: action.scheduleFit ?? metadata.scheduleFit,
      evidenceScore: action.evidenceScore ?? metadata.evidenceScore,
      citations: action.citations.length > 0 ? action.citations : metadata.citations,
    };
  });
}

/** Reads meeting-global actions without requiring an active Summary version. */
export async function loadMeetingActions(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingActionsState> {
  assertScopeKey(scopeKey);
  const meeting = await sqliteMeetingNoteRepository.getMeetingByNativeSessionId(meetingId, scopeKey);
  if (!meeting || meeting.lifecycle === 'deleted') {
    throw new Error('meeting actions are unavailable');
  }
  const actions = await sqliteMeetingNoteRepository.listMeetingActions(meeting.id, scopeKey);
  return {
    canonicalMeetingId: meeting.id,
    actions: actions.map(meetingActionRecordToCandidate),
  };
}
