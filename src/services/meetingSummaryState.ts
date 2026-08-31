import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { TranscriptSegmentRecord } from "../data/repositories/meetingNoteRepository";
import type { MeetingSummaryDocument, ScopeKey } from '../domain/meeting';
import { transitionProcessingStage } from '../domain/meeting';
import { summaryProjectionToDocument } from './meetingContentProjection';
import { loadMeetingFactsRecordV3ForVersion } from '../data/repositories/meetingSummaryV3Repository';

export interface CurrentMeetingSummaryState {
  canonicalMeetingId: string;
  document: MeetingSummaryDocument;
  stale: boolean;
}

function sameSummaryInputSegment(
  left: TranscriptSegmentRecord,
  right: TranscriptSegmentRecord,
): boolean {
  return left.ordinal === right.ordinal
    && left.speakerClusterId === right.speakerClusterId
    && left.speakerProfileId === right.speakerProfileId
    && left.speakerLabel === right.speakerLabel
    && left.speakerLabelOverride === right.speakerLabelOverride
    && left.text === right.text
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.confidence === right.confidence;
}

async function repairFalseSummaryStaleness(
  scopeKey: ScopeKey,
  canonicalMeetingId: string,
): Promise<boolean> {
  const [summary, activeTranscript] = await Promise.all([
    sqliteMeetingNoteRepository.getCurrentSummaryVersion(canonicalMeetingId, scopeKey),
    sqliteMeetingNoteRepository.getActiveTranscriptContent(canonicalMeetingId, scopeKey),
  ]);
  if (
    summary?.status !== 'stale'
    || !summary.transcriptRevisionId
    || !activeTranscript
    || summary.transcriptRevisionId === activeTranscript.revision.id
  ) return false;
  const sourceTranscript = await sqliteMeetingNoteRepository.getTranscriptRevisionContent(
    summary.transcriptRevisionId,
    scopeKey,
  );
  if (
    !sourceTranscript
    || sourceTranscript.segments.length !== activeTranscript.segments.length
    || sourceTranscript.segments.some((segment, index) => (
      !sameSummaryInputSegment(segment, activeTranscript.segments[index])
    ))
  ) return false;

  let repaired = false;
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const [currentSummary, currentTranscript, manualNote, summaryStage, meeting] = await Promise.all([
      transaction.getCurrentSummaryVersion(canonicalMeetingId, scopeKey),
      transaction.getActiveTranscriptContent(canonicalMeetingId, scopeKey),
      transaction.getManualNote(canonicalMeetingId, scopeKey),
      transaction.getStage(canonicalMeetingId, scopeKey, 'summary'),
      transaction.getMeeting(canonicalMeetingId, scopeKey),
    ]);
    if (
      currentSummary?.id !== summary.id
      || currentSummary.status !== 'stale'
      || !currentTranscript
      || currentTranscript.revision.id !== activeTranscript.revision.id
      || manualNote?.revision !== currentSummary.manualNoteRevision
      || !summaryStage
      || !meeting
    ) return;
    const currentSource = await transaction.getTranscriptRevisionContent(
      currentSummary.transcriptRevisionId!,
      scopeKey,
    );
    if (
      !currentSource
      || currentSource.segments.length !== currentTranscript.segments.length
      || currentSource.segments.some((segment, index) => (
        !sameSummaryInputSegment(segment, currentTranscript.segments[index])
      ))
    ) return;
    repaired = await transaction.restoreCurrentSummaryReady(
      canonicalMeetingId,
      scopeKey,
      currentSummary.id,
    );
    if (!repaired) return;
    const updatedAtMs = Math.max(Date.now(), meeting.updatedAtMs, summaryStage.updatedAtMs);
    await transaction.upsertStage(transitionProcessingStage(summaryStage, {
      stage: 'summary',
      status: 'ready',
      progress: 1,
      jobId: null,
      inputFingerprint: currentSummary.inputFingerprint,
    }, updatedAtMs), scopeKey);
    await transaction.updateMeeting(canonicalMeetingId, scopeKey, { updatedAtMs });
    await transaction.advanceCanonicalWrite(scopeKey, updatedAtMs);
  });
  return repaired;
}

async function reconcileSummaryStageWithCurrentVersion(
  scopeKey: ScopeKey,
  canonicalMeetingId: string,
): Promise<boolean> {
  let reconciled = false;
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const [summary, stage, meeting] = await Promise.all([
      transaction.getCurrentSummaryVersion(canonicalMeetingId, scopeKey),
      transaction.getStage(canonicalMeetingId, scopeKey, 'summary'),
      transaction.getMeeting(canonicalMeetingId, scopeKey),
    ]);
    if (!summary || !stage || !meeting || meeting.lifecycle === 'deleted') return;
    const targetStatus = summary.status === 'ready'
      ? 'ready' as const
      : summary.status === 'stale'
        ? 'stale' as const
        : null;
    if (!targetStatus) return;
    if (!['ready', 'stale'].includes(stage.status) || stage.status === targetStatus) return;
    const updatedAtMs = Math.max(Date.now(), stage.updatedAtMs, meeting.updatedAtMs);
    await transaction.upsertStage(transitionProcessingStage(stage, {
      stage: 'summary',
      status: targetStatus,
      progress: targetStatus === 'ready' ? 1 : null,
      jobId: null,
      inputFingerprint: summary.inputFingerprint,
    }, updatedAtMs), scopeKey);
    await transaction.updateMeeting(canonicalMeetingId, scopeKey, { updatedAtMs });
    await transaction.advanceCanonicalWrite(scopeKey, updatedAtMs);
    reconciled = true;
  });
  return reconciled;
}

/** Reads the current immutable local summary version. */
export async function loadCurrentMeetingSummaryState(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<CurrentMeetingSummaryState | null> {
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  await repairFalseSummaryStaleness(scopeKey, aggregate.note.id);
  await reconcileSummaryStageWithCurrentVersion(scopeKey, aggregate.note.id);
  const projection = await sqliteMeetingNoteRepository.getCurrentSummaryContent(
    aggregate.note.id,
    scopeKey,
  );
  if (!projection) return null;
  const facts = await loadMeetingFactsRecordV3ForVersion(projection.version.id);
  if (!facts || facts.canonicalMeetingId !== aggregate.note.id) return null;
  const document = summaryProjectionToDocument(projection, legacyMeetingId);
  if (!document) return null;
  return {
    canonicalMeetingId: aggregate.note.id,
    document,
    stale: projection?.version.status === 'stale',
  };
}
