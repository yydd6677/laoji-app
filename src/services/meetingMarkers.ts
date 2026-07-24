import {
  CreateMeetingMarkerUseCase,
  DeleteMeetingMarkerUseCase,
  type CreateMeetingMarkerResult,
  type DeleteMeetingMarkerResult,
} from '../application/meeting';
import {
  sqliteMeetingNoteRepository,
  type MarkerRecord,
  type MeetingNoteAggregate,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';

const createMarkerUseCase = new CreateMeetingMarkerUseCase(sqliteMeetingNoteRepository);
const deleteMarkerUseCase = new DeleteMeetingMarkerUseCase(sqliteMeetingNoteRepository);

export interface MeetingMarkersState {
  canonicalMeetingId: string;
  markers: readonly MarkerRecord[];
}

async function resolveCanonicalMeeting(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingNoteAggregate> {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new Error('meeting markers are unavailable');
  }
  return aggregate;
}

export async function loadMeetingMarkers(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingMarkersState> {
  const aggregate = await resolveCanonicalMeeting(scopeKey, meetingId);
  await sqliteMeetingNoteRepository.transaction(transaction => transaction.reconcileMeetingMarkers(
    aggregate.note.id,
    scopeKey,
    Date.now(),
  ));
  return {
    canonicalMeetingId: aggregate.note.id,
    markers: await sqliteMeetingNoteRepository.listMeetingMarkers(aggregate.note.id, scopeKey),
  };
}

export async function createMeetingMarker(
  scopeKey: ScopeKey,
  meetingId: string,
  positionMs: number,
): Promise<CreateMeetingMarkerResult> {
  const aggregate = await resolveCanonicalMeeting(scopeKey, meetingId);
  return createMarkerUseCase.execute({
    meetingId: aggregate.note.id,
    scopeKey,
    positionMs,
  });
}

export async function deleteMeetingMarker(
  scopeKey: ScopeKey,
  meetingId: string,
  markerId: string,
): Promise<DeleteMeetingMarkerResult> {
  const aggregate = await resolveCanonicalMeeting(scopeKey, meetingId);
  return deleteMarkerUseCase.execute({
    meetingId: aggregate.note.id,
    markerId,
    scopeKey,
  });
}
