import type {
  MeetingEntryPoint,
  MeetingCaptureMode,
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
  legacySourceId: string | null;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint | null;
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: MeetingCaptureMode | null;
  clientRequestId: string | null;
  recordedAtMs: number | null;
  lifecycle: MeetingLifecycle;
  startedAtMs: number | null;
  endedAtMs: number | null;
  syncState: MeetingNote['syncState'];
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
  currentSummaryVersionId: string | null;
  activeTranscriptSegmentCount: number;
  currentSummaryReady: boolean;
  primaryRecording: RecordingAssetRecord | null;
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
  description?: string | null;
  participants?: readonly string[];
  location?: string | null;
  mode?: MeetingCaptureMode | null;
  clientRequestId?: string | null;
  recordedAtMs?: number | null;
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
  description?: string | null;
  participants?: readonly string[];
  location?: string | null;
  mode?: MeetingCaptureMode | null;
  clientRequestId?: string | null;
  recordedAtMs?: number | null;
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
  speakerLabelOverride: string | null;
  text: string;
  normalizedText: string;
  confidence: number | null;
  isFinal: boolean;
  createdAtMs: number;
}

export interface TranscriptRevisionProjection {
  revision: TranscriptRevisionRecord;
  segments: readonly TranscriptSegmentRecord[];
}

export interface TranscriptRevisionRecord {
  id: string;
  meetingId: string;
  kind: 'realtime_draft' | 'final' | 'reprocessed';
  status: 'realtime_draft' | 'finalizing' | 'ready' | 'failed' | 'archived';
  sourceProvider: string | null;
  sourceModel: string | null;
  isActive: boolean;
  createdAtMs: number;
  finalizedAtMs: number | null;
}

export interface SaveTranscriptRevisionOptions {
  activate: boolean;
  replaceSegments: boolean;
}

export interface SummaryVersionRecord {
  id: string;
  meetingId: string;
  templateId: string;
  templateRevision: number;
  inputFingerprint: string;
  transcriptRevisionId: string | null;
  manualNoteRevision: number;
  scheduleSnapshotHash: string | null;
  status: 'queued' | 'generating' | 'ready' | 'failed' | 'stale';
  generatedBy: string | null;
  userEdited: boolean;
  supersedesVersionId: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export interface SummarySectionRecord {
  id: string;
  versionId: string;
  stableKey: string;
  kind: string;
  title: string | null;
  generatedText: string;
  userText: string | null;
  ordinal: number;
  userEditedAtMs: number | null;
}

export interface ActionItemRecord {
  id: string;
  meetingId: string;
  remoteId: string | null;
  content: string;
  status: 'pending' | 'completed' | 'dismissed';
  assigneeText: string | null;
  dueAtMs: number | null;
  sourceKind: 'generated' | 'manual' | 'marker';
  sourceSummaryVersionId: string | null;
  sourceSegmentId: string | null;
  sourceStartMs: number | null;
  generationFingerprint: string | null;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SaveSummaryVersionOptions {
  activate: boolean;
}

export interface SummaryVersionProjection {
  version: SummaryVersionRecord;
  sections: readonly SummarySectionRecord[];
  meetingActions: readonly ActionItemRecord[];
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
  getTranscriptRevision(id: string, scopeKey: ScopeKey): Promise<TranscriptRevisionRecord | null>;
  getActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null>;
  getSummaryVersion(id: string, scopeKey: ScopeKey): Promise<SummaryVersionRecord | null>;
  getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null>;
  setActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
    revisionId: string | null,
  ): Promise<void>;
  insertMeeting(note: NewMeetingNote): Promise<void>;
  updateMeeting(id: string, scopeKey: ScopeKey, patch: MeetingRootPatch): Promise<void>;
  bindOccurrence(link: OccurrenceLinkRecord, snapshot: ScheduleSnapshot): Promise<void>;
  upsertStage(stage: ProcessingStage, scopeKey: ScopeKey): Promise<void>;
  saveManualNote(note: ManualNoteRecord, scopeKey: ScopeKey): Promise<void>;
  saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void>;
  saveTranscriptRevision(
    revision: TranscriptRevisionRecord,
    segments: readonly TranscriptSegmentRecord[],
    scopeKey: ScopeKey,
    options: SaveTranscriptRevisionOptions,
  ): Promise<void>;
  saveSummaryVersion(
    version: SummaryVersionRecord,
    sections: readonly SummarySectionRecord[],
    actions: readonly ActionItemRecord[],
    scopeKey: ScopeKey,
    options: SaveSummaryVersionOptions,
  ): Promise<void>;
  /** Returns true only when this transaction inserted a new operation. */
  insertOutbox(operation: SyncOperationRecord): Promise<boolean>;
}

export interface MeetingNoteRepository {
  transaction<T>(work: (transaction: MeetingTransaction) => Promise<T>): Promise<T>;
  get(id: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  findByOccurrence(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null>;
  findByNativeSessionId(sessionId: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  getActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null>;
  getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null>;
  getTranscriptRevisionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null>;
  getActiveTranscriptContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null>;
  getSummaryVersionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionProjection | null>;
  getCurrentSummaryContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionProjection | null>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}
