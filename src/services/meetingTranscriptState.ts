import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { ScopeKey } from '../domain/meeting';
import type { TranscriptLine } from '../types';
import { transcriptProjectionToLegacyLines } from './meetingContentProjection';
import type { TranscriptCandidateKind } from './transcriptCompleteness';

export interface ActiveMeetingTranscriptState {
  canonicalMeetingId: string;
  kind: TranscriptCandidateKind;
  lines: TranscriptLine[];
  completing: boolean;
}

/** Reads the current local active transcript revision. */
export async function loadActiveMeetingTranscriptState(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<ActiveMeetingTranscriptState | null> {
  const state = await sqliteMeetingNoteRepository.getActiveTranscriptStateByNativeSessionId(
    legacyMeetingId,
    scopeKey,
  );
  if (!state) return null;
  const projection = state.transcript;
  return {
    canonicalMeetingId: projection.revision.meetingId,
    kind: projection.revision.kind,
    lines: transcriptProjectionToLegacyLines(projection, legacyMeetingId),
    completing: state.completing,
  };
}
