import { getFeatureFlags } from '../config/featureFlags';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { MeetingSummaryDocument, ScopeKey } from '../domain/meeting';
import { summaryProjectionToDocument } from './meetingContentProjection';

export interface CurrentMeetingSummaryState {
  canonicalMeetingId: string;
  document: MeetingSummaryDocument;
  stale: boolean;
}

/** Reads the current immutable summary version without enabling global canonical list cutover. */
export async function loadCurrentMeetingSummaryState(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<CurrentMeetingSummaryState | null> {
  if (!getFeatureFlags().localMeetingDbV1) return null;
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  const projection = await sqliteMeetingNoteRepository.getCurrentSummaryContent(
    aggregate.note.id,
    scopeKey,
  );
  const document = summaryProjectionToDocument(projection, legacyMeetingId);
  if (!document) return null;
  return {
    canonicalMeetingId: aggregate.note.id,
    document,
    stale: projection?.version.status === 'stale',
  };
}
