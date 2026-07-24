import { getFeatureFlags } from '../config/featureFlags';
import { sqliteMeetingNoteRepository } from '../data/repositories';
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

/** Reads the local active revision without enabling the global canonical list cutover. */
export async function loadActiveMeetingTranscriptState(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<ActiveMeetingTranscriptState | null> {
  if (!getFeatureFlags().localMeetingDbV1) return null;
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
