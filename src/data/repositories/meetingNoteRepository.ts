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
  recordingAssets: readonly RecordingAssetRecord[];
}

export interface MeetingListQuery {
  limit: number;
  before?: {
    updatedAtMs: number;
    id: string;
  } | null;
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
  remoteId?: string | null;
  legacySourceId?: string | null;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint;
  title: string;
  lifecycle: MeetingLifecycle;
  startedAtMs: number | null;
  endedAtMs: number | null;
  syncState?: MeetingNote['syncState'];
  createdAtMs: number;
}

export type RecordingAssetOrigin = 'captured' | 'imported' | 'recovered';

export type RecordingAssetLocalState =
  | 'capturing'
  | 'ingesting'
  | 'local_ready'
  | 'remote_only'
  | 'missing';

export interface RecordingAssetRecord {
  id: string;
  meetingId: string;
  role: 'primary' | 'secondary';
  origin: RecordingAssetOrigin;
  nativeSessionId: string | null;
  localUri: string | null;
  remoteAssetId: string | null;
  mimeType: string | null;
  fileName: string | null;
  byteSize: number | null;
  durationMs: number | null;
  checksumSha256: string | null;
  waveformJson: string | null;
  localState: RecordingAssetLocalState;
  createdAtMs: number;
  updatedAtMs: number;
  lastVerifiedAtMs: number | null;
}

export interface MeetingRootPatch {
  title?: string;
  remoteId?: string | null;
  lifecycle?: MeetingLifecycle;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  currentSummaryVersionId?: string | null;
  remoteRevision?: number | null;
  syncState?: MeetingNote['syncState'];
  deletedAtMs?: number | null;
  updatedAtMs: number;
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
  getMeeting(id: string, scopeKey: ScopeKey): Promise<MeetingNote | null>;
  findMeetingByOccurrence(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null>;
  findMeetingByNativeSessionId(sessionId: string, scopeKey: ScopeKey): Promise<MeetingNote | null>;
  getStage(
    meetingId: string,
    scopeKey: ScopeKey,
    stage: ProcessingStage['stage'],
  ): Promise<ProcessingStage | null>;
  getPrimaryRecording(meetingId: string, scopeKey: ScopeKey): Promise<RecordingAssetRecord | null>;
  insertMeeting(note: NewMeetingNote): Promise<void>;
  updateMeeting(id: string, scopeKey: ScopeKey, patch: MeetingRootPatch): Promise<void>;
  bindOccurrence(link: OccurrenceLinkRecord, snapshot: ScheduleSnapshot): Promise<void>;
  upsertStage(stage: ProcessingStage, scopeKey: ScopeKey): Promise<void>;
  saveManualNote(note: ManualNoteRecord, scopeKey: ScopeKey): Promise<void>;
  saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void>;
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
  findByNativeSessionId(sessionId: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}
