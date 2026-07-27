export type MeetingSummaryVersionStatus = 'ready' | 'stale';

export type MeetingSummarySectionKind =
  | 'paragraph'
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
}

export interface MeetingSummarySection {
  id: string;
  stableKey: string;
  kind: MeetingSummarySectionKind;
  title: string | null;
  content: string;
  citations: readonly MeetingSummaryCitation[];
}

export interface MeetingSummaryActionCandidate {
  id: string;
  /** Present after SQLite projection; provider IDs remain in `id` for raw API documents. */
  canonicalId?: string | null;
  content: string;
  assignee: string | null;
  dueAtMs: number | null;
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
