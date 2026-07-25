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
  onlyDeleted?: boolean;
}

export interface MeetingListProjectionItem {
  id: string;
  remoteId: string | null;
  remoteRevision: number | null;
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
  deletedFromLifecycle: Exclude<MeetingLifecycle, 'deleted'> | null;
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
  remoteRevision?: number | null;
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
  deletedAtMs?: number | null;
  deletedFromLifecycle?: Exclude<MeetingLifecycle, 'deleted'> | null;
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
  origin?: MeetingOrigin;
  entryPoint?: MeetingEntryPoint | null;
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
  deletedFromLifecycle?: Exclude<MeetingLifecycle, 'deleted'> | null;
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

export type OccurrenceLinkSyncState = 'local_only' | 'pending' | 'synced' | 'failed' | 'conflicted';

export interface OccurrenceSyncClaim {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  operationId: string;
  idempotencyKey: string;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface ClaimOccurrenceSyncOptions {
  nowMs: number;
  staleBeforeMs: number;
  maxMeetings: number;
}

export interface OccurrenceSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface OccurrenceSyncConflict {
  remoteRevision: number | null;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface RemoteOccurrenceLinkRecord {
  remoteId: string;
  meetingRemoteId: string;
  revision: number;
  sourceEventId: string;
  occurrenceDate: string;
  calendarRevision: number | null;
  recurrenceSegmentId: string | null;
  seriesKey: string | null;
  linkState: 'active' | 'orphaned';
  clientUpdatedAtMs: number;
  scheduleSnapshot: ScheduleSnapshot;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface MergeOccurrenceRemoteInput {
  scopeKey: ScopeKey;
  remote: RemoteOccurrenceLinkRecord;
  pulledAtMs: number;
}

export interface MergeOccurrenceRemoteResult {
  outcome: 'attached' | 'updated' | 'unchanged' | 'conflicted' | 'meeting_unavailable' | 'ignored_stale';
  meetingId: string | null;
}

export interface MeetingOccurrenceSyncConflictRecord {
  id: string;
  meetingId: string;
  localRevision: number | null;
  remoteRevision: number | null;
  localPayloadJson: string;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface ResolveMeetingOccurrenceSyncConflictInput {
  conflictId: string;
  meetingId: string;
  targetMeetingId: string;
  detachedHistoryId: string;
  scopeKey: ScopeKey;
  expectedRemotePayloadJson: string;
  remote: RemoteOccurrenceLinkRecord;
  resolvedAtMs: number;
}

export interface SetOccurrenceLinkStateInput extends OccurrenceReference {
  scopeKey: ScopeKey;
  selection: 'occurrence' | 'following' | 'series';
  state: 'active' | 'orphaned';
  updatedAtMs: number;
}

export interface TranscriptSegmentRecord {
  id: string;
  meetingId: string;
  /** Provider/server segment identity used to resolve structured-summary citations. */
  sourceId: string | null;
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
  remoteId: string | null;
  kind: 'realtime_draft' | 'final' | 'reprocessed';
  status: 'realtime_draft' | 'finalizing' | 'ready' | 'failed' | 'archived';
  sourceProvider: string | null;
  sourceModel: string | null;
  isActive: boolean;
  createdAtMs: number;
  finalizedAtMs: number | null;
}

export type SpeakerCorrectionScope = 'segment' | 'cluster' | 'future_profile';
export type SpeakerCorrectionSyncState = 'local_only' | 'pending' | 'synced' | 'failed' | 'blocked';

export interface ApplySpeakerCorrectionInput {
  correctionId: string;
  assignmentIdPrefix: string;
  clusterRecordId: string | null;
  meetingId: string;
  transcriptRevisionId: string;
  targetSegmentId: string;
  sourceClusterId: string | null;
  scope: Exclude<SpeakerCorrectionScope, 'future_profile'>;
  displayName: string;
  speakerProfileId: string | null;
  consentToProfileUpdate: false;
  syncState: Extract<SpeakerCorrectionSyncState, 'local_only' | 'pending'>;
  createdAtMs: number;
}

export interface ApplySpeakerCorrectionResult {
  correctionId: string;
  assignmentRevision: number;
  affectedSegmentIds: readonly string[];
  applied: boolean;
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

export interface SummaryCitationRecord {
  id: string;
  sectionId: string;
  segmentId: string;
  sourceSegmentId: string | null;
  startMs: number;
  endMs: number;
  quoteHash: string | null;
  ordinal: number;
}

export interface ActionItemRecord {
  id: string;
  meetingId: string;
  remoteId: string | null;
  remoteRevision: number | null;
  content: string;
  status: 'pending' | 'completed' | 'dismissed';
  assigneeText: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  reminderNotificationId: string | null;
  followupEventSourceId: string | null;
  sourceKind: 'generated' | 'manual' | 'marker';
  /** Local provenance only. Marker deletion clears this link while retaining segment/time. */
  sourceMarkerId: string | null;
  sourceSummaryVersionId: string | null;
  sourceSegmentId: string | null;
  sourceSegmentSourceId?: string | null;
  sourceStartMs: number | null;
  generationFingerprint: string | null;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MarkerRecord {
  id: string;
  meetingId: string;
  positionMs: number;
  nearestSegmentId: string | null;
  label: string | null;
  kind: 'important';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MeetingActionMutableFields {
  content: string;
  status: ActionItemRecord['status'];
  assigneeText: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  reminderNotificationId: string | null;
  userEditedAtMs: number;
  completedAtMs: number | null;
  updatedAtMs: number;
}

export interface MeetingActionFollowupLinkFields {
  followupEventSourceId: string;
  userEditedAtMs: number;
  updatedAtMs: number;
}

export interface MeetingActionReminderRecord {
  action: ActionItemRecord;
  meetingTitle: string;
  legacyMeetingId: string;
}

export interface MeetingSeriesActionRecord {
  action: ActionItemRecord;
  canonicalMeetingId: string;
  legacyMeetingId: string;
  remoteMeetingId: string | null;
  meetingTitle: string;
  occurrenceDate: string;
}

export interface MeetingSeriesCarryImportRecord {
  targetMeetingId: string;
  sourceMeetingId: string;
  sourceKind: 'decision' | 'action';
  sourceItemId: string;
  sourceOccurrenceDate: string;
  sourceTitle: string;
  contentSnapshot: string;
  assigneeSnapshot: string | null;
  dueAtMs: number | null;
  sourceSegmentId: string | null;
  sourceStartMs: number | null;
  importedAtMs: number;
}

export interface SaveSummaryVersionOptions {
  activate: boolean;
  citations?: readonly SummaryCitationRecord[];
}

export interface SummaryVersionProjection {
  version: SummaryVersionRecord;
  sections: readonly SummarySectionRecord[];
  citations: readonly SummaryCitationRecord[];
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

export interface MeetingRootSyncClaim {
  scopeKey: ScopeKey;
  meetingId: string;
  remoteId: string | null;
  remoteRevision: number | null;
  operationId: string;
  operationType: string;
  idempotencyKey: string;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface MeetingRootSyncCompletion {
  remoteId: string;
  remoteRevision: number | null;
  occurrence: {
    remoteId: string;
    remoteRevision: number;
    sourceEventId: string;
    occurrenceDate: string;
  } | null;
}

export interface ClaimMeetingRootSyncOptions {
  nowMs: number;
  staleBeforeMs: number;
  maxMeetings: number;
}

export interface MeetingRootSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface MeetingRootSyncConflict {
  remoteRevision: number | null;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface MeetingRootSyncConflictRecord {
  id: string;
  meetingId: string;
  localRevision: number | null;
  remoteRevision: number | null;
  localPayloadJson: string;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface MeetingRootRemoteConflictFields {
  remoteId: string;
  clientNoteId: string;
  remoteRevision: number;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint | null;
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: MeetingCaptureMode;
  recordedAtMs: number | null;
  lifecycle: MeetingLifecycle;
  deletedFromLifecycle: Exclude<MeetingLifecycle, 'deleted'> | null;
  deletedAtMs: number | null;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface ResolveMeetingRootSyncConflictInput {
  conflictId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  expectedLocalUpdatedAtMs: number;
  resolution: 'keep_local' | 'use_remote';
  remoteId: string;
  remoteClientNoteId: string;
  remoteRevision: number;
  remoteFields: MeetingRootRemoteConflictFields | null;
  nextOperations: readonly SyncOperationRecord[];
  resolvedAtMs: number;
}

export interface MeetingRootPullState {
  scopeKey: ScopeKey;
  cursor: string | null;
  updatedAtMs: number;
}

export interface AdvanceMeetingRootPullCursorInput {
  scopeKey: ScopeKey;
  expectedCursor: string | null;
  nextCursor: string | null;
  pulledAtMs: number;
}

export interface ActionSyncClaim {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  actionId: string;
  operationIds: readonly string[];
  idempotencyKey: string;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface ClaimActionSyncOptions {
  nowMs: number;
  staleBeforeMs: number;
  maxMeetings: number;
}

export interface ActionSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface ActionSyncConflict {
  localRevision: number | null;
  remoteRevision: number | null;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface ManualNoteSyncClaim {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  operationIds: readonly string[];
  idempotencyKey: string;
  claimToken: string;
  requestPayloadJson: string;
  attemptCount: number;
}

export interface ClaimManualNoteSyncOptions {
  nowMs: number;
  staleBeforeMs: number;
  maxMeetings: number;
}

export interface ManualNoteSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface ManualNoteSyncConflict {
  remoteRevision: number | null;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface MeetingManualNoteSyncConflictRecord {
  id: string;
  meetingId: string;
  localRevision: number | null;
  remoteRevision: number | null;
  localPayloadJson: string;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface RemoteManualNoteRecord {
  exists: boolean;
  remoteId: string | null;
  revision: number;
  clientNoteRevision: number;
  clientUpdatedAtMs: number;
  userEditedAtMs: number | null;
  content: string;
  serverCreatedAtMs: number | null;
  serverUpdatedAtMs: number | null;
}

export interface MergeMeetingManualNoteRemoteInput {
  meetingId: string;
  remoteMeetingId: string;
  scopeKey: ScopeKey;
  remote: RemoteManualNoteRecord;
  pulledAtMs: number;
}

export interface MergeMeetingManualNoteRemoteResult {
  outcome: 'unchanged' | 'updated' | 'attached' | 'conflicted' | 'ignored_stale';
  previousLocalRevision: number;
  nextLocalRevision: number;
}

export interface ResolveMeetingManualNoteSyncConflictInput {
  conflictId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  expectedLocalRevision: number;
  resolution: 'keep_local' | 'use_remote';
  remote: RemoteManualNoteRecord;
  nextOperation: SyncOperationRecord | null;
  resolvedAtMs: number;
}

export interface MeetingActionSyncConflictRecord {
  id: string;
  meetingId: string;
  actionId: string;
  localRevision: number | null;
  remoteRevision: number | null;
  localPayloadJson: string;
  remotePayloadJson: string;
  createdAtMs: number;
}

export interface MeetingActionRemoteConflictFields {
  content: string;
  status: ActionItemRecord['status'];
  assigneeText: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  reminderNotificationId: null;
  followupEventSourceId: string | null;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  updatedAtMs: number;
}

export interface MeetingActionPullState {
  meetingId: string;
  scopeKey: ScopeKey;
  remoteMeetingId: string;
  cursor: string | null;
  updatedAtMs: number;
}

export interface RemoteMeetingActionRecord {
  remoteId: string;
  clientActionId: string;
  revision: number;
  clientCreatedAtMs: number;
  clientUpdatedAtMs: number;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  content: string;
  status: ActionItemRecord['status'];
  assigneeText: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  followupEventSourceId: string | null;
  sourceKind: ActionItemRecord['sourceKind'];
  sourceSummaryVersionId: string | null;
  /** Stable provider/server segment identity, never a local transcript_segments primary key. */
  sourceSegmentId: string | null;
  sourceStartMs: number | null;
  generationFingerprint: string | null;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface MergeMeetingActionPullPageInput {
  meetingId: string;
  remoteMeetingId: string;
  scopeKey: ScopeKey;
  expectedCursor: string | null;
  nextCursor: string | null;
  items: readonly RemoteMeetingActionRecord[];
  pulledAtMs: number;
}

export interface MergeMeetingActionPullPageResult {
  applied: boolean;
  inserted: number;
  updated: number;
  attached: number;
  conflicted: number;
  ignoredStale: number;
  cursorAdvanced: boolean;
}

export interface ResolveMeetingActionSyncConflictInput {
  conflictId: string;
  meetingId: string;
  actionId: string;
  scopeKey: ScopeKey;
  expectedUpdatedAtMs: number;
  resolution: 'keep_local' | 'use_remote';
  remoteId: string | null;
  remoteRevision: number | null;
  remoteFields: MeetingActionRemoteConflictFields | null;
  nextOperation: SyncOperationRecord | null;
  resolvedAtMs: number;
}

export interface SpeakerCorrectionSyncClaim {
  scopeKey: ScopeKey;
  meetingId: string;
  meetingRemoteId: string;
  correctionId: string;
  operationId: string;
  idempotencyKey: string;
  claimToken: string;
  requestPayloadJson: string;
  baseRevision: number;
  attemptCount: number;
}

export interface ClaimSpeakerCorrectionSyncOptions {
  nowMs: number;
  staleBeforeMs: number;
  maxMeetings: number;
}

export interface SpeakerCorrectionSyncFailure {
  disposition: 'retry' | 'blocked' | 'permanent_error';
  errorCode: string;
  nextAttemptAtMs: number | null;
  updatedAtMs: number;
}

export interface SpeakerCorrectionSyncConflict {
  remoteRevision: number | null;
  remotePayloadJson: string;
  createdAtMs: number;
}

export type LegacyMirrorStatus = 'clean' | 'pending' | 'failed';

export interface MeetingScopeWriteState {
  scopeKey: ScopeKey;
  writeOwner: 'legacy' | 'canonical';
  canonicalRevision: number;
  legacyMirrorRevision: number;
  legacyMirrorStatus: LegacyMirrorStatus;
  lastErrorCode: string | null;
  updatedAtMs: number;
}

export interface MeetingTransaction {
  getMeeting(id: string, scopeKey: ScopeKey): Promise<MeetingNote | null>;
  getManualNote(meetingId: string, scopeKey: ScopeKey): Promise<ManualNoteRecord | null>;
  findMeetingByOccurrence(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null>;
  findMeetingByNativeSessionId(sessionId: string, scopeKey: ScopeKey): Promise<MeetingNote | null>;
  findMeetingByRemoteIdentity(
    remoteId: string,
    clientNoteId: string | null,
    clientRequestId: string | null,
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null>;
  hasOutstandingMeetingRootSync(meetingId: string, scopeKey: ScopeKey): Promise<boolean>;
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
  getActiveTranscriptContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null>;
  getSummaryVersion(id: string, scopeKey: ScopeKey): Promise<SummaryVersionRecord | null>;
  getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null>;
  getMeetingAction(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<ActionItemRecord | null>;
  getMeetingMarker(
    markerId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MarkerRecord | null>;
  listMeetingMarkers(meetingId: string, scopeKey: ScopeKey): Promise<readonly MarkerRecord[]>;
  insertMeetingMarker(marker: MarkerRecord, scopeKey: ScopeKey): Promise<boolean>;
  deleteMeetingMarker(markerId: string, meetingId: string, scopeKey: ScopeKey): Promise<boolean>;
  /** Rebinds markers only to active Transcript segments whose time range covers the marker. */
  reconcileMeetingMarkers(meetingId: string, scopeKey: ScopeKey, updatedAtMs: number): Promise<number>;
  /** Inserts a user-created action without routing it through immutable summary generation. */
  insertMeetingAction(action: ActionItemRecord, scopeKey: ScopeKey): Promise<boolean>;
  /** Inserts one immutable series-memory import; an existing source identity is an idempotent no-op. */
  insertSeriesCarryImport(
    record: MeetingSeriesCarryImportRecord,
    scopeKey: ScopeKey,
  ): Promise<boolean>;
  /** True when switching away from this version could hide a user edit or explicit action state. */
  hasUserProtectedSummaryState(versionId: string, scopeKey: ScopeKey): Promise<boolean>;
  /** Compare-and-set mutable fields; generated identity and source provenance stay immutable. */
  updateMeetingAction(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedUpdatedAtMs: number,
    fields: MeetingActionMutableFields,
  ): Promise<boolean>;
  /** Compare-and-set a one-way follow-up event link; existing different links are never overwritten. */
  linkMeetingActionFollowupEvent(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedUpdatedAtMs: number,
    fields: MeetingActionFollowupLinkFields,
  ): Promise<boolean>;
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
  /** Keeps the readable version active while marking its inputs outdated. */
  markCurrentSummaryStale(meetingId: string, scopeKey: ScopeKey): Promise<boolean>;
  saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void>;
  saveTranscriptRevision(
    revision: TranscriptRevisionRecord,
    segments: readonly TranscriptSegmentRecord[],
    scopeKey: ScopeKey,
    options: SaveTranscriptRevisionOptions,
  ): Promise<void>;
  /** Adds a user-locked assignment layer without rewriting provider speaker fields. */
  applySpeakerCorrection(
    input: ApplySpeakerCorrectionInput,
    scopeKey: ScopeKey,
  ): Promise<ApplySpeakerCorrectionResult>;
  /** Reprojects the speaker stage from durable corrections and their outbox rows. */
  reconcileSpeakerProcessingStage(
    meetingId: string,
    scopeKey: ScopeKey,
    updatedAtMs: number,
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
  advanceCanonicalWrite(scopeKey: ScopeKey, updatedAtMs: number): Promise<number>;
  markLegacyMirror(
    scopeKey: ScopeKey,
    canonicalRevision: number,
    status: 'clean' | 'failed',
    errorCode: string | null,
    updatedAtMs: number,
  ): Promise<boolean>;
}

export interface MeetingNoteRepository {
  transaction<T>(work: (transaction: MeetingTransaction) => Promise<T>): Promise<T>;
  get(id: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  findByOccurrence(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null>;
  findPreviousEndedSeriesMeeting(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null>;
  listPendingSeriesActions(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
    limit: number,
  ): Promise<readonly MeetingSeriesActionRecord[]>;
  findByNativeSessionId(sessionId: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  getActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null>;
  getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null>;
  listReadableSummaryVersions(
    meetingId: string,
    scopeKey: ScopeKey,
    limit?: number,
  ): Promise<readonly SummaryVersionRecord[]>;
  listMeetingActionReminders(scopeKey: ScopeKey): Promise<readonly MeetingActionReminderRecord[]>;
  setMeetingActionReminderNotificationId(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedReminderAtMs: number | null,
    notificationId: string | null,
  ): Promise<boolean>;
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
  listMeetingActions(meetingId: string, scopeKey: ScopeKey): Promise<readonly ActionItemRecord[]>;
  listMeetingActionSyncConflicts(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingActionSyncConflictRecord[]>;
  getMeetingActionPullState(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingActionPullState | null>;
  mergeMeetingActionPullPage(
    input: MergeMeetingActionPullPageInput,
  ): Promise<MergeMeetingActionPullPageResult>;
  resolveMeetingActionSyncConflict(
    input: ResolveMeetingActionSyncConflictInput,
  ): Promise<boolean>;
  listMeetingMarkers(meetingId: string, scopeKey: ScopeKey): Promise<readonly MarkerRecord[]>;
  listSeriesCarryImports(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingSeriesCarryImportRecord[]>;
  getScopeWriteState(scopeKey: ScopeKey): Promise<MeetingScopeWriteState>;
  getMeetingRootPullState(scopeKey: ScopeKey): Promise<MeetingRootPullState | null>;
  advanceMeetingRootPullCursor(input: AdvanceMeetingRootPullCursorInput): Promise<boolean>;
  claimMeetingRootSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimMeetingRootSyncOptions,
  ): Promise<readonly MeetingRootSyncClaim[]>;
  getNextMeetingRootSyncAttemptAt(
    scopeKey: ScopeKey,
    staleClaimAfterMs: number,
  ): Promise<number | null>;
  completeMeetingRootSyncClaim(
    claim: MeetingRootSyncClaim,
    completion: MeetingRootSyncCompletion,
    completedAtMs: number,
  ): Promise<boolean>;
  failMeetingRootSyncClaim(
    claim: MeetingRootSyncClaim,
    failure: MeetingRootSyncFailure,
  ): Promise<boolean>;
  recordMeetingRootSyncConflict(
    claim: MeetingRootSyncClaim,
    conflict: MeetingRootSyncConflict,
  ): Promise<boolean>;
  getMeetingRootSyncConflict(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingRootSyncConflictRecord | null>;
  resolveMeetingRootSyncConflict(input: ResolveMeetingRootSyncConflictInput): Promise<boolean>;
  ensureOccurrenceSyncOperations(scopeKey: ScopeKey, createdAtMs: number): Promise<number>;
  claimOccurrenceSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimOccurrenceSyncOptions,
  ): Promise<readonly OccurrenceSyncClaim[]>;
  getNextOccurrenceSyncAttemptAt(
    scopeKey: ScopeKey,
    staleClaimAfterMs: number,
  ): Promise<number | null>;
  completeOccurrenceSyncClaim(
    claim: OccurrenceSyncClaim,
    remoteId: string,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean>;
  failOccurrenceSyncClaim(
    claim: OccurrenceSyncClaim,
    failure: OccurrenceSyncFailure,
  ): Promise<boolean>;
  recordOccurrenceSyncConflict(
    claim: OccurrenceSyncClaim,
    conflict: OccurrenceSyncConflict,
  ): Promise<boolean>;
  hasOccurrenceSyncConflict(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<boolean>;
  getOccurrenceSyncConflict(
    reference: OccurrenceReference,
    scopeKey: ScopeKey,
  ): Promise<MeetingOccurrenceSyncConflictRecord | null>;
  resolveMeetingOccurrenceSyncConflict(
    input: ResolveMeetingOccurrenceSyncConflictInput,
  ): Promise<boolean>;
  mergeOccurrenceRemote(input: MergeOccurrenceRemoteInput): Promise<MergeOccurrenceRemoteResult>;
  setOccurrenceLinkState(input: SetOccurrenceLinkStateInput): Promise<number>;
  claimActionSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimActionSyncOptions,
  ): Promise<readonly ActionSyncClaim[]>;
  getNextActionSyncAttemptAt(
    scopeKey: ScopeKey,
    staleClaimAfterMs: number,
  ): Promise<number | null>;
  completeActionSyncClaim(
    claim: ActionSyncClaim,
    remoteId: string,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean>;
  failActionSyncClaim(claim: ActionSyncClaim, failure: ActionSyncFailure): Promise<boolean>;
  recordActionSyncConflict(
    claim: ActionSyncClaim,
    conflict: ActionSyncConflict,
  ): Promise<boolean>;
  ensureManualNoteSyncOperations(scopeKey: ScopeKey, createdAtMs: number): Promise<number>;
  claimManualNoteSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimManualNoteSyncOptions,
  ): Promise<readonly ManualNoteSyncClaim[]>;
  getNextManualNoteSyncAttemptAt(
    scopeKey: ScopeKey,
    staleClaimAfterMs: number,
  ): Promise<number | null>;
  completeManualNoteSyncClaim(
    claim: ManualNoteSyncClaim,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean>;
  failManualNoteSyncClaim(
    claim: ManualNoteSyncClaim,
    failure: ManualNoteSyncFailure,
  ): Promise<boolean>;
  recordManualNoteSyncConflict(
    claim: ManualNoteSyncClaim,
    conflict: ManualNoteSyncConflict,
  ): Promise<boolean>;
  getMeetingManualNoteSyncConflict(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingManualNoteSyncConflictRecord | null>;
  mergeMeetingManualNoteRemote(
    input: MergeMeetingManualNoteRemoteInput,
  ): Promise<MergeMeetingManualNoteRemoteResult>;
  resolveMeetingManualNoteSyncConflict(
    input: ResolveMeetingManualNoteSyncConflictInput,
  ): Promise<boolean>;
  claimSpeakerCorrectionSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimSpeakerCorrectionSyncOptions,
  ): Promise<readonly SpeakerCorrectionSyncClaim[]>;
  /** Restores retry/stale-claim wakeups after the provider process restarts. */
  getNextSpeakerCorrectionSyncAttemptAt(
    scopeKey: ScopeKey,
    staleClaimAfterMs: number,
  ): Promise<number | null>;
  completeSpeakerCorrectionSyncClaim(
    claim: SpeakerCorrectionSyncClaim,
    remoteAssignmentRevision: number,
    completedAtMs: number,
  ): Promise<boolean>;
  failSpeakerCorrectionSyncClaim(
    claim: SpeakerCorrectionSyncClaim,
    failure: SpeakerCorrectionSyncFailure,
  ): Promise<boolean>;
  recordSpeakerCorrectionSyncConflict(
    claim: SpeakerCorrectionSyncClaim,
    conflict: SpeakerCorrectionSyncConflict,
  ): Promise<boolean>;
  /** Makes only retryable speaker corrections for one meeting immediately claimable. */
  retrySpeakerCorrectionSyncOperations(
    meetingId: string,
    scopeKey: ScopeKey,
    requestedAtMs: number,
  ): Promise<boolean>;
  /** Converts claimable queued corrections into durable retry state after capability transport fails. */
  deferSpeakerCorrectionSyncForCapabilityFailure(
    scopeKey: ScopeKey,
    nextAttemptAtMs: number,
    updatedAtMs: number,
  ): Promise<number>;
  /** Keeps local corrections readable when a fresh server contract explicitly disables sync. */
  projectSpeakerCorrectionSyncDisabled(scopeKey: ScopeKey, updatedAtMs: number): Promise<number>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}
