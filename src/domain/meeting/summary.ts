export type MeetingSummaryVersionStatus = 'ready' | 'stale';

export type MeetingSummarySectionKind =
  | 'paragraph'
  | 'bullet_group'
  | 'quote'
  | 'timeline'
  | 'flow'
  | 'comparison'
  | 'risk_card'
  | 'stat'
  | 'bullets'
  | 'numbered'
  | 'decisions'
  | 'topics'
  | 'risks'
  | 'action_items'
  | 'legacy';

export interface MeetingSummaryCitation {
  id: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  quoteHash: string | null;
  sourceType?: 'transcript' | 'manual_note' | 'attachment';
  sourceLabel?: string | null;
}

export interface MeetingSummaryRichItem {
  id: string;
  title: string | null;
  text: string;
  meta: string | null;
  sourceId: string | null;
  startMs: number | null;
}

export interface MeetingSummaryRichEdge {
  from: string;
  to: string;
  label: string | null;
}

export interface MeetingSummaryRichBlock {
  kind: 'paragraph' | 'bullet_group' | 'quote' | 'timeline' | 'flow' | 'comparison' | 'risk_card' | 'stat';
  iconKey: 'overview' | 'topic' | 'quote' | 'time' | 'flow' | 'compare' | 'risk' | 'stat' | 'action';
  items: readonly MeetingSummaryRichItem[];
  edges?: readonly MeetingSummaryRichEdge[];
  edited?: boolean;
  originalSourceLabel?: string | null;
}

export interface MeetingSummarySection {
  id: string;
  stableKey: string;
  kind: MeetingSummarySectionKind;
  title: string | null;
  content: string;
  userEdited?: boolean;
  userEditedAtMs?: number | null;
  citations: readonly MeetingSummaryCitation[];
  richBlock?: MeetingSummaryRichBlock;
}

export interface MeetingSummaryActionCandidate {
  id: string;
  /** Present after SQLite projection; provider IDs remain in `id` for raw API documents. */
  canonicalId?: string | null;
  content: string;
  assignee: string | null;
  dueAtMs: number | null;
  dueText?: string | null;
  reminderAtMs: number | null;
  reminderNotificationId: string | null;
  followupEventSourceId: string | null;
  status: 'pending' | 'completed' | 'dismissed';
  /** Canonical meeting-level ownership; absent raw provider candidates are generated. */
  sourceKind?: 'generated' | 'manual' | 'marker';
  citations: readonly MeetingSummaryCitation[];
  /** Meeting-global action provenance can retain time even when no Transcript segment covers it. */
  sourceSegmentId?: string | null;
  sourceStartMs?: number | null;
  updatedAtMs?: number | null;
  scheduleFit?: 'high' | 'medium' | 'low';
  evidenceScore?: number;
}

export type MeetingFactTypeV3 =
  | 'topic'
  | 'context'
  | 'conclusion'
  | 'action'
  | 'risk'
  | 'question'
  | 'quote'
  | 'timeline';

export type MeetingFactCertaintyV3 = 'confirmed' | 'proposed' | 'uncertain' | 'negated' | 'completed';

export interface MeetingFactSourceV3 {
  sourceId: string;
  sourceType: 'transcript' | 'manual_note' | 'attachment';
  quote: string;
  contentHash: string;
  startMs: number | null;
  endMs: number | null;
  speaker: string | null;
}

export interface MeetingFactV3 {
  factId: string;
  factType: MeetingFactTypeV3;
  certainty: MeetingFactCertaintyV3;
  content: string;
  sources: readonly MeetingFactSourceV3[];
  evidenceScore: number;
  conflictGroupId: string | null;
}

export interface MeetingFactRelationV3 {
  relationType: 'supports' | 'contradicts' | 'precedes' | 'depends_on' | 'alternative';
  fromFactId: string;
  toFactId: string;
}

export interface MeetingActionCandidateV3 {
  actionId: string;
  factId: string;
  content: string;
  owner: string | null;
  dueText: string | null;
  scheduleFit: 'high' | 'medium' | 'low';
  evidenceScore: number;
}

export interface MeetingFactsDocumentV3 {
  schemaVersion: 3;
  overview: { text: string; factIds: readonly string[] };
  facts: readonly MeetingFactV3[];
  relations: readonly MeetingFactRelationV3[];
  actionCandidates: readonly MeetingActionCandidateV3[];
}

export interface MeetingFactsResultV3 {
  documentId: string;
  meetingId: string;
  factsDocument: MeetingFactsDocumentV3;
  sourceFingerprint: string;
  transcriptRevision: string;
  modelRevision: string;
  promptRevision: string;
  generatedAt: string;
  coverage: {
    totalSegments: number;
    includedSegments: number;
    topicGroups: number;
    coveredTopicGroups: number;
    topicCoverage: number;
    sourceTypes: readonly ('transcript' | 'manual_note' | 'attachment')[];
    includedSourceTypes: readonly ('transcript' | 'manual_note' | 'attachment')[];
    sourceCoverage: number;
    usedEmbeddings: boolean;
    inputTokenBudget: number;
    estimatedInputTokens: number;
  };
}

export interface MeetingSummaryCarryForwardItem {
  kind: 'decision' | 'action';
  sourceMeetingId: string;
  sourceItemId: string;
  sourceTitle: string;
  sourceOccurrenceDate: string;
  content: string;
  assignee: string | null;
  dueAt: string | null;
}

export interface MeetingSummaryCarryForwardAuthorization {
  requestId: string;
  items: readonly MeetingSummaryCarryForwardItem[];
}

export interface MeetingSummaryTextAttachmentItem {
  attachmentId: string;
  kind: 'text';
  positionMs: number;
  content: string;
  contentSha256: string;
  updatedAtMs: number;
}

export interface MeetingSummaryImageAttachmentItem {
  attachmentId: string;
  kind: 'image';
  positionMs: number;
  remoteAttachmentId: string;
  remoteRevision: number;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  updatedAtMs: number;
}

export type MeetingSummaryAttachmentItem =
  | MeetingSummaryTextAttachmentItem
  | MeetingSummaryImageAttachmentItem;

/** A fresh, generation-scoped opt-in. It is deliberately unrelated to sharing consent. */
export interface MeetingSummaryAttachmentAuthorization {
  requestId: string;
  items: readonly MeetingSummaryAttachmentItem[];
}

/**
 * Client-normalized v2 document. It is safe to serialize in the legacy cache while SQLite becomes
 * the canonical source; generated content remains immutable after it is mirrored as a version.
 */
export interface MeetingSummaryDocument {
  schemaVersion: 2;
  remoteVersionId: string | null;
  meetingId: string;
  templateId: string;
  templateRevision: number;
  transcriptRevisionId: string | null;
  /** Server-owned transcript revision used for generation; distinct from the local SQLite revision ID. */
  remoteTranscriptRevisionId?: string | null;
  manualNoteRevision: number;
  scheduleSnapshotHash: string | null;
  status: MeetingSummaryVersionStatus;
  generatedBy: string | null;
  supersedesVersionId: string | null;
  createdAtMs: number;
  completedAtMs: number;
  sections: readonly MeetingSummarySection[];
  actionItemCandidates: readonly MeetingSummaryActionCandidate[];
}
