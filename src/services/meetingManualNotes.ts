import { SaveManualNoteUseCase } from '../application/meeting';
import type { ManualNoteRecord } from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';

const saveManualNoteUseCase = new SaveManualNoteUseCase(sqliteMeetingNoteRepository);

async function resolveCanonicalMeeting(scopeKey: ScopeKey, meetingId: string) {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new Error('meeting manual note is unavailable');
  }
  return aggregate;
}

export async function loadMeetingManualNote(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<ManualNoteRecord> {
  return (await resolveCanonicalMeeting(scopeKey, meetingId)).manualNote;
}

export async function saveMeetingManualNote(
  scopeKey: ScopeKey,
  meetingId: string,
  content: string,
  expectedRevision: number,
) {
  const aggregate = await resolveCanonicalMeeting(scopeKey, meetingId);
  return saveManualNoteUseCase.execute({
    meetingId: aggregate.note.id,
    scopeKey,
    content,
    expectedRevision,
  });
}
