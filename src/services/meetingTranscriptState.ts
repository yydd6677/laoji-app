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
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  const projection = await sqliteMeetingNoteRepository.getActiveTranscriptContent(
    aggregate.note.id,
    scopeKey,
  );
  if (!projection) return null;
  const transcriptStage = aggregate.processingStages.find(stage => stage.stage === 'transcript');
  return {
    canonicalMeetingId: aggregate.note.id,
    kind: projection.revision.kind,
    lines: transcriptProjectionToLegacyLines(projection, legacyMeetingId),
    completing: transcriptStage?.status === 'finalizing'
      || projection.revision.status === 'finalizing',
  };
}
