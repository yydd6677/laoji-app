import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  MeetingNote,
  ProcessingStage,
  ScheduleSnapshot,
  ScopeKey,
} from '../../domain/meeting';
import {
  assertProcessingStage,
  assertScopeKey,
  calendarMeetingSeriesKey,
  secureClientIdFactory,
} from '../../domain/meeting';
import { withMeetingDatabaseTransaction, openMeetingDatabase } from '../db/openDatabase';
import type {
  ActionItemRecord,
  ActionSyncClaim,
  ActionSyncConflict,
  ActionSyncFailure,
  ApplySpeakerCorrectionInput,
  ApplySpeakerCorrectionResult,
  ClaimActionSyncOptions,
  ClaimManualNoteSyncOptions,
  ClaimMeetingRootSyncOptions,
  ClaimOccurrenceSyncOptions,
  ClaimSpeakerCorrectionSyncOptions,
  ManualNoteRecord,
  ManualNoteSyncClaim,
  ManualNoteSyncConflict,
  ManualNoteSyncFailure,
  MarkerRecord,
  MeetingActionMutableFields,
  MeetingActionFollowupLinkFields,
  MeetingActionReminderRecord,
  MeetingActionPullState,
  MergeMeetingActionPullPageInput,
  MergeMeetingActionPullPageResult,
  MergeMeetingManualNoteRemoteInput,
  MergeMeetingManualNoteRemoteResult,
  MergeOccurrenceRemoteInput,
  MergeOccurrenceRemoteResult,
  MeetingActionSyncConflictRecord,
  MeetingManualNoteSyncConflictRecord,
  MeetingListProjection,
  MeetingListProjectionItem,
  MeetingListQuery,
  MeetingNoteAggregate,
  MeetingNoteRepository,
  MeetingRootSyncClaim,
  MeetingRootSyncConflict,
  MeetingRootSyncFailure,
  MeetingRootPatch,
  MeetingScopeWriteState,
  MeetingSeriesActionRecord,
  MeetingSeriesCarryImportRecord,
  MeetingTransaction,
  NewMeetingNote,
  OccurrenceLinkRecord,
  OccurrenceSyncClaim,
  OccurrenceSyncConflict,
  OccurrenceSyncFailure,
  RecordingAssetRecord,
  ResolveMeetingActionSyncConflictInput,
  ResolveMeetingManualNoteSyncConflictInput,
  RemoteMeetingActionRecord,
  RemoteOccurrenceLinkRecord,
  SaveSummaryVersionOptions,
  SetOccurrenceLinkStateInput,
  SaveTranscriptRevisionOptions,
  SpeakerCorrectionSyncClaim,
  SpeakerCorrectionSyncConflict,
  SpeakerCorrectionSyncFailure,
  SummaryCitationRecord,
  SummarySectionRecord,
  SummaryVersionRecord,
  SummaryVersionProjection,
  SyncOperationRecord,
  TranscriptRevisionProjection,
  TranscriptRevisionRecord,
  TranscriptSegmentRecord,
  Unsubscribe,
} from './meetingNoteRepository';

type MeetingRow = {
  id: string;
  scope_key: string;
  remote_id: string | null;
  legacy_source_id: string | null;
  origin: MeetingNote['origin'];
  entry_point: MeetingNote['entryPoint'];
  title: string;
  description: string | null;
  participants_json: string;
  location: string | null;
  mode: MeetingNote['mode'];
  client_request_id: string | null;
  recorded_at_ms: number | null;
  lifecycle: MeetingNote['lifecycle'];
  started_at_ms: number | null;
  ended_at_ms: number | null;
  current_summary_version_id: string | null;
  remote_revision: number | null;
  sync_state: MeetingNote['syncState'];
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  active_transcript_segment_count?: number;
  current_summary_ready?: number;
};

type RecordingAssetRow = {
  id: string;
  meeting_id: string;
  role: 'primary' | 'secondary';
  origin: RecordingAssetRecord['origin'];
  native_session_id: string | null;
  local_uri: string | null;
  remote_asset_id: string | null;
  mime_type: string | null;
  file_name: string | null;
  byte_size: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  waveform_json: string | null;
  local_state: RecordingAssetRecord['localState'];
  created_at_ms: number;
  updated_at_ms: number;
  last_verified_at_ms: number | null;
};

type ManualNoteRow = {
  meeting_id: string;
  content: string;
  revision: number;
  base_remote_revision: number | null;
  dirty: number;
  last_saved_at_ms: number;
  user_edited_at_ms: number | null;
};

type StageRow = {
  meeting_id: string;
  stage: ProcessingStage['stage'];
  status: string;
  attempt_count: number;
  progress: number | null;
  job_id: string | null;
  input_fingerprint: string | null;
  error_code: string | null;
  user_message_key: string | null;
  retryable: number;
  next_retry_at_ms: number | null;
  updated_at_ms: number;
};

