import type {
  MeetingEntryPoint,
  MeetingCaptureMode,
  MeetingLifecycle,
  MeetingNote,
  MeetingOrigin,
  MeetingSummaryActivationFenceV3,
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
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
  deletedFromLifecycle: Exclude<MeetingLifecycle, 'deleted'> | null;
  currentSummaryVersionId: string | null;
  activeTranscriptSegmentCount: number;
  currentSummaryReady: boolean;
  /** Bounded current-summary excerpt owned by the list projection. */
  currentSummaryPreview: string | null;
  primaryRecording: RecordingAssetRecord | null;
  stages: readonly ProcessingStage[];
}

export interface MeetingListProjection {
  items: readonly MeetingListProjectionItem[];
  hasMore: boolean;
}

export interface MeetingListOrderEntry {
  meetingId: string;
  position: number;
  updatedAtMs: number;
}

export interface NewMeetingNote {
  id: string;
  scopeKey: ScopeKey;
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

export function canonicalRecordingSourceSha256(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (/^[0-9a-f]{64}$/.test(normalized)) return `sha256:${normalized}`;
  if (/^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized;
  throw new Error('recording asset source hash is invalid');
}

export interface RecordingAssetRecord {
  id: string;
  meetingId: string;
  assetGeneration: string;
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
  sourceSha256: string | null;
  waveformJson: string | null;
  localState: RecordingAssetLocalState;
  uploadOperationId: string | null;
  remoteObjectRevision: number | null;
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
  lifecycle?: MeetingLifecycle;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  currentSummaryVersionId?: string | null;
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

export type MeetingRecordingMergeTaskStatus = 'pending' | 'failed' | 'completed';

export interface MeetingRecordingMergeTaskRecord {
  id: string;
  scopeKey: ScopeKey;
  detachedHistoryId: string;
  sourceMeetingId: string;
  sourceRecordingAssetId: string;
  targetMeetingId: string;
  targetRecordingAssetId: string;
  targetAssetGeneration: string;
  sourceAssetSnapshotJson: string;
  status: MeetingRecordingMergeTaskStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  retryable: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
}

export interface CompleteMeetingRecordingMergeTaskInput {
  taskId: string;
  targetMeetingId: string;
  scopeKey: ScopeKey;
  recordingAsset: RecordingAssetRecord;
  completedAtMs: number;
}

export interface FailMeetingRecordingMergeTaskInput {
  taskId: string;
  targetMeetingId: string;
  scopeKey: ScopeKey;
  errorCode: string;
  retryable: boolean;
  failedAtMs: number;
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
  /** Local RecordingAsset identity when this device can resolve the source. */
  sourceRecordingAssetId: string | null;
  /** Stable server RecordingAsset identity retained even before the asset exists locally. */
  sourceRecordingAssetRemoteId: string | null;
  /** Server job that produced this segment; immutable once known. */
  sourceTranscriptionJobId: string | null;
  /** Stable identity across partial, stable and final text events. */
  stableSegmentKey: string;
  /** Monotonic text revision for this stable segment identity. */
  segmentRevision: number;
  textState: 'partial' | 'stable' | 'final';
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
  sourceManifestSha256: string | null;
  isActive: boolean;
  createdAtMs: number;
  finalizedAtMs: number | null;
  textFinalAtMs: number | null;
}

export type SpeakerCorrectionScope = 'segment' | 'cluster' | 'future_profile';

export interface ApplySpeakerCorrectionInput {
  correctionId: string;
  assignmentIdPrefix: string;
  clusterRecordId: string | null;
  meetingId: string;
  transcriptRevisionId: string;
  targetSegmentId: string;
  sourceClusterId: string | null;
  scope: SpeakerCorrectionScope;
  displayName: string;
  speakerProfileId: string | null;
  consentToProfileUpdate: boolean;
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

/** Immutable Facts V3 payload linked to the summary version in the same transaction. */
export interface SummaryFactDocumentRecord {
  id: string;
  meetingId: string;
  summaryVersionId: string;
  sourceFingerprint: string;
  transcriptRevision: string;
  modelRevision: string;
  promptRevision: string;
  documentJson: string;
  coverageJson: string;
  generatedAtMs: number;
  createdAtMs: number;
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
  userRemovedAtMs: number | null;
}

export interface ActionItemRecord {
  id: string;
  meetingId: string;
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

export type MeetingAttachmentKind = 'text' | 'image';

export interface MeetingAttachmentRecord {
  id: string;
  meetingId: string;
  markerId: string | null;
  positionMs: number;
  kind: MeetingAttachmentKind;
  textContent: string | null;
  localUri: string | null;
  mimeType: string | null;
  fileName: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MeetingTagRecord {
  id: string;
  scopeKey: ScopeKey;
  name: string;
  normalizedName: string;
  meetingCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MeetingTagAssignment {
  meetingId: string;
  tagId: string;
  tagName: string;
}

export interface MeetingOrganizationMeeting {
  meetingId: string;
  navigationMeetingId: string;
  title: string;
  recordedAtMs: number;
  occurrenceCount: number;
}

export interface MeetingPersonAggregate {
  key: string;
  profileId: string | null;
  name: string;
  confirmed: boolean;
  meetingCount: number;
  occurrenceCount: number;
  meetings: readonly MeetingOrganizationMeeting[];
}

export interface MeetingTopicAggregate {
  key: string;
  source: 'user_tag' | 'summary';
  tagId: string | null;
  name: string;
  meetingCount: number;
  meetings: readonly MeetingOrganizationMeeting[];
}

export interface MeetingOrganizationProjection {
  people: readonly MeetingPersonAggregate[];
  topics: readonly MeetingTopicAggregate[];
}

export interface MeetingOrganizationOptions {
  includeSummaryTopics?: boolean;
}

export type MeetingSearchSourceKind =
  | 'title'
  | 'tag'
  | 'manual_note'
  | 'transcript'
  | 'summary'
  | 'action';

export interface MeetingSearchResult {
  resultId: string;
  meetingId: string;
  navigationMeetingId: string;
  sourceKind: MeetingSearchSourceKind;
  sourceId: string;
  startMs: number | null;
  meetingTitle: string;
  recordedAtMs: number;
  snippet: string;
  rank: number;
}

export interface RenameMeetingTagResult {
  tag: MeetingTagRecord;
  merged: boolean;
  affectedMeetingIds: readonly string[];
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
  factDocument?: SummaryFactDocumentRecord;
  activationFenceV3?: MeetingSummaryActivationFenceV3;
}

export class SummaryV3ActivationFenceError extends Error {
  constructor() {
    super('summary v3 activation fence changed');
    this.name = 'SummaryV3ActivationFenceError';
  }
}

export interface SummaryVersionProjection {
  version: SummaryVersionRecord;
  sections: readonly SummarySectionRecord[];
  citations: readonly SummaryCitationRecord[];
  meetingActions: readonly ActionItemRecord[];
}

export interface MeetingScopeRevisionState {
  scopeKey: ScopeKey;
  canonicalRevision: number;
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
  getStage(
    meetingId: string,
    scopeKey: ScopeKey,
    stage: ProcessingStage['stage'],
  ): Promise<ProcessingStage | null>;
  getPrimaryRecording(meetingId: string, scopeKey: ScopeKey): Promise<RecordingAssetRecord | null>;
  getRecordingAsset(
    meetingId: string,
    recordingAssetId: string,
    scopeKey: ScopeKey,
  ): Promise<RecordingAssetRecord | null>;
  getTranscriptRevision(id: string, scopeKey: ScopeKey): Promise<TranscriptRevisionRecord | null>;
  getTranscriptRevisionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null>;
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
  getSummarySection(
    sectionId: string,
    versionId: string,
    scopeKey: ScopeKey,
  ): Promise<SummarySectionRecord | null>;
  getSummarySectionCitations(
    sectionId: string,
    versionId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly SummaryCitationRecord[]>;
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
  /** Reverses only a proven false stale transition for the expected current version. */
  restoreCurrentSummaryReady(
    meetingId: string,
    scopeKey: ScopeKey,
    expectedVersionId: string,
  ): Promise<boolean>;
  saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void>;
  /** Enriches immutable Transcript segments without guessing when several assets are possible. */
  enrichTranscriptRecordingProvenance(
    meetingId: string,
    recordingAssetId: string,
    scopeKey: ScopeKey,
  ): Promise<number>;
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
  /** Reprojects the speaker stage from durable local corrections. */
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
  /** Updates only user-owned text and citation visibility in the current summary version. */
  updateCurrentSummarySectionUserState(
    meetingId: string,
    versionId: string,
    sectionId: string,
    scopeKey: ScopeKey,
    userText: string | null,
    userEditedAtMs: number | null,
    visibleCitationIds: readonly string[],
    citationRemovedAtMs: number | null,
  ): Promise<boolean>;
  /** Returns true only when this transaction inserted a new operation. */
  advanceCanonicalWrite(scopeKey: ScopeKey, updatedAtMs: number): Promise<number>;
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
  getTranscriptRevisionContentByRemoteId(
    meetingId: string,
    remoteRevisionId: string,
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
  listMeetingMarkers(meetingId: string, scopeKey: ScopeKey): Promise<readonly MarkerRecord[]>;
  listMeetingAttachments(meetingId: string, scopeKey: ScopeKey): Promise<readonly MeetingAttachmentRecord[]>;
  createMeetingAttachment(
    attachment: MeetingAttachmentRecord,
    scopeKey: ScopeKey,
  ): Promise<MeetingAttachmentRecord>;
  deleteMeetingAttachment(
    attachmentId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingAttachmentRecord | null>;
  listMeetingTags(meetingId: string, scopeKey: ScopeKey): Promise<readonly MeetingTagRecord[]>;
  resolveCanonicalMeetingId(navigationMeetingId: string, scopeKey: ScopeKey): Promise<string | null>;
  listMeetingTagAssignments(scopeKey: ScopeKey): Promise<readonly MeetingTagAssignment[]>;
  listMeetingTagsForScope(scopeKey: ScopeKey): Promise<readonly MeetingTagRecord[]>;
  listMeetingOrganization(
    scopeKey: ScopeKey,
    options?: MeetingOrganizationOptions,
  ): Promise<MeetingOrganizationProjection>;
  createMeetingTag(tag: Omit<MeetingTagRecord, 'meetingCount'>): Promise<MeetingTagRecord>;
  renameOrMergeMeetingTag(
    tagId: string,
    scopeKey: ScopeKey,
    name: string,
    normalizedName: string,
    updatedAtMs: number,
  ): Promise<RenameMeetingTagResult>;
  deleteMeetingTag(tagId: string, scopeKey: ScopeKey): Promise<readonly string[]>;
  replaceMeetingTags(
    meetingId: string,
    scopeKey: ScopeKey,
    tagIds: readonly string[],
    updatedAtMs: number,
  ): Promise<readonly MeetingTagRecord[]>;
  searchMeetingContent(
    scopeKey: ScopeKey,
    query: string,
    limit?: number,
  ): Promise<readonly MeetingSearchResult[]>;
  listSeriesCarryImports(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingSeriesCarryImportRecord[]>;
  getScopeRevisionState(scopeKey: ScopeKey): Promise<MeetingScopeRevisionState>;
  listMeetingRecordingMergeTasks(
    targetMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingRecordingMergeTaskRecord[]>;
  completeMeetingRecordingMergeTask(
    input: CompleteMeetingRecordingMergeTaskInput,
  ): Promise<boolean>;
  failMeetingRecordingMergeTask(input: FailMeetingRecordingMergeTaskInput): Promise<boolean>;
  setOccurrenceLinkState(input: SetOccurrenceLinkStateInput): Promise<number>;
  /** Physically removes one local-only guest tombstone after all owned files were deleted. */
  purgeDeletedGuestMeeting(
    meetingId: string,
    purgedAtMs: number,
    options?: { allowRecoverable?: boolean },
  ): Promise<boolean>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  listMeetingDisplayOrder(scopeKey: ScopeKey): Promise<readonly MeetingListOrderEntry[]>;
  replaceMeetingDisplayOrder(
    scopeKey: ScopeKey,
    orderedMeetingIds: readonly string[],
    updatedAtMs: number,
  ): Promise<boolean>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}
