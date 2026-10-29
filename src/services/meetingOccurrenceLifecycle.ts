import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { OccurrenceReference, ScopeKey } from '../domain/meeting';

export async function setOccurrenceMeetingLinkState(input: {
  scopeKey: ScopeKey;
  occurrence: OccurrenceReference;
  selection: 'occurrence' | 'following' | 'series';
  state: 'active' | 'orphaned';
  updatedAtMs?: number;
}): Promise<number> {
  const changed = await sqliteMeetingNoteRepository.setOccurrenceLinkState({
    scopeKey: input.scopeKey,
    sourceEventId: input.occurrence.sourceEventId,
    occurrenceDate: input.occurrence.occurrenceDate,
    selection: input.selection,
    state: input.state,
    updatedAtMs: input.updatedAtMs ?? Date.now(),
  });
  return changed;
}
