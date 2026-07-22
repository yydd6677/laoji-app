import type {
  MeetingEntryPoint,
  MeetingLifecycle,
  MeetingNote,
  MeetingOrigin,
  OccurrenceReference,
  ProcessingStage,
  ScheduleSnapshot,
  ScopeKey,
} from '../../domain/meeting';

export type Unsubscribe = () => void;

export interface ManualNoteRecord {
  meetingId: string;
  content: string;
  revision: number;
  baseRemoteRevision: number | null;
  dirty: boolean;
  lastSavedAtMs: number;
  userEditedAtMs: number | null;
}

export interface MeetingNoteAggregate {
  note: MeetingNote;
  occurrence: OccurrenceReference | null;
  scheduleSnapshot: ScheduleSnapshot | null;
  manualNote: ManualNoteRecord;
  processingStages: readonly ProcessingStage[];
}

export interface MeetingListQuery {
  limit: number;
  beforeUpdatedAtMs?: number | null;
  includeDeleted?: boolean;
}

export interface MeetingListProjectionItem {
  id: string;
  remoteId: string | null;
  origin: MeetingOrigin;
  title: string;
  lifecycle: MeetingLifecycle;
  startedAtMs: number | null;
  updatedAtMs: number;
  currentSummaryVersionId: string | null;
  stages: readonly ProcessingStage[];
}

export interface MeetingListProjection {
  items: readonly MeetingListProjectionItem[];
  hasMore: boolean;
}

export interface NewMeetingNote {
  id: string;
  scopeKey: ScopeKey;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint;
  title: string;
  lifecycle: MeetingLifecycle;
  startedAtMs: number | null;
  createdAtMs: number;
}

export interface OccurrenceLinkRecord extends OccurrenceReference {
  meetingId: string;
  scopeKey: ScopeKey;
  calendarRevision: number | null;
  recurrenceSegmentId: string | null;
  seriesKey: string | null;
  linkedAtMs: number;
}

export interface TranscriptSegmentRecord {
  id: string;
  meetingId: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  speakerClusterId: string | null;
  speakerProfileId: string | null;
  speakerLabel: string | null;
  text: string;
  normalizedText: string;
  confidence: number | null;
  isFinal: boolean;
  createdAtMs: number;
}

export interface SyncOperationRecord {
  operationId: string;
  scopeKey: ScopeKey;
  aggregateType: string;
  aggregateId: string;
  operationType: string;
  baseRevision: number | null;
  payloadJson: string;
  createdAtMs: number;
}

export interface MeetingTransaction {
  insertMeeting(note: NewMeetingNote): Promise<void>;
  bindOccurrence(link: OccurrenceLinkRecord, snapshot: ScheduleSnapshot): Promise<void>;
  upsertStage(stage: ProcessingStage): Promise<void>;
  saveManualNote(note: ManualNoteRecord): Promise<void>;
  appendTranscriptSegments(revisionId: string, segments: readonly TranscriptSegmentRecord[]): Promise<void>;
  insertOutbox(operation: SyncOperationRecord): Promise<void>;
}

export interface MeetingNoteRepository {
  transaction<T>(work: (transaction: MeetingTransaction) => Promise<T>): Promise<T>;
  get(id: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  findByOccurrence(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}