type SyncOutboxRow = {
  operation_id: string;
  scope_key: string;
  aggregate_type: string;
  aggregate_id: string;
  operation_type: string;
  base_revision: number | null;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at_ms: number | null;
  last_error_code: string | null;
  request_payload_json: string | null;
  claim_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type ActionSyncOutboxRow = SyncOutboxRow & {
  meeting_id: string;
  meeting_remote_id: string;
  action_remote_id: string | null;
  action_remote_revision: number | null;
  action_content: string;
  action_status: ActionItemRecord['status'];
  action_assignee_text: string | null;
  action_due_at_ms: number | null;
  action_reminder_at_ms: number | null;
  action_followup_event_source_id: string | null;
  action_source_kind: ActionItemRecord['sourceKind'];
  action_source_summary_version_id: string | null;
  action_source_segment_id: string | null;
  action_source_segment_source_id: string | null;
  action_source_start_ms: number | null;
  action_generation_fingerprint: string | null;
  action_user_edited_at_ms: number | null;
  action_completed_at_ms: number | null;
  action_created_at_ms: number;
  action_updated_at_ms: number;
};

type ManualNoteSyncOutboxRow = SyncOutboxRow & {
  meeting_id: string;
  meeting_remote_id: string;
  note_content: string;
  note_revision: number;
  note_base_remote_revision: number | null;
  note_dirty: number;
  note_last_saved_at_ms: number;
  note_user_edited_at_ms: number | null;
};

type OccurrenceSyncOutboxRow = SyncOutboxRow & {
  meeting_id: string;
  meeting_remote_id: string;
  occurrence_remote_id: string | null;
  occurrence_remote_revision: number | null;
  calendar_source_event_id: string;
  occurrence_date: string;
  calendar_revision: number | null;
  recurrence_segment_id: string | null;
  series_key: string | null;
  link_state: 'active' | 'orphaned';
  client_updated_at_ms: number;
  event_title: string;
  planned_start_ms: number | null;
  planned_end_ms: number | null;
  all_day: number;
  timezone_id: string | null;
  occurrence_location: string | null;
  occurrence_participants_json: string;
  occurrence_description: string | null;
  captured_event_revision: number | null;
  captured_at_ms: number;
};

type MeetingRootSyncOutboxRow = SyncOutboxRow & {
  meeting_remote_id: string | null;
  transport_order: number;
};

type SpeakerCorrectionSyncOutboxRow = SyncOutboxRow & {
  meeting_id: string;
  meeting_remote_id: string;
  transcript_remote_id: string;
  assignment_revision: number;
};

type MeetingScopeWriteStateRow = {
  scope_key: string;
  write_owner: MeetingScopeWriteState['writeOwner'];
  canonical_revision: number;
  legacy_mirror_revision: number;
  legacy_mirror_status: MeetingScopeWriteState['legacyMirrorStatus'];
  last_error_code: string | null;
  updated_at_ms: number;
};

type TranscriptRevisionRow = {
  id: string;
  meeting_id: string;
  remote_id: string | null;
  kind: TranscriptRevisionRecord['kind'];
  status: TranscriptRevisionRecord['status'];
  source_provider: string | null;
  source_model: string | null;
  is_active: number;
  created_at_ms: number;
  finalized_at_ms: number | null;
};

type TranscriptSegmentRow = {
  id: string;
  revision_id: string;
  meeting_id: string;
  source_segment_id: string | null;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  speaker_cluster_id: string | null;
  speaker_profile_id: string | null;
  speaker_label: string | null;
  speaker_label_override: string | null;
  text: string;
  normalized_text: string;
  confidence: number | null;
  is_final: number;
  created_at_ms: number;
};

type SpeakerCorrectionRow = {
  id: string;
  scope_key: string;
  meeting_id: string;
  transcript_revision_id: string;
  scope: string;
  target_segment_id: string;
  source_cluster_id: string | null;
  speaker_profile_id: string | null;
  display_name: string;
  consent_to_profile_update: number;
  base_revision: number;
  assignment_revision: number;
  sync_state: string;
  created_at_ms: number;
  updated_at_ms: number;
  remote_assignment_revision: number | null;
  last_sync_error_code: string | null;
  synced_at_ms: number | null;
};

type MarkerRow = {
  id: string;
  meeting_id: string;
  position_ms: number;
  nearest_segment_id: string | null;
  label: string | null;
  kind: MarkerRecord['kind'];
  created_at_ms: number;
  updated_at_ms: number;
};

type SummaryVersionRow = {
  id: string;
  meeting_id: string;
  template_id: string;
  template_revision: number;
  input_fingerprint: string;
  transcript_revision_id: string | null;
  manual_note_revision: number;
  schedule_snapshot_hash: string | null;
  status: SummaryVersionRecord['status'];
  generated_by: string | null;
  user_edited: number;
  supersedes_version_id: string | null;
  created_at_ms: number;
  completed_at_ms: number | null;
  effective_user_edited?: number;
};

type SummarySectionRow = {
  id: string;
  version_id: string;
  stable_key: string;
  kind: string;
  title: string | null;
  generated_text: string;
  user_text: string | null;
  ordinal: number;
  user_edited_at_ms: number | null;
};

type SummaryCitationRow = {
  id: string;
  section_id: string;
  segment_id: string;
  source_segment_id?: string | null;
  start_ms: number;
  end_ms: number;
  quote_hash: string | null;
  ordinal: number;
};

type ActionItemRow = {
  id: string;
  meeting_id: string;
  remote_id: string | null;
  remote_revision: number | null;
  content: string;
  status: ActionItemRecord['status'];
  assignee_text: string | null;
  due_at_ms: number | null;
  reminder_at_ms: number | null;
  reminder_notification_id: string | null;
  followup_event_source_id: string | null;
  source_kind: ActionItemRecord['sourceKind'];
  source_marker_id: string | null;
  source_summary_version_id: string | null;
  source_segment_id: string | null;
  source_segment_source_id?: string | null;
  source_start_ms: number | null;
  generation_fingerprint: string | null;
  user_edited_at_ms: number | null;
  completed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type MeetingActionReminderRow = ActionItemRow & {
  meeting_title: string;
  legacy_meeting_id: string;
};

type MeetingSeriesActionRow = ActionItemRow & {
  canonical_meeting_id: string;
  legacy_meeting_id: string;
  meeting_remote_id: string | null;
  meeting_title: string;
  occurrence_date: string;
};

type MeetingSeriesCarryImportRow = {
  target_meeting_id: string;
  source_meeting_id: string;
  source_kind: MeetingSeriesCarryImportRecord['sourceKind'];
  source_item_id: string;
  source_occurrence_date: string;
  source_title: string;
  content_snapshot: string;
  assignee_snapshot: string | null;
  due_at_ms: number | null;
  source_segment_id: string | null;
  source_start_ms: number | null;
  imported_at_ms: number;
};

type MeetingActionSyncConflictRow = {
  id: string;
  meeting_id: string;
  aggregate_id: string;
  local_revision: number | null;
  remote_revision: number | null;
  local_payload_json: string;
  remote_payload_json: string;
  created_at_ms: number;
};

type MeetingManualNoteSyncConflictRow = {
  id: string;
  meeting_id: string;
  local_revision: number | null;
  remote_revision: number | null;
  local_payload_json: string;
  remote_payload_json: string;
  created_at_ms: number;
};

type MeetingActionPullStateRow = {
  meeting_id: string;
  scope_key: string;
  remote_meeting_id: string;
  cursor: string | null;
  updated_at_ms: number;
};

type OccurrenceRow = {
  calendar_source_event_id: string;
  occurrence_date: string;
};

type OccurrenceLinkRow = OccurrenceRow & {
  meeting_id: string;
  scope_key: string;
  remote_id: string | null;
  remote_revision: number | null;
  calendar_revision: number | null;
  recurrence_segment_id: string | null;
  series_key: string | null;
  link_state: 'active' | 'orphaned';
  linked_at_ms: number;
  client_updated_at_ms: number;
  sync_state: string;
  last_sync_error_code: string | null;
  synced_at_ms: number | null;
};

type ScheduleSnapshotRow = {
  event_title: string;
  planned_start_ms: number | null;
  planned_end_ms: number | null;
  all_day: number;
  timezone_id: string | null;
  location: string | null;
  participants_json: string;
  description: string | null;
  captured_event_revision: number | null;
  captured_at_ms: number;
};

const RECORDING_LOCAL_STATES = new Set<RecordingAssetRecord['localState']>([
  'capturing',
  'ingesting',
  'local_ready',
  'remote_only',
  'missing',
]);
const MEETING_CAPTURE_MODES = new Set<NonNullable<MeetingNote['mode']>>([
  'realtime', 'offline', 'whisper', 'qwen',
]);
const TRANSCRIPT_REVISION_KINDS = new Set<TranscriptRevisionRecord['kind']>([
  'realtime_draft', 'final', 'reprocessed',
]);
const TRANSCRIPT_REVISION_STATUSES = new Set<TranscriptRevisionRecord['status']>([
  'realtime_draft', 'finalizing', 'ready', 'failed', 'archived',
]);
const SUMMARY_VERSION_STATUSES = new Set<SummaryVersionRecord['status']>([
  'queued', 'generating', 'ready', 'failed', 'stale',
]);
const SUMMARY_EFFECTIVE_USER_EDITED_SQL = `CASE WHEN
  version.user_edited = 1
  OR EXISTS (
    SELECT 1 FROM summary_sections ownership_section
    WHERE ownership_section.version_id = version.id
      AND (ownership_section.user_text IS NOT NULL OR ownership_section.user_edited_at_ms IS NOT NULL)
  )
  OR EXISTS (
    SELECT 1 FROM action_items ownership_action
    WHERE ownership_action.source_summary_version_id = version.id
      AND (ownership_action.user_edited_at_ms IS NOT NULL OR ownership_action.status <> 'pending')
  )
  THEN 1 ELSE 0 END AS effective_user_edited`;

function noteFromRow(row: MeetingRow): MeetingNote {
  assertScopeKey(row.scope_key);
  if (row.mode !== null && !MEETING_CAPTURE_MODES.has(row.mode)) {
    throw new Error('stored meeting mode is invalid');
  }
  return {
    id: row.id,
    scopeKey: row.scope_key,
    remoteId: row.remote_id,
    legacySourceId: row.legacy_source_id,
    origin: row.origin,
    entryPoint: row.entry_point,
    title: row.title,
    description: row.description,
    participants: participantsFromJson(row.participants_json),
    location: row.location,
    mode: row.mode,
    clientRequestId: row.client_request_id,
    recordedAtMs: row.recorded_at_ms,
    lifecycle: row.lifecycle,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    currentSummaryVersionId: row.current_summary_version_id,
    remoteRevision: row.remote_revision,
    syncState: row.sync_state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    deletedAtMs: row.deleted_at_ms,
  };
}

function scopeWriteStateFromRow(row: MeetingScopeWriteStateRow): MeetingScopeWriteState {
  assertScopeKey(row.scope_key);
  if (
    !['legacy', 'canonical'].includes(row.write_owner)
    || !['clean', 'pending', 'failed'].includes(row.legacy_mirror_status)
    || !Number.isSafeInteger(row.canonical_revision)
    || row.canonical_revision < 0
    || !Number.isSafeInteger(row.legacy_mirror_revision)
    || row.legacy_mirror_revision < 0
    || row.legacy_mirror_revision > row.canonical_revision
    || !Number.isSafeInteger(row.updated_at_ms)
    || row.updated_at_ms < 0
  ) throw new Error('stored meeting scope write state is invalid');
  if (
    row.write_owner === 'legacy'
    && (
      row.canonical_revision !== 0
      || row.legacy_mirror_revision !== 0
      || row.legacy_mirror_status !== 'clean'
    )
  ) throw new Error('legacy meeting scope has canonical write state');
  if (row.write_owner === 'canonical' && row.canonical_revision < 1) {
    throw new Error('canonical meeting scope has no write revision');
  }
  return {
    scopeKey: row.scope_key,
    writeOwner: row.write_owner,
    canonicalRevision: row.canonical_revision,
    legacyMirrorRevision: row.legacy_mirror_revision,
    legacyMirrorStatus: row.legacy_mirror_status,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  };
}

function manualNoteFromRow(row: ManualNoteRow): ManualNoteRecord {
  return {
    meetingId: row.meeting_id,
    content: row.content,
    revision: row.revision,
    baseRemoteRevision: row.base_remote_revision,
    dirty: row.dirty === 1,
    lastSavedAtMs: row.last_saved_at_ms,
    userEditedAtMs: row.user_edited_at_ms,
  };
}

function stageFromRow(row: StageRow): ProcessingStage {
  const stage: ProcessingStage = {
    meetingId: row.meeting_id,
    stage: row.stage,
    status: row.status,
    attemptCount: row.attempt_count,
    progress: row.progress,
    jobId: row.job_id,
    inputFingerprint: row.input_fingerprint,
    errorCode: row.error_code,
    userMessageKey: row.user_message_key,
    retryable: row.retryable === 1,
    nextRetryAtMs: row.next_retry_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
  assertProcessingStage(stage);
  return stage;
}

function recordingAssetFromRow(row: RecordingAssetRow): RecordingAssetRecord {
  if (
    (row.role !== 'primary' && row.role !== 'secondary') ||
    !RECORDING_LOCAL_STATES.has(row.local_state)
  ) {
    throw new Error('recording asset is invalid');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    role: row.role,
    origin: row.origin,
    nativeSessionId: row.native_session_id,
    localUri: row.local_uri,
    remoteAssetId: row.remote_asset_id,
    mimeType: row.mime_type,
    fileName: row.file_name,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    checksumSha256: row.checksum_sha256,
    waveformJson: row.waveform_json,
    localState: row.local_state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    lastVerifiedAtMs: row.last_verified_at_ms,
  };
}

function transcriptRevisionFromRow(row: TranscriptRevisionRow): TranscriptRevisionRecord {
  if (!TRANSCRIPT_REVISION_KINDS.has(row.kind) || !TRANSCRIPT_REVISION_STATUSES.has(row.status)) {
    throw new Error('stored transcript revision state is invalid');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    remoteId: row.remote_id,
    kind: row.kind,
    status: row.status,
    sourceProvider: row.source_provider,
    sourceModel: row.source_model,
    isActive: row.is_active === 1,
    createdAtMs: row.created_at_ms,
    finalizedAtMs: row.finalized_at_ms,
  };
}

function summaryVersionFromRow(row: SummaryVersionRow): SummaryVersionRecord {
  if (!SUMMARY_VERSION_STATUSES.has(row.status)) throw new Error('stored summary version state is invalid');
  return {
    id: row.id,
    meetingId: row.meeting_id,
    templateId: row.template_id,
    templateRevision: row.template_revision,
    inputFingerprint: row.input_fingerprint,
    transcriptRevisionId: row.transcript_revision_id,
    manualNoteRevision: row.manual_note_revision,
    scheduleSnapshotHash: row.schedule_snapshot_hash,
    status: row.status,
    generatedBy: row.generated_by,
    userEdited: (row.effective_user_edited ?? row.user_edited) === 1,
    supersedesVersionId: row.supersedes_version_id,
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
  };
}

function transcriptSegmentFromRow(row: TranscriptSegmentRow): TranscriptSegmentRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    sourceId: row.source_segment_id,
    ordinal: row.ordinal,
    startMs: row.start_ms,
    endMs: row.end_ms,
    speakerClusterId: row.speaker_cluster_id,
    speakerProfileId: row.speaker_profile_id,
    speakerLabel: row.speaker_label,
    speakerLabelOverride: row.speaker_label_override,
    text: row.text,
    normalizedText: row.normalized_text,
    confidence: row.confidence,
    isFinal: row.is_final === 1,
    createdAtMs: row.created_at_ms,
  };
}

function markerFromRow(row: MarkerRow): MarkerRecord {
  if (row.kind !== 'important') throw new Error('stored meeting marker kind is invalid');
  return {
    id: row.id,
    meetingId: row.meeting_id,
    positionMs: row.position_ms,
    nearestSegmentId: row.nearest_segment_id,
    label: row.label,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function seriesCarryImportFromRow(row: MeetingSeriesCarryImportRow): MeetingSeriesCarryImportRecord {
  if (row.source_kind !== 'decision' && row.source_kind !== 'action') {
    throw new Error('stored series carry import kind is invalid');
  }
  return {
    targetMeetingId: row.target_meeting_id,
    sourceMeetingId: row.source_meeting_id,
    sourceKind: row.source_kind,
    sourceItemId: row.source_item_id,
    sourceOccurrenceDate: row.source_occurrence_date,
    sourceTitle: row.source_title,
    contentSnapshot: row.content_snapshot,
    assigneeSnapshot: row.assignee_snapshot,
    dueAtMs: row.due_at_ms,
    sourceSegmentId: row.source_segment_id,
    sourceStartMs: row.source_start_ms,
    importedAtMs: row.imported_at_ms,
  };
}

function summarySectionFromRow(row: SummarySectionRow): SummarySectionRecord {
  return {
    id: row.id,
    versionId: row.version_id,
    stableKey: row.stable_key,
    kind: row.kind,
    title: row.title,
    generatedText: row.generated_text,
    userText: row.user_text,
    ordinal: row.ordinal,
    userEditedAtMs: row.user_edited_at_ms,
  };
}

function summaryCitationFromRow(row: SummaryCitationRow): SummaryCitationRecord {
  return {
    id: row.id,
    sectionId: row.section_id,
    segmentId: row.segment_id,
    sourceSegmentId: row.source_segment_id ?? null,
    startMs: row.start_ms,
    endMs: row.end_ms,
    quoteHash: row.quote_hash,
    ordinal: row.ordinal,
  };
}

function actionItemFromRow(row: ActionItemRow): ActionItemRecord {
  actionStatus(row.status);
  if (row.source_kind !== 'generated' && row.source_kind !== 'manual' && row.source_kind !== 'marker') {
    throw new Error('stored meeting action source is invalid');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    remoteId: row.remote_id,
    remoteRevision: row.remote_revision,
    content: row.content,
    status: row.status,
    assigneeText: row.assignee_text,
    dueAtMs: row.due_at_ms,
    reminderAtMs: row.reminder_at_ms,
    reminderNotificationId: row.reminder_notification_id,
    followupEventSourceId: row.followup_event_source_id,
    sourceKind: row.source_kind,
    sourceMarkerId: row.source_marker_id,
    sourceSummaryVersionId: row.source_summary_version_id,
    sourceSegmentId: row.source_segment_id,
    sourceSegmentSourceId: row.source_segment_source_id ?? null,
    sourceStartMs: row.source_start_ms,
    generationFingerprint: row.generation_fingerprint,
    userEditedAtMs: row.user_edited_at_ms,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function assertRemoteMeetingAction(action: RemoteMeetingActionRecord): void {
  assertRecordId(action.remoteId, 'remote meeting action ID');
  assertRecordId(action.clientActionId, 'remote meeting action client ID');
  assertNonNegativeInteger(action.revision, 'remote meeting action revision');
  if (action.revision < 1) throw new Error('remote meeting action revision is invalid');
  assertNonNegativeInteger(action.clientCreatedAtMs, 'remote meeting action creation time');
  assertNonNegativeInteger(action.clientUpdatedAtMs, 'remote meeting action update time');
  assertOptionalNonNegativeInteger(action.userEditedAtMs, 'remote meeting action edit time');
  assertOptionalNonNegativeInteger(action.completedAtMs, 'remote meeting action completion time');
  assertNonNegativeInteger(action.serverCreatedAtMs, 'remote meeting action server creation time');
  assertNonNegativeInteger(action.serverUpdatedAtMs, 'remote meeting action server update time');
  if (
    action.clientCreatedAtMs > action.clientUpdatedAtMs
    || action.serverCreatedAtMs > action.serverUpdatedAtMs
    || (action.userEditedAtMs !== null && action.userEditedAtMs > action.clientUpdatedAtMs)
  ) throw new Error('remote meeting action clock is invalid');
  actionStatus(action.status);
  if (!action.content.trim() || action.content.length > 20_000 || action.content.includes('\u0000')) {
    throw new Error('remote meeting action content is invalid');
  }
  assertNullableBoundedText(action.assigneeText, 500, 'remote meeting action assignee');
  assertOptionalNonNegativeInteger(action.dueAtMs, 'remote meeting action due time');
  assertOptionalNonNegativeInteger(action.reminderAtMs, 'remote meeting action reminder time');
  if (action.reminderAtMs !== null && (action.dueAtMs === null || action.status !== 'pending')) {
    throw new Error('remote meeting action reminder is invalid');
  }
  if ((action.status === 'completed') !== (action.completedAtMs !== null)) {
    throw new Error('remote meeting action completion is invalid');
  }
  if (
    action.completedAtMs !== null
    && (
      action.completedAtMs < action.clientCreatedAtMs
      || action.completedAtMs > action.clientUpdatedAtMs
    )
  ) throw new Error('remote meeting action completion time is invalid');
  if (action.sourceKind !== 'generated' && action.sourceKind !== 'manual' && action.sourceKind !== 'marker') {
    throw new Error('remote meeting action source is invalid');
  }
  for (const [value, label] of [
    [action.followupEventSourceId, 'remote meeting action follow-up ID'],
    [action.sourceSummaryVersionId, 'remote meeting action summary ID'],
    [action.sourceSegmentId, 'remote meeting action segment ID'],
    [action.generationFingerprint, 'remote meeting action generation ID'],
  ] as const) {
    if (value !== null) assertRecordId(value, label);
  }
  if (action.sourceKind !== 'generated' && action.generationFingerprint !== null) {
    throw new Error('manual remote meeting action has generation identity');
  }
  assertOptionalNonNegativeInteger(action.sourceStartMs, 'remote meeting action source time');
}

function remoteActionConflictPayload(
  action: RemoteMeetingActionRecord,
  meetingRemoteId: string,
): Record<string, unknown> {
  return {
    id: action.remoteId,
    meeting_id: meetingRemoteId,
    client_action_id: action.clientActionId,
    revision: action.revision,
    client_created_at_ms: action.clientCreatedAtMs,
    client_updated_at_ms: action.clientUpdatedAtMs,
    user_edited_at_ms: action.userEditedAtMs,
    completed_at_ms: action.completedAtMs,
    content: action.content,
    status: action.status,
    assignee: action.assigneeText,
    due_at_ms: action.dueAtMs,
    reminder_at_ms: action.reminderAtMs,
    followup_event_source_id: action.followupEventSourceId,
    source_kind: action.sourceKind,
    source_summary_version_id: action.sourceSummaryVersionId,
    source_segment_id: action.sourceSegmentId,
    source_start_ms: action.sourceStartMs,
    generation_fingerprint: action.generationFingerprint,
    created_at: new Date(action.serverCreatedAtMs).toISOString(),
    updated_at: new Date(action.serverUpdatedAtMs).toISOString(),
  };
}

function localActionConflictPayload(action: ActionItemRow): Record<string, unknown> {
  return {
    id: action.remote_id,
    client_action_id: action.id,
    revision: action.remote_revision,
    client_created_at_ms: action.created_at_ms,
    client_updated_at_ms: action.updated_at_ms,
    user_edited_at_ms: action.user_edited_at_ms,
    completed_at_ms: action.completed_at_ms,
    content: action.content,
    status: action.status,
    assignee: action.assignee_text,
    due_at_ms: action.due_at_ms,
    reminder_at_ms: action.reminder_at_ms,
    followup_event_source_id: action.followup_event_source_id,
    source_kind: action.source_kind,
    source_summary_version_id: action.source_summary_version_id,
    source_segment_id: action.source_segment_source_id ?? action.source_segment_id,
    source_start_ms: action.source_start_ms,
    generation_fingerprint: action.generation_fingerprint,
  };
}

function remoteActionIdentityMatches(
  local: ActionItemRow,
  remote: RemoteMeetingActionRecord,
): boolean {
  return local.created_at_ms === remote.clientCreatedAtMs
    && local.source_kind === remote.sourceKind
    && local.source_summary_version_id === remote.sourceSummaryVersionId
    && (local.source_segment_source_id ?? local.source_segment_id) === remote.sourceSegmentId
    && local.source_start_ms === remote.sourceStartMs
    && local.generation_fingerprint === remote.generationFingerprint;
}

function remoteActionFieldsMatch(
  local: ActionItemRow,
  remote: RemoteMeetingActionRecord,
): boolean {
  return remoteActionIdentityMatches(local, remote)
    && local.updated_at_ms === remote.clientUpdatedAtMs
    && local.user_edited_at_ms === remote.userEditedAtMs
    && local.completed_at_ms === remote.completedAtMs
    && local.content === remote.content
    && local.status === remote.status
    && local.assignee_text === remote.assigneeText
    && local.due_at_ms === remote.dueAtMs
    && local.reminder_at_ms === remote.reminderAtMs
    && local.followup_event_source_id === remote.followupEventSourceId;
}

function assertRecordId(value: string, field: string): void {
  if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function assertActionPullCursor(value: string | null, field: string): void {
  if (
    value !== null
    && (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
  ) throw new Error(`${field} is invalid`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
}

function assertOptionalNonNegativeInteger(value: number | null, field: string): void {
  if (value !== null) assertNonNegativeInteger(value, field);
}

function assertNullableBoundedText(value: string | null, maximum: number, field: string): void {
  if (value !== null && (value.length > maximum || /[\u0000]/.test(value))) {
    throw new Error(`${field} is invalid`);
  }
}

function assertMeetingParticipants(value: readonly string[]): void {
  if (value.length > 500 || value.some(item => (
    typeof item !== 'string' || !item.trim() || item.length > 1000 || /[\u0000]/.test(item)
  ))) {
    throw new Error('meeting participants are invalid');
  }
}

function assertMeetingMode(value: MeetingNote['mode']): void {
  if (value !== null && !MEETING_CAPTURE_MODES.has(value)) throw new Error('meeting mode is invalid');
}

function actionStatus(value: ActionItemRecord['status']): ActionItemRecord['status'] {
  if (value !== 'pending' && value !== 'completed' && value !== 'dismissed') {
    throw new Error('meeting action status is invalid');
  }
  return value;
}

function normalizedSyncErrorCode(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('meeting action sync error code is invalid');
  }
  return normalized;
}

function meetingRootOperationRank(value: string): number {
  if (value === 'meeting.create') return 0;
  if (value === 'meeting.update') return 1;
  if (value === 'meeting.delete') return 2;
  return 3;
}

function compareMeetingRootOperations(
  left: MeetingRootSyncOutboxRow,
  right: MeetingRootSyncOutboxRow,
): number {
  return left.created_at_ms - right.created_at_ms
    || left.transport_order - right.transport_order
    || meetingRootOperationRank(left.operation_type) - meetingRootOperationRank(right.operation_type)
    || left.operation_id.localeCompare(right.operation_id);
}

function actionSyncRequestPayload(row: ActionSyncOutboxRow): string {
  actionStatus(row.action_status);
  if (
    row.action_source_kind !== 'generated'
    && row.action_source_kind !== 'manual'
    && row.action_source_kind !== 'marker'
  ) throw new Error('meeting action sync source is invalid');
  return JSON.stringify({
    schema_version: 2,
    meeting_remote_id: row.meeting_remote_id,
    action_id: row.aggregate_id,
    remote_id: row.action_remote_id,
    expected_remote_revision: row.action_remote_revision,
    client_created_at_ms: row.action_created_at_ms,
    client_updated_at_ms: row.action_updated_at_ms,
    user_edited_at_ms: row.action_user_edited_at_ms,
    completed_at_ms: row.action_completed_at_ms,
    content: row.action_content,
    status: row.action_status,
    assignee: row.action_assignee_text,
    due_at_ms: row.action_due_at_ms,
    reminder_at_ms: row.action_reminder_at_ms,
    followup_event_source_id: row.action_followup_event_source_id,
    source_kind: row.action_source_kind,
    source_summary_version_id: row.action_source_summary_version_id,
    source_segment_id: row.action_source_segment_source_id ?? row.action_source_segment_id,
    source_start_ms: row.action_source_start_ms,
    generation_fingerprint: row.action_generation_fingerprint,
  });
}

function manualNoteSyncRequestPayload(row: Pick<ManualNoteSyncOutboxRow,
  | 'meeting_remote_id'
  | 'note_revision'
  | 'note_content'
  | 'note_base_remote_revision'
  | 'note_last_saved_at_ms'
  | 'note_user_edited_at_ms'
>): string {
  if (
    row.note_revision < 1
    || !Number.isSafeInteger(row.note_revision)
    || row.note_content.length > 200_000
    || row.note_content.includes('\u0000')
    || !Number.isSafeInteger(row.note_last_saved_at_ms)
    || row.note_last_saved_at_ms < 0
  ) throw new Error('manual note sync state is invalid');
  return JSON.stringify({
    schema_version: 2,
    meeting_remote_id: row.meeting_remote_id,
    expected_remote_revision: row.note_base_remote_revision,
    client_note_revision: row.note_revision,
    client_updated_at_ms: row.note_last_saved_at_ms,
    user_edited_at_ms: row.note_user_edited_at_ms,
    content: row.note_content,
  });
}

function assertOccurrenceDate(value: string, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} is invalid`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw new Error(`${field} is invalid`);
}

function assertScheduleSnapshot(snapshot: ScheduleSnapshot, field: string): void {
  assertOptionalNonNegativeInteger(snapshot.plannedStartMs, `${field} start time`);
  assertOptionalNonNegativeInteger(snapshot.plannedEndMs, `${field} end time`);
  if (
    snapshot.plannedStartMs !== null
    && snapshot.plannedEndMs !== null
    && snapshot.plannedEndMs < snapshot.plannedStartMs
  ) throw new Error(`${field} time is invalid`);
  assertNullableBoundedText(snapshot.eventTitle, 20_000, `${field} title`);
  assertNullableBoundedText(snapshot.timezoneId, 160, `${field} timezone`);
  assertNullableBoundedText(snapshot.location, 2_000, `${field} location`);
  assertNullableBoundedText(snapshot.description, 100_000, `${field} description`);
  assertMeetingParticipants(snapshot.participants);
  assertOptionalNonNegativeInteger(snapshot.capturedEventRevision, `${field} calendar revision`);
  assertNonNegativeInteger(snapshot.capturedAtMs, `${field} capture time`);
}

function occurrenceScheduleSnapshotFromRow(row: OccurrenceSyncOutboxRow): ScheduleSnapshot {
  const snapshot: ScheduleSnapshot = {
    eventTitle: row.event_title,
    plannedStartMs: row.planned_start_ms,
    plannedEndMs: row.planned_end_ms,
    allDay: row.all_day === 1,
    timezoneId: row.timezone_id,
    location: row.occurrence_location,
    participants: participantsFromJson(row.occurrence_participants_json),
    description: row.occurrence_description,
    capturedEventRevision: row.captured_event_revision,
    capturedAtMs: row.captured_at_ms,
  };
  assertScheduleSnapshot(snapshot, 'occurrence schedule snapshot');
  return snapshot;
}

function occurrenceSyncRequestPayload(row: OccurrenceSyncOutboxRow): string {
  assertRecordId(row.meeting_remote_id, 'occurrence remote meeting ID');
  assertRecordId(row.calendar_source_event_id, 'occurrence source event ID');
  assertOccurrenceDate(row.occurrence_date, 'occurrence date');
  if (row.link_state !== 'active' && row.link_state !== 'orphaned') {
    throw new Error('occurrence link state is invalid');
  }
  assertOptionalNonNegativeInteger(row.occurrence_remote_revision, 'occurrence remote revision');
  assertNonNegativeInteger(row.client_updated_at_ms, 'occurrence update time');
  const snapshot = occurrenceScheduleSnapshotFromRow(row);
  return JSON.stringify({
    schema_version: 2,
    meeting_remote_id: row.meeting_remote_id,
    expected_remote_revision: row.occurrence_remote_revision,
    source_event_id: row.calendar_source_event_id,
    occurrence_date: row.occurrence_date,
    calendar_revision: row.calendar_revision,
    recurrence_segment_id: row.recurrence_segment_id,
    series_key: row.series_key,
    link_state: row.link_state,
    client_updated_at_ms: row.client_updated_at_ms,
    schedule_snapshot: snapshot,
  });
}

function assertRemoteOccurrenceLink(remote: RemoteOccurrenceLinkRecord): void {
  assertRecordId(remote.remoteId, 'remote occurrence ID');
  assertRecordId(remote.meetingRemoteId, 'remote occurrence meeting ID');
  assertRecordId(remote.sourceEventId, 'remote occurrence source event ID');
  assertOccurrenceDate(remote.occurrenceDate, 'remote occurrence date');
  assertNonNegativeInteger(remote.revision, 'remote occurrence revision');
  if (remote.revision < 1) throw new Error('remote occurrence revision is invalid');
  assertOptionalNonNegativeInteger(remote.calendarRevision, 'remote occurrence calendar revision');
  if (remote.recurrenceSegmentId !== null) {
    assertRecordId(remote.recurrenceSegmentId, 'remote occurrence segment ID');
  }
  if (remote.seriesKey !== null) assertRecordId(remote.seriesKey, 'remote occurrence series ID');
  if (remote.linkState !== 'active' && remote.linkState !== 'orphaned') {
    throw new Error('remote occurrence link state is invalid');
  }
  assertNonNegativeInteger(remote.clientUpdatedAtMs, 'remote occurrence update time');
  assertNonNegativeInteger(remote.serverCreatedAtMs, 'remote occurrence creation time');
  assertNonNegativeInteger(remote.serverUpdatedAtMs, 'remote occurrence server update time');
  if (remote.serverCreatedAtMs > remote.serverUpdatedAtMs) {
    throw new Error('remote occurrence server clock is invalid');
  }
  assertScheduleSnapshot(remote.scheduleSnapshot, 'remote occurrence schedule snapshot');
}

function scheduleSnapshotsEqual(left: ScheduleSnapshot, right: ScheduleSnapshot): boolean {
  return left.eventTitle === right.eventTitle
    && left.plannedStartMs === right.plannedStartMs
    && left.plannedEndMs === right.plannedEndMs
    && left.allDay === right.allDay
    && left.timezoneId === right.timezoneId
    && left.location === right.location
    && left.description === right.description
    && left.capturedEventRevision === right.capturedEventRevision
    && left.capturedAtMs === right.capturedAtMs
    && left.participants.length === right.participants.length
    && left.participants.every((item, index) => item === right.participants[index]);
}

function assertRemoteManualNote(
  remote: MergeMeetingManualNoteRemoteInput['remote'],
): void {
  if (
    typeof remote.content !== 'string'
    || remote.content.length > 200_000
    || remote.content.includes('\u0000')
  ) throw new Error('remote manual note content is invalid');
  assertNonNegativeInteger(remote.revision, 'remote manual note revision');
  assertNonNegativeInteger(remote.clientNoteRevision, 'remote manual note client revision');
  assertNonNegativeInteger(remote.clientUpdatedAtMs, 'remote manual note update time');
  assertOptionalNonNegativeInteger(remote.userEditedAtMs, 'remote manual note edit time');
  assertOptionalNonNegativeInteger(remote.serverCreatedAtMs, 'remote manual note creation time');
  assertOptionalNonNegativeInteger(remote.serverUpdatedAtMs, 'remote manual note server update time');
  if (remote.userEditedAtMs !== null && remote.userEditedAtMs > remote.clientUpdatedAtMs) {
    throw new Error('remote manual note edit time is invalid');
  }
  if (remote.exists) {
    if (remote.remoteId === null) throw new Error('remote manual note identity is missing');
    assertRecordId(remote.remoteId, 'remote manual note ID');
    if (
      remote.revision < 1
      || remote.clientNoteRevision < 1
      || remote.serverCreatedAtMs === null
      || remote.serverUpdatedAtMs === null
      || remote.serverCreatedAtMs > remote.serverUpdatedAtMs
    ) throw new Error('remote manual note state is invalid');
    return;
  }
  if (
    remote.remoteId !== null
    || remote.revision !== 0
    || remote.clientNoteRevision !== 0
    || remote.clientUpdatedAtMs !== 0
    || remote.userEditedAtMs !== null
    || remote.content !== ''
    || remote.serverCreatedAtMs !== null
    || remote.serverUpdatedAtMs !== null
  ) throw new Error('missing remote manual note state is invalid');
}

function remoteManualNotePayloadJson(
  remoteMeetingId: string,
  remote: MergeMeetingManualNoteRemoteInput['remote'],
): string {
  return JSON.stringify({
    schema_version: 2,
    exists: remote.exists,
    id: remote.remoteId,
    meeting_id: remoteMeetingId,
    revision: remote.revision,
    client_note_revision: remote.clientNoteRevision,
    client_updated_at_ms: remote.clientUpdatedAtMs,
    user_edited_at_ms: remote.userEditedAtMs,
    content: remote.content,
    created_at_ms: remote.serverCreatedAtMs,
    updated_at_ms: remote.serverUpdatedAtMs,
  });
}

function localManualNotePayloadJson(
  meetingRemoteId: string,
  note: ManualNoteRow,
): string {
  return JSON.stringify({
    schema_version: 2,
    meeting_remote_id: meetingRemoteId,
    expected_remote_revision: note.base_remote_revision,
    client_note_revision: note.revision,
    client_updated_at_ms: note.last_saved_at_ms,
    user_edited_at_ms: note.user_edited_at_ms,
    content: note.content,
  });
}

function manualNoteFieldsMatchRemote(
  note: ManualNoteRow,
  remote: MergeMeetingManualNoteRemoteInput['remote'],
): boolean {
  return remote.exists
    && note.content === remote.content
    && note.last_saved_at_ms === remote.clientUpdatedAtMs
    && note.user_edited_at_ms === remote.userEditedAtMs;
}

function speakerCorrectionSyncRequestPayload(row: SpeakerCorrectionSyncOutboxRow): string {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return JSON.stringify({
      schema_version: 0,
      meeting_remote_id: row.meeting_remote_id,
      invalid_local_payload: row.payload_json,
    });
  }
  return JSON.stringify({
    ...(payload as Record<string, unknown>),
    meeting_remote_id: row.meeting_remote_id,
    transcript_revision_id: row.transcript_remote_id,
  });
}

async function refreshMeetingSyncState(
  database: SQLiteDatabase,
  meetingId: string,
  scopeKey: ScopeKey,
): Promise<void> {
  const unresolvedConflict = await database.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_conflicts conflict
     WHERE conflict.scope_key = ? AND conflict.status = 'unresolved'
       AND (
         (conflict.aggregate_type = 'meeting_note' AND conflict.aggregate_id = ?)
         OR (
           conflict.aggregate_type = 'action_item'
           AND conflict.aggregate_id IN (
             SELECT action.id FROM action_items action WHERE action.meeting_id = ?
           )
         )
         OR (conflict.aggregate_type = 'manual_note' AND conflict.aggregate_id = ?)
         OR (conflict.aggregate_type = 'meeting_occurrence' AND conflict.aggregate_id = ?)
         OR (
           conflict.aggregate_type = 'speaker_correction'
           AND conflict.aggregate_id IN (
             SELECT correction.id FROM speaker_corrections correction
             WHERE correction.meeting_id = ?
           )
         )
       )
     LIMIT 1`,
    scopeKey,
    meetingId,
    meetingId,
    meetingId,
    meetingId,
    meetingId,
  );
  const outstanding = await database.getAllAsync<{ status: string }>(
    `SELECT outbox.status FROM sync_outbox outbox
     WHERE outbox.scope_key = ? AND outbox.status <> 'completed'
       AND (
         (outbox.aggregate_type = 'meeting_note' AND outbox.aggregate_id = ?)
         OR (
           outbox.aggregate_type = 'action_item'
           AND outbox.aggregate_id IN (
             SELECT action.id FROM action_items action WHERE action.meeting_id = ?
           )
         )
         OR (outbox.aggregate_type = 'manual_note' AND outbox.aggregate_id = ?)
         OR (outbox.aggregate_type = 'meeting_occurrence' AND outbox.aggregate_id = ?)
         OR (
           outbox.aggregate_type = 'speaker_correction'
           AND outbox.aggregate_id IN (
             SELECT correction.id FROM speaker_corrections correction
             WHERE correction.meeting_id = ?
           )
         )
       )`,
    scopeKey,
    meetingId,
    meetingId,
    meetingId,
    meetingId,
    meetingId,
  );
  const conflicted = Boolean(unresolvedConflict)
    || outstanding.some(item => item.status === 'blocked' || item.status === 'permanent_error');
  const syncState: MeetingNote['syncState'] = conflicted
    ? 'conflicted'
    : outstanding.length > 0
      ? 'pending'
      : 'synced';
  await database.runAsync(
    `UPDATE meeting_notes SET sync_state = ?
     WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
    syncState,
    meetingId,
    scopeKey,
  );
}

function participantsFromJson(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function snapshotFromRow(row: ScheduleSnapshotRow): ScheduleSnapshot {
  return {
    eventTitle: row.event_title,
    plannedStartMs: row.planned_start_ms,
    plannedEndMs: row.planned_end_ms,
    allDay: row.all_day === 1,
    timezoneId: row.timezone_id,
    location: row.location,
    participants: participantsFromJson(row.participants_json),
    description: row.description,
    capturedEventRevision: row.captured_event_revision,
    capturedAtMs: row.captured_at_ms,
  };
}

class SqliteMeetingTransaction implements MeetingTransaction {
  readonly touchedMeetingIds = new Set<string>();

  constructor(private readonly database: SQLiteDatabase) {}

  async getMeeting(id: string, scopeKey: ScopeKey): Promise<MeetingNote | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<MeetingRow>(
      'SELECT * FROM meeting_notes WHERE id = ? AND scope_key = ?',
      id,
      scopeKey,
    );
    return row ? noteFromRow(row) : null;
  }

  async getManualNote(meetingId: string, scopeKey: ScopeKey): Promise<ManualNoteRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<ManualNoteRow>(
      `SELECT note.* FROM manual_notes note
       INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
       WHERE note.meeting_id = ? AND meeting.scope_key = ?`,
      meetingId,
      scopeKey,
    );
    return row ? manualNoteFromRow(row) : null;
  }

  async findMeetingByOccurrence(
    reference: { sourceEventId: string; occurrenceDate: string },
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<MeetingRow>(
      `SELECT meeting.* FROM meeting_notes meeting
       INNER JOIN meeting_occurrence_links link ON link.meeting_id = meeting.id
       WHERE meeting.scope_key = ?
         AND link.scope_key = ?
         AND link.calendar_source_event_id = ?
         AND link.occurrence_date = ?
       LIMIT 1`,
      scopeKey,
      scopeKey,
      reference.sourceEventId,
      reference.occurrenceDate,
    );
    return row ? noteFromRow(row) : null;
  }

  async findMeetingByNativeSessionId(
    sessionId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null> {
    assertScopeKey(scopeKey);
    const normalized = sessionId.trim();
    if (!normalized) return null;
    const row = await this.database.getFirstAsync<MeetingRow>(
      `SELECT DISTINCT meeting.* FROM meeting_notes meeting
       LEFT JOIN recording_assets asset ON asset.meeting_id = meeting.id
       WHERE meeting.scope_key = ? AND (
         asset.native_session_id = ? OR meeting.id = ? OR
         meeting.remote_id = ? OR meeting.legacy_source_id = ?
       )
       ORDER BY CASE WHEN asset.native_session_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      scopeKey,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
    );
    return row ? noteFromRow(row) : null;
  }

  async findMeetingByRemoteIdentity(
    remoteId: string,
    clientRequestId: string | null,
    scopeKey: ScopeKey,
  ): Promise<MeetingNote | null> {
    assertScopeKey(scopeKey);
    assertRecordId(remoteId, 'meeting remote ID');
    if (clientRequestId) assertRecordId(clientRequestId, 'meeting client request ID');
    const rows = await this.database.getAllAsync<MeetingRow>(
      `SELECT * FROM meeting_notes
       WHERE scope_key = ? AND (
         remote_id = ? OR (
           ? IS NOT NULL AND client_request_id = ?
           AND entry_point <> 'legacy_store'
         )
       )
       ORDER BY CASE WHEN remote_id = ? THEN 0 ELSE 1 END, created_at_ms, id
       LIMIT 2`,
      scopeKey,
      remoteId,
      clientRequestId,
      clientRequestId,
      remoteId,
    );
    if (rows.length > 1 && rows[0].id !== rows[1].id) {
      throw new Error('meeting remote snapshot identity is ambiguous');
    }
    return rows[0] ? noteFromRow(rows[0]) : null;
  }

  async hasOutstandingMeetingRootSync(meetingId: string, scopeKey: ScopeKey): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    const row = await this.database.getFirstAsync<{ found: number }>(
      `SELECT 1 AS found FROM sync_outbox
       WHERE scope_key = ? AND aggregate_type = 'meeting_note'
         AND aggregate_id = ? AND status <> 'completed'
       LIMIT 1`,
      scopeKey,
      meetingId,
    );
    return Boolean(row);
  }

  async getStage(
    meetingId: string,
    scopeKey: ScopeKey,
    stageName: ProcessingStage['stage'],
  ): Promise<ProcessingStage | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<StageRow>(
      `SELECT stage.* FROM processing_stages stage
       INNER JOIN meeting_notes meeting ON meeting.id = stage.meeting_id
       WHERE stage.meeting_id = ? AND meeting.scope_key = ? AND stage.stage = ?`,
      meetingId,
      scopeKey,
      stageName,
    );
    return row ? stageFromRow(row) : null;
  }

  async getPrimaryRecording(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<RecordingAssetRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<RecordingAssetRow>(
      `SELECT asset.* FROM recording_assets asset
       INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
       WHERE asset.meeting_id = ? AND meeting.scope_key = ? AND asset.role = 'primary'
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return row ? recordingAssetFromRow(row) : null;
  }

  async getTranscriptRevision(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.id = ? AND meeting.scope_key = ?`,
      id,
      scopeKey,
    );
    return row ? transcriptRevisionFromRow(row) : null;
  }

  async getActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.meeting_id = ? AND meeting.scope_key = ? AND revision.is_active = 1
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return row ? transcriptRevisionFromRow(row) : null;
  }

  async getActiveTranscriptContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null> {
    assertScopeKey(scopeKey);
    const revision = await this.database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.meeting_id = ? AND meeting.scope_key = ? AND revision.is_active = 1
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    if (!revision) return null;
    const segments = await this.database.getAllAsync<TranscriptSegmentRow>(
      `SELECT segment.* FROM transcript_segments segment
       INNER JOIN transcript_revisions stored ON stored.id = segment.revision_id
       INNER JOIN meeting_notes meeting ON meeting.id = stored.meeting_id
       WHERE segment.revision_id = ? AND stored.meeting_id = ? AND meeting.scope_key = ?
       ORDER BY segment.ordinal, segment.id`,
      revision.id,
      revision.meeting_id,
      scopeKey,
    );
    return {
      revision: transcriptRevisionFromRow(revision),
      segments: segments.map(transcriptSegmentFromRow),
    };
  }

  async getSummaryVersion(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE version.id = ? AND meeting.scope_key = ?`,
      id,
      scopeKey,
    );
    return row ? summaryVersionFromRow(row) : null;
  }

  async getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE meeting.id = ? AND meeting.scope_key = ?
         AND meeting.current_summary_version_id = version.id
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return row ? summaryVersionFromRow(row) : null;
  }

  async hasUserProtectedSummaryState(versionId: string, scopeKey: ScopeKey): Promise<boolean> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<{ protected: number }>(
      `SELECT CASE
         WHEN version.user_edited = 1 THEN 1
         WHEN EXISTS (
           SELECT 1 FROM summary_sections section
           WHERE section.version_id = version.id
             AND (section.user_text IS NOT NULL OR section.user_edited_at_ms IS NOT NULL)
         ) THEN 1
         WHEN EXISTS (
           SELECT 1 FROM action_items action
           WHERE action.source_summary_version_id = version.id
             AND (action.user_edited_at_ms IS NOT NULL OR action.status <> 'pending')
         ) THEN 1
         ELSE 0
       END AS protected
       FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE version.id = ? AND meeting.scope_key = ?`,
      versionId,
      scopeKey,
    );
    return row?.protected === 1;
  }

  async getMeetingAction(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<ActionItemRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<ActionItemRow>(
      `SELECT action.* FROM action_items action
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       WHERE action.id = ? AND action.meeting_id = ? AND meeting.scope_key = ?`,
      actionId,
      meetingId,
      scopeKey,
    );
    return row ? actionItemFromRow(row) : null;
  }

  async getMeetingMarker(
    markerId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MarkerRecord | null> {
    assertScopeKey(scopeKey);
    const row = await this.database.getFirstAsync<MarkerRow>(
      `SELECT marker.* FROM markers marker
       INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
       WHERE marker.id = ? AND marker.meeting_id = ? AND meeting.scope_key = ?`,
      markerId,
      meetingId,
      scopeKey,
    );
    return row ? markerFromRow(row) : null;
  }

  async listMeetingMarkers(meetingId: string, scopeKey: ScopeKey): Promise<readonly MarkerRecord[]> {
    assertScopeKey(scopeKey);
    const rows = await this.database.getAllAsync<MarkerRow>(
      `SELECT marker.* FROM markers marker
       INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
       WHERE marker.meeting_id = ? AND meeting.scope_key = ?
       ORDER BY marker.position_ms, marker.created_at_ms, marker.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(markerFromRow);
  }

  async insertMeetingMarker(marker: MarkerRecord, scopeKey: ScopeKey): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(marker.id, 'meeting marker ID');
    assertRecordId(marker.meetingId, 'meeting ID');
    assertNonNegativeInteger(marker.positionMs, 'meeting marker position');
    assertNonNegativeInteger(marker.createdAtMs, 'meeting marker creation time');
    assertNonNegativeInteger(marker.updatedAtMs, 'meeting marker update time');
    if (marker.kind !== 'important') throw new Error('meeting marker kind is invalid');
    if (marker.label !== null && marker.label.length > 500) {
      throw new Error('meeting marker label is too long');
    }
    const meeting = await this.getMeeting(marker.meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept markers in active scope');
    }
    if (marker.nearestSegmentId !== null) {
      const segment = await this.database.getFirstAsync<TranscriptSegmentRow>(
        `SELECT segment.* FROM transcript_segments segment
         INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
         INNER JOIN meeting_notes stored ON stored.id = revision.meeting_id
         WHERE segment.id = ? AND revision.meeting_id = ? AND revision.is_active = 1
           AND stored.scope_key = ? AND segment.start_ms <= ? AND segment.end_ms >= ?`,
        marker.nearestSegmentId,
        marker.meetingId,
        scopeKey,
        marker.positionMs,
        marker.positionMs,
      );
      if (!segment) throw new Error('meeting marker segment does not cover its position');
    }
    const result = await this.database.runAsync(
      `INSERT INTO markers (
         id, meeting_id, position_ms, nearest_segment_id, label, kind,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      marker.id,
      marker.meetingId,
      marker.positionMs,
      marker.nearestSegmentId,
      marker.label,
      marker.kind,
      marker.createdAtMs,
      marker.updatedAtMs,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(marker.meetingId);
    return result.changes > 0;
  }

  async deleteMeetingMarker(
    markerId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(markerId, 'meeting marker ID');
    assertRecordId(meetingId, 'meeting ID');
    const result = await this.database.runAsync(
      `DELETE FROM markers
       WHERE id = ? AND meeting_id = ? AND EXISTS (
         SELECT 1 FROM meeting_notes meeting
         WHERE meeting.id = markers.meeting_id
           AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
       )`,
      markerId,
      meetingId,
      scopeKey,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(meetingId);
    return result.changes > 0;
  }

  async reconcileMeetingMarkers(
    meetingId: string,
    scopeKey: ScopeKey,
    updatedAtMs: number,
  ): Promise<number> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    assertNonNegativeInteger(updatedAtMs, 'meeting marker reconciliation time');
    const meeting = await this.getMeeting(meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') return 0;
    const markers = await this.listMeetingMarkers(meetingId, scopeKey);
    if (markers.length === 0) return 0;
    const transcript = await this.getActiveTranscriptContent(meetingId, scopeKey);
    const segments = transcript?.segments ?? [];
    let changed = 0;
    for (const marker of markers) {
      const nearest = segments
        .filter(segment => segment.startMs <= marker.positionMs && segment.endMs >= marker.positionMs)
        .sort((left, right) => (
          Math.abs(marker.positionMs - left.startMs) - Math.abs(marker.positionMs - right.startMs)
          || left.ordinal - right.ordinal
          || left.id.localeCompare(right.id)
        ))[0]?.id ?? null;
      if (nearest === marker.nearestSegmentId) continue;
      const result = await this.database.runAsync(
        `UPDATE markers SET nearest_segment_id = ?, updated_at_ms = ?
         WHERE id = ? AND meeting_id = ? AND nearest_segment_id IS ?`,
        nearest,
        Math.max(marker.updatedAtMs, updatedAtMs),
        marker.id,
        meetingId,
        marker.nearestSegmentId,
      );
      changed += result.changes;
    }
    if (changed > 0) this.touchedMeetingIds.add(meetingId);
    return changed;
  }

  async insertMeetingAction(action: ActionItemRecord, scopeKey: ScopeKey): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(action.id, 'meeting action ID');
    assertRecordId(action.meetingId, 'meeting ID');
    if (!action.content.trim()) throw new Error('meeting action content is empty');
    actionStatus(action.status);
    assertOptionalNonNegativeInteger(action.dueAtMs, 'meeting action due time');
    assertOptionalNonNegativeInteger(action.reminderAtMs, 'meeting action reminder time');
    if (action.reminderNotificationId !== null) {
      assertRecordId(action.reminderNotificationId, 'meeting action notification ID');
    }
    if (action.reminderAtMs === null && action.reminderNotificationId !== null) {
      throw new Error('meeting action notification requires a reminder time');
    }
    if (action.reminderAtMs !== null && action.dueAtMs === null) {
      throw new Error('meeting action reminder requires a due time');
    }
    if (!['generated', 'manual', 'marker'].includes(action.sourceKind)) {
      throw new Error('meeting action source is invalid');
    }
    if (action.sourceKind !== 'marker' && action.sourceMarkerId !== null) {
      throw new Error('non-marker action cannot retain a marker source');
    }
    if (action.sourceMarkerId !== null) {
      assertRecordId(action.sourceMarkerId, 'meeting action marker source');
      const marker = await this.getMeetingMarker(action.sourceMarkerId, action.meetingId, scopeKey);
      if (!marker || marker.positionMs !== action.sourceStartMs) {
        throw new Error('meeting action marker source is unavailable');
      }
      if (action.sourceSegmentId !== marker.nearestSegmentId) {
        throw new Error('meeting action marker segment changed during creation');
      }
    }
    assertOptionalNonNegativeInteger(action.sourceStartMs, 'meeting action source time');
    assertOptionalNonNegativeInteger(action.userEditedAtMs, 'meeting action edit time');
    assertOptionalNonNegativeInteger(action.completedAtMs, 'meeting action completion time');
    assertNonNegativeInteger(action.createdAtMs, 'meeting action creation time');
    assertNonNegativeInteger(action.updatedAtMs, 'meeting action update time');
    if (action.status === 'completed' && action.completedAtMs === null) {
      throw new Error('completed meeting action requires a completion time');
    }
    if (action.status !== 'completed' && action.completedAtMs !== null) {
      throw new Error('open meeting action cannot retain a completion time');
    }
    const meeting = await this.getMeeting(action.meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept actions in active scope');
    }
    const result = await this.database.runAsync(
      `INSERT INTO action_items (
         id, meeting_id, remote_id, content, status, assignee_text, due_at_ms,
         reminder_at_ms, reminder_notification_id, followup_event_source_id,
         source_kind, source_marker_id, source_summary_version_id, source_segment_id, source_start_ms,
         generation_fingerprint, user_edited_at_ms, completed_at_ms,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      action.id,
      action.meetingId,
      action.remoteId,
      action.content,
      action.status,
      action.assigneeText,
      action.dueAtMs,
      action.reminderAtMs,
      action.reminderNotificationId,
      action.followupEventSourceId,
      action.sourceKind,
      action.sourceMarkerId,
      action.sourceSummaryVersionId,
      action.sourceSegmentId,
      action.sourceStartMs,
      action.generationFingerprint,
      action.userEditedAtMs,
      action.completedAtMs,
      action.createdAtMs,
      action.updatedAtMs,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(action.meetingId);
    return result.changes > 0;
  }

  async insertSeriesCarryImport(
    record: MeetingSeriesCarryImportRecord,
    scopeKey: ScopeKey,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(record.targetMeetingId, 'series carry target meeting ID');
    assertRecordId(record.sourceMeetingId, 'series carry source meeting ID');
    assertRecordId(record.sourceItemId, 'series carry source item ID');
    if (record.sourceKind !== 'decision' && record.sourceKind !== 'action') {
      throw new Error('series carry source kind is invalid');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.sourceOccurrenceDate)) {
      throw new Error('series carry source date is invalid');
    }
    if (!record.contentSnapshot.trim() || record.contentSnapshot.length > 20_000) {
      throw new Error('series carry content is invalid');
    }
    assertNullableBoundedText(record.sourceTitle, 1_000, 'series carry source title');
    assertNullableBoundedText(record.assigneeSnapshot, 1_000, 'series carry assignee');
    assertOptionalNonNegativeInteger(record.dueAtMs, 'series carry due time');
    if (record.sourceSegmentId !== null) {
      assertRecordId(record.sourceSegmentId, 'series carry source segment ID');
    }
    assertOptionalNonNegativeInteger(record.sourceStartMs, 'series carry source time');
    assertNonNegativeInteger(record.importedAtMs, 'series carry import time');
    const target = await this.getMeeting(record.targetMeetingId, scopeKey);
    if (!target || target.lifecycle === 'deleted') {
      throw new Error('series carry target is unavailable');
    }
    const result = await this.database.runAsync(
      `INSERT INTO meeting_series_carry_imports (
         target_meeting_id, source_meeting_id, source_kind, source_item_id,
         source_occurrence_date, source_title, content_snapshot, assignee_snapshot,
         due_at_ms, source_segment_id, source_start_ms, imported_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_meeting_id, source_kind, source_item_id) DO NOTHING`,
      record.targetMeetingId,
      record.sourceMeetingId,
      record.sourceKind,
      record.sourceItemId,
      record.sourceOccurrenceDate,
      record.sourceTitle,
      record.contentSnapshot,
      record.assigneeSnapshot,
      record.dueAtMs,
      record.sourceSegmentId,
      record.sourceStartMs,
      record.importedAtMs,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(record.targetMeetingId);
    return result.changes > 0;
  }

  async updateMeetingAction(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedUpdatedAtMs: number,
    fields: MeetingActionMutableFields,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(actionId, 'meeting action ID');
    assertRecordId(meetingId, 'meeting ID');
    if (!fields.content.trim()) throw new Error('meeting action content is empty');
    actionStatus(fields.status);
    assertOptionalNonNegativeInteger(fields.dueAtMs, 'meeting action due time');
    assertOptionalNonNegativeInteger(fields.reminderAtMs, 'meeting action reminder time');
    if (fields.reminderNotificationId !== null) {
      assertRecordId(fields.reminderNotificationId, 'meeting action notification ID');
    }
    if (fields.reminderAtMs === null && fields.reminderNotificationId !== null) {
      throw new Error('meeting action notification requires a reminder time');
    }
    assertNonNegativeInteger(fields.userEditedAtMs, 'meeting action edit time');
    assertOptionalNonNegativeInteger(fields.completedAtMs, 'meeting action completion time');
    assertNonNegativeInteger(fields.updatedAtMs, 'meeting action update time');
    assertNonNegativeInteger(expectedUpdatedAtMs, 'meeting action expected revision');
    if (fields.updatedAtMs <= expectedUpdatedAtMs) {
      throw new Error('meeting action update time must advance');
    }
    if (fields.status === 'completed' && fields.completedAtMs === null) {
      throw new Error('completed meeting action requires a completion time');
    }
    if (fields.status !== 'completed' && fields.completedAtMs !== null) {
      throw new Error('open meeting action cannot retain a completion time');
    }
    const result = await this.database.runAsync(
      `UPDATE action_items SET
         content = ?, status = ?, assignee_text = ?, due_at_ms = ?,
         reminder_at_ms = ?, reminder_notification_id = ?,
         user_edited_at_ms = ?, completed_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND updated_at_ms = ?
         AND EXISTS (
           SELECT 1 FROM meeting_notes meeting
           WHERE meeting.id = action_items.meeting_id
             AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         )`,
      fields.content,
      fields.status,
      fields.assigneeText,
      fields.dueAtMs,
      fields.reminderAtMs,
      fields.reminderNotificationId,
      fields.userEditedAtMs,
      fields.completedAtMs,
      fields.updatedAtMs,
      actionId,
      meetingId,
      expectedUpdatedAtMs,
      scopeKey,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(meetingId);
    return result.changes > 0;
  }

  async linkMeetingActionFollowupEvent(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedUpdatedAtMs: number,
    fields: MeetingActionFollowupLinkFields,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(actionId, 'meeting action ID');
    assertRecordId(meetingId, 'meeting ID');
    assertRecordId(fields.followupEventSourceId, 'follow-up event source ID');
    assertNonNegativeInteger(fields.userEditedAtMs, 'meeting action edit time');
    assertNonNegativeInteger(fields.updatedAtMs, 'meeting action update time');
    assertNonNegativeInteger(expectedUpdatedAtMs, 'meeting action expected revision');
    if (fields.updatedAtMs <= expectedUpdatedAtMs) {
      throw new Error('meeting action update time must advance');
    }
    const result = await this.database.runAsync(
      `UPDATE action_items SET
         followup_event_source_id = ?, user_edited_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND updated_at_ms = ?
         AND followup_event_source_id IS NULL
         AND EXISTS (
           SELECT 1 FROM meeting_notes meeting
           WHERE meeting.id = action_items.meeting_id
             AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         )`,
      fields.followupEventSourceId,
      fields.userEditedAtMs,
      fields.updatedAtMs,
      actionId,
      meetingId,
      expectedUpdatedAtMs,
      scopeKey,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(meetingId);
    return result.changes > 0;
  }

  async setActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
    revisionId: string | null,
  ): Promise<void> {
    assertScopeKey(scopeKey);
    const meeting = await this.getMeeting(meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept transcript activation in active scope');
    }
    if (revisionId) {
      const revision = await this.getTranscriptRevision(revisionId, scopeKey);
      if (!revision || revision.meetingId !== meetingId) {
        throw new Error('active transcript revision is outside the active meeting scope');
      }
      if (!['realtime_draft', 'finalizing', 'ready'].includes(revision.status)) {
        throw new Error('inactive transcript state cannot become active');
      }
      if (revision.kind !== 'realtime_draft') {
        const segmentCount = Number((await this.database.getFirstAsync<{ count: number }>(
          `SELECT COUNT(*) AS count FROM transcript_segments segment
           INNER JOIN transcript_revisions stored ON stored.id = segment.revision_id
           INNER JOIN meeting_notes scoped ON scoped.id = stored.meeting_id
           WHERE stored.id = ? AND stored.meeting_id = ? AND scoped.scope_key = ?`,
          revisionId,
          meetingId,
          scopeKey,
        ))?.count ?? 0);
        if (segmentCount === 0) throw new Error('empty final transcript revision cannot become active');
      }
    }
    await this.database.runAsync(
      'UPDATE transcript_revisions SET is_active = 0 WHERE meeting_id = ?',
      meetingId,
    );
    if (revisionId) {
      const result = await this.database.runAsync(
        'UPDATE transcript_revisions SET is_active = 1 WHERE id = ? AND meeting_id = ?',
        revisionId,
        meetingId,
      );
      if (result.changes !== 1) throw new Error('active transcript revision disappeared');
    }
    this.touchedMeetingIds.add(meetingId);
  }

  private async assertMeetingInScope(meetingId: string, scopeKey: ScopeKey): Promise<void> {
    if (!await this.getMeeting(meetingId, scopeKey)) {
      throw new Error('meeting does not exist in active scope');
    }
  }

  async insertMeeting(note: NewMeetingNote): Promise<void> {
    assertScopeKey(note.scopeKey);
    const description = note.description ?? null;
    const participants = note.participants ?? [];
    const location = note.location ?? null;
    const mode = note.mode ?? null;
    const clientRequestId = note.clientRequestId?.trim() || null;
    const recordedAtMs = note.recordedAtMs ?? null;
    assertNullableBoundedText(description, 100_000, 'meeting description');
    assertMeetingParticipants(participants);
    assertNullableBoundedText(location, 2_000, 'meeting location');
    assertMeetingMode(mode);
    if (clientRequestId) assertRecordId(clientRequestId, 'meeting client request ID');
    assertOptionalNonNegativeInteger(recordedAtMs, 'meeting recorded time');
    await this.database.runAsync(
      `INSERT INTO meeting_notes (
         id, scope_key, remote_id, legacy_source_id, origin, entry_point, title,
         description, participants_json, location, mode, client_request_id, recorded_at_ms, lifecycle,
         started_at_ms, ended_at_ms, current_summary_version_id, remote_revision,
         sync_state, created_at_ms, updated_at_ms, deleted_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      note.id,
      note.scopeKey,
      note.remoteId ?? null,
      note.legacySourceId ?? null,
      note.origin,
      note.entryPoint,
      note.title,
      description,
      JSON.stringify(participants),
      location,
      mode,
      clientRequestId,
      recordedAtMs,
      note.lifecycle,
      note.startedAtMs,
      note.endedAtMs,
      note.syncState ?? (note.scopeKey === 'guest' ? 'local' : 'pending'),
      note.createdAtMs,
      note.createdAtMs,
    );
    this.touchedMeetingIds.add(note.id);
  }

  async updateMeeting(id: string, scopeKey: ScopeKey, patch: MeetingRootPatch): Promise<void> {
    assertScopeKey(scopeKey);
    if (!Number.isSafeInteger(patch.updatedAtMs) || patch.updatedAtMs < 0) {
      throw new Error('meeting update time is invalid');
    }
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'origin')) add('origin', patch.origin!);
    if (Object.prototype.hasOwnProperty.call(patch, 'entryPoint')) add('entry_point', patch.entryPoint ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) add('title', patch.title!);
    if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
      const value = patch.description ?? null;
      assertNullableBoundedText(value, 100_000, 'meeting description');
      add('description', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'participants')) {
      const value = patch.participants ?? [];
      assertMeetingParticipants(value);
      add('participants_json', JSON.stringify(value));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'location')) {
      const value = patch.location ?? null;
      assertNullableBoundedText(value, 2_000, 'meeting location');
      add('location', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
      const value = patch.mode ?? null;
      assertMeetingMode(value);
      add('mode', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'clientRequestId')) {
      const value = patch.clientRequestId?.trim() || null;
      if (value) assertRecordId(value, 'meeting client request ID');
      add('client_request_id', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'recordedAtMs')) {
      const value = patch.recordedAtMs ?? null;
      assertOptionalNonNegativeInteger(value, 'meeting recorded time');
      add('recorded_at_ms', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'remoteId')) add('remote_id', patch.remoteId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'lifecycle')) add('lifecycle', patch.lifecycle!);
    if (Object.prototype.hasOwnProperty.call(patch, 'startedAtMs')) add('started_at_ms', patch.startedAtMs ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'endedAtMs')) add('ended_at_ms', patch.endedAtMs ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'currentSummaryVersionId')) {
      add('current_summary_version_id', patch.currentSummaryVersionId ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'remoteRevision')) {
      add('remote_revision', patch.remoteRevision ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'syncState')) add('sync_state', patch.syncState!);
    if (Object.prototype.hasOwnProperty.call(patch, 'deletedAtMs')) add('deleted_at_ms', patch.deletedAtMs ?? null);
    add('updated_at_ms', patch.updatedAtMs);
    const result = await this.database.runAsync(
      `UPDATE meeting_notes SET ${assignments.join(', ')} WHERE id = ? AND scope_key = ?`,
      ...values,
      id,
      scopeKey,
    );
    if (result.changes !== 1) throw new Error('meeting does not exist in active scope');
    this.touchedMeetingIds.add(id);
  }

  async bindOccurrence(link: OccurrenceLinkRecord, snapshot: ScheduleSnapshot): Promise<void> {
    assertScopeKey(link.scopeKey);
    const seriesKey = calendarMeetingSeriesKey(link.scopeKey, link.sourceEventId);
    await this.assertMeetingInScope(link.meetingId, link.scopeKey);
    const existing = await this.database.getFirstAsync<{ meeting_id: string; lifecycle: MeetingNote['lifecycle'] }>(
      `SELECT occurrence.meeting_id, meeting.lifecycle
       FROM meeting_occurrence_links occurrence
       INNER JOIN meeting_notes meeting ON meeting.id = occurrence.meeting_id
       WHERE occurrence.scope_key = ?
         AND occurrence.calendar_source_event_id = ?
         AND occurrence.occurrence_date = ?`,
      link.scopeKey,
      link.sourceEventId,
      link.occurrenceDate,
    );
    if (existing?.meeting_id === link.meetingId) return;
    if (existing && existing.lifecycle !== 'deleted') {
      throw new Error('calendar occurrence already belongs to another meeting');
    }
    if (existing) {
      const syncState = link.scopeKey === 'guest' ? 'local_only' : 'pending';
      const rebound = await this.database.runAsync(
        `UPDATE meeting_occurrence_links SET
           meeting_id = ?, calendar_revision = ?, recurrence_segment_id = ?,
           series_key = ?, link_state = 'active', linked_at_ms = ?,
           remote_id = NULL, remote_revision = NULL, client_updated_at_ms = ?,
           sync_state = ?, last_sync_error_code = NULL, synced_at_ms = NULL
         WHERE meeting_id = ? AND scope_key = ?`,
        link.meetingId,
        link.calendarRevision,
        link.recurrenceSegmentId,
        seriesKey,
        link.linkedAtMs,
        link.linkedAtMs,
        syncState,
        existing.meeting_id,
        link.scopeKey,
      );
      if (rebound.changes !== 1) throw new Error('calendar occurrence changed during binding');
    } else {
      await this.database.runAsync(
        `INSERT INTO meeting_occurrence_links (
           meeting_id, scope_key, calendar_source_event_id, occurrence_date,
           calendar_revision, recurrence_segment_id, series_key, link_state, linked_at_ms,
           remote_id, remote_revision, client_updated_at_ms, sync_state,
           last_sync_error_code, synced_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?, NULL, NULL)`,
        link.meetingId,
        link.scopeKey,
        link.sourceEventId,
        link.occurrenceDate,
        link.calendarRevision,
        link.recurrenceSegmentId,
        seriesKey,
        link.linkedAtMs,
        link.linkedAtMs,
        link.scopeKey === 'guest' ? 'local_only' : 'pending',
      );
    }
    await this.database.runAsync(
      `INSERT INTO meeting_schedule_snapshots (
         meeting_id, event_title, planned_start_ms, planned_end_ms, all_day,
         timezone_id, location, participants_json, description,
         captured_event_revision, captured_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      link.meetingId,
      snapshot.eventTitle,
      snapshot.plannedStartMs,
      snapshot.plannedEndMs,
      snapshot.allDay ? 1 : 0,
      snapshot.timezoneId,
      snapshot.location,
      JSON.stringify(snapshot.participants),
      snapshot.description,
      snapshot.capturedEventRevision,
      snapshot.capturedAtMs,
    );
    this.touchedMeetingIds.add(link.meetingId);
  }

  async upsertStage(stage: ProcessingStage, scopeKey: ScopeKey): Promise<void> {
    assertScopeKey(scopeKey);
    assertProcessingStage(stage);
    await this.assertMeetingInScope(stage.meetingId, scopeKey);
    await this.database.runAsync(
      `INSERT INTO processing_stages (
         meeting_id, stage, status, attempt_count, progress, job_id,
         input_fingerprint, error_code, user_message_key, retryable,
         next_retry_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id, stage) DO UPDATE SET
         status = excluded.status,
         attempt_count = excluded.attempt_count,
         progress = excluded.progress,
         job_id = excluded.job_id,
         input_fingerprint = excluded.input_fingerprint,
         error_code = excluded.error_code,
         user_message_key = excluded.user_message_key,
         retryable = excluded.retryable,
         next_retry_at_ms = excluded.next_retry_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
      stage.meetingId,
      stage.stage,
      stage.status,
      stage.attemptCount,
      stage.progress,
      stage.jobId,
      stage.inputFingerprint,
      stage.errorCode,
      stage.userMessageKey,
      stage.retryable ? 1 : 0,
      stage.nextRetryAtMs,
      stage.updatedAtMs,
    );
    this.touchedMeetingIds.add(stage.meetingId);
  }

  async saveManualNote(note: ManualNoteRecord, scopeKey: ScopeKey): Promise<void> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(note.meetingId, scopeKey);
    await this.database.runAsync(
      `INSERT INTO manual_notes (
         meeting_id, content, format, revision, base_remote_revision,
         dirty, last_saved_at_ms, user_edited_at_ms
       ) VALUES (?, ?, 'plain', ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET
         content = excluded.content,
         revision = excluded.revision,
         base_remote_revision = excluded.base_remote_revision,
         dirty = excluded.dirty,
         last_saved_at_ms = excluded.last_saved_at_ms,
         user_edited_at_ms = excluded.user_edited_at_ms`,
      note.meetingId,
      note.content,
      note.revision,
      note.baseRemoteRevision,
      note.dirty ? 1 : 0,
      note.lastSavedAtMs,
      note.userEditedAtMs,
    );
    this.touchedMeetingIds.add(note.meetingId);
  }

  async markCurrentSummaryStale(meetingId: string, scopeKey: ScopeKey): Promise<boolean> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(meetingId, scopeKey);
    const result = await this.database.runAsync(
      `UPDATE summary_versions
       SET status = 'stale'
       WHERE id = (
         SELECT current_summary_version_id
         FROM meeting_notes
         WHERE id = ? AND scope_key = ?
       )
         AND meeting_id = ?
         AND status = 'ready'`,
      meetingId,
      scopeKey,
      meetingId,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(meetingId);
    return result.changes > 0;
  }

  async saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(asset.meetingId, scopeKey);
    if (!asset.id.trim() || !asset.meetingId.trim()) throw new Error('recording asset identity is invalid');
    if (asset.role !== 'primary' && asset.role !== 'secondary') throw new Error('recording asset role is invalid');
    if (!RECORDING_LOCAL_STATES.has(asset.localState)) throw new Error('recording asset state is invalid');
    if (!Number.isSafeInteger(asset.createdAtMs) || !Number.isSafeInteger(asset.updatedAtMs)) {
      throw new Error('recording asset time is invalid');
    }
    if (asset.durationMs !== null && (!Number.isSafeInteger(asset.durationMs) || asset.durationMs < 0)) {
      throw new Error('recording asset duration is invalid');
    }
    if (asset.byteSize !== null && (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0)) {
      throw new Error('recording asset size is invalid');
    }
    const existingOwner = await this.database.getFirstAsync<{ meeting_id: string }>(
      'SELECT meeting_id FROM recording_assets WHERE id = ?',
      asset.id,
    );
    if (existingOwner && existingOwner.meeting_id !== asset.meetingId) {
      throw new Error('recording asset belongs to a different meeting');
    }
    await this.database.runAsync(
      `INSERT INTO recording_assets (
         id, meeting_id, role, origin, native_session_id, local_uri, remote_asset_id,
         mime_type, file_name, byte_size, duration_ms, checksum_sha256, waveform_json,
         local_state, created_at_ms, updated_at_ms, last_verified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         origin = excluded.origin,
         native_session_id = excluded.native_session_id,
         local_uri = excluded.local_uri,
         remote_asset_id = excluded.remote_asset_id,
         mime_type = excluded.mime_type,
         file_name = excluded.file_name,
         byte_size = excluded.byte_size,
         duration_ms = excluded.duration_ms,
         checksum_sha256 = excluded.checksum_sha256,
         waveform_json = excluded.waveform_json,
         local_state = excluded.local_state,
         updated_at_ms = excluded.updated_at_ms,
         last_verified_at_ms = excluded.last_verified_at_ms`,
      asset.id,
      asset.meetingId,
      asset.role,
      asset.origin,
      asset.nativeSessionId,
      asset.localUri,
      asset.remoteAssetId,
      asset.mimeType,
      asset.fileName,
      asset.byteSize,
      asset.durationMs,
      asset.checksumSha256,
      asset.waveformJson,
      asset.localState,
      asset.createdAtMs,
      asset.updatedAtMs,
      asset.lastVerifiedAtMs,
    );
    this.touchedMeetingIds.add(asset.meetingId);
  }

  async saveTranscriptRevision(
    revision: TranscriptRevisionRecord,
    segments: readonly TranscriptSegmentRecord[],
    scopeKey: ScopeKey,
    options: SaveTranscriptRevisionOptions,
  ): Promise<void> {
    assertScopeKey(scopeKey);
    assertRecordId(revision.id, 'transcript revision ID');
    assertRecordId(revision.meetingId, 'meeting ID');
    assertNullableBoundedText(revision.remoteId, 512, 'transcript remote revision ID');
    if (!TRANSCRIPT_REVISION_KINDS.has(revision.kind) || !TRANSCRIPT_REVISION_STATUSES.has(revision.status)) {
      throw new Error('transcript revision state is invalid');
    }
    assertNonNegativeInteger(revision.createdAtMs, 'transcript revision creation time');
    assertOptionalNonNegativeInteger(revision.finalizedAtMs, 'transcript revision finalization time');
    if (revision.finalizedAtMs !== null && revision.finalizedAtMs < revision.createdAtMs) {
      throw new Error('transcript revision finalization precedes creation');
    }
    if (revision.isActive !== options.activate) {
      throw new Error('transcript revision activation contract is inconsistent');
    }
    if (options.activate && !['realtime_draft', 'finalizing', 'ready'].includes(revision.status)) {
      throw new Error('inactive transcript state cannot become active');
    }
    if (revision.kind !== 'realtime_draft' && segments.length === 0) {
      throw new Error('final transcript revision cannot be empty');
    }
    const meeting = await this.getMeeting(revision.meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept transcript content in active scope');
    }
    const segmentIds = new Set<string>();
    const sourceSegmentIds = new Set<string>();
    const ordinals = new Set<number>();
    for (const segment of segments) {
      assertRecordId(segment.id, 'transcript segment ID');
      if (segment.meetingId !== revision.meetingId) {
        throw new Error('transcript segment belongs to a different meeting');
      }
      assertNonNegativeInteger(segment.ordinal, 'transcript segment ordinal');
      assertNonNegativeInteger(segment.startMs, 'transcript segment start');
      assertNonNegativeInteger(segment.endMs, 'transcript segment end');
      assertNonNegativeInteger(segment.createdAtMs, 'transcript segment creation time');
      if (segment.endMs < segment.startMs) throw new Error('transcript segment end precedes start');
      if (segment.confidence !== null && (
        !Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1
      )) {
        throw new Error('transcript segment confidence is invalid');
      }
      if (segmentIds.has(segment.id) || ordinals.has(segment.ordinal)) {
        throw new Error('transcript revision contains duplicate segment identity');
      }
      if (segment.sourceId && sourceSegmentIds.has(segment.sourceId)) {
        throw new Error('transcript revision contains duplicate source segment identity');
      }
      segmentIds.add(segment.id);
      if (segment.sourceId) sourceSegmentIds.add(segment.sourceId);
      ordinals.add(segment.ordinal);
    }
    if (segments.some((segment, index) => segment.ordinal !== index)) {
      throw new Error('transcript segment ordinals must be contiguous and ordered');
    }

    const existingRow = await this.database.getFirstAsync<TranscriptRevisionRow>(
      'SELECT * FROM transcript_revisions WHERE id = ?',
      revision.id,
    );
    if (existingRow && existingRow.meeting_id !== revision.meetingId) {
      throw new Error('transcript revision belongs to a different meeting');
    }
    if (existingRow && existingRow.kind !== revision.kind) {
      throw new Error('transcript revision kind cannot be changed');
    }
    if (existingRow?.remote_id && revision.remoteId && existingRow.remote_id !== revision.remoteId) {
      throw new Error('transcript remote revision identity cannot be changed');
    }
    if (existingRow && revision.kind !== 'realtime_draft') {
      const existing = transcriptRevisionFromRow(existingRow);
      if (
        existing.kind !== revision.kind ||
        existing.status !== revision.status ||
        existing.sourceProvider !== revision.sourceProvider ||
        existing.sourceModel !== revision.sourceModel ||
        existing.createdAtMs !== revision.createdAtMs ||
        existing.finalizedAtMs !== revision.finalizedAtMs
      ) {
        throw new Error('immutable transcript revision cannot be replaced');
      }
      const rows = await this.database.getAllAsync<TranscriptSegmentRow>(
        'SELECT * FROM transcript_segments WHERE revision_id = ? ORDER BY ordinal',
        revision.id,
      );
      const matches = rows.length === segments.length && rows.every((row, index) => {
        const segment = segments[index];
        return row.id === segment.id && row.meeting_id === segment.meetingId
          && row.ordinal === segment.ordinal && row.start_ms === segment.startMs
          && row.end_ms === segment.endMs && row.speaker_cluster_id === segment.speakerClusterId
          && row.speaker_profile_id === segment.speakerProfileId
          && row.speaker_label === segment.speakerLabel && row.text === segment.text
          && row.normalized_text === segment.normalizedText && row.confidence === segment.confidence
          && row.is_final === (segment.isFinal ? 1 : 0) && row.created_at_ms === segment.createdAtMs;
      });
      if (!matches) throw new Error('immutable transcript segments cannot be replaced');
      for (const [index, row] of rows.entries()) {
        const sourceId = segments[index].sourceId;
        if (row.source_segment_id && row.source_segment_id !== sourceId) {
          throw new Error('immutable transcript source segment identity cannot be replaced');
        }
        if (!row.source_segment_id && sourceId) {
          await this.database.runAsync(
            'UPDATE transcript_segments SET source_segment_id = ? WHERE id = ?',
            sourceId,
            row.id,
          );
        }
      }
      if (!existingRow.remote_id && revision.remoteId) {
        await this.database.runAsync(
          'UPDATE transcript_revisions SET remote_id = ? WHERE id = ?',
          revision.remoteId,
          revision.id,
        );
      }
    }

    if (options.activate) {
      await this.database.runAsync(
        'UPDATE transcript_revisions SET is_active = 0 WHERE meeting_id = ? AND id != ?',
        revision.meetingId,
        revision.id,
      );
    }
    if (!existingRow) {
      await this.database.runAsync(
        `INSERT INTO transcript_revisions (
           id, meeting_id, remote_id, kind, status, source_provider, source_model,
           is_active, created_at_ms, finalized_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision.id,
        revision.meetingId,
        revision.remoteId,
        revision.kind,
        revision.status,
        revision.sourceProvider,
        revision.sourceModel,
        options.activate ? 1 : 0,
        revision.createdAtMs,
        revision.finalizedAtMs,
      );
    } else if (revision.kind === 'realtime_draft') {
      if (!options.replaceSegments) {
        throw new Error('mutable transcript revision requires an explicit segment replacement');
      }
      const citationCount = Number((await this.database.getFirstAsync<{ count: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM summary_citations citation
            INNER JOIN transcript_segments segment ON segment.id = citation.segment_id
            WHERE segment.revision_id = ?) +
           (SELECT COUNT(*) FROM action_item_citations citation
            INNER JOIN transcript_segments segment ON segment.id = citation.segment_id
            WHERE segment.revision_id = ?)
         ) AS count`,
        revision.id,
        revision.id,
      ))?.count ?? 0);
      if (citationCount > 0) throw new Error('cited transcript draft cannot be replaced');
      await this.database.runAsync('DELETE FROM transcript_segments WHERE revision_id = ?', revision.id);
      await this.database.runAsync(
        `UPDATE transcript_revisions SET
           remote_id = COALESCE(remote_id, ?), status = ?, source_provider = ?,
           source_model = ?, is_active = ?, finalized_at_ms = ?
         WHERE id = ?`,
        revision.remoteId,
        revision.status,
        revision.sourceProvider,
        revision.sourceModel,
        options.activate ? 1 : 0,
        revision.finalizedAtMs,
        revision.id,
      );
    } else if (existingRow.is_active !== (options.activate ? 1 : 0)) {
      await this.database.runAsync(
        'UPDATE transcript_revisions SET is_active = ? WHERE id = ?',
        options.activate ? 1 : 0,
        revision.id,
      );
    }

    if (!existingRow || revision.kind === 'realtime_draft') {
      for (const segment of segments) {
        await this.database.runAsync(
          `INSERT INTO transcript_segments (
             id, revision_id, meeting_id, source_segment_id, ordinal, start_ms, end_ms,
             speaker_cluster_id, speaker_profile_id, speaker_label,
             speaker_label_override, text, normalized_text, confidence,
             is_final, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          segment.id,
          revision.id,
          segment.meetingId,
          segment.sourceId,
          segment.ordinal,
          segment.startMs,
          segment.endMs,
          segment.speakerClusterId,
          segment.speakerProfileId,
          segment.speakerLabel,
          segment.speakerLabelOverride,
          segment.text,
          segment.normalizedText,
          segment.confidence,
          segment.isFinal ? 1 : 0,
          segment.createdAtMs,
        );
      }
    }
    if (options.activate) {
      await this.reconcileMeetingMarkers(
        revision.meetingId,
        scopeKey,
        revision.finalizedAtMs ?? revision.createdAtMs,
      );
    }
    this.touchedMeetingIds.add(revision.meetingId);
  }

  async applySpeakerCorrection(
    input: ApplySpeakerCorrectionInput,
    scopeKey: ScopeKey,
  ): Promise<ApplySpeakerCorrectionResult> {
    assertScopeKey(scopeKey);
    assertRecordId(input.correctionId, 'speaker correction ID');
    assertRecordId(input.assignmentIdPrefix, 'speaker assignment ID');
    assertRecordId(input.meetingId, 'speaker correction meeting ID');
    assertRecordId(input.transcriptRevisionId, 'speaker correction transcript revision ID');
    assertRecordId(input.targetSegmentId, 'speaker correction segment ID');
    if (input.clusterRecordId !== null) assertRecordId(input.clusterRecordId, 'speaker cluster ID');
    assertNullableBoundedText(input.sourceClusterId, 512, 'speaker source cluster ID');
    assertNullableBoundedText(input.speakerProfileId, 512, 'speaker profile ID');
    assertNonNegativeInteger(input.createdAtMs, 'speaker correction time');
    if (input.scope !== 'segment' && input.scope !== 'cluster') {
      throw new Error('speaker correction scope is invalid');
    }
    if (input.scope === 'cluster' && input.sourceClusterId === null) {
      throw new Error('speaker cluster correction has no source cluster');
    }
    if (input.consentToProfileUpdate) {
      throw new Error('local speaker correction cannot update a voice profile');
    }
    if (input.syncState !== 'local_only' && input.syncState !== 'pending') {
      throw new Error('speaker correction sync state is invalid');
    }
    const displayName = input.displayName.trim();
    if (
      !displayName || displayName !== input.displayName || displayName.length > 120
      || /[\u0000-\u001f\u007f]/.test(displayName)
    ) throw new Error('speaker display name is invalid');

    await this.assertMeetingInScope(input.meetingId, scopeKey);
    const revision = await this.getTranscriptRevision(input.transcriptRevisionId, scopeKey);
    if (
      !revision || revision.meetingId !== input.meetingId || !revision.isActive
      || revision.kind === 'realtime_draft'
    ) throw new Error('speaker correction transcript revision is not stable and active');
    const target = await this.database.getFirstAsync<TranscriptSegmentRow>(
      `SELECT segment.* FROM transcript_segments segment
       INNER JOIN meeting_notes meeting ON meeting.id = segment.meeting_id
       WHERE segment.id = ? AND segment.revision_id = ?
         AND segment.meeting_id = ? AND meeting.scope_key = ?`,
      input.targetSegmentId,
      input.transcriptRevisionId,
      input.meetingId,
      scopeKey,
    );
    if (!target) throw new Error('speaker correction target no longer exists');
    if (target.speaker_cluster_id !== input.sourceClusterId) {
      throw new Error('speaker correction cluster changed');
    }

    const existing = await this.database.getFirstAsync<SpeakerCorrectionRow>(
      'SELECT * FROM speaker_corrections WHERE id = ?',
      input.correctionId,
    );
    if (existing) {
      const same = existing.scope_key === scopeKey
        && existing.meeting_id === input.meetingId
        && existing.transcript_revision_id === input.transcriptRevisionId
        && existing.scope === input.scope
        && existing.target_segment_id === input.targetSegmentId
        && existing.source_cluster_id === input.sourceClusterId
        && existing.speaker_profile_id === input.speakerProfileId
        && existing.display_name === displayName
        && existing.consent_to_profile_update === 0;
      if (!same) throw new Error('speaker correction identity was reused');
      const assigned = await this.database.getAllAsync<{ segment_id: string }>(
        `SELECT segment_id FROM speaker_assignments
         WHERE correction_id = ? ORDER BY segment_id`,
        input.correctionId,
      );
      if (assigned.length === 0) throw new Error('speaker correction has no assignments');
      return {
        correctionId: existing.id,
        assignmentRevision: existing.assignment_revision,
        affectedSegmentIds: assigned.map(row => row.segment_id),
        applied: false,
      };
    }

    const affected = input.scope === 'cluster'
      ? await this.database.getAllAsync<TranscriptSegmentRow>(
        `SELECT * FROM transcript_segments
         WHERE meeting_id = ? AND revision_id = ? AND speaker_cluster_id = ?
         ORDER BY ordinal, id`,
        input.meetingId,
        input.transcriptRevisionId,
        input.sourceClusterId,
      )
      : [target];
    if (affected.length === 0) throw new Error('speaker correction has no affected segments');

    let clusterRecordId: string | null = null;
    if (input.sourceClusterId !== null) {
      if (input.clusterRecordId === null) throw new Error('speaker cluster identity is missing');
      await this.database.runAsync(
        `INSERT OR IGNORE INTO speaker_clusters (
           id, meeting_id, transcript_revision_id, source_cluster_id, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        input.clusterRecordId,
        input.meetingId,
        input.transcriptRevisionId,
        input.sourceClusterId,
        input.createdAtMs,
      );
      const cluster = await this.database.getFirstAsync<{
        id: string;
        meeting_id: string;
        transcript_revision_id: string;
        source_cluster_id: string;
      }>(
        `SELECT id, meeting_id, transcript_revision_id, source_cluster_id
         FROM speaker_clusters
         WHERE transcript_revision_id = ? AND source_cluster_id = ?`,
        input.transcriptRevisionId,
        input.sourceClusterId,
      );
      if (
        !cluster || cluster.meeting_id !== input.meetingId
        || cluster.transcript_revision_id !== input.transcriptRevisionId
        || cluster.source_cluster_id !== input.sourceClusterId
      ) throw new Error('speaker cluster identity is inconsistent');
      clusterRecordId = cluster.id;
    }

    const revisionRow = await this.database.getFirstAsync<{ revision: number }>(
      `SELECT COALESCE(MAX(assignment_revision), 0) AS revision
       FROM speaker_corrections WHERE meeting_id = ?`,
      input.meetingId,
    );
    const baseRevision = Number(revisionRow?.revision ?? 0);
    assertNonNegativeInteger(baseRevision, 'speaker assignment base revision');
    const assignmentRevision = baseRevision + 1;
    if (!Number.isSafeInteger(assignmentRevision)) {
      throw new Error('speaker assignment revision overflow');
    }
    await this.database.runAsync(
      `INSERT INTO speaker_corrections (
         id, scope_key, meeting_id, transcript_revision_id, scope,
         target_segment_id, source_cluster_id, speaker_profile_id,
         display_name, consent_to_profile_update, base_revision,
         assignment_revision, sync_state, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      input.correctionId,
      scopeKey,
      input.meetingId,
      input.transcriptRevisionId,
      input.scope,
      input.targetSegmentId,
      input.sourceClusterId,
      input.speakerProfileId,
      displayName,
      baseRevision,
      assignmentRevision,
      input.syncState,
      input.createdAtMs,
      input.createdAtMs,
    );
    for (const [index, segment] of affected.entries()) {
      const assignmentId = `${input.assignmentIdPrefix}:${index}`;
      assertRecordId(assignmentId, 'speaker assignment ID');
      await this.database.runAsync(
        `INSERT INTO speaker_assignments (
           id, correction_id, meeting_id, transcript_revision_id, segment_id,
           speaker_cluster_id, speaker_profile_id, display_name,
           assignment_revision, source, user_locked, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?)`,
        assignmentId,
        input.correctionId,
        input.meetingId,
        input.transcriptRevisionId,
        segment.id,
        clusterRecordId,
        input.speakerProfileId,
        displayName,
        assignmentRevision,
        input.createdAtMs,
      );
      const updated = await this.database.runAsync(
        `UPDATE transcript_segments SET speaker_label_override = ?
         WHERE id = ? AND meeting_id = ? AND revision_id = ?`,
        displayName,
        segment.id,
        input.meetingId,
        input.transcriptRevisionId,
      );
      if (updated.changes !== 1) throw new Error('speaker assignment target changed concurrently');
    }
    this.touchedMeetingIds.add(input.meetingId);
    return {
      correctionId: input.correctionId,
      assignmentRevision,
      affectedSegmentIds: affected.map(segment => segment.id),
      applied: true,
    };
  }

  async saveSummaryVersion(
    version: SummaryVersionRecord,
    sections: readonly SummarySectionRecord[],
    actions: readonly ActionItemRecord[],
    scopeKey: ScopeKey,
    options: SaveSummaryVersionOptions,
  ): Promise<void> {
    assertScopeKey(scopeKey);
    assertRecordId(version.id, 'summary version ID');
    assertRecordId(version.meetingId, 'meeting ID');
    if (!version.templateId.trim() || !version.inputFingerprint.trim()) {
      throw new Error('summary version contract is invalid');
    }
    if (!SUMMARY_VERSION_STATUSES.has(version.status)) throw new Error('summary version state is invalid');
    assertNonNegativeInteger(version.templateRevision, 'summary template revision');
    assertNonNegativeInteger(version.manualNoteRevision, 'summary note revision');
    assertNonNegativeInteger(version.createdAtMs, 'summary creation time');
    assertOptionalNonNegativeInteger(version.completedAtMs, 'summary completion time');
    if (version.completedAtMs !== null && version.completedAtMs < version.createdAtMs) {
      throw new Error('summary completion precedes creation');
    }
    if (options.activate && version.status !== 'ready' && version.status !== 'stale') {
      throw new Error('only a readable summary version can be activated');
    }
    const meeting = await this.getMeeting(version.meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept summary content in active scope');
    }
    if (version.transcriptRevisionId) {
      const transcript = await this.getTranscriptRevision(version.transcriptRevisionId, scopeKey);
      if (!transcript || transcript.meetingId !== version.meetingId) {
        throw new Error('summary transcript revision is outside the active meeting scope');
      }
    }
    if (version.supersedesVersionId) {
      const superseded = await this.getSummaryVersion(version.supersedesVersionId, scopeKey);
      if (!superseded || superseded.meetingId !== version.meetingId) {
        throw new Error('superseded summary version is outside the active meeting scope');
      }
    }
    const sectionIds = new Set<string>();
    const sectionKeys = new Set<string>();
    const sectionOrdinals = new Set<number>();
    for (const section of sections) {
      assertRecordId(section.id, 'summary section ID');
      if (section.versionId !== version.id || !section.stableKey.trim() || !section.kind.trim()) {
        throw new Error('summary section contract is invalid');
      }
      assertNonNegativeInteger(section.ordinal, 'summary section ordinal');
      assertOptionalNonNegativeInteger(section.userEditedAtMs, 'summary section edit time');
      if (
        sectionIds.has(section.id) || sectionKeys.has(section.stableKey)
        || sectionOrdinals.has(section.ordinal)
      ) {
        throw new Error('summary version contains duplicate section identity');
      }
      sectionIds.add(section.id);
      sectionKeys.add(section.stableKey);
      sectionOrdinals.add(section.ordinal);
    }
    if (sections.some((section, index) => section.ordinal !== index)) {
      throw new Error('summary section ordinals must be contiguous and ordered');
    }
    if (version.status === 'ready' && sections.length === 0) {
      throw new Error('ready summary version cannot be empty');
    }
    const citations = options.citations ?? [];
    const citationIds = new Set<string>();
    const citationOrdinals = new Map<string, Set<number>>();
    if (citations.length > 0 && !version.transcriptRevisionId) {
      throw new Error('cited summary requires a transcript revision');
    }
    for (const citation of citations) {
      assertRecordId(citation.id, 'summary citation ID');
      assertRecordId(citation.segmentId, 'summary citation segment ID');
      if (!sectionIds.has(citation.sectionId)) {
        throw new Error('summary citation references an unknown section');
      }
      assertNonNegativeInteger(citation.startMs, 'summary citation start time');
      assertNonNegativeInteger(citation.endMs, 'summary citation end time');
      assertNonNegativeInteger(citation.ordinal, 'summary citation ordinal');
      if (citation.endMs < citation.startMs) throw new Error('summary citation time range is invalid');
      if (citationIds.has(citation.id)) throw new Error('summary version contains duplicate citation identity');
      citationIds.add(citation.id);
      const ordinals = citationOrdinals.get(citation.sectionId) ?? new Set<number>();
      if (ordinals.has(citation.ordinal)) throw new Error('summary section contains duplicate citation ordinal');
      ordinals.add(citation.ordinal);
      citationOrdinals.set(citation.sectionId, ordinals);
      const segment = await this.database.getFirstAsync<{
        meeting_id: string;
        revision_id: string;
        start_ms: number;
        end_ms: number;
      }>(
        `SELECT segment.meeting_id, segment.revision_id, segment.start_ms, segment.end_ms
         FROM transcript_segments segment
         INNER JOIN meeting_notes meeting ON meeting.id = segment.meeting_id
         WHERE segment.id = ? AND meeting.scope_key = ?`,
        citation.segmentId,
        scopeKey,
      );
      if (
        !segment
        || segment.meeting_id !== version.meetingId
        || segment.revision_id !== version.transcriptRevisionId
      ) {
        throw new Error('summary citation is outside the locked transcript revision');
      }
      const segmentEndMs = Math.max(segment.start_ms, segment.end_ms);
      if (citation.startMs < segment.start_ms || citation.endMs > segmentEndMs) {
        throw new Error('summary citation is outside its transcript segment time range');
      }
    }
    citationOrdinals.forEach(ordinals => {
      const ordered = [...ordinals].sort((left, right) => left - right);
      if (ordered.some((ordinal, index) => ordinal !== index)) {
        throw new Error('summary citation ordinals must be contiguous per section');
      }
    });
    const actionIds = new Set<string>();
    for (const action of actions) {
      assertRecordId(action.id, 'meeting action ID');
      if (action.meetingId !== version.meetingId || !action.content.trim()) {
        throw new Error('meeting action contract is invalid');
      }
      if (action.sourceKind !== 'generated' && action.sourceKind !== 'manual' && action.sourceKind !== 'marker') {
        throw new Error('meeting action source is invalid');
      }
      if (action.sourceKind === 'generated' && action.sourceSummaryVersionId !== version.id) {
        throw new Error('generated action must reference its summary version');
      }
      actionStatus(action.status);
      assertOptionalNonNegativeInteger(action.dueAtMs, 'meeting action due time');
      assertOptionalNonNegativeInteger(action.sourceStartMs, 'meeting action source time');
      assertOptionalNonNegativeInteger(action.userEditedAtMs, 'meeting action edit time');
      assertOptionalNonNegativeInteger(action.completedAtMs, 'meeting action completion time');
      assertNonNegativeInteger(action.createdAtMs, 'meeting action creation time');
      assertNonNegativeInteger(action.updatedAtMs, 'meeting action update time');
      if (action.status === 'completed' && action.completedAtMs === null) {
        throw new Error('completed meeting action requires a completion time');
      }
      if (actionIds.has(action.id)) throw new Error('summary version contains duplicate action identity');
      actionIds.add(action.id);
      if (action.sourceSegmentId) {
        const source = await this.database.getFirstAsync<{ meeting_id: string; revision_id: string }>(
          `SELECT segment.meeting_id, segment.revision_id FROM transcript_segments segment
           INNER JOIN meeting_notes meeting ON meeting.id = segment.meeting_id
           WHERE segment.id = ? AND meeting.scope_key = ?`,
          action.sourceSegmentId,
          scopeKey,
        );
        if (
          !source
          || source.meeting_id !== version.meetingId
          || (action.sourceKind === 'generated' && source.revision_id !== version.transcriptRevisionId)
        ) {
          throw new Error('meeting action source segment is outside the active meeting scope');
        }
      }
    }

    const existingRow = await this.database.getFirstAsync<SummaryVersionRow>(
      'SELECT * FROM summary_versions WHERE id = ?',
      version.id,
    );
    if (existingRow && existingRow.meeting_id !== version.meetingId) {
      throw new Error('summary version belongs to a different meeting');
    }
    if (existingRow) {
      const existing = summaryVersionFromRow(existingRow);
      if (
        existing.inputFingerprint !== version.inputFingerprint
        || existing.templateId !== version.templateId
        || existing.templateRevision !== version.templateRevision
        || existing.transcriptRevisionId !== version.transcriptRevisionId
        || existing.manualNoteRevision !== version.manualNoteRevision
        || existing.scheduleSnapshotHash !== version.scheduleSnapshotHash
        || existing.status !== version.status
        || existing.generatedBy !== version.generatedBy
        || existing.supersedesVersionId !== version.supersedesVersionId
        || existing.createdAtMs !== version.createdAtMs
        || existing.completedAtMs !== version.completedAtMs
      ) {
        throw new Error('immutable summary version cannot be replaced');
      }
      const rows = await this.database.getAllAsync<SummarySectionRow>(
        'SELECT * FROM summary_sections WHERE version_id = ? ORDER BY ordinal',
        version.id,
      );
      const sectionsMatch = rows.length === sections.length && rows.every((row, index) => {
        const section = sections[index];
        return row.id === section.id && row.version_id === section.versionId
          && row.stable_key === section.stableKey && row.kind === section.kind
          && row.title === section.title && row.generated_text === section.generatedText
          && row.ordinal === section.ordinal;
      });
      if (!sectionsMatch) throw new Error('immutable summary sections cannot be replaced');
      const citationRows = await this.database.getAllAsync<SummaryCitationRow>(
        `SELECT citation.* FROM summary_citations citation
         INNER JOIN summary_sections section ON section.id = citation.section_id
         WHERE section.version_id = ?
         ORDER BY section.ordinal, citation.ordinal, citation.id`,
        version.id,
      );
      const citationsMatch = citationRows.length === citations.length && citationRows.every((row, index) => {
        const citation = citations[index];
        return row.id === citation.id && row.section_id === citation.sectionId
          && row.segment_id === citation.segmentId && row.start_ms === citation.startMs
          && row.end_ms === citation.endMs && row.quote_hash === citation.quoteHash
          && row.ordinal === citation.ordinal;
      });
      if (!citationsMatch) throw new Error('immutable summary citations cannot be replaced');
    } else {
      await this.database.runAsync(
        `INSERT INTO summary_versions (
           id, meeting_id, template_id, template_revision, input_fingerprint,
           transcript_revision_id, manual_note_revision, schedule_snapshot_hash,
           status, generated_by, user_edited, supersedes_version_id,
           created_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        version.id,
        version.meetingId,
        version.templateId,
        version.templateRevision,
        version.inputFingerprint,
        version.transcriptRevisionId,
        version.manualNoteRevision,
        version.scheduleSnapshotHash,
        version.status,
        version.generatedBy,
        version.userEdited ? 1 : 0,
        version.supersedesVersionId,
        version.createdAtMs,
        version.completedAtMs,
      );
      for (const section of sections) {
        await this.database.runAsync(
          `INSERT INTO summary_sections (
             id, version_id, stable_key, kind, title, generated_text,
             user_text, ordinal, user_edited_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          section.id,
          section.versionId,
          section.stableKey,
          section.kind,
          section.title,
          section.generatedText,
          section.userText,
          section.ordinal,
          section.userEditedAtMs,
        );
      }
      for (const citation of citations) {
        await this.database.runAsync(
          `INSERT INTO summary_citations (
             id, section_id, segment_id, start_ms, end_ms, quote_hash, ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          citation.id,
          citation.sectionId,
          citation.segmentId,
          citation.startMs,
          citation.endMs,
          citation.quoteHash,
          citation.ordinal,
        );
      }
    }

    for (const action of actions) {
      const existingAction = await this.database.getFirstAsync<{
        meeting_id: string;
        status: ActionItemRecord['status'];
        user_edited_at_ms: number | null;
        generation_fingerprint: string | null;
      }>(
        'SELECT meeting_id, status, user_edited_at_ms, generation_fingerprint FROM action_items WHERE id = ?',
        action.id,
      );
      if (existingAction && existingAction.meeting_id !== action.meetingId) {
        throw new Error('meeting action belongs to a different meeting');
      }
      if (
        existingAction?.generation_fingerprint && action.generationFingerprint
        && existingAction.generation_fingerprint !== action.generationFingerprint
      ) {
        throw new Error('meeting action identity changed its generation fingerprint');
      }
      if (!existingAction) {
        await this.database.runAsync(
          `INSERT INTO action_items (
             id, meeting_id, remote_id, content, status, assignee_text, due_at_ms,
             source_kind, source_summary_version_id, source_segment_id, source_start_ms,
             generation_fingerprint, user_edited_at_ms, completed_at_ms,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          action.id,
          action.meetingId,
          action.remoteId,
          action.content,
          action.status,
          action.assigneeText,
          action.dueAtMs,
          action.sourceKind,
          action.sourceSummaryVersionId,
          action.sourceSegmentId,
          action.sourceStartMs,
          action.generationFingerprint,
          action.userEditedAtMs,
          action.completedAtMs,
          action.createdAtMs,
          action.updatedAtMs,
        );
      } else if (existingAction.user_edited_at_ms === null && existingAction.status === 'pending') {
        await this.database.runAsync(
          `UPDATE action_items SET
             source_summary_version_id = ?, generation_fingerprint = ?, updated_at_ms = ?
           WHERE id = ?`,
          action.sourceSummaryVersionId,
          action.generationFingerprint,
          action.updatedAtMs,
          action.id,
        );
      }
    }
    if (options.activate) {
      await this.updateMeeting(version.meetingId, scopeKey, {
        currentSummaryVersionId: version.id,
        updatedAtMs: Math.max(meeting.updatedAtMs, version.completedAtMs ?? version.createdAtMs),
      });
    }
    this.touchedMeetingIds.add(version.meetingId);
  }

  async insertOutbox(operation: SyncOperationRecord): Promise<boolean> {
    assertScopeKey(operation.scopeKey);
    const operationId = operation.operationId.trim();
    const aggregateType = operation.aggregateType.trim();
    const aggregateId = operation.aggregateId.trim();
    const operationType = operation.operationType.trim();
    if (!operationId || !aggregateType || !aggregateId || !operationType) {
      throw new Error('meeting sync operation identity is invalid');
    }
    if (!Number.isSafeInteger(operation.createdAtMs) || operation.createdAtMs < 0) {
      throw new Error('meeting sync operation time is invalid');
    }
    if (!operation.payloadJson) throw new Error('meeting sync operation payload is invalid');
    const existing = await this.database.getFirstAsync<SyncOutboxRow>(
      `SELECT operation_id, scope_key, aggregate_type, aggregate_id,
              operation_type, base_revision, payload_json
       FROM sync_outbox WHERE operation_id = ?`,
      operationId,
    );
    if (existing) {
      const unchanged = existing.scope_key === operation.scopeKey
        && existing.aggregate_type === aggregateType
        && existing.aggregate_id === aggregateId
        && existing.operation_type === operationType
        && existing.base_revision === operation.baseRevision
        && existing.payload_json === operation.payloadJson;
      if (!unchanged) throw new Error('meeting sync operation identity was reused');
      return false;
    }
    await this.database.runAsync(
      `INSERT INTO sync_outbox (
         operation_id, scope_key, aggregate_type, aggregate_id, operation_type,
         base_revision, payload_json, status, attempt_count, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      operationId,
      operation.scopeKey,
      aggregateType,
      aggregateId,
      operationType,
      operation.baseRevision,
      operation.payloadJson,
      operation.createdAtMs,
      operation.createdAtMs,
    );
    return true;
  }

  async advanceCanonicalWrite(scopeKey: ScopeKey, updatedAtMs: number): Promise<number> {
    assertScopeKey(scopeKey);
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new Error('meeting canonical write time is invalid');
    }
    const existingRow = await this.database.getFirstAsync<MeetingScopeWriteStateRow>(
      'SELECT * FROM meeting_scope_write_state WHERE scope_key = ?',
      scopeKey,
    );
    if (!existingRow) {
      await this.database.runAsync(
        `INSERT INTO meeting_scope_write_state (
           scope_key, write_owner, canonical_revision, legacy_mirror_revision,
           legacy_mirror_status, last_error_code, updated_at_ms
         ) VALUES (?, 'canonical', 1, 0, 'pending', NULL, ?)`,
        scopeKey,
        updatedAtMs,
      );
      return 1;
    }
    const existing = scopeWriteStateFromRow(existingRow);
    const canonicalRevision = existing.canonicalRevision + 1;
    if (!Number.isSafeInteger(canonicalRevision)) {
      throw new Error('meeting canonical revision overflow');
    }
    const result = await this.database.runAsync(
      `UPDATE meeting_scope_write_state SET
         write_owner = 'canonical',
         canonical_revision = ?,
         legacy_mirror_status = 'pending',
         last_error_code = NULL,
         updated_at_ms = ?
       WHERE scope_key = ? AND canonical_revision = ?`,
      canonicalRevision,
      Math.max(existing.updatedAtMs, updatedAtMs),
      scopeKey,
      existing.canonicalRevision,
    );
    if (result.changes !== 1) throw new Error('meeting canonical revision changed during transaction');
    return canonicalRevision;
  }

  async markLegacyMirror(
    scopeKey: ScopeKey,
    canonicalRevision: number,
    status: 'clean' | 'failed',
    errorCode: string | null,
    updatedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 1) {
      throw new Error('meeting canonical revision is invalid');
    }
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new Error('meeting legacy mirror time is invalid');
    }
    const normalizedError = errorCode?.trim() || null;
    if (
      status === 'clean' && normalizedError !== null
      || status === 'failed' && (
        normalizedError === null
        || normalizedError.length > 160
        || /[\u0000-\u001f\u007f]/.test(normalizedError)
      )
    ) throw new Error('meeting legacy mirror error code is invalid');
    const result = await this.database.runAsync(
      `UPDATE meeting_scope_write_state SET
         legacy_mirror_revision = CASE WHEN ? = 'clean' THEN ? ELSE legacy_mirror_revision END,
         legacy_mirror_status = ?,
         last_error_code = ?,
         updated_at_ms = MAX(updated_at_ms, ?)
       WHERE scope_key = ?
         AND write_owner = 'canonical'
         AND canonical_revision = ?
         AND (legacy_mirror_status != 'clean' OR ? = 'clean')`,
      status,
      canonicalRevision,
      status,
      normalizedError,
      updatedAtMs,
      scopeKey,
      canonicalRevision,
      status,
    );
    return result.changes === 1;
  }
}

export class SqliteMeetingNoteRepository implements MeetingNoteRepository {
  private readonly meetingListeners = new Map<ScopeKey, Map<string, Set<() => void>>>();
  private readonly listListeners = new Map<ScopeKey, Set<() => void>>();

  async transaction<T>(work: (transaction: MeetingTransaction) => Promise<T>): Promise<T> {
    let touchedMeetingIds: readonly string[] = [];
    const result = await withMeetingDatabaseTransaction<T>(async database => {
      const transaction = new SqliteMeetingTransaction(database);
      const value = await work(transaction);
      touchedMeetingIds = [...transaction.touchedMeetingIds];
      return value;
    });
    if (touchedMeetingIds.length > 0) this.notify(touchedMeetingIds);
    return result;
  }

  async get(id: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const noteRow = await database.getFirstAsync<MeetingRow>(
      'SELECT * FROM meeting_notes WHERE id = ? AND scope_key = ?',
      id,
      scopeKey,
    );
    if (!noteRow) return null;
    return this.aggregateFromRow(database, noteRow, scopeKey);
  }

  async findByOccurrence(
    reference: { sourceEventId: string; occurrenceDate: string },
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const noteRow = await database.getFirstAsync<MeetingRow>(
      `SELECT meeting.* FROM meeting_notes meeting
       INNER JOIN meeting_occurrence_links link ON link.meeting_id = meeting.id
       WHERE meeting.scope_key = ?
         AND link.scope_key = ?
         AND link.calendar_source_event_id = ?
         AND link.occurrence_date = ?
       LIMIT 1`,
      scopeKey,
      scopeKey,
      reference.sourceEventId,
      reference.occurrenceDate,
    );
    if (!noteRow) return null;
    return this.aggregateFromRow(database, noteRow, scopeKey);
  }

  async findPreviousEndedSeriesMeeting(
    reference: { sourceEventId: string; occurrenceDate: string },
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const seriesKey = calendarMeetingSeriesKey(scopeKey, reference.sourceEventId);
    const noteRow = await database.getFirstAsync<MeetingRow>(
      `SELECT meeting.* FROM meeting_notes meeting
       INNER JOIN meeting_occurrence_links link ON link.meeting_id = meeting.id
       WHERE meeting.scope_key = ?
         AND link.scope_key = ?
         AND link.series_key = ?
         AND link.occurrence_date < ?
         AND link.link_state = 'active'
         AND meeting.lifecycle = 'ended'
       ORDER BY link.occurrence_date DESC,
         COALESCE(meeting.ended_at_ms, meeting.updated_at_ms) DESC,
         meeting.id DESC
       LIMIT 1`,
      scopeKey,
      scopeKey,
      seriesKey,
      reference.occurrenceDate,
    );
    return noteRow ? this.aggregateFromRow(database, noteRow, scopeKey) : null;
  }

  async listPendingSeriesActions(
    reference: { sourceEventId: string; occurrenceDate: string },
    scopeKey: ScopeKey,
    limit: number,
  ): Promise<readonly MeetingSeriesActionRecord[]> {
    assertScopeKey(scopeKey);
    const requestedLimit = Math.trunc(limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
      throw new Error('meeting series action limit is invalid');
    }
    const database = await openMeetingDatabase();
    const seriesKey = calendarMeetingSeriesKey(scopeKey, reference.sourceEventId);
    const rows = await database.getAllAsync<MeetingSeriesActionRow>(
      `SELECT action.*, segment.source_segment_id AS source_segment_source_id,
         meeting.id AS canonical_meeting_id,
         COALESCE(meeting.legacy_source_id, meeting.remote_id, meeting.id) AS legacy_meeting_id,
         meeting.remote_id AS meeting_remote_id,
         meeting.title AS meeting_title,
         link.occurrence_date AS occurrence_date
       FROM action_items action
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       INNER JOIN meeting_occurrence_links link ON link.meeting_id = meeting.id
       LEFT JOIN transcript_segments segment ON segment.id = action.source_segment_id
       WHERE meeting.scope_key = ?
         AND link.scope_key = ?
         AND link.series_key = ?
         AND link.occurrence_date < ?
         AND link.link_state = 'active'
         AND meeting.lifecycle = 'ended'
         AND action.status = 'pending'
       ORDER BY CASE WHEN action.due_at_ms IS NULL THEN 1 ELSE 0 END,
         action.due_at_ms,
         link.occurrence_date DESC,
         action.created_at_ms,
         action.id
       LIMIT ?`,
      scopeKey,
      scopeKey,
      seriesKey,
      reference.occurrenceDate,
      requestedLimit,
    );
    return rows.map(row => ({
      action: actionItemFromRow(row),
      canonicalMeetingId: row.canonical_meeting_id,
      legacyMeetingId: row.legacy_meeting_id,
      remoteMeetingId: row.meeting_remote_id,
      meetingTitle: row.meeting_title,
      occurrenceDate: row.occurrence_date,
    }));
  }

  async findByNativeSessionId(
    sessionId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate | null> {
    assertScopeKey(scopeKey);
    const normalized = sessionId.trim();
    if (!normalized) return null;
    const database = await openMeetingDatabase();
    const noteRow = await database.getFirstAsync<MeetingRow>(
      `SELECT DISTINCT meeting.* FROM meeting_notes meeting
       LEFT JOIN recording_assets asset ON asset.meeting_id = meeting.id
       WHERE meeting.scope_key = ? AND (
         asset.native_session_id = ? OR meeting.id = ? OR
         meeting.remote_id = ? OR meeting.legacy_source_id = ?
       )
       ORDER BY CASE WHEN asset.native_session_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      scopeKey,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
    );
    if (!noteRow) return null;
    return this.aggregateFromRow(database, noteRow, scopeKey);
  }

  async getActiveTranscriptRevision(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionRecord | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.meeting_id = ? AND meeting.scope_key = ? AND revision.is_active = 1
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return row ? transcriptRevisionFromRow(row) : null;
  }

  async getCurrentSummaryVersion(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionRecord | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE meeting.id = ? AND meeting.scope_key = ?
         AND meeting.current_summary_version_id = version.id
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return row ? summaryVersionFromRow(row) : null;
  }

  async listReadableSummaryVersions(
    meetingId: string,
    scopeKey: ScopeKey,
    limit = 50,
  ): Promise<readonly SummaryVersionRecord[]> {
    assertScopeKey(scopeKey);
    const normalizedMeetingId = meetingId.trim();
    if (!normalizedMeetingId) throw new Error('summary version meeting identity is invalid');
    const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE version.meeting_id = ? AND meeting.scope_key = ?
         AND version.status IN ('ready', 'stale')
       ORDER BY COALESCE(version.completed_at_ms, version.created_at_ms) DESC,
         version.created_at_ms DESC, version.id DESC
       LIMIT ?`,
      normalizedMeetingId,
      scopeKey,
      normalizedLimit,
    );
    return rows.map(summaryVersionFromRow);
  }

  async listMeetingActionReminders(
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingActionReminderRecord[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingActionReminderRow>(
      `SELECT action.*, meeting.title AS meeting_title,
         COALESCE(
           NULLIF(meeting.legacy_source_id, ''),
           NULLIF(meeting.remote_id, ''),
           (SELECT NULLIF(asset.native_session_id, '')
            FROM recording_assets asset
            WHERE asset.meeting_id = meeting.id AND asset.native_session_id IS NOT NULL
            ORDER BY CASE asset.role WHEN 'primary' THEN 0 ELSE 1 END, asset.created_at_ms
            LIMIT 1),
           meeting.id
         ) AS legacy_meeting_id
       FROM action_items action
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         AND action.reminder_at_ms IS NOT NULL
       ORDER BY action.reminder_at_ms, action.id`,
      scopeKey,
    );
    return rows.map(row => ({
      action: actionItemFromRow(row),
      meetingTitle: row.meeting_title,
      legacyMeetingId: row.legacy_meeting_id,
    }));
  }

  async setMeetingActionReminderNotificationId(
    actionId: string,
    meetingId: string,
    scopeKey: ScopeKey,
    expectedReminderAtMs: number | null,
    notificationId: string | null,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(actionId, 'meeting action ID');
    assertRecordId(meetingId, 'meeting ID');
    assertOptionalNonNegativeInteger(expectedReminderAtMs, 'meeting action reminder time');
    if (notificationId !== null) assertRecordId(notificationId, 'meeting action notification ID');
    const database = await openMeetingDatabase();
    const result = await database.runAsync(
      `UPDATE action_items SET reminder_notification_id = ?
       WHERE id = ? AND meeting_id = ?
         AND ((reminder_at_ms IS NULL AND ? IS NULL) OR reminder_at_ms = ?)
         AND EXISTS (
           SELECT 1 FROM meeting_notes meeting
           WHERE meeting.id = action_items.meeting_id
             AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         )`,
      notificationId,
      actionId,
      meetingId,
      expectedReminderAtMs,
      expectedReminderAtMs,
      scopeKey,
    );
    return result.changes === 1;
  }

  async getScopeWriteState(scopeKey: ScopeKey): Promise<MeetingScopeWriteState> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<MeetingScopeWriteStateRow>(
      'SELECT * FROM meeting_scope_write_state WHERE scope_key = ?',
      scopeKey,
    );
    return row ? scopeWriteStateFromRow(row) : {
      scopeKey,
      writeOwner: 'legacy',
      canonicalRevision: 0,
      legacyMirrorRevision: 0,
      legacyMirrorStatus: 'clean',
      lastErrorCode: null,
      updatedAtMs: 0,
    };
  }

  async claimMeetingRootSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimMeetingRootSyncOptions,
  ): Promise<readonly MeetingRootSyncClaim[]> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return [];
    assertNonNegativeInteger(options.nowMs, 'meeting root sync claim time');
    assertNonNegativeInteger(options.staleBeforeMs, 'meeting root sync stale time');
    if (!Number.isSafeInteger(options.maxMeetings) || options.maxMeetings < 1) {
      throw new Error('meeting root sync concurrency is invalid');
    }
    const maxMeetings = Math.min(3, options.maxMeetings);

    return withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<MeetingRootSyncOutboxRow>(
        `SELECT
           outbox.operation_id, outbox.scope_key, outbox.aggregate_type,
           outbox.aggregate_id, outbox.operation_type, outbox.base_revision,
           outbox.payload_json, outbox.status, outbox.attempt_count,
           outbox.next_attempt_at_ms, outbox.last_error_code,
           outbox.request_payload_json, outbox.claim_token,
           outbox.created_at_ms, outbox.updated_at_ms,
           outbox.rowid AS transport_order,
           meeting.remote_id AS meeting_remote_id
         FROM sync_outbox outbox
         INNER JOIN meeting_notes meeting ON meeting.id = outbox.aggregate_id
         WHERE outbox.scope_key = ? AND meeting.scope_key = ?
           AND outbox.aggregate_type = 'meeting_note'
           AND outbox.status IN ('pending', 'retry', 'in_flight', 'blocked', 'permanent_error')
         ORDER BY outbox.created_at_ms, outbox.operation_id`,
        scopeKey,
        scopeKey,
      );
      const byMeeting = new Map<string, MeetingRootSyncOutboxRow[]>();
      rows.forEach(row => {
        const group = byMeeting.get(row.aggregate_id);
        if (group) group.push(row);
        else byMeeting.set(row.aggregate_id, [row]);
      });
      const candidates = [...byMeeting.values()]
        .map(group => [...group].sort(compareMeetingRootOperations))
        .sort((left, right) => compareMeetingRootOperations(left[0], right[0]));

      const claims: MeetingRootSyncClaim[] = [];
      for (const operations of candidates) {
        const first = operations[0];
        if (!first) continue;
        const unexpectedInFlight = operations.find(row => (
          row.status === 'in_flight' && row.operation_id !== first.operation_id
        ));
        if (unexpectedInFlight) {
          throw new Error('meeting root sync order contains a later in-flight operation');
        }
        if (first.status === 'blocked' || first.status === 'permanent_error') continue;
        if (first.status === 'retry'
          && first.next_attempt_at_ms !== null
          && first.next_attempt_at_ms > options.nowMs) continue;
        if (first.status === 'in_flight' && first.updated_at_ms > options.staleBeforeMs) continue;

        const requestPayloadJson = first.request_payload_json ?? first.payload_json;
        const claimToken = secureClientIdFactory.create();
        let updateSql = `UPDATE sync_outbox SET
           status = 'in_flight', attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL,
           request_payload_json = ?, claim_token = ?, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?`;
        const params: Array<string | number | null> = [
          requestPayloadJson,
          claimToken,
          options.nowMs,
          first.operation_id,
          scopeKey,
          first.aggregate_id,
        ];
        if (first.status === 'pending') {
          updateSql += " AND status = 'pending'";
        } else if (first.status === 'retry') {
          updateSql += ` AND status = 'retry' AND updated_at_ms = ?
            AND next_attempt_at_ms IS ? AND request_payload_json IS ?`;
          params.push(
            first.updated_at_ms,
            first.next_attempt_at_ms,
            first.request_payload_json,
          );
        } else {
          updateSql += " AND status = 'in_flight' AND updated_at_ms <= ?";
          params.push(options.staleBeforeMs);
        }
        const updated = await database.runAsync(updateSql, ...params);
        if (updated.changes !== 1) {
          throw new Error('meeting root sync claim changed concurrently');
        }
        claims.push({
          scopeKey,
          meetingId: first.aggregate_id,
          remoteId: first.meeting_remote_id,
          operationId: first.operation_id,
          operationType: first.operation_type,
          idempotencyKey: first.operation_id,
          claimToken,
          requestPayloadJson,
          attemptCount: first.attempt_count + 1,
        });
        if (claims.length >= maxMeetings) break;
      }
      return claims;
    });
  }

  async completeMeetingRootSyncClaim(
    claim: MeetingRootSyncClaim,
    remoteId: string,
    completedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.operationId, 'meeting root sync operation');
    assertRecordId(claim.claimToken, 'meeting root sync claim');
    assertRecordId(remoteId, 'meeting remote ID');
    assertNonNegativeInteger(completedAtMs, 'meeting root sync completion time');
    const applied = await withMeetingDatabaseTransaction(async database => {
      const operation = await database.getFirstAsync<SyncOutboxRow>(
        `SELECT * FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (!operation) return false;
      if (operation.operation_type !== claim.operationType) {
        throw new Error('meeting root sync operation type changed');
      }
      const meeting = await database.getFirstAsync<MeetingRow>(
        'SELECT * FROM meeting_notes WHERE id = ? AND scope_key = ?',
        claim.meetingId,
        claim.scopeKey,
      );
      if (!meeting) throw new Error('meeting root sync target no longer exists');
      if (meeting.remote_id !== null && meeting.remote_id !== remoteId) {
        throw new Error('meeting root remote identity changed');
      }
      const remoteOwner = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM meeting_notes
         WHERE scope_key = ? AND remote_id = ? AND id <> ?
         LIMIT 1`,
        claim.scopeKey,
        remoteId,
        claim.meetingId,
      );
      if (remoteOwner) {
        throw new Error('meeting root remote identity belongs to another local meeting');
      }
      await database.runAsync(
        'UPDATE meeting_notes SET remote_id = ? WHERE id = ? AND scope_key = ?',
        remoteId,
        claim.meetingId,
        claim.scopeKey,
      );
      const completed = await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        completedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (completed.changes !== 1) {
        throw new Error('meeting root sync completion changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      if (claim.operationType === 'meeting.delete') {
        await database.runAsync(
          `UPDATE meeting_notes SET sync_state = 'deleted'
           WHERE id = ? AND scope_key = ? AND lifecycle = 'deleted'`,
          claim.meetingId,
          claim.scopeKey,
        );
      }
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(claim.scopeKey, completedAtMs);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async failMeetingRootSyncClaim(
    claim: MeetingRootSyncClaim,
    failure: MeetingRootSyncFailure,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.operationId, 'meeting root sync operation');
    assertRecordId(claim.claimToken, 'meeting root sync claim');
    assertNonNegativeInteger(failure.updatedAtMs, 'meeting root sync failure time');
    assertOptionalNonNegativeInteger(failure.nextAttemptAtMs, 'meeting root sync retry time');
    const errorCode = normalizedSyncErrorCode(failure.errorCode);
    if (failure.disposition === 'retry' && failure.nextAttemptAtMs === null) {
      throw new Error('meeting root sync retry time is missing');
    }
    if (failure.disposition !== 'retry' && failure.nextAttemptAtMs !== null) {
      throw new Error('meeting root sync terminal failure cannot have retry time');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const failed = await database.runAsync(
        `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?,
           last_error_code = ?, claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        failure.disposition,
        failure.nextAttemptAtMs,
        errorCode,
        failure.updatedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (failed.changes === 0) return false;
      if (failed.changes !== 1) throw new Error('meeting root sync failure changed concurrently');
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      if (failure.disposition !== 'retry') {
        await database.runAsync(
          `UPDATE meeting_notes SET sync_state = 'conflicted'
           WHERE id = ? AND scope_key = ?`,
          claim.meetingId,
          claim.scopeKey,
        );
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(claim.scopeKey, failure.updatedAtMs);
      }
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async recordMeetingRootSyncConflict(
    claim: MeetingRootSyncClaim,
    conflict: MeetingRootSyncConflict,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.operationId, 'meeting root sync operation');
    assertRecordId(claim.claimToken, 'meeting root sync claim');
    assertNonNegativeInteger(conflict.createdAtMs, 'meeting root sync conflict time');
    if (!conflict.remotePayloadJson || conflict.remotePayloadJson.length > 1_048_576) {
      throw new Error('meeting root sync conflict payload is invalid');
    }
    try {
      JSON.parse(conflict.remotePayloadJson);
    } catch {
      throw new Error('meeting root sync conflict payload is not JSON');
    }
    const conflictId = `meeting-note:${claim.operationId}`;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const operation = await database.getFirstAsync<SyncOutboxRow>(
        `SELECT * FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (!operation) return false;
      await database.runAsync(
        `INSERT OR IGNORE INTO sync_conflicts (
           id, scope_key, aggregate_type, aggregate_id,
           local_revision, remote_revision, local_payload_json,
           remote_payload_json, status, created_at_ms
         ) VALUES (?, ?, 'meeting_note', ?, ?, NULL, ?, ?, 'unresolved', ?)`,
        conflictId,
        claim.scopeKey,
        claim.meetingId,
        operation.base_revision,
        claim.requestPayloadJson,
        conflict.remotePayloadJson,
        conflict.createdAtMs,
      );
      const stored = await database.getFirstAsync<{
        scope_key: string;
        aggregate_type: string;
        aggregate_id: string;
      }>('SELECT scope_key, aggregate_type, aggregate_id FROM sync_conflicts WHERE id = ?', conflictId);
      if (
        !stored
        || stored.scope_key !== claim.scopeKey
        || stored.aggregate_type !== 'meeting_note'
        || stored.aggregate_id !== claim.meetingId
      ) throw new Error('meeting root sync conflict identity was reused');
      const blocked = await database.runAsync(
        `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
           last_error_code = 'revision_conflict', claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_note' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        conflict.createdAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (blocked.changes !== 1) {
        throw new Error('meeting root sync conflict changed concurrently');
      }
      await database.runAsync(
        `UPDATE meeting_notes SET sync_state = 'conflicted'
         WHERE id = ? AND scope_key = ?`,
        claim.meetingId,
        claim.scopeKey,
      );
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(claim.scopeKey, conflict.createdAtMs);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async ensureOccurrenceSyncOperations(scopeKey: ScopeKey, createdAtMs: number): Promise<number> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return 0;
    assertNonNegativeInteger(createdAtMs, 'occurrence sync backfill time');
    const insertedMeetingIds = await withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<OccurrenceSyncOutboxRow>(
        `SELECT
           '' AS operation_id, link.scope_key, 'meeting_occurrence' AS aggregate_type,
           link.meeting_id AS aggregate_id, 'occurrence.upsert' AS operation_type,
           link.remote_revision AS base_revision, '{}' AS payload_json,
           'pending' AS status, 0 AS attempt_count, NULL AS next_attempt_at_ms,
           NULL AS last_error_code, NULL AS request_payload_json, NULL AS claim_token,
           link.linked_at_ms AS created_at_ms, link.client_updated_at_ms AS updated_at_ms,
           link.meeting_id, meeting.remote_id AS meeting_remote_id,
           link.remote_id AS occurrence_remote_id,
           link.remote_revision AS occurrence_remote_revision,
           link.calendar_source_event_id, link.occurrence_date, link.calendar_revision,
           link.recurrence_segment_id, link.series_key, link.link_state,
           CASE WHEN link.client_updated_at_ms > 0
             THEN link.client_updated_at_ms ELSE link.linked_at_ms END AS client_updated_at_ms,
           snapshot.event_title, snapshot.planned_start_ms, snapshot.planned_end_ms,
           snapshot.all_day, snapshot.timezone_id,
           snapshot.location AS occurrence_location,
           snapshot.participants_json AS occurrence_participants_json,
           snapshot.description AS occurrence_description,
           snapshot.captured_event_revision, snapshot.captured_at_ms
         FROM meeting_occurrence_links link
         INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
         INNER JOIN meeting_schedule_snapshots snapshot ON snapshot.meeting_id = link.meeting_id
         WHERE link.scope_key = ? AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted' AND meeting.remote_id IS NOT NULL
           AND link.sync_state <> 'synced'
           AND NOT EXISTS (
             SELECT 1 FROM sync_conflicts conflict
             WHERE conflict.scope_key = link.scope_key
               AND conflict.aggregate_type = 'meeting_occurrence'
               AND conflict.aggregate_id = link.meeting_id
               AND conflict.status = 'unresolved'
           )
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox outbox
             WHERE outbox.scope_key = link.scope_key
               AND outbox.aggregate_type = 'meeting_occurrence'
               AND outbox.aggregate_id = link.meeting_id
               AND outbox.status <> 'completed'
           )
         ORDER BY link.linked_at_ms, link.meeting_id`,
        scopeKey,
        scopeKey,
      );
      const inserted: string[] = [];
      const transaction = new SqliteMeetingTransaction(database);
      for (const row of rows) {
        const clientUpdatedAtMs = row.client_updated_at_ms > 0
          ? row.client_updated_at_ms
          : Math.max(row.created_at_ms, createdAtMs);
        const normalized = { ...row, client_updated_at_ms: clientUpdatedAtMs };
        const operationId = `occurrence.upsert:${row.meeting_id}:${clientUpdatedAtMs}`;
        const wasInserted = await transaction.insertOutbox({
          operationId,
          scopeKey,
          aggregateType: 'meeting_occurrence',
          aggregateId: row.meeting_id,
          operationType: 'occurrence.upsert',
          baseRevision: row.occurrence_remote_revision,
          payloadJson: occurrenceSyncRequestPayload(normalized),
          createdAtMs,
        });
        if (!wasInserted) continue;
        await database.runAsync(
          `UPDATE meeting_occurrence_links SET
             client_updated_at_ms = ?, sync_state = 'pending',
             last_sync_error_code = NULL
           WHERE meeting_id = ? AND scope_key = ?`,
          clientUpdatedAtMs,
          row.meeting_id,
          scopeKey,
        );
        await refreshMeetingSyncState(database, row.meeting_id, scopeKey);
        inserted.push(row.meeting_id);
      }
      return inserted;
    });
    if (insertedMeetingIds.length > 0) this.notify(insertedMeetingIds);
    return insertedMeetingIds.length;
  }

  async claimOccurrenceSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimOccurrenceSyncOptions,
  ): Promise<readonly OccurrenceSyncClaim[]> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return [];
    assertNonNegativeInteger(options.nowMs, 'occurrence sync claim time');
    assertNonNegativeInteger(options.staleBeforeMs, 'occurrence sync stale time');
    if (!Number.isSafeInteger(options.maxMeetings) || options.maxMeetings < 1) {
      throw new Error('occurrence sync concurrency is invalid');
    }
    const maxMeetings = Math.min(3, options.maxMeetings);
    return withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<OccurrenceSyncOutboxRow>(
        `SELECT outbox.*,
           link.meeting_id, meeting.remote_id AS meeting_remote_id,
           link.remote_id AS occurrence_remote_id,
           link.remote_revision AS occurrence_remote_revision,
           link.calendar_source_event_id, link.occurrence_date, link.calendar_revision,
           link.recurrence_segment_id, link.series_key, link.link_state,
           link.client_updated_at_ms,
           snapshot.event_title, snapshot.planned_start_ms, snapshot.planned_end_ms,
           snapshot.all_day, snapshot.timezone_id,
           snapshot.location AS occurrence_location,
           snapshot.participants_json AS occurrence_participants_json,
           snapshot.description AS occurrence_description,
           snapshot.captured_event_revision, snapshot.captured_at_ms
         FROM sync_outbox outbox
         INNER JOIN meeting_occurrence_links link
           ON link.meeting_id = outbox.aggregate_id AND link.scope_key = outbox.scope_key
         INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
         INNER JOIN meeting_schedule_snapshots snapshot ON snapshot.meeting_id = link.meeting_id
         WHERE outbox.scope_key = ? AND meeting.scope_key = ?
           AND outbox.aggregate_type = 'meeting_occurrence'
           AND outbox.status IN ('pending', 'retry', 'in_flight', 'blocked', 'permanent_error')
           AND meeting.lifecycle <> 'deleted' AND meeting.remote_id IS NOT NULL
         ORDER BY outbox.created_at_ms, outbox.operation_id`,
        scopeKey,
        scopeKey,
      );
      const claims: OccurrenceSyncClaim[] = [];
      for (const row of rows) {
        if (row.operation_type !== 'occurrence.upsert') {
          throw new Error('occurrence sync operation type is invalid');
        }
        if (row.status === 'blocked' || row.status === 'permanent_error') continue;
        if (
          row.status === 'retry'
          && row.next_attempt_at_ms !== null
          && row.next_attempt_at_ms > options.nowMs
        ) continue;
        if (row.status === 'in_flight' && row.updated_at_ms > options.staleBeforeMs) continue;
        const requestPayloadJson = row.request_payload_json ?? occurrenceSyncRequestPayload(row);
        const claimToken = secureClientIdFactory.create();
        let updateSql = `UPDATE sync_outbox SET
           status = 'in_flight', attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL,
           request_payload_json = ?, claim_token = ?, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?`;
        const params: Array<string | number | null> = [
          requestPayloadJson,
          claimToken,
          options.nowMs,
          row.operation_id,
          scopeKey,
          row.meeting_id,
        ];
        if (row.status === 'pending') {
          updateSql += " AND status = 'pending'";
        } else if (row.status === 'retry') {
          updateSql += ` AND status = 'retry' AND updated_at_ms = ?
            AND next_attempt_at_ms IS ? AND request_payload_json IS ?`;
          params.push(row.updated_at_ms, row.next_attempt_at_ms, row.request_payload_json);
        } else {
          updateSql += " AND status = 'in_flight' AND updated_at_ms <= ?";
          params.push(options.staleBeforeMs);
        }
        const updated = await database.runAsync(updateSql, ...params);
        if (updated.changes !== 1) throw new Error('occurrence sync claim changed concurrently');
        await database.runAsync(
          `UPDATE meeting_occurrence_links SET sync_state = 'pending', last_sync_error_code = NULL
           WHERE meeting_id = ? AND scope_key = ?`,
          row.meeting_id,
          scopeKey,
        );
        claims.push({
          scopeKey,
          meetingId: row.meeting_id,
          meetingRemoteId: row.meeting_remote_id,
          operationId: row.operation_id,
          idempotencyKey: row.operation_id,
          claimToken,
          requestPayloadJson,
          attemptCount: row.attempt_count + 1,
        });
        if (claims.length >= maxMeetings) break;
      }
      return claims;
    });
  }

  async completeOccurrenceSyncClaim(
    claim: OccurrenceSyncClaim,
    remoteId: string,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'occurrence meeting ID');
    assertRecordId(claim.operationId, 'occurrence sync operation');
    assertRecordId(claim.claimToken, 'occurrence sync claim');
    assertRecordId(remoteId, 'occurrence remote ID');
    assertNonNegativeInteger(remoteRevision, 'occurrence remote revision');
    if (remoteRevision < 1) throw new Error('occurrence remote revision is invalid');
    assertNonNegativeInteger(completedAtMs, 'occurrence sync completion time');
    const applied = await withMeetingDatabaseTransaction(async database => {
      const operation = await database.getFirstAsync<SyncOutboxRow>(
        `SELECT * FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (!operation) return false;
      const link = await database.getFirstAsync<OccurrenceLinkRow>(
        'SELECT * FROM meeting_occurrence_links WHERE meeting_id = ? AND scope_key = ?',
        claim.meetingId,
        claim.scopeKey,
      );
      if (!link) throw new Error('occurrence sync target no longer exists');
      if (link.remote_id !== null && link.remote_id !== remoteId) {
        throw new Error('occurrence remote identity changed');
      }
      const owner = await database.getFirstAsync<{ meeting_id: string }>(
        `SELECT meeting_id FROM meeting_occurrence_links
         WHERE scope_key = ? AND remote_id = ? AND meeting_id <> ? LIMIT 1`,
        claim.scopeKey,
        remoteId,
        claim.meetingId,
      );
      if (owner) throw new Error('occurrence remote identity belongs to another meeting');
      await database.runAsync(
        `UPDATE meeting_occurrence_links SET
           remote_id = ?, remote_revision = ?, sync_state = 'synced',
           last_sync_error_code = NULL, synced_at_ms = ?
         WHERE meeting_id = ? AND scope_key = ?`,
        remoteId,
        remoteRevision,
        completedAtMs,
        claim.meetingId,
        claim.scopeKey,
      );
      const completed = await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        completedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (completed.changes !== 1) throw new Error('occurrence sync completion changed concurrently');
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(claim.scopeKey, completedAtMs);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async failOccurrenceSyncClaim(
    claim: OccurrenceSyncClaim,
    failure: OccurrenceSyncFailure,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'occurrence meeting ID');
    assertRecordId(claim.operationId, 'occurrence sync operation');
    assertRecordId(claim.claimToken, 'occurrence sync claim');
    assertNonNegativeInteger(failure.updatedAtMs, 'occurrence sync failure time');
    assertOptionalNonNegativeInteger(failure.nextAttemptAtMs, 'occurrence sync retry time');
    const errorCode = normalizedSyncErrorCode(failure.errorCode);
    if (failure.disposition === 'retry' && failure.nextAttemptAtMs === null) {
      throw new Error('occurrence sync retry time is missing');
    }
    if (failure.disposition !== 'retry' && failure.nextAttemptAtMs !== null) {
      throw new Error('occurrence sync terminal failure cannot have retry time');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const failed = await database.runAsync(
        `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?,
           last_error_code = ?, claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        failure.disposition,
        failure.nextAttemptAtMs,
        errorCode,
        failure.updatedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (failed.changes === 0) return false;
      if (failed.changes !== 1) throw new Error('occurrence sync failure changed concurrently');
      await database.runAsync(
        `UPDATE meeting_occurrence_links SET sync_state = ?, last_sync_error_code = ?
         WHERE meeting_id = ? AND scope_key = ?`,
        failure.disposition === 'retry' ? 'pending' : 'failed',
        errorCode,
        claim.meetingId,
        claim.scopeKey,
      );
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      if (failure.disposition !== 'retry') {
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(claim.scopeKey, failure.updatedAtMs);
      }
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async recordOccurrenceSyncConflict(
    claim: OccurrenceSyncClaim,
    conflict: OccurrenceSyncConflict,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'occurrence meeting ID');
    assertRecordId(claim.operationId, 'occurrence sync operation');
    assertRecordId(claim.claimToken, 'occurrence sync claim');
    assertOptionalNonNegativeInteger(conflict.remoteRevision, 'occurrence conflict revision');
    assertNonNegativeInteger(conflict.createdAtMs, 'occurrence conflict time');
    if (!conflict.remotePayloadJson || conflict.remotePayloadJson.length > 1_048_576) {
      throw new Error('occurrence conflict payload is invalid');
    }
    JSON.parse(conflict.remotePayloadJson);
    const conflictId = `meeting-occurrence:${claim.operationId}`;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const operation = await database.getFirstAsync<SyncOutboxRow>(
        `SELECT * FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (!operation) return false;
      await database.runAsync(
        `INSERT OR IGNORE INTO sync_conflicts (
           id, scope_key, aggregate_type, aggregate_id,
           local_revision, remote_revision, local_payload_json,
           remote_payload_json, status, created_at_ms
         ) VALUES (?, ?, 'meeting_occurrence', ?, ?, ?, ?, ?, 'unresolved', ?)`,
        conflictId,
        claim.scopeKey,
        claim.meetingId,
        operation.base_revision,
        conflict.remoteRevision,
        claim.requestPayloadJson,
        conflict.remotePayloadJson,
        conflict.createdAtMs,
      );
      const blocked = await database.runAsync(
        `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
           last_error_code = 'occurrence_conflict', claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'meeting_occurrence' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        conflict.createdAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (blocked.changes !== 1) throw new Error('occurrence conflict changed concurrently');
      await database.runAsync(
        `UPDATE meeting_occurrence_links SET
           sync_state = 'conflicted', last_sync_error_code = 'occurrence_conflict'
         WHERE meeting_id = ? AND scope_key = ?`,
        claim.meetingId,
        claim.scopeKey,
      );
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(claim.scopeKey, conflict.createdAtMs);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async hasOccurrenceSyncConflict(
    reference: { sourceEventId: string; occurrenceDate: string },
    scopeKey: ScopeKey,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(reference.sourceEventId, 'occurrence source event ID');
    assertOccurrenceDate(reference.occurrenceDate, 'occurrence date');
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<{ found: number }>(
      `SELECT 1 AS found
       FROM meeting_occurrence_links link
       INNER JOIN sync_conflicts conflict
         ON conflict.aggregate_type = 'meeting_occurrence'
        AND conflict.aggregate_id = link.meeting_id
        AND conflict.scope_key = link.scope_key
        AND conflict.status = 'unresolved'
       WHERE link.scope_key = ?
         AND link.calendar_source_event_id = ?
         AND link.occurrence_date = ?
       LIMIT 1`,
      scopeKey,
      reference.sourceEventId,
      reference.occurrenceDate,
    );
    return Boolean(row);
  }

  async mergeOccurrenceRemote(input: MergeOccurrenceRemoteInput): Promise<MergeOccurrenceRemoteResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest meeting cannot merge remote occurrence');
    assertNonNegativeInteger(input.pulledAtMs, 'occurrence pull time');
    assertRemoteOccurrenceLink(input.remote);
    let touchedMeetingId: string | null = null;
    const result = await withMeetingDatabaseTransaction<MergeOccurrenceRemoteResult>(async database => {
      const remote = input.remote;
      const targetMeeting = await database.getFirstAsync<MeetingRow>(
        'SELECT * FROM meeting_notes WHERE scope_key = ? AND remote_id = ?',
        input.scopeKey,
        remote.meetingRemoteId,
      );
      if (!targetMeeting) {
        return { outcome: 'meeting_unavailable', meetingId: null } as MergeOccurrenceRemoteResult;
      }
      const localForReference = await database.getFirstAsync<OccurrenceLinkRow>(
        `SELECT * FROM meeting_occurrence_links
         WHERE scope_key = ? AND calendar_source_event_id = ? AND occurrence_date = ?`,
        input.scopeKey,
        remote.sourceEventId,
        remote.occurrenceDate,
      );
      const localForMeeting = await database.getFirstAsync<OccurrenceLinkRow>(
        'SELECT * FROM meeting_occurrence_links WHERE meeting_id = ? AND scope_key = ?',
        targetMeeting.id,
        input.scopeKey,
      );

      const remotePayloadJson = JSON.stringify({
        schema_version: 2,
        exists: true,
        id: remote.remoteId,
        meeting_id: remote.meetingRemoteId,
        revision: remote.revision,
        source_event_id: remote.sourceEventId,
        occurrence_date: remote.occurrenceDate,
        calendar_revision: remote.calendarRevision,
        recurrence_segment_id: remote.recurrenceSegmentId,
        series_key: remote.seriesKey,
        link_state: remote.linkState,
        client_updated_at_ms: remote.clientUpdatedAtMs,
        schedule_snapshot: remote.scheduleSnapshot,
        created_at_ms: remote.serverCreatedAtMs,
        updated_at_ms: remote.serverUpdatedAtMs,
      });
      const recordConflict = async (
        meetingId: string,
        localPayloadJson: string,
        code: string,
      ): Promise<MergeOccurrenceRemoteResult> => {
        const conflictId = `occurrence-pull:${meetingId}`;
        await database.runAsync(
          `INSERT OR IGNORE INTO sync_conflicts (
             id, scope_key, aggregate_type, aggregate_id,
             local_revision, remote_revision, local_payload_json,
             remote_payload_json, status, created_at_ms
           ) VALUES (?, ?, 'meeting_occurrence', ?, NULL, ?, ?, ?, 'unresolved', ?)`,
          conflictId,
          input.scopeKey,
          meetingId,
          remote.revision,
          localPayloadJson,
          JSON.stringify({ error_code: code, current: JSON.parse(remotePayloadJson) }),
          input.pulledAtMs,
        );
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
             last_error_code = ?, claim_token = NULL, updated_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = 'meeting_occurrence'
             AND aggregate_id = ? AND status <> 'completed'`,
          code,
          input.pulledAtMs,
          input.scopeKey,
          meetingId,
        );
        await database.runAsync(
          `UPDATE meeting_occurrence_links SET sync_state = 'conflicted', last_sync_error_code = ?
           WHERE meeting_id = ? AND scope_key = ?`,
          code,
          meetingId,
          input.scopeKey,
        );
        await refreshMeetingSyncState(database, meetingId, input.scopeKey);
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
        touchedMeetingId = meetingId;
        return { outcome: 'conflicted', meetingId };
      };

      if (targetMeeting.lifecycle === 'deleted') {
        return recordConflict(
          targetMeeting.id,
          JSON.stringify({ lifecycle: 'deleted', meeting_id: targetMeeting.id }),
          'local_meeting_deleted',
        );
      }
      if (localForReference && localForReference.meeting_id !== targetMeeting.id) {
        return recordConflict(
          localForReference.meeting_id,
          JSON.stringify(localForReference),
          'occurrence_bound_to_another_local_meeting',
        );
      }
      if (
        localForMeeting
        && (
          localForMeeting.calendar_source_event_id !== remote.sourceEventId
          || localForMeeting.occurrence_date !== remote.occurrenceDate
        )
      ) {
        return recordConflict(
          targetMeeting.id,
          JSON.stringify(localForMeeting),
          'meeting_bound_to_another_local_occurrence',
        );
      }
      if (!localForMeeting) {
        await database.runAsync(
          `INSERT INTO meeting_occurrence_links (
             meeting_id, scope_key, calendar_source_event_id, occurrence_date,
             calendar_revision, recurrence_segment_id, series_key, link_state, linked_at_ms,
             remote_id, remote_revision, client_updated_at_ms, sync_state,
             last_sync_error_code, synced_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL, ?)`,
          targetMeeting.id,
          input.scopeKey,
          remote.sourceEventId,
          remote.occurrenceDate,
          remote.calendarRevision,
          remote.recurrenceSegmentId,
          remote.seriesKey,
          remote.linkState,
          remote.scheduleSnapshot.capturedAtMs,
          remote.remoteId,
          remote.revision,
          remote.clientUpdatedAtMs,
          input.pulledAtMs,
        );
        const snapshot = remote.scheduleSnapshot;
        await database.runAsync(
          `INSERT INTO meeting_schedule_snapshots (
             meeting_id, event_title, planned_start_ms, planned_end_ms, all_day,
             timezone_id, location, participants_json, description,
             captured_event_revision, captured_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          targetMeeting.id,
          snapshot.eventTitle,
          snapshot.plannedStartMs,
          snapshot.plannedEndMs,
          snapshot.allDay ? 1 : 0,
          snapshot.timezoneId,
          snapshot.location,
          JSON.stringify(snapshot.participants),
          snapshot.description,
          snapshot.capturedEventRevision,
          snapshot.capturedAtMs,
        );
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
        touchedMeetingId = targetMeeting.id;
        return { outcome: 'attached', meetingId: targetMeeting.id };
      }

      if (
        localForMeeting.remote_revision !== null
        && remote.revision < localForMeeting.remote_revision
      ) return { outcome: 'ignored_stale', meetingId: targetMeeting.id };
      const snapshotRow = await database.getFirstAsync<ScheduleSnapshotRow>(
        'SELECT * FROM meeting_schedule_snapshots WHERE meeting_id = ?',
        targetMeeting.id,
      );
      if (!snapshotRow) throw new Error('local occurrence schedule snapshot is missing');
      const localSnapshot = snapshotFromRow(snapshotRow);
      const fieldsMatch = localForMeeting.calendar_revision === remote.calendarRevision
        && localForMeeting.recurrence_segment_id === remote.recurrenceSegmentId
        && localForMeeting.series_key === remote.seriesKey
        && localForMeeting.link_state === remote.linkState
        && scheduleSnapshotsEqual(localSnapshot, remote.scheduleSnapshot);
      if (!fieldsMatch) {
        return recordConflict(
          targetMeeting.id,
          JSON.stringify({ ...localForMeeting, schedule_snapshot: localSnapshot }),
          'occurrence_remote_diverged',
        );
      }
      const unchanged = localForMeeting.remote_id === remote.remoteId
        && localForMeeting.remote_revision === remote.revision
        && localForMeeting.client_updated_at_ms === remote.clientUpdatedAtMs
        && localForMeeting.sync_state === 'synced';
      if (unchanged) return { outcome: 'unchanged', meetingId: targetMeeting.id };
      if (localForMeeting.remote_id !== null && localForMeeting.remote_id !== remote.remoteId) {
        return recordConflict(
          targetMeeting.id,
          JSON.stringify({ ...localForMeeting, schedule_snapshot: localSnapshot }),
          'occurrence_remote_identity_changed',
        );
      }
      await database.runAsync(
        `UPDATE meeting_occurrence_links SET
           remote_id = ?, remote_revision = ?, client_updated_at_ms = ?,
           sync_state = 'synced', last_sync_error_code = NULL, synced_at_ms = ?
         WHERE meeting_id = ? AND scope_key = ?`,
        remote.remoteId,
        remote.revision,
        remote.clientUpdatedAtMs,
        input.pulledAtMs,
        targetMeeting.id,
        input.scopeKey,
      );
      await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'meeting_occurrence'
           AND aggregate_id = ? AND status <> 'completed'`,
        input.pulledAtMs,
        input.scopeKey,
        targetMeeting.id,
      );
      await refreshMeetingSyncState(database, targetMeeting.id, input.scopeKey);
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
      touchedMeetingId = targetMeeting.id;
      return { outcome: 'updated', meetingId: targetMeeting.id };
    });
    if (touchedMeetingId) this.notify([touchedMeetingId]);
    return result;
  }

  async setOccurrenceLinkState(input: SetOccurrenceLinkStateInput): Promise<number> {
    assertScopeKey(input.scopeKey);
    assertRecordId(input.sourceEventId, 'occurrence source event ID');
    assertOccurrenceDate(input.occurrenceDate, 'occurrence date');
    assertNonNegativeInteger(input.updatedAtMs, 'occurrence state update time');
    if (!['occurrence', 'following', 'series'].includes(input.selection)) {
      throw new Error('occurrence state selection is invalid');
    }
    if (input.state !== 'active' && input.state !== 'orphaned') {
      throw new Error('occurrence link state is invalid');
    }
    const touched = await withMeetingDatabaseTransaction(async database => {
      let selectionSql = '';
      const selectionParams: Array<string> = [];
      if (input.selection === 'occurrence') {
        selectionSql = 'AND link.occurrence_date = ?';
        selectionParams.push(input.occurrenceDate);
      } else if (input.selection === 'following') {
        selectionSql = 'AND link.occurrence_date >= ?';
        selectionParams.push(input.occurrenceDate);
      }
      const rows = await database.getAllAsync<OccurrenceLinkRow>(
        `SELECT link.* FROM meeting_occurrence_links link
         INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
         WHERE link.scope_key = ? AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'
           AND link.calendar_source_event_id = ?
           ${selectionSql}
         ORDER BY link.occurrence_date, link.meeting_id`,
        input.scopeKey,
        input.scopeKey,
        input.sourceEventId,
        ...selectionParams,
      );
      const meetingIds: string[] = [];
      const transaction = new SqliteMeetingTransaction(database);
      for (const row of rows) {
        if (row.link_state === input.state) continue;
        const nextUpdatedAtMs = Math.max(input.updatedAtMs, row.client_updated_at_ms + 1);
        if (!Number.isSafeInteger(nextUpdatedAtMs)) {
          throw new Error('occurrence state update clock overflowed');
        }
        const conflict = await database.getFirstAsync<{ found: number }>(
          `SELECT 1 AS found FROM sync_conflicts
           WHERE scope_key = ? AND aggregate_type = 'meeting_occurrence'
             AND aggregate_id = ? AND status = 'unresolved' LIMIT 1`,
          input.scopeKey,
          row.meeting_id,
        );
        await database.runAsync(
          `UPDATE meeting_occurrence_links SET
             link_state = ?, client_updated_at_ms = ?, sync_state = ?,
             last_sync_error_code = ?
           WHERE meeting_id = ? AND scope_key = ?`,
          input.state,
          nextUpdatedAtMs,
          conflict ? 'conflicted' : input.scopeKey === 'guest' ? 'local_only' : 'pending',
          conflict ? 'occurrence_conflict' : null,
          row.meeting_id,
          input.scopeKey,
        );
        if (input.scopeKey !== 'guest' && !conflict) {
          await database.runAsync(
            `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
               last_error_code = 'superseded_local_state', claim_token = NULL, updated_at_ms = ?
             WHERE scope_key = ? AND aggregate_type = 'meeting_occurrence'
               AND aggregate_id = ? AND status <> 'completed'`,
            nextUpdatedAtMs,
            input.scopeKey,
            row.meeting_id,
          );
          const syncRow = await database.getFirstAsync<OccurrenceSyncOutboxRow>(
            `SELECT
               '' AS operation_id, link.scope_key, 'meeting_occurrence' AS aggregate_type,
               link.meeting_id AS aggregate_id, 'occurrence.upsert' AS operation_type,
               link.remote_revision AS base_revision, '{}' AS payload_json,
               'pending' AS status, 0 AS attempt_count, NULL AS next_attempt_at_ms,
               NULL AS last_error_code, NULL AS request_payload_json, NULL AS claim_token,
               ? AS created_at_ms, ? AS updated_at_ms,
               link.meeting_id, meeting.remote_id AS meeting_remote_id,
               link.remote_id AS occurrence_remote_id,
               link.remote_revision AS occurrence_remote_revision,
               link.calendar_source_event_id, link.occurrence_date, link.calendar_revision,
               link.recurrence_segment_id, link.series_key, link.link_state,
               link.client_updated_at_ms,
               snapshot.event_title, snapshot.planned_start_ms, snapshot.planned_end_ms,
               snapshot.all_day, snapshot.timezone_id,
               snapshot.location AS occurrence_location,
               snapshot.participants_json AS occurrence_participants_json,
               snapshot.description AS occurrence_description,
               snapshot.captured_event_revision, snapshot.captured_at_ms
             FROM meeting_occurrence_links link
             INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
             INNER JOIN meeting_schedule_snapshots snapshot ON snapshot.meeting_id = link.meeting_id
             WHERE link.meeting_id = ? AND link.scope_key = ?
               AND meeting.scope_key = ? AND meeting.remote_id IS NOT NULL`,
            nextUpdatedAtMs,
            nextUpdatedAtMs,
            row.meeting_id,
            input.scopeKey,
            input.scopeKey,
          );
          if (syncRow) {
            await transaction.insertOutbox({
              operationId: `occurrence.${input.state}:${row.meeting_id}:${nextUpdatedAtMs}`,
              scopeKey: input.scopeKey,
              aggregateType: 'meeting_occurrence',
              aggregateId: row.meeting_id,
              operationType: 'occurrence.upsert',
              baseRevision: syncRow.occurrence_remote_revision,
              payloadJson: occurrenceSyncRequestPayload(syncRow),
              createdAtMs: nextUpdatedAtMs,
            });
          }
        }
        await refreshMeetingSyncState(database, row.meeting_id, input.scopeKey);
        meetingIds.push(row.meeting_id);
      }
      if (meetingIds.length > 0) {
        const writeState = await database.getFirstAsync<MeetingScopeWriteStateRow>(
          'SELECT * FROM meeting_scope_write_state WHERE scope_key = ?',
          input.scopeKey,
        );
        if (writeState?.write_owner === 'canonical') {
          await transaction.advanceCanonicalWrite(input.scopeKey, input.updatedAtMs);
        }
      }
      return meetingIds;
    });
    if (touched.length > 0) this.notify(touched);
    return touched.length;
  }

  async claimActionSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimActionSyncOptions,
  ): Promise<readonly ActionSyncClaim[]> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return [];
    assertNonNegativeInteger(options.nowMs, 'meeting action sync claim time');
    assertNonNegativeInteger(options.staleBeforeMs, 'meeting action sync stale time');
    if (!Number.isSafeInteger(options.maxMeetings) || options.maxMeetings < 1) {
      throw new Error('meeting action sync concurrency is invalid');
    }
    const maxMeetings = Math.min(3, options.maxMeetings);

    return withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<ActionSyncOutboxRow>(
        `SELECT
           outbox.operation_id, outbox.scope_key, outbox.aggregate_type,
           outbox.aggregate_id, outbox.operation_type, outbox.base_revision,
           outbox.payload_json, outbox.status, outbox.attempt_count,
           outbox.next_attempt_at_ms, outbox.last_error_code,
           outbox.request_payload_json, outbox.claim_token,
           outbox.created_at_ms, outbox.updated_at_ms,
           action.meeting_id AS meeting_id,
           meeting.remote_id AS meeting_remote_id,
           action.remote_id AS action_remote_id,
           action.remote_revision AS action_remote_revision,
           action.content AS action_content,
           action.status AS action_status,
           action.assignee_text AS action_assignee_text,
           action.due_at_ms AS action_due_at_ms,
           action.reminder_at_ms AS action_reminder_at_ms,
           action.followup_event_source_id AS action_followup_event_source_id,
           action.source_kind AS action_source_kind,
           action.source_summary_version_id AS action_source_summary_version_id,
           action.source_segment_id AS action_source_segment_id,
           segment.source_segment_id AS action_source_segment_source_id,
           action.source_start_ms AS action_source_start_ms,
           action.generation_fingerprint AS action_generation_fingerprint,
           action.user_edited_at_ms AS action_user_edited_at_ms,
           action.completed_at_ms AS action_completed_at_ms,
           action.created_at_ms AS action_created_at_ms,
           action.updated_at_ms AS action_updated_at_ms
         FROM sync_outbox outbox
         INNER JOIN action_items action ON action.id = outbox.aggregate_id
         LEFT JOIN transcript_segments segment ON segment.id = action.source_segment_id
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE outbox.scope_key = ?
           AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'
           AND meeting.remote_id IS NOT NULL
           AND LENGTH(TRIM(meeting.remote_id)) > 0
           AND outbox.aggregate_type = 'action_item'
           AND outbox.operation_type = 'action_item.upsert'
           AND outbox.status IN ('pending', 'retry', 'in_flight')
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox blocker
             WHERE blocker.scope_key = outbox.scope_key
               AND blocker.aggregate_type = outbox.aggregate_type
               AND blocker.aggregate_id = outbox.aggregate_id
               AND blocker.status IN ('blocked', 'permanent_error')
           )
         ORDER BY outbox.created_at_ms, outbox.operation_id`,
        scopeKey,
        scopeKey,
      );

      type ClaimMode = 'stale' | 'retry' | 'pending';
      type ClaimGroup = {
        mode: ClaimMode;
        rows: ActionSyncOutboxRow[];
        sortAtMs: number;
      };
      const byAction = new Map<string, ActionSyncOutboxRow[]>();
      rows.forEach(row => {
        const group = byAction.get(row.aggregate_id);
        if (group) group.push(row);
        else byAction.set(row.aggregate_id, [row]);
      });
      const groups: ClaimGroup[] = [];
      byAction.forEach(actionRows => {
        const inFlight = actionRows.filter(row => row.status === 'in_flight');
        if (inFlight.length > 0) {
          if (inFlight.every(row => row.updated_at_ms <= options.staleBeforeMs)) {
            groups.push({
              mode: 'stale',
              rows: inFlight,
              sortAtMs: Math.min(...inFlight.map(row => row.updated_at_ms)),
            });
          }
          return;
        }
        const retries = actionRows.filter(row => row.status === 'retry');
        if (retries.length > 0) {
          const eligible = retries
            .filter(row => row.next_attempt_at_ms === null || row.next_attempt_at_ms <= options.nowMs)
            .sort((left, right) => (
              (left.next_attempt_at_ms ?? 0) - (right.next_attempt_at_ms ?? 0)
              || left.updated_at_ms - right.updated_at_ms
              || left.created_at_ms - right.created_at_ms
              || left.operation_id.localeCompare(right.operation_id)
            ));
          const anchor = eligible[0];
          if (anchor) {
            const cohort = retries.filter(row => (
              row.request_payload_json === anchor.request_payload_json
              && row.next_attempt_at_ms === anchor.next_attempt_at_ms
              && row.updated_at_ms === anchor.updated_at_ms
            ));
            groups.push({ mode: 'retry', rows: cohort, sortAtMs: anchor.updated_at_ms });
          }
          return;
        }
        const pending = actionRows.filter(row => row.status === 'pending');
        if (pending.length > 0) {
          groups.push({
            mode: 'pending',
            rows: pending,
            sortAtMs: Math.min(...pending.map(row => row.created_at_ms)),
          });
        }
      });
      const priority: Record<ClaimMode, number> = { stale: 0, retry: 1, pending: 2 };
      groups.sort((left, right) => (
        priority[left.mode] - priority[right.mode]
        || left.sortAtMs - right.sortAtMs
        || left.rows[0].aggregate_id.localeCompare(right.rows[0].aggregate_id)
      ));

      const claims: ActionSyncClaim[] = [];
      const claimedMeetings = new Set<string>();
      for (const group of groups) {
        const first = group.rows[0];
        if (!first || claimedMeetings.has(first.meeting_id)) continue;
        const ordered = [...group.rows].sort((left, right) => (
          left.created_at_ms - right.created_at_ms
          || left.operation_id.localeCompare(right.operation_id)
        ));
        const idempotencyRow = ordered[ordered.length - 1];
        const requestPayloadJson = group.mode === 'pending'
          ? actionSyncRequestPayload(idempotencyRow)
          : idempotencyRow.request_payload_json ?? actionSyncRequestPayload(idempotencyRow);
        let meetingRemoteId = first.meeting_remote_id;
        try {
          const requestPayload = JSON.parse(requestPayloadJson) as { meeting_remote_id?: unknown };
          if (typeof requestPayload.meeting_remote_id === 'string' && requestPayload.meeting_remote_id.trim()) {
            meetingRemoteId = requestPayload.meeting_remote_id.trim();
          }
        } catch {
          // The transport parser will quarantine malformed snapshots before network I/O.
        }
        const claimToken = secureClientIdFactory.create();
        let updateSql = `UPDATE sync_outbox SET
           status = 'in_flight',
           attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL,
           last_error_code = NULL,
           request_payload_json = ?,
           claim_token = ?,
           updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND operation_type = 'action_item.upsert'`;
        const updateParams: Array<string | number | null> = [
          requestPayloadJson,
          claimToken,
          options.nowMs,
          scopeKey,
          first.aggregate_id,
        ];
        if (group.mode === 'stale') {
          updateSql += " AND status = 'in_flight' AND updated_at_ms <= ?";
          updateParams.push(options.staleBeforeMs);
        } else if (group.mode === 'retry') {
          updateSql += ` AND status = 'retry'
            AND request_payload_json IS ?
            AND next_attempt_at_ms IS ?
            AND updated_at_ms = ?`;
          updateParams.push(
            idempotencyRow.request_payload_json,
            idempotencyRow.next_attempt_at_ms,
            idempotencyRow.updated_at_ms,
          );
        } else {
          updateSql += " AND status = 'pending'";
        }
        const updated = await database.runAsync(updateSql, ...updateParams);
        if (updated.changes !== ordered.length) {
          throw new Error('meeting action sync claim changed concurrently');
        }
        claims.push({
          scopeKey,
          meetingId: first.meeting_id,
          meetingRemoteId,
          actionId: first.aggregate_id,
          operationIds: ordered.map(row => row.operation_id),
          idempotencyKey: idempotencyRow.operation_id,
          claimToken,
          requestPayloadJson,
          attemptCount: idempotencyRow.attempt_count + 1,
        });
        claimedMeetings.add(first.meeting_id);
        if (claims.length >= maxMeetings) break;
      }
      return claims;
    });
  }

  async completeActionSyncClaim(
    claim: ActionSyncClaim,
    remoteId: string,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.actionId, 'meeting action ID');
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'meeting action sync claim');
    assertRecordId(remoteId, 'meeting action remote ID');
    assertNonNegativeInteger(remoteRevision, 'meeting action remote revision');
    assertNonNegativeInteger(completedAtMs, 'meeting action sync completion time');
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getAllAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        claim.scopeKey,
        claim.actionId,
        claim.claimToken,
      );
      const expectedIds = new Set(claim.operationIds);
      if (
        claimed.length !== expectedIds.size
        || claimed.some(row => !expectedIds.has(row.operation_id))
      ) return false;
      const action = await database.getFirstAsync<{
        remote_id: string | null;
        remote_revision: number | null;
      }>(
        `SELECT action.remote_id, action.remote_revision FROM action_items action
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE action.id = ? AND action.meeting_id = ? AND meeting.scope_key = ?`,
        claim.actionId,
        claim.meetingId,
        claim.scopeKey,
      );
      if (!action) throw new Error('meeting action sync target no longer exists');
      if (action.remote_id !== null && action.remote_id !== remoteId) {
        throw new Error('meeting action remote identity changed');
      }
      if (action.remote_revision !== null && action.remote_revision > remoteRevision) {
        throw new Error('meeting action remote revision moved backwards');
      }
      await database.runAsync(
        `UPDATE action_items SET remote_id = ?, remote_revision = ?
         WHERE id = ? AND meeting_id = ?`,
        remoteId,
        remoteRevision,
        claim.actionId,
        claim.meetingId,
      );
      const completed = await database.runAsync(
        `UPDATE sync_outbox SET
           status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        completedAtMs,
        claim.scopeKey,
        claim.actionId,
        claim.claimToken,
      );
      if (completed.changes !== expectedIds.size) {
        throw new Error('meeting action sync completion changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async failActionSyncClaim(
    claim: ActionSyncClaim,
    failure: ActionSyncFailure,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.actionId, 'meeting action ID');
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'meeting action sync claim');
    assertNonNegativeInteger(failure.updatedAtMs, 'meeting action sync failure time');
    assertOptionalNonNegativeInteger(failure.nextAttemptAtMs, 'meeting action sync retry time');
    const errorCode = normalizedSyncErrorCode(failure.errorCode);
    if (failure.disposition === 'retry' && failure.nextAttemptAtMs === null) {
      throw new Error('meeting action sync retry time is missing');
    }
    if (failure.disposition !== 'retry' && failure.nextAttemptAtMs !== null) {
      throw new Error('meeting action sync terminal failure cannot have retry time');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const failed = await database.runAsync(
        `UPDATE sync_outbox SET
           status = ?, next_attempt_at_ms = ?, last_error_code = ?,
           claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        failure.disposition,
        failure.nextAttemptAtMs,
        errorCode,
        failure.updatedAtMs,
        claim.scopeKey,
        claim.actionId,
        claim.claimToken,
      );
      if (failed.changes === 0) return false;
      if (failed.changes !== new Set(claim.operationIds).size) {
        throw new Error('meeting action sync failure changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async recordActionSyncConflict(
    claim: ActionSyncClaim,
    conflict: ActionSyncConflict,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.actionId, 'meeting action ID');
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'meeting action sync claim');
    assertOptionalNonNegativeInteger(conflict.localRevision, 'meeting action local remote revision');
    assertOptionalNonNegativeInteger(conflict.remoteRevision, 'meeting action conflict remote revision');
    assertNonNegativeInteger(conflict.createdAtMs, 'meeting action conflict time');
    if (!conflict.remotePayloadJson || conflict.remotePayloadJson.length > 1_048_576) {
      throw new Error('meeting action conflict payload is invalid');
    }
    try {
      JSON.parse(conflict.remotePayloadJson);
    } catch {
      throw new Error('meeting action conflict payload is not JSON');
    }
    const conflictId = `action-item:${claim.idempotencyKey}`;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getAllAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        claim.scopeKey,
        claim.actionId,
        claim.claimToken,
      );
      if (claimed.length !== new Set(claim.operationIds).size) return false;
      await database.runAsync(
        `INSERT OR IGNORE INTO sync_conflicts (
           id, scope_key, aggregate_type, aggregate_id,
           local_revision, remote_revision, local_payload_json,
           remote_payload_json, status, created_at_ms
         ) VALUES (?, ?, 'action_item', ?, ?, ?, ?, ?, 'unresolved', ?)`,
        conflictId,
        claim.scopeKey,
        claim.actionId,
        conflict.localRevision,
        conflict.remoteRevision,
        claim.requestPayloadJson,
        conflict.remotePayloadJson,
        conflict.createdAtMs,
      );
      const stored = await database.getFirstAsync<{
        scope_key: string;
        aggregate_type: string;
        aggregate_id: string;
      }>('SELECT scope_key, aggregate_type, aggregate_id FROM sync_conflicts WHERE id = ?', conflictId);
      if (
        !stored
        || stored.scope_key !== claim.scopeKey
        || stored.aggregate_type !== 'action_item'
        || stored.aggregate_id !== claim.actionId
      ) throw new Error('meeting action conflict identity was reused');
      const blocked = await database.runAsync(
        `UPDATE sync_outbox SET
           status = 'blocked', next_attempt_at_ms = NULL,
           last_error_code = 'revision_conflict', claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        conflict.createdAtMs,
        claim.scopeKey,
        claim.actionId,
        claim.claimToken,
      );
      if (blocked.changes !== new Set(claim.operationIds).size) {
        throw new Error('meeting action conflict changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async ensureManualNoteSyncOperations(
    scopeKey: ScopeKey,
    createdAtMs: number,
  ): Promise<number> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return 0;
    assertNonNegativeInteger(createdAtMs, 'manual note sync repair time');
    const repairedMeetingIds = await withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<{
        meeting_id: string;
        content: string;
        revision: number;
        base_remote_revision: number | null;
        last_saved_at_ms: number;
        user_edited_at_ms: number | null;
      }>(
        `SELECT note.meeting_id, note.content, note.revision,
           note.base_remote_revision, note.last_saved_at_ms, note.user_edited_at_ms
         FROM manual_notes note
         INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND note.dirty = 1 AND note.revision >= 1
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox outbox
             WHERE outbox.scope_key = meeting.scope_key
               AND outbox.aggregate_type = 'manual_note'
               AND outbox.aggregate_id = note.meeting_id
               AND outbox.status <> 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM sync_conflicts conflict
             WHERE conflict.scope_key = meeting.scope_key
               AND conflict.aggregate_type = 'manual_note'
               AND conflict.aggregate_id = note.meeting_id
               AND conflict.status = 'unresolved'
           )
         ORDER BY note.last_saved_at_ms, note.meeting_id`,
        scopeKey,
      );
      const repaired: string[] = [];
      for (const row of rows) {
        const operationId = secureClientIdFactory.create();
        const payloadJson = JSON.stringify({
          schema_version: 2,
          meeting_id: row.meeting_id,
          expected_remote_revision: row.base_remote_revision,
          client_note_revision: row.revision,
          client_updated_at_ms: row.last_saved_at_ms,
          user_edited_at_ms: row.user_edited_at_ms,
          content: row.content,
        });
        const inserted = await database.runAsync(
          `INSERT INTO sync_outbox (
             operation_id, scope_key, aggregate_type, aggregate_id,
             operation_type, base_revision, payload_json, status,
             attempt_count, next_attempt_at_ms, last_error_code,
             request_payload_json, claim_token, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 'manual_note', ?, 'manual_note.upsert', ?, ?, 'pending',
             0, NULL, NULL, NULL, NULL, ?, ?)`,
          operationId,
          scopeKey,
          row.meeting_id,
          row.base_remote_revision,
          payloadJson,
          createdAtMs,
          createdAtMs,
        );
        if (inserted.changes !== 1) throw new Error('manual note sync repair was not inserted');
        await database.runAsync(
          `UPDATE meeting_notes SET sync_state = 'pending'
           WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
          row.meeting_id,
          scopeKey,
        );
        repaired.push(row.meeting_id);
      }
      return repaired;
    });
    if (repairedMeetingIds.length > 0) this.notify(repairedMeetingIds);
    return repairedMeetingIds.length;
  }

  async claimManualNoteSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimManualNoteSyncOptions,
  ): Promise<readonly ManualNoteSyncClaim[]> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return [];
    assertNonNegativeInteger(options.nowMs, 'manual note sync claim time');
    assertNonNegativeInteger(options.staleBeforeMs, 'manual note sync stale time');
    if (!Number.isSafeInteger(options.maxMeetings) || options.maxMeetings < 1) {
      throw new Error('manual note sync concurrency is invalid');
    }
    const maxMeetings = Math.min(3, options.maxMeetings);

    return withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<ManualNoteSyncOutboxRow>(
        `SELECT
           outbox.operation_id, outbox.scope_key, outbox.aggregate_type,
           outbox.aggregate_id, outbox.operation_type, outbox.base_revision,
           outbox.payload_json, outbox.status, outbox.attempt_count,
           outbox.next_attempt_at_ms, outbox.last_error_code,
           outbox.request_payload_json, outbox.claim_token,
           outbox.created_at_ms, outbox.updated_at_ms,
           note.meeting_id AS meeting_id,
           meeting.remote_id AS meeting_remote_id,
           note.content AS note_content,
           note.revision AS note_revision,
           note.base_remote_revision AS note_base_remote_revision,
           note.dirty AS note_dirty,
           note.last_saved_at_ms AS note_last_saved_at_ms,
           note.user_edited_at_ms AS note_user_edited_at_ms
         FROM sync_outbox outbox
         INNER JOIN manual_notes note ON note.meeting_id = outbox.aggregate_id
         INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
         WHERE outbox.scope_key = ? AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'
           AND meeting.remote_id IS NOT NULL
           AND LENGTH(TRIM(meeting.remote_id)) > 0
           AND outbox.aggregate_type = 'manual_note'
           AND outbox.operation_type = 'manual_note.upsert'
           AND outbox.status IN ('pending', 'retry', 'in_flight')
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox blocker
             WHERE blocker.scope_key = outbox.scope_key
               AND blocker.aggregate_type = 'manual_note'
               AND blocker.aggregate_id = outbox.aggregate_id
               AND blocker.status IN ('blocked', 'permanent_error')
           )
         ORDER BY outbox.created_at_ms, outbox.operation_id`,
        scopeKey,
        scopeKey,
      );

      type ClaimMode = 'stale' | 'retry' | 'pending';
      type ClaimGroup = { mode: ClaimMode; rows: ManualNoteSyncOutboxRow[]; sortAtMs: number };
      const byMeeting = new Map<string, ManualNoteSyncOutboxRow[]>();
      rows.forEach(row => {
        const group = byMeeting.get(row.meeting_id);
        if (group) group.push(row);
        else byMeeting.set(row.meeting_id, [row]);
      });
      const groups: ClaimGroup[] = [];
      byMeeting.forEach(meetingRows => {
        const inFlight = meetingRows.filter(row => row.status === 'in_flight');
        if (inFlight.length > 0) {
          if (inFlight.every(row => row.updated_at_ms <= options.staleBeforeMs)) {
            groups.push({
              mode: 'stale',
              rows: inFlight,
              sortAtMs: Math.min(...inFlight.map(row => row.updated_at_ms)),
            });
          }
          return;
        }
        const retries = meetingRows.filter(row => row.status === 'retry');
        if (retries.length > 0) {
          const eligible = retries
            .filter(row => row.next_attempt_at_ms === null || row.next_attempt_at_ms <= options.nowMs)
            .sort((left, right) => (
              (left.next_attempt_at_ms ?? 0) - (right.next_attempt_at_ms ?? 0)
              || left.updated_at_ms - right.updated_at_ms
              || left.created_at_ms - right.created_at_ms
              || left.operation_id.localeCompare(right.operation_id)
            ));
          const anchor = eligible[0];
          if (anchor) {
            const cohort = retries.filter(row => (
              row.request_payload_json === anchor.request_payload_json
              && row.next_attempt_at_ms === anchor.next_attempt_at_ms
              && row.updated_at_ms === anchor.updated_at_ms
            ));
            groups.push({ mode: 'retry', rows: cohort, sortAtMs: anchor.updated_at_ms });
          }
          return;
        }
        const pending = meetingRows.filter(row => row.status === 'pending');
        if (pending.length > 0) {
          groups.push({
            mode: 'pending',
            rows: pending,
            sortAtMs: Math.min(...pending.map(row => row.created_at_ms)),
          });
        }
      });
      const priority: Record<ClaimMode, number> = { stale: 0, retry: 1, pending: 2 };
      groups.sort((left, right) => (
        priority[left.mode] - priority[right.mode]
        || left.sortAtMs - right.sortAtMs
        || left.rows[0].meeting_id.localeCompare(right.rows[0].meeting_id)
      ));

      const claims: ManualNoteSyncClaim[] = [];
      for (const group of groups) {
        const first = group.rows[0];
        if (!first) continue;
        const ordered = [...group.rows].sort((left, right) => (
          left.created_at_ms - right.created_at_ms
          || left.operation_id.localeCompare(right.operation_id)
        ));
        const idempotencyRow = ordered[ordered.length - 1];
        const requestPayloadJson = group.mode === 'pending'
          ? manualNoteSyncRequestPayload(idempotencyRow)
          : idempotencyRow.request_payload_json ?? manualNoteSyncRequestPayload(idempotencyRow);
        let meetingRemoteId = first.meeting_remote_id;
        try {
          const payload = JSON.parse(requestPayloadJson) as { meeting_remote_id?: unknown };
          if (typeof payload.meeting_remote_id === 'string' && payload.meeting_remote_id.trim()) {
            meetingRemoteId = payload.meeting_remote_id.trim();
          }
        } catch {
          // The transport parser quarantines malformed snapshots before network I/O.
        }
        const claimToken = secureClientIdFactory.create();
        let updateSql = `UPDATE sync_outbox SET
           status = 'in_flight', attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL,
           request_payload_json = ?, claim_token = ?, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND operation_type = 'manual_note.upsert'`;
        const params: Array<string | number | null> = [
          requestPayloadJson,
          claimToken,
          options.nowMs,
          scopeKey,
          first.meeting_id,
        ];
        if (group.mode === 'stale') {
          updateSql += " AND status = 'in_flight' AND updated_at_ms <= ?";
          params.push(options.staleBeforeMs);
        } else if (group.mode === 'retry') {
          updateSql += ` AND status = 'retry'
            AND request_payload_json IS ? AND next_attempt_at_ms IS ? AND updated_at_ms = ?`;
          params.push(
            idempotencyRow.request_payload_json,
            idempotencyRow.next_attempt_at_ms,
            idempotencyRow.updated_at_ms,
          );
        } else {
          updateSql += " AND status = 'pending'";
        }
        const updated = await database.runAsync(updateSql, ...params);
        if (updated.changes !== ordered.length) {
          throw new Error('manual note sync claim changed concurrently');
        }
        claims.push({
          scopeKey,
          meetingId: first.meeting_id,
          meetingRemoteId,
          operationIds: ordered.map(row => row.operation_id),
          idempotencyKey: idempotencyRow.operation_id,
          claimToken,
          requestPayloadJson,
          attemptCount: idempotencyRow.attempt_count + 1,
        });
        if (claims.length >= maxMeetings) break;
      }
      return claims;
    });
  }

  async completeManualNoteSyncClaim(
    claim: ManualNoteSyncClaim,
    remoteRevision: number,
    completedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'manual note sync claim');
    assertNonNegativeInteger(remoteRevision, 'manual note remote revision');
    if (remoteRevision < 1) throw new Error('manual note remote revision is invalid');
    assertNonNegativeInteger(completedAtMs, 'manual note sync completion time');
    let request: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
      request = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      request = null;
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getAllAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      const expectedIds = new Set(claim.operationIds);
      if (
        claimed.length !== expectedIds.size
        || claimed.some(row => !expectedIds.has(row.operation_id))
      ) return false;
      const note = await database.getFirstAsync<ManualNoteRow>(
        `SELECT note.* FROM manual_notes note
         INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
         WHERE note.meeting_id = ? AND meeting.scope_key = ?`,
        claim.meetingId,
        claim.scopeKey,
      );
      if (!note) throw new Error('manual note sync target no longer exists');
      if (note.base_remote_revision !== null && note.base_remote_revision > remoteRevision) {
        throw new Error('manual note remote revision moved backwards');
      }
      const snapshotMatches = Boolean(
        request
        && request.content === note.content
        && request.client_note_revision === note.revision
        && request.client_updated_at_ms === note.last_saved_at_ms
        && request.user_edited_at_ms === note.user_edited_at_ms
      );
      const updatedNote = await database.runAsync(
        `UPDATE manual_notes SET base_remote_revision = ?, dirty = ?
         WHERE meeting_id = ?`,
        remoteRevision,
        snapshotMatches ? 0 : 1,
        claim.meetingId,
      );
      if (updatedNote.changes !== 1) throw new Error('manual note sync target changed concurrently');
      const completed = await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        completedAtMs,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (completed.changes !== expectedIds.size) {
        throw new Error('manual note sync completion changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async failManualNoteSyncClaim(
    claim: ManualNoteSyncClaim,
    failure: ManualNoteSyncFailure,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'manual note sync claim');
    assertNonNegativeInteger(failure.updatedAtMs, 'manual note sync failure time');
    assertOptionalNonNegativeInteger(failure.nextAttemptAtMs, 'manual note sync retry time');
    const errorCode = normalizedSyncErrorCode(failure.errorCode);
    if (failure.disposition === 'retry' && failure.nextAttemptAtMs === null) {
      throw new Error('manual note sync retry time is missing');
    }
    if (failure.disposition !== 'retry' && failure.nextAttemptAtMs !== null) {
      throw new Error('manual note sync terminal failure cannot have retry time');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const failed = await database.runAsync(
        `UPDATE sync_outbox SET status = ?, next_attempt_at_ms = ?, last_error_code = ?,
           claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        failure.disposition,
        failure.nextAttemptAtMs,
        errorCode,
        failure.updatedAtMs,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (failed.changes === 0) return false;
      if (failed.changes !== new Set(claim.operationIds).size) {
        throw new Error('manual note sync failure changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async recordManualNoteSyncConflict(
    claim: ManualNoteSyncClaim,
    conflict: ManualNoteSyncConflict,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'meeting ID');
    assertRecordId(claim.claimToken, 'manual note sync claim');
    assertOptionalNonNegativeInteger(conflict.remoteRevision, 'manual note conflict remote revision');
    assertNonNegativeInteger(conflict.createdAtMs, 'manual note conflict time');
    if (!conflict.remotePayloadJson || conflict.remotePayloadJson.length > 1_048_576) {
      throw new Error('manual note conflict payload is invalid');
    }
    try {
      JSON.parse(conflict.remotePayloadJson);
    } catch {
      throw new Error('manual note conflict payload is not JSON');
    }
    let localRevision: number | null = null;
    try {
      const payload = JSON.parse(claim.requestPayloadJson) as { expected_remote_revision?: unknown };
      localRevision = payload.expected_remote_revision === null
        ? null
        : Number.isSafeInteger(payload.expected_remote_revision)
          && Number(payload.expected_remote_revision) >= 0
          ? Number(payload.expected_remote_revision)
          : null;
    } catch {
      localRevision = null;
    }
    const conflictId = `manual-note:${claim.idempotencyKey}`;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getAllAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (claimed.length !== new Set(claim.operationIds).size) return false;
      await database.runAsync(
        `INSERT OR IGNORE INTO sync_conflicts (
           id, scope_key, aggregate_type, aggregate_id,
           local_revision, remote_revision, local_payload_json,
           remote_payload_json, status, created_at_ms
         ) VALUES (?, ?, 'manual_note', ?, ?, ?, ?, ?, 'unresolved', ?)`,
        conflictId,
        claim.scopeKey,
        claim.meetingId,
        localRevision,
        conflict.remoteRevision,
        claim.requestPayloadJson,
        conflict.remotePayloadJson,
        conflict.createdAtMs,
      );
      const stored = await database.getFirstAsync<{
        scope_key: string;
        aggregate_type: string;
        aggregate_id: string;
      }>('SELECT scope_key, aggregate_type, aggregate_id FROM sync_conflicts WHERE id = ?', conflictId);
      if (
        !stored
        || stored.scope_key !== claim.scopeKey
        || stored.aggregate_type !== 'manual_note'
        || stored.aggregate_id !== claim.meetingId
      ) throw new Error('manual note conflict identity was reused');
      const blocked = await database.runAsync(
        `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
           last_error_code = 'revision_conflict', claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'in_flight' AND claim_token = ?`,
        conflict.createdAtMs,
        claim.scopeKey,
        claim.meetingId,
        claim.claimToken,
      );
      if (blocked.changes !== new Set(claim.operationIds).size) {
        throw new Error('manual note conflict changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async claimSpeakerCorrectionSyncOperations(
    scopeKey: ScopeKey,
    options: ClaimSpeakerCorrectionSyncOptions,
  ): Promise<readonly SpeakerCorrectionSyncClaim[]> {
    assertScopeKey(scopeKey);
    if (scopeKey === 'guest') return [];
    assertNonNegativeInteger(options.nowMs, 'speaker correction sync claim time');
    assertNonNegativeInteger(options.staleBeforeMs, 'speaker correction sync stale time');
    if (!Number.isSafeInteger(options.maxMeetings) || options.maxMeetings < 1) {
      throw new Error('speaker correction sync concurrency is invalid');
    }
    const maxMeetings = Math.min(3, options.maxMeetings);

    return withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<SpeakerCorrectionSyncOutboxRow>(
        `SELECT
           outbox.operation_id, outbox.scope_key, outbox.aggregate_type,
           outbox.aggregate_id, outbox.operation_type, outbox.base_revision,
           outbox.payload_json, outbox.status, outbox.attempt_count,
           outbox.next_attempt_at_ms, outbox.last_error_code,
           outbox.request_payload_json, outbox.claim_token,
           outbox.created_at_ms, outbox.updated_at_ms,
           correction.meeting_id AS meeting_id,
           meeting.remote_id AS meeting_remote_id,
           revision.remote_id AS transcript_remote_id,
           correction.assignment_revision AS assignment_revision
         FROM sync_outbox outbox
         INNER JOIN speaker_corrections correction ON correction.id = outbox.aggregate_id
         INNER JOIN meeting_notes meeting ON meeting.id = correction.meeting_id
         INNER JOIN transcript_revisions revision
           ON revision.id = correction.transcript_revision_id
         WHERE outbox.scope_key = ?
           AND correction.scope_key = ?
           AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'
           AND meeting.remote_id IS NOT NULL
           AND LENGTH(TRIM(meeting.remote_id)) > 0
           AND revision.remote_id IS NOT NULL
           AND LENGTH(TRIM(revision.remote_id)) > 0
           AND correction.sync_state IN ('pending', 'failed')
           AND outbox.aggregate_type = 'speaker_correction'
           AND outbox.operation_type = 'speaker_correction.submit'
           AND outbox.status IN ('pending', 'retry', 'in_flight')
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox blocker
             INNER JOIN speaker_corrections blocked_correction
               ON blocked_correction.id = blocker.aggregate_id
             WHERE blocker.scope_key = outbox.scope_key
               AND blocker.aggregate_type = 'speaker_correction'
               AND blocked_correction.meeting_id = correction.meeting_id
               AND blocker.status IN ('blocked', 'permanent_error')
           )
         ORDER BY correction.meeting_id, correction.assignment_revision,
           outbox.created_at_ms, outbox.operation_id`,
        scopeKey,
        scopeKey,
        scopeKey,
      );

      type ClaimMode = 'stale' | 'retry' | 'pending';
      type Candidate = { mode: ClaimMode; row: SpeakerCorrectionSyncOutboxRow; sortAtMs: number };
      const byMeeting = new Map<string, SpeakerCorrectionSyncOutboxRow[]>();
      rows.forEach(row => {
        const group = byMeeting.get(row.meeting_id);
        if (group) group.push(row);
        else byMeeting.set(row.meeting_id, [row]);
      });
      const candidates: Candidate[] = [];
      byMeeting.forEach(meetingRows => {
        const ordered = [...meetingRows].sort((left, right) => (
          left.assignment_revision - right.assignment_revision
          || left.created_at_ms - right.created_at_ms
          || left.operation_id.localeCompare(right.operation_id)
        ));
        const row = ordered[0];
        if (!row) return;
        if (row.status === 'in_flight') {
          if (row.updated_at_ms <= options.staleBeforeMs) {
            candidates.push({ mode: 'stale', row, sortAtMs: row.updated_at_ms });
          }
          return;
        }
        if (row.status === 'retry') {
          if (row.next_attempt_at_ms === null || row.next_attempt_at_ms <= options.nowMs) {
            candidates.push({ mode: 'retry', row, sortAtMs: row.updated_at_ms });
          }
          return;
        }
        if (row.status === 'pending') {
          candidates.push({ mode: 'pending', row, sortAtMs: row.created_at_ms });
        }
      });
      const priority: Record<ClaimMode, number> = { stale: 0, retry: 1, pending: 2 };
      candidates.sort((left, right) => (
        priority[left.mode] - priority[right.mode]
        || left.sortAtMs - right.sortAtMs
        || left.row.meeting_id.localeCompare(right.row.meeting_id)
      ));

      const claims: SpeakerCorrectionSyncClaim[] = [];
      for (const candidate of candidates.slice(0, maxMeetings)) {
        const row = candidate.row;
        const requestPayloadJson = candidate.mode === 'pending'
          ? speakerCorrectionSyncRequestPayload(row)
          : row.request_payload_json ?? speakerCorrectionSyncRequestPayload(row);
        let meetingRemoteId = row.meeting_remote_id;
        try {
          const requestPayload = JSON.parse(requestPayloadJson) as { meeting_remote_id?: unknown };
          if (typeof requestPayload.meeting_remote_id === 'string' && requestPayload.meeting_remote_id.trim()) {
            meetingRemoteId = requestPayload.meeting_remote_id.trim();
          }
        } catch {
          // The transport parser quarantines malformed snapshots before network I/O.
        }
        const claimToken = secureClientIdFactory.create();
        let updateSql = `UPDATE sync_outbox SET
           status = 'in_flight', attempt_count = attempt_count + 1,
           next_attempt_at_ms = NULL, last_error_code = NULL,
           request_payload_json = ?, claim_token = ?, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction'
           AND aggregate_id = ? AND operation_type = 'speaker_correction.submit'`;
        const updateParams: Array<string | number | null> = [
          requestPayloadJson,
          claimToken,
          options.nowMs,
          row.operation_id,
          scopeKey,
          row.aggregate_id,
        ];
        if (candidate.mode === 'stale') {
          updateSql += " AND status = 'in_flight' AND updated_at_ms <= ?";
          updateParams.push(options.staleBeforeMs);
        } else if (candidate.mode === 'retry') {
          updateSql += ` AND status = 'retry'
            AND request_payload_json IS ?
            AND next_attempt_at_ms IS ? AND updated_at_ms = ?`;
          updateParams.push(
            row.request_payload_json,
            row.next_attempt_at_ms,
            row.updated_at_ms,
          );
        } else {
          updateSql += " AND status = 'pending'";
        }
        const updated = await database.runAsync(updateSql, ...updateParams);
        if (updated.changes !== 1) {
          throw new Error('speaker correction sync claim changed concurrently');
        }
        const markedPending = await database.runAsync(
          `UPDATE speaker_corrections SET
             sync_state = 'pending', last_sync_error_code = NULL, updated_at_ms = ?
           WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
          options.nowMs,
          row.aggregate_id,
          row.meeting_id,
          scopeKey,
        );
        if (markedPending.changes !== 1) {
          throw new Error('speaker correction sync target changed concurrently');
        }
        const baseRevision = Number(row.base_revision ?? 0);
        assertNonNegativeInteger(baseRevision, 'speaker correction sync base revision');
        claims.push({
          scopeKey,
          meetingId: row.meeting_id,
          meetingRemoteId,
          correctionId: row.aggregate_id,
          operationId: row.operation_id,
          idempotencyKey: row.aggregate_id,
          claimToken,
          requestPayloadJson,
          baseRevision,
          attemptCount: row.attempt_count + 1,
        });
      }
      return claims;
    });
  }

  async completeSpeakerCorrectionSyncClaim(
    claim: SpeakerCorrectionSyncClaim,
    remoteAssignmentRevision: number,
    completedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'speaker correction meeting ID');
    assertRecordId(claim.correctionId, 'speaker correction ID');
    assertRecordId(claim.operationId, 'speaker correction operation ID');
    assertRecordId(claim.claimToken, 'speaker correction sync claim');
    assertNonNegativeInteger(remoteAssignmentRevision, 'speaker correction remote revision');
    assertNonNegativeInteger(completedAtMs, 'speaker correction sync completion time');
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getFirstAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.correctionId,
        claim.claimToken,
      );
      if (!claimed) return false;
      const correction = await database.getFirstAsync<{
        remote_assignment_revision: number | null;
      }>(
        `SELECT correction.remote_assignment_revision
         FROM speaker_corrections correction
         INNER JOIN meeting_notes meeting ON meeting.id = correction.meeting_id
         WHERE correction.id = ? AND correction.meeting_id = ?
           AND correction.scope_key = ? AND meeting.scope_key = ?`,
        claim.correctionId,
        claim.meetingId,
        claim.scopeKey,
        claim.scopeKey,
      );
      if (!correction) throw new Error('speaker correction sync target no longer exists');
      if (
        correction.remote_assignment_revision !== null
        && correction.remote_assignment_revision !== remoteAssignmentRevision
      ) throw new Error('speaker correction remote revision changed');
      const updatedCorrection = await database.runAsync(
        `UPDATE speaker_corrections SET
           sync_state = 'synced', remote_assignment_revision = ?,
           last_sync_error_code = NULL, synced_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
        remoteAssignmentRevision,
        completedAtMs,
        completedAtMs,
        claim.correctionId,
        claim.meetingId,
        claim.scopeKey,
      );
      if (updatedCorrection.changes !== 1) {
        throw new Error('speaker correction sync target changed concurrently');
      }
      const completed = await database.runAsync(
        `UPDATE sync_outbox SET
           status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        completedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.correctionId,
        claim.claimToken,
      );
      if (completed.changes !== 1) {
        throw new Error('speaker correction sync completion changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async failSpeakerCorrectionSyncClaim(
    claim: SpeakerCorrectionSyncClaim,
    failure: SpeakerCorrectionSyncFailure,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'speaker correction meeting ID');
    assertRecordId(claim.correctionId, 'speaker correction ID');
    assertRecordId(claim.operationId, 'speaker correction operation ID');
    assertRecordId(claim.claimToken, 'speaker correction sync claim');
    assertNonNegativeInteger(failure.updatedAtMs, 'speaker correction sync failure time');
    assertOptionalNonNegativeInteger(failure.nextAttemptAtMs, 'speaker correction sync retry time');
    const errorCode = normalizedSyncErrorCode(failure.errorCode);
    if (failure.disposition === 'retry' && failure.nextAttemptAtMs === null) {
      throw new Error('speaker correction sync retry time is missing');
    }
    if (failure.disposition !== 'retry' && failure.nextAttemptAtMs !== null) {
      throw new Error('speaker correction sync terminal failure cannot have retry time');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const failed = await database.runAsync(
        `UPDATE sync_outbox SET
           status = ?, next_attempt_at_ms = ?, last_error_code = ?,
           claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        failure.disposition,
        failure.nextAttemptAtMs,
        errorCode,
        failure.updatedAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.correctionId,
        claim.claimToken,
      );
      if (failed.changes === 0) return false;
      if (failed.changes !== 1) {
        throw new Error('speaker correction sync failure changed concurrently');
      }
      const correctionState = failure.disposition === 'retry' ? 'failed' : 'blocked';
      const updatedCorrection = await database.runAsync(
        `UPDATE speaker_corrections SET
           sync_state = ?, last_sync_error_code = ?, updated_at_ms = ?
         WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
        correctionState,
        errorCode,
        failure.updatedAtMs,
        claim.correctionId,
        claim.meetingId,
        claim.scopeKey,
      );
      if (updatedCorrection.changes !== 1) {
        throw new Error('speaker correction sync failure target changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async recordSpeakerCorrectionSyncConflict(
    claim: SpeakerCorrectionSyncClaim,
    conflict: SpeakerCorrectionSyncConflict,
  ): Promise<boolean> {
    assertScopeKey(claim.scopeKey);
    assertRecordId(claim.meetingId, 'speaker correction meeting ID');
    assertRecordId(claim.correctionId, 'speaker correction ID');
    assertRecordId(claim.operationId, 'speaker correction operation ID');
    assertRecordId(claim.claimToken, 'speaker correction sync claim');
    assertOptionalNonNegativeInteger(conflict.remoteRevision, 'speaker correction conflict revision');
    assertNonNegativeInteger(conflict.createdAtMs, 'speaker correction conflict time');
    if (!conflict.remotePayloadJson || conflict.remotePayloadJson.length > 1_048_576) {
      throw new Error('speaker correction conflict payload is invalid');
    }
    try {
      JSON.parse(conflict.remotePayloadJson);
    } catch {
      throw new Error('speaker correction conflict payload is not JSON');
    }
    const conflictId = `speaker-correction:${claim.correctionId}`;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const claimed = await database.getFirstAsync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_outbox
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        claim.operationId,
        claim.scopeKey,
        claim.correctionId,
        claim.claimToken,
      );
      if (!claimed) return false;
      await database.runAsync(
        `INSERT OR IGNORE INTO sync_conflicts (
           id, scope_key, aggregate_type, aggregate_id,
           local_revision, remote_revision, local_payload_json,
           remote_payload_json, status, created_at_ms
         ) VALUES (?, ?, 'speaker_correction', ?, ?, ?, ?, ?, 'unresolved', ?)`,
        conflictId,
        claim.scopeKey,
        claim.correctionId,
        claim.baseRevision,
        conflict.remoteRevision,
        claim.requestPayloadJson,
        conflict.remotePayloadJson,
        conflict.createdAtMs,
      );
      const stored = await database.getFirstAsync<{
        scope_key: string;
        aggregate_type: string;
        aggregate_id: string;
      }>('SELECT scope_key, aggregate_type, aggregate_id FROM sync_conflicts WHERE id = ?', conflictId);
      if (
        !stored
        || stored.scope_key !== claim.scopeKey
        || stored.aggregate_type !== 'speaker_correction'
        || stored.aggregate_id !== claim.correctionId
      ) throw new Error('speaker correction conflict identity was reused');
      const blocked = await database.runAsync(
        `UPDATE sync_outbox SET
           status = 'blocked', next_attempt_at_ms = NULL,
           last_error_code = 'revision_conflict', claim_token = NULL, updated_at_ms = ?
         WHERE operation_id = ? AND scope_key = ?
           AND aggregate_type = 'speaker_correction' AND aggregate_id = ?
           AND status = 'in_flight' AND claim_token = ?`,
        conflict.createdAtMs,
        claim.operationId,
        claim.scopeKey,
        claim.correctionId,
        claim.claimToken,
      );
      if (blocked.changes !== 1) {
        throw new Error('speaker correction conflict changed concurrently');
      }
      const updatedCorrection = await database.runAsync(
        `UPDATE speaker_corrections SET
           sync_state = 'blocked', last_sync_error_code = 'revision_conflict',
           updated_at_ms = ?
         WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
        conflict.createdAtMs,
        claim.correctionId,
        claim.meetingId,
        claim.scopeKey,
      );
      if (updatedCorrection.changes !== 1) {
        throw new Error('speaker correction conflict target changed concurrently');
      }
      await refreshMeetingSyncState(database, claim.meetingId, claim.scopeKey);
      return true;
    });
    if (applied) this.notify([claim.meetingId]);
    return applied;
  }

  async getTranscriptRevisionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const revision = await database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.id = ? AND meeting.scope_key = ?`,
      id,
      scopeKey,
    );
    return revision ? this.transcriptProjectionFromRow(database, revision, scopeKey) : null;
  }

  async getActiveTranscriptContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const revision = await database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.meeting_id = ? AND meeting.scope_key = ? AND revision.is_active = 1
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return revision ? this.transcriptProjectionFromRow(database, revision, scopeKey) : null;
  }

  async getSummaryVersionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionProjection | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const version = await database.getFirstAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE version.id = ? AND meeting.scope_key = ?`,
      id,
      scopeKey,
    );
    return version ? this.summaryProjectionFromRow(database, version, scopeKey) : null;
  }

  async getCurrentSummaryContent(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionProjection | null> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const version = await database.getFirstAsync<SummaryVersionRow>(
      `SELECT version.*, ${SUMMARY_EFFECTIVE_USER_EDITED_SQL} FROM summary_versions version
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE meeting.id = ? AND meeting.scope_key = ?
         AND meeting.current_summary_version_id = version.id
       LIMIT 1`,
      meetingId,
      scopeKey,
    );
    return version ? this.summaryProjectionFromRow(database, version, scopeKey) : null;
  }

  async listMeetingMarkers(meetingId: string, scopeKey: ScopeKey): Promise<readonly MarkerRecord[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MarkerRow>(
      `SELECT marker.* FROM markers marker
       INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
       WHERE marker.meeting_id = ? AND meeting.scope_key = ?
       ORDER BY marker.position_ms, marker.created_at_ms, marker.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(markerFromRow);
  }

  async listSeriesCarryImports(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingSeriesCarryImportRecord[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingSeriesCarryImportRow>(
      `SELECT imported.* FROM meeting_series_carry_imports imported
       INNER JOIN meeting_notes meeting ON meeting.id = imported.target_meeting_id
       WHERE imported.target_meeting_id = ? AND meeting.scope_key = ?
       ORDER BY imported.imported_at_ms, imported.source_kind, imported.source_item_id`,
      meetingId,
      scopeKey,
    );
    return rows.map(seriesCarryImportFromRow);
  }

  async listMeetingActions(meetingId: string, scopeKey: ScopeKey): Promise<readonly ActionItemRecord[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<ActionItemRow>(
      `SELECT action.*, segment.source_segment_id AS source_segment_source_id
       FROM action_items action
       LEFT JOIN transcript_segments segment ON segment.id = action.source_segment_id
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       WHERE action.meeting_id = ? AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
       ORDER BY CASE action.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
         CASE WHEN action.due_at_ms IS NULL THEN 1 ELSE 0 END,
         action.due_at_ms, action.created_at_ms, action.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(actionItemFromRow);
  }

  async listMeetingActionSyncConflicts(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingActionSyncConflictRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingActionSyncConflictRow>(
      `SELECT conflict.id, action.meeting_id, conflict.aggregate_id,
         conflict.local_revision, conflict.remote_revision,
         conflict.local_payload_json, conflict.remote_payload_json,
         conflict.created_at_ms
       FROM sync_conflicts conflict
       INNER JOIN action_items action ON action.id = conflict.aggregate_id
       INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
       WHERE conflict.scope_key = ? AND conflict.aggregate_type = 'action_item'
         AND conflict.status = 'unresolved'
         AND action.meeting_id = ? AND meeting.scope_key = ?
         AND meeting.lifecycle <> 'deleted'
       ORDER BY conflict.created_at_ms, conflict.id`,
      scopeKey,
      meetingId,
      scopeKey,
    );
    return rows.map(row => ({
      id: row.id,
      meetingId: row.meeting_id,
      actionId: row.aggregate_id,
      localRevision: row.local_revision,
      remoteRevision: row.remote_revision,
      localPayloadJson: row.local_payload_json,
      remotePayloadJson: row.remote_payload_json,
      createdAtMs: row.created_at_ms,
    }));
  }

  async getMeetingActionPullState(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingActionPullState | null> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    if (scopeKey === 'guest') return null;
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<MeetingActionPullStateRow>(
      `SELECT state.* FROM meeting_action_pull_state state
       INNER JOIN meeting_notes meeting ON meeting.id = state.meeting_id
       WHERE state.meeting_id = ? AND state.scope_key = ?
         AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
      meetingId,
      scopeKey,
      scopeKey,
    );
    return row ? {
      meetingId: row.meeting_id,
      scopeKey: row.scope_key as ScopeKey,
      remoteMeetingId: row.remote_meeting_id,
      cursor: row.cursor,
      updatedAtMs: row.updated_at_ms,
    } : null;
  }

  async mergeMeetingActionPullPage(
    input: MergeMeetingActionPullPageInput,
  ): Promise<MergeMeetingActionPullPageResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest meeting cannot pull remote actions');
    assertRecordId(input.meetingId, 'meeting ID');
    assertRecordId(input.remoteMeetingId, 'remote meeting ID');
    assertActionPullCursor(input.expectedCursor, 'meeting action expected cursor');
    assertActionPullCursor(input.nextCursor, 'meeting action next cursor');
    assertNonNegativeInteger(input.pulledAtMs, 'meeting action pull time');
    if (input.items.length > 200) throw new Error('meeting action pull page is too large');
    if (input.items.length > 0 && input.nextCursor === null) {
      throw new Error('meeting action pull page cursor is missing');
    }
    if (input.items.length > 0 && input.nextCursor === input.expectedCursor) {
      throw new Error('meeting action pull page cursor did not advance');
    }
    input.items.forEach(assertRemoteMeetingAction);
    if (
      new Set(input.items.map(item => item.clientActionId)).size !== input.items.length
      || new Set(input.items.map(item => item.remoteId)).size !== input.items.length
    ) throw new Error('meeting action pull page contains duplicate identities');

    const result = await withMeetingDatabaseTransaction(async database => {
      const emptyResult = (): MergeMeetingActionPullPageResult => ({
        applied: false,
        inserted: 0,
        updated: 0,
        attached: 0,
        conflicted: 0,
        ignoredStale: 0,
        cursorAdvanced: false,
      });
      const meeting = await database.getFirstAsync<MeetingRow>(
        `SELECT * FROM meeting_notes
         WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
        input.meetingId,
        input.scopeKey,
      );
      if (!meeting || meeting.remote_id !== input.remoteMeetingId) {
        throw new Error('meeting action pull identity changed');
      }
      const state = await database.getFirstAsync<MeetingActionPullStateRow>(
        'SELECT * FROM meeting_action_pull_state WHERE meeting_id = ?',
        input.meetingId,
      );
      if (state) {
        if (
          state.scope_key !== input.scopeKey
          || state.remote_meeting_id !== input.remoteMeetingId
        ) throw new Error('meeting action pull state belongs to another meeting');
        if (state.cursor !== input.expectedCursor) return emptyResult();
      } else if (input.expectedCursor !== null) {
        return emptyResult();
      }

      let inserted = 0;
      let updated = 0;
      let attached = 0;
      let conflicted = 0;
      let ignoredStale = 0;
      let didChange = false;
      let contentChanged = false;
      let latestClientUpdatedAtMs = meeting.updated_at_ms;

      const mappedSegmentId = async (sourceSegmentId: string | null): Promise<string | null> => {
        if (sourceSegmentId === null) return null;
        const matches = await database.getAllAsync<{ id: string }>(
          `SELECT segment.id FROM transcript_segments segment
           INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
           INNER JOIN meeting_notes stored ON stored.id = revision.meeting_id
           WHERE revision.meeting_id = ? AND revision.is_active = 1
             AND stored.scope_key = ? AND stored.lifecycle <> 'deleted'
             AND (segment.source_segment_id = ? OR segment.id = ?)
           ORDER BY segment.id`,
          input.meetingId,
          input.scopeKey,
          sourceSegmentId,
          sourceSegmentId,
        );
        const identities = [...new Set(matches.map(row => row.id))];
        return identities.length === 1 ? identities[0] : null;
      };

      const recordConflict = async (
        local: ActionItemRow,
        remote: RemoteMeetingActionRecord,
        errorCode: string,
      ): Promise<void> => {
        const localPayloadJson = JSON.stringify(localActionConflictPayload(local));
        const remotePayloadJson = JSON.stringify({
          error_code: errorCode,
          current: remoteActionConflictPayload(remote, input.remoteMeetingId),
        });
        const existing = await database.getFirstAsync<{
          id: string;
          remote_revision: number | null;
        }>(
          `SELECT id, remote_revision FROM sync_conflicts
           WHERE scope_key = ? AND aggregate_type = 'action_item'
             AND aggregate_id = ? AND status = 'unresolved'
           ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
          input.scopeKey,
          remote.clientActionId,
        );
        if (existing) {
          if (existing.remote_revision === null || remote.revision >= existing.remote_revision) {
            await database.runAsync(
              `UPDATE sync_conflicts SET local_revision = ?, remote_revision = ?,
                 local_payload_json = ?, remote_payload_json = ?, created_at_ms = ?
               WHERE id = ? AND scope_key = ? AND status = 'unresolved'`,
              local.remote_revision,
              remote.revision,
              localPayloadJson,
              remotePayloadJson,
              input.pulledAtMs,
              existing.id,
              input.scopeKey,
            );
          }
        } else {
          const conflictId = [
            'action-pull',
            remote.clientActionId,
            remote.revision,
            remote.serverUpdatedAtMs,
          ].join(':');
          const created = await database.runAsync(
            `INSERT INTO sync_conflicts (
               id, scope_key, aggregate_type, aggregate_id,
               local_revision, remote_revision, local_payload_json,
               remote_payload_json, status, created_at_ms
             ) VALUES (?, ?, 'action_item', ?, ?, ?, ?, ?, 'unresolved', ?)`,
            conflictId,
            input.scopeKey,
            remote.clientActionId,
            local.remote_revision,
            remote.revision,
            localPayloadJson,
            remotePayloadJson,
            input.pulledAtMs,
          );
          if (created.changes !== 1) throw new Error('meeting action pull conflict was not recorded');
        }
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
             last_error_code = 'remote_pull_conflict', claim_token = NULL, updated_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = 'action_item'
             AND aggregate_id = ? AND status <> 'completed'`,
          input.pulledAtMs,
          input.scopeKey,
          remote.clientActionId,
        );
        conflicted += 1;
        didChange = true;
      };

      for (const remote of input.items) {
        const duplicateRemoteIdentity = await database.getFirstAsync<{ id: string }>(
          `SELECT action.id FROM action_items action
           INNER JOIN meeting_notes stored ON stored.id = action.meeting_id
           WHERE action.remote_id = ? AND action.id <> ? AND stored.scope_key = ?
           LIMIT 1`,
          remote.remoteId,
          remote.clientActionId,
          input.scopeKey,
        );
        if (duplicateRemoteIdentity) {
          throw new Error('remote meeting action identity is already attached');
        }
        const local = await database.getFirstAsync<ActionItemRow>(
          `SELECT action.*, segment.source_segment_id AS source_segment_source_id
           FROM action_items action
           LEFT JOIN transcript_segments segment ON segment.id = action.source_segment_id
           WHERE action.id = ?`,
          remote.clientActionId,
        );
        if (local && local.meeting_id !== input.meetingId) {
          throw new Error('remote meeting action belongs to another local meeting');
        }
        const sourceSegmentId = await mappedSegmentId(remote.sourceSegmentId);
        if (!local) {
          const created = await database.runAsync(
            `INSERT INTO action_items (
               id, meeting_id, remote_id, remote_revision,
               content, status, assignee_text, due_at_ms,
               reminder_at_ms, reminder_notification_id, followup_event_source_id,
               source_kind, source_marker_id, source_summary_version_id,
               source_segment_id, source_start_ms, generation_fingerprint,
               user_edited_at_ms, completed_at_ms, created_at_ms, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
            remote.clientActionId,
            input.meetingId,
            remote.remoteId,
            remote.revision,
            remote.content,
            remote.status,
            remote.assigneeText,
            remote.dueAtMs,
            remote.reminderAtMs,
            remote.followupEventSourceId,
            remote.sourceKind,
            remote.sourceSummaryVersionId,
            sourceSegmentId,
            remote.sourceStartMs,
            remote.generationFingerprint,
            remote.userEditedAtMs,
            remote.completedAtMs,
            remote.clientCreatedAtMs,
            remote.clientUpdatedAtMs,
          );
          if (created.changes !== 1) throw new Error('remote meeting action was not inserted');
          inserted += 1;
          didChange = true;
          contentChanged = true;
          latestClientUpdatedAtMs = Math.max(latestClientUpdatedAtMs, remote.clientUpdatedAtMs);
          continue;
        }

        if (local.remote_id !== null && local.remote_id !== remote.remoteId) {
          await recordConflict(local, remote, 'remote_identity_mismatch');
          continue;
        }
        if (local.remote_revision !== null && remote.revision < local.remote_revision) {
          ignoredStale += 1;
          continue;
        }
        if (!remoteActionIdentityMatches(local, remote)) {
          await recordConflict(local, remote, 'action_identity_mismatch');
          continue;
        }

        const outstanding = await database.getFirstAsync<{ found: number }>(
          `SELECT 1 AS found FROM sync_outbox
           WHERE scope_key = ? AND aggregate_type = 'action_item'
             AND aggregate_id = ? AND status <> 'completed' LIMIT 1`,
          input.scopeKey,
          remote.clientActionId,
        );
        const unresolved = await database.getFirstAsync<{ found: number }>(
          `SELECT 1 AS found FROM sync_conflicts
           WHERE scope_key = ? AND aggregate_type = 'action_item'
             AND aggregate_id = ? AND status = 'unresolved' LIMIT 1`,
          input.scopeKey,
          remote.clientActionId,
        );
        if (remoteActionFieldsMatch(local, remote)) {
          const attachedResult = await database.runAsync(
            `UPDATE action_items SET remote_id = ?, remote_revision = ?, source_segment_id = ?
             WHERE id = ? AND meeting_id = ?`,
            remote.remoteId,
            remote.revision,
            sourceSegmentId,
            remote.clientActionId,
            input.meetingId,
          );
          if (attachedResult.changes !== 1) throw new Error('meeting action attachment changed concurrently');
          const completedOutbox = await database.runAsync(
            `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
               last_error_code = 'satisfied_by_pull', request_payload_json = NULL,
               claim_token = NULL, updated_at_ms = ?
             WHERE scope_key = ? AND aggregate_type = 'action_item'
               AND aggregate_id = ? AND status <> 'completed'`,
            input.pulledAtMs,
            input.scopeKey,
            remote.clientActionId,
          );
          const resolvedConflicts = await database.runAsync(
            `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
             WHERE scope_key = ? AND aggregate_type = 'action_item'
               AND aggregate_id = ? AND status = 'unresolved'`,
            input.pulledAtMs,
            input.scopeKey,
            remote.clientActionId,
          );
          const attachmentChanged = local.remote_id !== remote.remoteId
            || local.remote_revision !== remote.revision
            || local.source_segment_id !== sourceSegmentId
            || completedOutbox.changes > 0
            || resolvedConflicts.changes > 0;
          if (attachmentChanged) {
            attached += 1;
            didChange = true;
          }
          continue;
        }

        const unacknowledgedLocalWrite = local.remote_revision === null
          && (local.user_edited_at_ms !== null || local.source_kind !== 'generated');
        if (outstanding || unresolved || unacknowledgedLocalWrite) {
          await recordConflict(local, remote, 'remote_pull_conflict');
          continue;
        }
        if (local.remote_revision !== null && remote.revision === local.remote_revision) {
          await recordConflict(local, remote, 'remote_payload_revision_mismatch');
          continue;
        }

        const applied = await database.runAsync(
          `UPDATE action_items SET
             remote_id = ?, remote_revision = ?, content = ?, status = ?,
             assignee_text = ?, due_at_ms = ?, reminder_at_ms = ?,
             reminder_notification_id = NULL, followup_event_source_id = ?,
             source_segment_id = ?, user_edited_at_ms = ?, completed_at_ms = ?,
             updated_at_ms = ?
           WHERE id = ? AND meeting_id = ?`,
          remote.remoteId,
          remote.revision,
          remote.content,
          remote.status,
          remote.assigneeText,
          remote.dueAtMs,
          remote.reminderAtMs,
          remote.followupEventSourceId,
          sourceSegmentId,
          remote.userEditedAtMs,
          remote.completedAtMs,
          remote.clientUpdatedAtMs,
          remote.clientActionId,
          input.meetingId,
        );
        if (applied.changes !== 1) throw new Error('remote meeting action changed concurrently');
        updated += 1;
        didChange = true;
        contentChanged = true;
        latestClientUpdatedAtMs = Math.max(latestClientUpdatedAtMs, remote.clientUpdatedAtMs);
      }

      if (state) {
        const advanced = await database.runAsync(
          `UPDATE meeting_action_pull_state SET cursor = ?, updated_at_ms = ?
           WHERE meeting_id = ? AND scope_key = ? AND remote_meeting_id = ? AND cursor IS ?`,
          input.nextCursor,
          input.pulledAtMs,
          input.meetingId,
          input.scopeKey,
          input.remoteMeetingId,
          input.expectedCursor,
        );
        if (advanced.changes !== 1) {
          throw new Error('meeting action pull cursor changed concurrently');
        }
      } else {
        const createdState = await database.runAsync(
          `INSERT INTO meeting_action_pull_state (
             meeting_id, scope_key, remote_meeting_id, cursor, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
          input.meetingId,
          input.scopeKey,
          input.remoteMeetingId,
          input.nextCursor,
          input.pulledAtMs,
        );
        if (createdState.changes !== 1) throw new Error('meeting action pull state was not created');
      }

      if (didChange) {
        if (contentChanged && latestClientUpdatedAtMs > meeting.updated_at_ms) {
          await database.runAsync(
            `UPDATE meeting_notes SET updated_at_ms = ?
             WHERE id = ? AND scope_key = ? AND updated_at_ms < ?`,
            latestClientUpdatedAtMs,
            input.meetingId,
            input.scopeKey,
            latestClientUpdatedAtMs,
          );
        }
        await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
      }
      return {
        applied: true,
        inserted,
        updated,
        attached,
        conflicted,
        ignoredStale,
        cursorAdvanced: input.nextCursor !== input.expectedCursor,
      };
    });
    if (
      result.applied
      && result.inserted + result.updated + result.attached + result.conflicted > 0
    ) this.notify([input.meetingId]);
    return result;
  }

  async resolveMeetingActionSyncConflict(
    input: ResolveMeetingActionSyncConflictInput,
  ): Promise<boolean> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest action cannot have a sync conflict');
    assertRecordId(input.conflictId, 'meeting action conflict ID');
    assertRecordId(input.meetingId, 'meeting ID');
    assertRecordId(input.actionId, 'meeting action ID');
    assertNonNegativeInteger(input.expectedUpdatedAtMs, 'meeting action conflict revision');
    assertOptionalNonNegativeInteger(input.remoteRevision, 'meeting action conflict remote revision');
    assertNonNegativeInteger(input.resolvedAtMs, 'meeting action conflict resolution time');
    if (input.remoteId !== null) assertRecordId(input.remoteId, 'meeting action remote ID');
    if (input.resolution === 'keep_local') {
      if (input.remoteId === null !== (input.remoteRevision === null)) {
        throw new Error('meeting action remote conflict identity is incomplete');
      }
      if (input.remoteFields !== null || input.nextOperation === null) {
        throw new Error('meeting action local resolution is invalid');
      }
      if (
        input.nextOperation.scopeKey !== input.scopeKey
        || input.nextOperation.aggregateType !== 'action_item'
        || input.nextOperation.aggregateId !== input.actionId
        || input.nextOperation.operationType !== 'action_item.upsert'
        || input.nextOperation.baseRevision !== input.remoteRevision
      ) throw new Error('meeting action local resolution operation is invalid');
    } else if (input.resolution === 'use_remote') {
      if (input.remoteId === null || input.remoteRevision === null || input.remoteFields === null) {
        throw new Error('meeting action remote resolution is incomplete');
      }
      if (input.nextOperation !== null) throw new Error('meeting action remote resolution cannot enqueue a write');
      actionStatus(input.remoteFields.status);
      if (
        !input.remoteFields.content.trim()
        || input.remoteFields.content.length > 20_000
        || input.remoteFields.content.includes('\u0000')
      ) throw new Error('meeting action remote content is invalid');
      assertNullableBoundedText(input.remoteFields.assigneeText, 500, 'meeting action remote assignee');
      assertOptionalNonNegativeInteger(input.remoteFields.dueAtMs, 'meeting action remote due time');
      assertOptionalNonNegativeInteger(input.remoteFields.reminderAtMs, 'meeting action remote reminder time');
      assertOptionalNonNegativeInteger(input.remoteFields.userEditedAtMs, 'meeting action remote edit time');
      assertOptionalNonNegativeInteger(input.remoteFields.completedAtMs, 'meeting action remote completion time');
      assertNonNegativeInteger(input.remoteFields.updatedAtMs, 'meeting action remote update time');
      if (input.remoteFields.followupEventSourceId !== null) {
        assertRecordId(input.remoteFields.followupEventSourceId, 'meeting action remote follow-up ID');
      }
      if (input.remoteFields.reminderNotificationId !== null) {
        throw new Error('meeting action remote resolution cannot retain a device notification');
      }
      if (input.remoteFields.reminderAtMs !== null && input.remoteFields.dueAtMs === null) {
        throw new Error('meeting action remote reminder requires a due time');
      }
      if (input.remoteFields.status === 'completed' && input.remoteFields.completedAtMs === null) {
        throw new Error('completed remote action requires a completion time');
      }
      if (input.remoteFields.status !== 'completed' && input.remoteFields.completedAtMs !== null) {
        throw new Error('open remote action cannot retain a completion time');
      }
    } else {
      throw new Error('meeting action conflict resolution is invalid');
    }

    const applied = await withMeetingDatabaseTransaction(async database => {
      const conflict = await database.getFirstAsync<MeetingActionSyncConflictRow>(
        `SELECT conflict.id, action.meeting_id, conflict.aggregate_id,
           conflict.local_revision, conflict.remote_revision,
           conflict.local_payload_json, conflict.remote_payload_json,
           conflict.created_at_ms
         FROM sync_conflicts conflict
         INNER JOIN action_items action ON action.id = conflict.aggregate_id
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE conflict.id = ? AND conflict.scope_key = ?
           AND conflict.aggregate_type = 'action_item'
           AND conflict.aggregate_id = ? AND conflict.status = 'unresolved'
           AND action.meeting_id = ? AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'`,
        input.conflictId,
        input.scopeKey,
        input.actionId,
        input.meetingId,
        input.scopeKey,
      );
      if (!conflict) return false;
      if (conflict.remote_revision !== null && conflict.remote_revision !== input.remoteRevision) {
        throw new Error('meeting action conflict remote revision changed');
      }
      const action = await database.getFirstAsync<ActionItemRow>(
        `SELECT action.* FROM action_items action
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE action.id = ? AND action.meeting_id = ? AND meeting.scope_key = ?`,
        input.actionId,
        input.meetingId,
        input.scopeKey,
      );
      if (!action || action.updated_at_ms !== input.expectedUpdatedAtMs) return false;

      await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = 'superseded_by_conflict_resolution',
           request_payload_json = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status <> 'completed'`,
        input.resolvedAtMs,
        input.scopeKey,
        input.actionId,
      );

      if (input.resolution === 'use_remote') {
        const fields = input.remoteFields!;
        const updated = await database.runAsync(
          `UPDATE action_items SET remote_id = ?, remote_revision = ?,
             content = ?, status = ?, assignee_text = ?, due_at_ms = ?,
             reminder_at_ms = ?, reminder_notification_id = NULL,
             followup_event_source_id = ?, user_edited_at_ms = ?,
             completed_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND meeting_id = ? AND updated_at_ms = ?`,
          input.remoteId,
          input.remoteRevision,
          fields.content,
          fields.status,
          fields.assigneeText,
          fields.dueAtMs,
          fields.reminderAtMs,
          fields.followupEventSourceId,
          fields.userEditedAtMs,
          fields.completedAtMs,
          fields.updatedAtMs,
          input.actionId,
          input.meetingId,
          input.expectedUpdatedAtMs,
        );
        if (updated.changes !== 1) return false;
      } else {
        const updated = await database.runAsync(
          `UPDATE action_items SET remote_id = ?, remote_revision = ?
           WHERE id = ? AND meeting_id = ? AND updated_at_ms = ?`,
          input.remoteId,
          input.remoteRevision,
          input.actionId,
          input.meetingId,
          input.expectedUpdatedAtMs,
        );
        if (updated.changes !== 1) return false;
      }

      const resolved = await database.runAsync(
        `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
         WHERE id = ? AND scope_key = ? AND aggregate_type = 'action_item'
           AND aggregate_id = ? AND status = 'unresolved'`,
        input.resolvedAtMs,
        input.conflictId,
        input.scopeKey,
        input.actionId,
      );
      if (resolved.changes !== 1) return false;

      const transaction = new SqliteMeetingTransaction(database);
      if (input.nextOperation !== null) {
        const inserted = await transaction.insertOutbox(input.nextOperation);
        if (!inserted) throw new Error('meeting action conflict operation already exists');
      }
      await transaction.updateMeeting(input.meetingId, input.scopeKey, {
        syncState: input.resolution === 'keep_local' ? 'pending' : 'synced',
        updatedAtMs: input.resolvedAtMs,
      });
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      await transaction.advanceCanonicalWrite(input.scopeKey, input.resolvedAtMs);
      return true;
    });
    if (applied) this.notify([input.meetingId]);
    return applied;
  }

  async getMeetingManualNoteSyncConflict(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingManualNoteSyncConflictRecord | null> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    if (scopeKey === 'guest') return null;
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<MeetingManualNoteSyncConflictRow>(
      `SELECT conflict.id, meeting.id AS meeting_id,
         conflict.local_revision, conflict.remote_revision,
         conflict.local_payload_json, conflict.remote_payload_json,
         conflict.created_at_ms
       FROM sync_conflicts conflict
       INNER JOIN meeting_notes meeting ON meeting.id = conflict.aggregate_id
       WHERE conflict.scope_key = ? AND conflict.aggregate_type = 'manual_note'
         AND conflict.aggregate_id = ? AND conflict.status = 'unresolved'
         AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
       ORDER BY conflict.created_at_ms DESC, conflict.id DESC
       LIMIT 1`,
      scopeKey,
      meetingId,
      scopeKey,
    );
    return row ? {
      id: row.id,
      meetingId: row.meeting_id,
      localRevision: row.local_revision,
      remoteRevision: row.remote_revision,
      localPayloadJson: row.local_payload_json,
      remotePayloadJson: row.remote_payload_json,
      createdAtMs: row.created_at_ms,
    } : null;
  }

  async mergeMeetingManualNoteRemote(
    input: MergeMeetingManualNoteRemoteInput,
  ): Promise<MergeMeetingManualNoteRemoteResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest meeting cannot pull a remote manual note');
    assertRecordId(input.meetingId, 'meeting ID');
    assertRecordId(input.remoteMeetingId, 'remote meeting ID');
    assertNonNegativeInteger(input.pulledAtMs, 'manual note pull time');
    assertRemoteManualNote(input.remote);
    const result = await withMeetingDatabaseTransaction(async database => {
      const meeting = await database.getFirstAsync<MeetingRow>(
        `SELECT * FROM meeting_notes
         WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
        input.meetingId,
        input.scopeKey,
      );
      if (!meeting) throw new Error('manual note pull meeting no longer exists');
      if (meeting.remote_id !== input.remoteMeetingId) {
        throw new Error('manual note pull meeting identity changed');
      }
      const note = await database.getFirstAsync<ManualNoteRow>(
        'SELECT * FROM manual_notes WHERE meeting_id = ?',
        input.meetingId,
      );
      if (!note) throw new Error('manual note pull target is missing');
      const previousLocalRevision = note.revision;
      const outstanding = await database.getFirstAsync<{ found: number }>(
        `SELECT 1 AS found FROM sync_outbox
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status <> 'completed' LIMIT 1`,
        input.scopeKey,
        input.meetingId,
      );
      const unresolved = await database.getFirstAsync<MeetingManualNoteSyncConflictRow>(
        `SELECT conflict.id, meeting.id AS meeting_id,
           conflict.local_revision, conflict.remote_revision,
           conflict.local_payload_json, conflict.remote_payload_json,
           conflict.created_at_ms
         FROM sync_conflicts conflict
         INNER JOIN meeting_notes meeting ON meeting.id = conflict.aggregate_id
         WHERE conflict.scope_key = ? AND conflict.aggregate_type = 'manual_note'
           AND conflict.aggregate_id = ? AND conflict.status = 'unresolved'
         ORDER BY conflict.created_at_ms DESC, conflict.id DESC LIMIT 1`,
        input.scopeKey,
        input.meetingId,
      );

      if (
        input.remote.exists
        && note.base_remote_revision !== null
        && input.remote.revision < note.base_remote_revision
      ) {
        return {
          outcome: 'ignored_stale' as const,
          previousLocalRevision,
          nextLocalRevision: note.revision,
        };
      }

      if (manualNoteFieldsMatchRemote(note, input.remote)) {
        const attachmentChanged = note.base_remote_revision !== input.remote.revision
          || note.dirty === 1
          || Boolean(outstanding)
          || Boolean(unresolved);
        await database.runAsync(
          `UPDATE manual_notes SET base_remote_revision = ?, dirty = 0
           WHERE meeting_id = ?`,
          input.remote.revision,
          input.meetingId,
        );
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
             last_error_code = 'satisfied_by_pull', request_payload_json = NULL,
             claim_token = NULL, updated_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = 'manual_note'
             AND aggregate_id = ? AND status <> 'completed'`,
          input.pulledAtMs,
          input.scopeKey,
          input.meetingId,
        );
        await database.runAsync(
          `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = 'manual_note'
             AND aggregate_id = ? AND status = 'unresolved'`,
          input.pulledAtMs,
          input.scopeKey,
          input.meetingId,
        );
        if (attachmentChanged) {
          await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
          const transaction = new SqliteMeetingTransaction(database);
          await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
        }
        return {
          outcome: attachmentChanged ? 'attached' as const : 'unchanged' as const,
          previousLocalRevision,
          nextLocalRevision: note.revision,
        };
      }

      if (
        !input.remote.exists
        && note.base_remote_revision === null
        && !unresolved
        && (note.dirty === 1 || Boolean(outstanding))
      ) {
        return {
          outcome: 'unchanged' as const,
          previousLocalRevision,
          nextLocalRevision: note.revision,
        };
      }
      if (
        !input.remote.exists
        && note.base_remote_revision === null
        && note.dirty === 0
        && !outstanding
        && !unresolved
        && note.revision === 0
        && note.content === ''
      ) {
        return {
          outcome: 'unchanged' as const,
          previousLocalRevision,
          nextLocalRevision: note.revision,
        };
      }

      const mustConflict = Boolean(unresolved)
        || note.dirty === 1
        || Boolean(outstanding)
        || !input.remote.exists
        || (note.base_remote_revision === null && (note.revision > 0 || note.content !== ''))
        || note.base_remote_revision === input.remote.revision;
      if (mustConflict) {
        const remoteRevision = input.remote.exists ? input.remote.revision : null;
        const remotePayloadJson = remoteManualNotePayloadJson(input.remoteMeetingId, input.remote);
        const localPayloadJson = localManualNotePayloadJson(input.remoteMeetingId, note);
        if (unresolved) {
          if (
            unresolved.remote_revision !== null
            && remoteRevision !== null
            && remoteRevision < unresolved.remote_revision
          ) {
            return {
              outcome: 'ignored_stale' as const,
              previousLocalRevision,
              nextLocalRevision: note.revision,
            };
          }
          await database.runAsync(
            `UPDATE sync_conflicts SET local_revision = ?, remote_revision = ?,
               local_payload_json = ?, remote_payload_json = ?, created_at_ms = ?
             WHERE id = ? AND scope_key = ? AND aggregate_type = 'manual_note'
               AND aggregate_id = ? AND status = 'unresolved'`,
            note.base_remote_revision,
            remoteRevision,
            localPayloadJson,
            remotePayloadJson,
            input.pulledAtMs,
            unresolved.id,
            input.scopeKey,
            input.meetingId,
          );
        } else {
          const created = await database.runAsync(
            `INSERT INTO sync_conflicts (
               id, scope_key, aggregate_type, aggregate_id,
               local_revision, remote_revision, local_payload_json,
               remote_payload_json, status, created_at_ms
             ) VALUES (?, ?, 'manual_note', ?, ?, ?, ?, ?, 'unresolved', ?)`,
            `manual-note-pull:${secureClientIdFactory.create()}`,
            input.scopeKey,
            input.meetingId,
            note.base_remote_revision,
            remoteRevision,
            localPayloadJson,
            remotePayloadJson,
            input.pulledAtMs,
          );
          if (created.changes !== 1) throw new Error('manual note pull conflict was not recorded');
        }
        await database.runAsync(
          `UPDATE sync_outbox SET status = 'blocked', next_attempt_at_ms = NULL,
             last_error_code = 'remote_pull_conflict', claim_token = NULL, updated_at_ms = ?
           WHERE scope_key = ? AND aggregate_type = 'manual_note'
             AND aggregate_id = ? AND status <> 'completed'`,
          input.pulledAtMs,
          input.scopeKey,
          input.meetingId,
        );
        await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
        const transaction = new SqliteMeetingTransaction(database);
        await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
        return {
          outcome: 'conflicted' as const,
          previousLocalRevision,
          nextLocalRevision: note.revision,
        };
      }

      if (!input.remote.exists) throw new Error('missing remote manual note escaped conflict handling');
      const contentChanged = note.content !== input.remote.content;
      const nextRevision = contentChanged
        ? Math.max(note.revision + 1, input.remote.clientNoteRevision)
        : note.revision;
      const updated = await database.runAsync(
        `UPDATE manual_notes SET content = ?, revision = ?, base_remote_revision = ?,
           dirty = 0, last_saved_at_ms = ?, user_edited_at_ms = ?
         WHERE meeting_id = ? AND revision = ?`,
        input.remote.content,
        nextRevision,
        input.remote.revision,
        input.remote.clientUpdatedAtMs,
        input.remote.userEditedAtMs,
        input.meetingId,
        note.revision,
      );
      if (updated.changes !== 1) throw new Error('manual note pull changed concurrently');
      if (contentChanged) {
        await database.runAsync(
          `UPDATE summary_versions SET status = 'stale'
           WHERE id = (SELECT current_summary_version_id FROM meeting_notes WHERE id = ?)
             AND meeting_id = ? AND status = 'ready'`,
          input.meetingId,
          input.meetingId,
        );
        await database.runAsync(
          `UPDATE meeting_notes SET updated_at_ms = MAX(updated_at_ms, ?)
           WHERE id = ? AND scope_key = ?`,
          input.remote.clientUpdatedAtMs,
          input.meetingId,
          input.scopeKey,
        );
      }
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(input.scopeKey, input.pulledAtMs);
      return {
        outcome: 'updated' as const,
        previousLocalRevision,
        nextLocalRevision: nextRevision,
      };
    });
    if (result.outcome === 'updated' || result.outcome === 'attached' || result.outcome === 'conflicted') {
      this.notify([input.meetingId]);
    }
    return result;
  }

  async resolveMeetingManualNoteSyncConflict(
    input: ResolveMeetingManualNoteSyncConflictInput,
  ): Promise<boolean> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest manual note cannot have a sync conflict');
    assertRecordId(input.conflictId, 'manual note conflict ID');
    assertRecordId(input.meetingId, 'meeting ID');
    assertNonNegativeInteger(input.expectedLocalRevision, 'manual note conflict revision');
    assertNonNegativeInteger(input.resolvedAtMs, 'manual note conflict resolution time');
    assertRemoteManualNote(input.remote);
    const remoteBaseRevision = input.remote.exists ? input.remote.revision : null;
    if (input.resolution === 'keep_local') {
      if (!input.nextOperation) throw new Error('manual note local resolution operation is missing');
      if (
        input.nextOperation.scopeKey !== input.scopeKey
        || input.nextOperation.aggregateType !== 'manual_note'
        || input.nextOperation.aggregateId !== input.meetingId
        || input.nextOperation.operationType !== 'manual_note.upsert'
        || input.nextOperation.baseRevision !== remoteBaseRevision
      ) throw new Error('manual note local resolution operation is invalid');
    } else if (input.resolution === 'use_remote') {
      if (input.nextOperation !== null) throw new Error('manual note remote resolution cannot enqueue a write');
    } else {
      throw new Error('manual note conflict resolution is invalid');
    }

    const applied = await withMeetingDatabaseTransaction(async database => {
      const conflict = await database.getFirstAsync<MeetingManualNoteSyncConflictRow>(
        `SELECT conflict.id, meeting.id AS meeting_id,
           conflict.local_revision, conflict.remote_revision,
           conflict.local_payload_json, conflict.remote_payload_json,
           conflict.created_at_ms
         FROM sync_conflicts conflict
         INNER JOIN meeting_notes meeting ON meeting.id = conflict.aggregate_id
         WHERE conflict.id = ? AND conflict.scope_key = ?
           AND conflict.aggregate_type = 'manual_note'
           AND conflict.aggregate_id = ? AND conflict.status = 'unresolved'
           AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
        input.conflictId,
        input.scopeKey,
        input.meetingId,
        input.scopeKey,
      );
      if (!conflict) return false;
      if (conflict.remote_revision !== remoteBaseRevision) {
        throw new Error('manual note conflict remote revision changed');
      }
      const note = await database.getFirstAsync<ManualNoteRow>(
        'SELECT * FROM manual_notes WHERE meeting_id = ?',
        input.meetingId,
      );
      if (!note || note.revision !== input.expectedLocalRevision) return false;

      await database.runAsync(
        `UPDATE sync_outbox SET status = 'completed', next_attempt_at_ms = NULL,
           last_error_code = 'superseded_by_conflict_resolution',
           request_payload_json = NULL, claim_token = NULL, updated_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status <> 'completed'`,
        input.resolvedAtMs,
        input.scopeKey,
        input.meetingId,
      );

      let nextMeetingUpdatedAtMs = input.resolvedAtMs;
      let contentChanged = false;
      if (input.resolution === 'keep_local') {
        let payload: Record<string, unknown>;
        try {
          const parsed = JSON.parse(input.nextOperation!.payloadJson) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          payload = parsed as Record<string, unknown>;
        } catch {
          throw new Error('manual note local resolution payload is invalid');
        }
        const nextRevision = payload.client_note_revision;
        const nextUpdatedAtMs = payload.client_updated_at_ms;
        const nextUserEditedAtMs = payload.user_edited_at_ms;
        if (
          payload.schema_version !== 2
          || payload.content !== note.content
          || payload.expected_remote_revision !== remoteBaseRevision
          || !Number.isSafeInteger(nextRevision)
          || Number(nextRevision) <= note.revision
          || !Number.isSafeInteger(nextUpdatedAtMs)
          || Number(nextUpdatedAtMs) <= note.last_saved_at_ms
          || (input.remote.exists && Number(nextUpdatedAtMs) <= input.remote.clientUpdatedAtMs)
          || !Number.isSafeInteger(nextUserEditedAtMs)
          || Number(nextUserEditedAtMs) > Number(nextUpdatedAtMs)
        ) throw new Error('manual note local resolution payload does not match current content');
        const updated = await database.runAsync(
          `UPDATE manual_notes SET revision = ?, base_remote_revision = ?, dirty = 1,
             last_saved_at_ms = ?, user_edited_at_ms = ?
           WHERE meeting_id = ? AND revision = ?`,
          Number(nextRevision),
          remoteBaseRevision,
          Number(nextUpdatedAtMs),
          Number(nextUserEditedAtMs),
          input.meetingId,
          note.revision,
        );
        if (updated.changes !== 1) return false;
        nextMeetingUpdatedAtMs = Math.max(nextMeetingUpdatedAtMs, Number(nextUpdatedAtMs));
      } else {
        contentChanged = note.content !== input.remote.content;
        // Accepting an absent cloud note restores the same pristine local state
        // used for a newly created meeting; otherwise every later GET would
        // manufacture the same conflict again.
        const nextRevision = input.remote.exists
          ? Math.max(note.revision + 1, input.remote.clientNoteRevision)
          : 0;
        const updated = await database.runAsync(
          `UPDATE manual_notes SET content = ?, revision = ?, base_remote_revision = ?,
             dirty = 0, last_saved_at_ms = ?, user_edited_at_ms = ?
           WHERE meeting_id = ? AND revision = ?`,
          input.remote.content,
          nextRevision,
          remoteBaseRevision,
          input.remote.clientUpdatedAtMs,
          input.remote.userEditedAtMs,
          input.meetingId,
          note.revision,
        );
        if (updated.changes !== 1) return false;
      }

      const resolved = await database.runAsync(
        `UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?
         WHERE scope_key = ? AND aggregate_type = 'manual_note'
           AND aggregate_id = ? AND status = 'unresolved'`,
        input.resolvedAtMs,
        input.scopeKey,
        input.meetingId,
      );
      if (resolved.changes < 1) return false;
      const transaction = new SqliteMeetingTransaction(database);
      if (input.nextOperation !== null) {
        const inserted = await transaction.insertOutbox(input.nextOperation);
        if (!inserted) throw new Error('manual note conflict operation already exists');
      }
      if (contentChanged) await transaction.markCurrentSummaryStale(input.meetingId, input.scopeKey);
      await transaction.updateMeeting(input.meetingId, input.scopeKey, {
        syncState: input.resolution === 'keep_local' ? 'pending' : 'synced',
        updatedAtMs: nextMeetingUpdatedAtMs,
      });
      await refreshMeetingSyncState(database, input.meetingId, input.scopeKey);
      await transaction.advanceCanonicalWrite(input.scopeKey, nextMeetingUpdatedAtMs);
      return true;
    });
    if (applied) this.notify([input.meetingId]);
    return applied;
  }

  async listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const requestedLimit = Math.trunc(query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, requestedLimit))
      : 50;
    const conditions = ['meeting.scope_key = ?'];
    const params: Array<string | number> = [scopeKey];
    if (!query.includeDeleted) conditions.push("meeting.lifecycle != 'deleted'");
    if (query.before) {
      conditions.push('(meeting.updated_at_ms < ? OR (meeting.updated_at_ms = ? AND meeting.id < ?))');
      params.push(query.before.updatedAtMs, query.before.updatedAtMs, query.before.id);
    }
    params.push(limit + 1);
    const rows = await database.getAllAsync<MeetingRow>(
      `SELECT meeting.*,
         (SELECT COUNT(*) FROM transcript_revisions revision
          INNER JOIN transcript_segments segment ON segment.revision_id = revision.id
          WHERE revision.meeting_id = meeting.id AND revision.is_active = 1
         ) AS active_transcript_segment_count,
         CASE WHEN EXISTS (
           SELECT 1 FROM summary_versions version
           WHERE version.id = meeting.current_summary_version_id
             AND version.meeting_id = meeting.id
             AND version.status IN ('ready', 'stale')
         ) THEN 1 ELSE 0 END AS current_summary_ready
       FROM meeting_notes meeting
       WHERE ${conditions.join(' AND ')}
       ORDER BY meeting.updated_at_ms DESC, meeting.id DESC
       LIMIT ?`,
      params,
    );
    const visibleRows = rows.slice(0, limit);
    const ids = visibleRows.map(row => row.id);
    const stagesByMeeting = new Map<string, ProcessingStage[]>();
    const primaryRecordingByMeeting = new Map<string, RecordingAssetRecord>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const [stageRows, recordingRows] = await Promise.all([
        database.getAllAsync<StageRow>(
          `SELECT stage.* FROM processing_stages stage
           INNER JOIN meeting_notes meeting ON meeting.id = stage.meeting_id
           WHERE meeting.scope_key = ? AND stage.meeting_id IN (${placeholders})
           ORDER BY stage.meeting_id, stage.stage`,
          [scopeKey, ...ids],
        ),
        database.getAllAsync<RecordingAssetRow>(
          `SELECT asset.* FROM recording_assets asset
           INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
           WHERE meeting.scope_key = ? AND asset.meeting_id IN (${placeholders})
             AND asset.role = 'primary'
           ORDER BY asset.meeting_id`,
          [scopeKey, ...ids],
        ),
      ]);
      stageRows.forEach(row => {
        const stages = stagesByMeeting.get(row.meeting_id) ?? [];
        stages.push(stageFromRow(row));
        stagesByMeeting.set(row.meeting_id, stages);
      });
      recordingRows.forEach(row => {
        primaryRecordingByMeeting.set(row.meeting_id, recordingAssetFromRow(row));
      });
    }
    const items: MeetingListProjectionItem[] = visibleRows.map(row => ({
      id: row.id,
      remoteId: row.remote_id,
      legacySourceId: row.legacy_source_id,
      origin: row.origin,
      entryPoint: row.entry_point,
      title: row.title,
      description: row.description,
      participants: participantsFromJson(row.participants_json),
      location: row.location,
      mode: row.mode,
      clientRequestId: row.client_request_id,
      recordedAtMs: row.recorded_at_ms,
      lifecycle: row.lifecycle,
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      syncState: row.sync_state,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      deletedAtMs: row.deleted_at_ms,
      currentSummaryVersionId: row.current_summary_version_id,
      activeTranscriptSegmentCount: Number(row.active_transcript_segment_count ?? 0),
      currentSummaryReady: row.current_summary_ready === 1,
      primaryRecording: primaryRecordingByMeeting.get(row.id) ?? null,
      stages: stagesByMeeting.get(row.id) ?? [],
    }));
    return { items, hasMore: rows.length > limit };
  }

  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe {
    assertScopeKey(scopeKey);
    let byId = this.meetingListeners.get(scopeKey);
    if (!byId) {
      byId = new Map();
      this.meetingListeners.set(scopeKey, byId);
    }
    let listeners = byId.get(id);
    if (!listeners) {
      listeners = new Set();
      byId.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) byId?.delete(id);
      if (byId?.size === 0) this.meetingListeners.delete(scopeKey);
    };
  }

  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe {
    assertScopeKey(scopeKey);
    let listeners = this.listListeners.get(scopeKey);
    if (!listeners) {
      listeners = new Set();
      this.listListeners.set(scopeKey, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listListeners.delete(scopeKey);
    };
  }

  private async transcriptProjectionFromRow(
    database: SQLiteDatabase,
    revision: TranscriptRevisionRow,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection> {
    const rows = await database.getAllAsync<TranscriptSegmentRow>(
      `SELECT segment.* FROM transcript_segments segment
       INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE segment.revision_id = ? AND revision.meeting_id = ? AND meeting.scope_key = ?
       ORDER BY segment.ordinal, segment.id`,
      revision.id,
      revision.meeting_id,
      scopeKey,
    );
    return {
      revision: transcriptRevisionFromRow(revision),
      segments: rows.map(transcriptSegmentFromRow),
    };
  }

  private async summaryProjectionFromRow(
    database: SQLiteDatabase,
    version: SummaryVersionRow,
    scopeKey: ScopeKey,
  ): Promise<SummaryVersionProjection> {
    const [sectionRows, citationRows, actionRows] = await Promise.all([
      database.getAllAsync<SummarySectionRow>(
        `SELECT section.* FROM summary_sections section
         INNER JOIN summary_versions version ON version.id = section.version_id
         INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
         WHERE section.version_id = ? AND version.meeting_id = ? AND meeting.scope_key = ?
         ORDER BY section.ordinal, section.id`,
        version.id,
        version.meeting_id,
        scopeKey,
      ),
      database.getAllAsync<SummaryCitationRow>(
        `SELECT citation.*, segment.source_segment_id AS source_segment_id
         FROM summary_citations citation
         INNER JOIN summary_sections section ON section.id = citation.section_id
         INNER JOIN transcript_segments segment ON segment.id = citation.segment_id
         INNER JOIN summary_versions version ON version.id = section.version_id
         INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
         WHERE section.version_id = ? AND version.meeting_id = ? AND meeting.scope_key = ?
         ORDER BY section.ordinal, citation.ordinal, citation.id`,
        version.id,
        version.meeting_id,
        scopeKey,
      ),
      database.getAllAsync<ActionItemRow>(
        `SELECT action.*, segment.source_segment_id AS source_segment_source_id
         FROM action_items action
         LEFT JOIN transcript_segments segment ON segment.id = action.source_segment_id
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE action.meeting_id = ? AND meeting.scope_key = ?
         ORDER BY CASE action.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
           CASE WHEN action.due_at_ms IS NULL THEN 1 ELSE 0 END,
           action.due_at_ms, action.created_at_ms, action.id`,
        version.meeting_id,
        scopeKey,
      ),
    ]);
    return {
      version: summaryVersionFromRow(version),
      sections: sectionRows.map(summarySectionFromRow),
      citations: citationRows.map(summaryCitationFromRow),
      meetingActions: actionRows.map(actionItemFromRow),
    };
  }

  private async aggregateFromRow(
    database: SQLiteDatabase,
    noteRow: MeetingRow,
    scopeKey: ScopeKey,
  ): Promise<MeetingNoteAggregate> {
    const [manualNoteRow, occurrenceRow, snapshotRow, stageRows, recordingRows] = await Promise.all([
      database.getFirstAsync<ManualNoteRow>(
        `SELECT note.* FROM manual_notes note
         INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
         WHERE note.meeting_id = ? AND meeting.scope_key = ?`,
        noteRow.id,
        scopeKey,
      ),
      database.getFirstAsync<OccurrenceRow>(
        `SELECT link.calendar_source_event_id, link.occurrence_date
         FROM meeting_occurrence_links link
         INNER JOIN meeting_notes meeting ON meeting.id = link.meeting_id
         WHERE link.meeting_id = ? AND meeting.scope_key = ?`,
        noteRow.id,
        scopeKey,
      ),
      database.getFirstAsync<ScheduleSnapshotRow>(
        `SELECT snapshot.* FROM meeting_schedule_snapshots snapshot
         INNER JOIN meeting_notes meeting ON meeting.id = snapshot.meeting_id
         WHERE snapshot.meeting_id = ? AND meeting.scope_key = ?`,
        noteRow.id,
        scopeKey,
      ),
      database.getAllAsync<StageRow>(
        `SELECT stage.* FROM processing_stages stage
         INNER JOIN meeting_notes meeting ON meeting.id = stage.meeting_id
         WHERE stage.meeting_id = ? AND meeting.scope_key = ?
         ORDER BY stage.stage`,
        noteRow.id,
        scopeKey,
      ),
      database.getAllAsync<RecordingAssetRow>(
        `SELECT asset.* FROM recording_assets asset
         INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
         WHERE asset.meeting_id = ? AND meeting.scope_key = ?
         ORDER BY CASE WHEN asset.role = 'primary' THEN 0 ELSE 1 END, asset.created_at_ms, asset.id`,
        noteRow.id,
        scopeKey,
      ),
    ]);
    if (!manualNoteRow) throw new Error('meeting manual note is missing');
    return {
      note: noteFromRow(noteRow),
      occurrence: occurrenceRow
        ? {
          sourceEventId: occurrenceRow.calendar_source_event_id,
          occurrenceDate: occurrenceRow.occurrence_date,
        }
        : null,
      scheduleSnapshot: snapshotRow ? snapshotFromRow(snapshotRow) : null,
      manualNote: manualNoteFromRow(manualNoteRow),
      processingStages: stageRows.map(stageFromRow),
      recordingAssets: recordingRows.map(recordingAssetFromRow),
    };
  }

  private notify(touchedMeetingIds: readonly string[]): void {
    const touched = new Set(touchedMeetingIds);
    if (touched.size === 0) return;
    const invoke = (listener: () => void) => {
      try {
        listener();
      } catch {
        // A presentation subscriber must never make a committed transaction appear to fail.
      }
    };
    this.meetingListeners.forEach(byId => {
      byId.forEach((listeners, id) => {
        if (!touched.has(id)) return;
        listeners.forEach(invoke);
      });
    });
    this.listListeners.forEach(listeners => listeners.forEach(invoke));
  }
}

export const sqliteMeetingNoteRepository = new SqliteMeetingNoteRepository();
