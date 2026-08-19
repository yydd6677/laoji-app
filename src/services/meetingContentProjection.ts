import type { MeetingSummary, TranscriptLine } from '../types';
import type {
  MeetingSummaryActionCandidate,
  MeetingSummaryDocument,
  MeetingSummarySectionKind,
} from '../domain/meeting';
import type {
  ActionItemRecord,
  SummarySectionRecord,
  SummaryVersionProjection,
  TranscriptRevisionProjection,
} from '../data/repositories';
import { meetingSummaryDocumentToLegacySummary } from './meetingSummaryFormat';

function sectionText(section: SummarySectionRecord): string {
  return (section.userText !== null ? section.userText : section.generatedText).trim();
}

function sectionKind(value: string): MeetingSummarySectionKind {
  if (
    value === 'paragraph' || value === 'bullets' || value === 'numbered'
    || value === 'decisions' || value === 'topics' || value === 'risks'
    || value === 'action_items'
  ) return value;
  return 'legacy';
}

export function transcriptProjectionToLegacyLines(
  projection: TranscriptRevisionProjection | null,
  legacyMeetingId: string,
): TranscriptLine[] {
  if (!projection) return [];
  const revisionKind = projection.revision.kind === 'realtime_draft'
    ? 'realtimeDraft'
    : projection.revision.kind;
  return projection.segments.map(segment => ({
    id: segment.sourceId ?? segment.id,
    meeting_id: legacyMeetingId,
    recording_asset_id: segment.sourceRecordingAssetRemoteId,
    transcription_job_id: segment.sourceTranscriptionJobId,
    recordingAssetId: segment.sourceRecordingAssetId ?? undefined,
    recordingAssetRemoteId: segment.sourceRecordingAssetRemoteId ?? undefined,
    transcriptionJobId: segment.sourceTranscriptionJobId ?? undefined,
    speaker_id: segment.speakerProfileId ?? segment.speakerClusterId ?? undefined,
    speaker_label: segment.speakerLabelOverride ?? segment.speakerLabel ?? undefined,
    speakerClusterId: segment.speakerClusterId ?? undefined,
    text: segment.text,
    start_time: segment.startMs / 1000,
    end_time: segment.endMs / 1000,
    confidence: segment.confidence ?? undefined,
    created_at: new Date(segment.createdAtMs).toISOString(),
    isFinal: projection.revision.kind !== 'realtime_draft' && segment.isFinal,
    textState: segment.textState,
    revisionKind,
  }));
}

export function summaryProjectionToLegacySummary(
  projection: SummaryVersionProjection | null,
  legacyMeetingId: string,
): MeetingSummary | null {
  if (!projection || !['ready', 'stale'].includes(projection.version.status)) return null;
  const document = summaryProjectionToDocument(projection, legacyMeetingId);
  return document ? meetingSummaryDocumentToLegacySummary(document) : null;
}

export function summaryProjectionToDocument(
  projection: SummaryVersionProjection | null,
  legacyMeetingId: string,
): MeetingSummaryDocument | null {
  if (!projection || !['ready', 'stale'].includes(projection.version.status)) return null;
  const citationsBySection = new Map<string, typeof projection.citations>();
  projection.citations.forEach(citation => {
    citationsBySection.set(citation.sectionId, [
      ...(citationsBySection.get(citation.sectionId) ?? []),
      citation,
    ]);
  });
  const sections = projection.sections
    .map(section => {
      const sectionCitations = citationsBySection.get(section.id) ?? [];
      const removedCitationTimes = sectionCitations
        .map(citation => citation.userRemovedAtMs)
        .filter((value): value is number => value !== null);
      const userEditedAtMs = [section.userEditedAtMs, ...removedCitationTimes]
        .filter((value): value is number => value !== null)
        .reduce<number | null>((latest, value) => latest === null ? value : Math.max(latest, value), null);
      return {
        id: section.id,
        stableKey: section.stableKey,
        kind: sectionKind(section.kind),
        title: section.title,
        content: sectionText(section),
        userEdited: section.userText !== null || removedCitationTimes.length > 0,
        userEditedAtMs,
        citations: sectionCitations
          .filter(citation => citation.userRemovedAtMs === null)
          .map(citation => ({
            id: citation.id,
            segmentId: citation.sourceSegmentId ?? citation.segmentId,
            startMs: citation.startMs,
            endMs: citation.endMs,
            quoteHash: citation.quoteHash,
          })),
      };
    })
    .filter(section => section.content || section.title);
  const actions = projection.meetingActions.map(meetingActionRecordToCandidate);
  if (sections.length === 0 && actions.length === 0) return null;
  return {
    schemaVersion: 2,
    remoteVersionId: projection.version.id,
    meetingId: legacyMeetingId,
    templateId: projection.version.templateId,
    templateRevision: projection.version.templateRevision,
    transcriptRevisionId: projection.version.transcriptRevisionId,
    manualNoteRevision: projection.version.manualNoteRevision,
    scheduleSnapshotHash: projection.version.scheduleSnapshotHash,
    status: projection.version.status === 'stale' ? 'stale' : 'ready',
    generatedBy: projection.version.generatedBy,
    supersedesVersionId: projection.version.supersedesVersionId,
    createdAtMs: projection.version.createdAtMs,
    completedAtMs: projection.version.completedAtMs ?? projection.version.createdAtMs,
    sections,
    actionItemCandidates: actions,
  };
}

export function meetingActionRecordToCandidate(
  action: ActionItemRecord,
): MeetingSummaryActionCandidate {
  return {
    id: action.remoteId ?? action.id,
    canonicalId: action.id,
    content: action.content,
    assignee: action.assigneeText,
    dueAtMs: action.dueAtMs,
    reminderAtMs: action.reminderAtMs,
    reminderNotificationId: action.reminderNotificationId,
    followupEventSourceId: action.followupEventSourceId,
    status: action.status,
    sourceKind: action.sourceKind,
    updatedAtMs: action.updatedAtMs,
    sourceSegmentId: action.sourceSegmentSourceId ?? action.sourceSegmentId,
    sourceStartMs: action.sourceStartMs,
    citations: action.sourceSegmentId === null ? [] : [{
      id: `${action.id}:source`,
      segmentId: action.sourceSegmentSourceId ?? action.sourceSegmentId,
      startMs: action.sourceStartMs ?? 0,
      endMs: action.sourceStartMs ?? 0,
      quoteHash: null,
    }],
  };
}
