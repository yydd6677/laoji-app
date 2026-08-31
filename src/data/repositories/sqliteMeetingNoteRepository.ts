import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  MeetingNote,
  ProcessingStage,
  ScheduleSnapshot,
  ScopeKey,
  SpeakerStatus,
} from '../../domain/meeting';
import {
  assertProcessingStage,
  assertScopeKey,
  automaticMeetingTopicsFromSummaryText,
  calendarMeetingSeriesKey,
  meetingSummaryActivationFenceMatches,
  namedSpeakerIdentityLabel,
  transitionProcessingStage,
} from '../../domain/meeting';
import { withMeetingDatabaseTransaction, openMeetingDatabase } from '../db/openDatabase';
import { sha256Text } from './vnext/immutableSourceRepository';
import {
  parseMeetingSearchQuery,
  type MeetingSearchFilters,
} from '../../services/meetingSearchQuery';
import type {
  ActionItemRecord,
  ApplySpeakerCorrectionInput,
  ApplySpeakerCorrectionResult,
  CompleteMeetingRecordingMergeTaskInput,
  FailMeetingRecordingMergeTaskInput,
  ManualNoteRecord,
  MarkerRecord,
  MeetingActionMutableFields,
  MeetingActionFollowupLinkFields,
  MeetingActionReminderRecord,
  MeetingAttachmentRecord,
  MeetingOrganizationMeeting,
  MeetingOrganizationOptions,
  MeetingOrganizationProjection,
  MeetingPersonAggregate,
  MeetingRecordingMergeTaskRecord,
  MeetingListProjection,
  MeetingListProjectionItem,
  MeetingListOrderEntry,
  MeetingListQuery,
  MeetingNoteAggregate,
  MeetingNoteRepository,
  MeetingRootPatch,
  MeetingScopeRevisionState,
  MeetingSearchResult,
  MeetingSearchSourceKind,
  MeetingSeriesActionRecord,
  MeetingSeriesCarryImportRecord,
  MeetingTagAssignment,
  MeetingTagRecord,
  MeetingTopicAggregate,
  MeetingTransaction,
  NewMeetingNote,
  OccurrenceLinkRecord,
  RecordingAssetRecord,
  RenameMeetingTagResult,
  SaveSummaryVersionOptions,
  SetOccurrenceLinkStateInput,
  SaveTranscriptRevisionOptions,
  SummaryCitationRecord,
  SummarySectionRecord,
  SummaryVersionRecord,
  SummaryVersionProjection,
  TranscriptRevisionProjection,
  TranscriptRevisionRecord,
  TranscriptSegmentRecord,
  Unsubscribe,
} from './meetingNoteRepository';
import { SummaryV3ActivationFenceError } from './meetingNoteRepository';

type StoredMeetingSyncState = 'local' | 'pending' | 'synced' | 'conflicted' | 'deleted';

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
  sync_state: StoredMeetingSyncState;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  deleted_from_lifecycle: Exclude<MeetingNote['lifecycle'], 'deleted'> | null;
  active_transcript_segment_count?: number;
  current_summary_ready?: number;
  current_summary_preview?: string | null;
};

type RecordingAssetRow = {
  id: string;
  meeting_id: string;
  asset_generation: string;
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
  source_sha256: string | null;
  waveform_json: string | null;
  local_state: RecordingAssetRecord['localState'];
  upload_operation_id: string | null;
  remote_object_revision: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  last_verified_at_ms: number | null;
};


type MeetingRecordingMergeTaskRow = {
  id: string;
  scope_key: string;
  detached_history_id: string;
  source_meeting_id: string;
  source_recording_asset_id: string;
  target_meeting_id: string;
  target_recording_asset_id: string;
  target_asset_generation: string;
  source_asset_snapshot_json: string;
  status: MeetingRecordingMergeTaskRecord['status'];
  attempt_count: number;
  last_error_code: string | null;
  retryable: number;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
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

type MeetingScopeRevisionRow = {
  scope_key: string;
  canonical_revision: number;
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
  source_manifest_sha256: string | null;
  is_active: number;
  created_at_ms: number;
  finalized_at_ms: number | null;
  text_final_at_ms: number | null;
};

type TranscriptSegmentRow = {
  id: string;
  revision_id: string;
  meeting_id: string;
  source_segment_id: string | null;
  source_recording_asset_id: string | null;
  source_recording_asset_remote_id: string | null;
  source_transcription_job_id: string | null;
  stable_segment_key: string;
  segment_revision: number;
  text_state: TranscriptSegmentRecord['textState'];
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


type MeetingAttachmentRow = {
  id: string;
  meeting_id: string;
  marker_id: string | null;
  position_ms: number;
  kind: string;
  text_content: string | null;
  local_uri: string | null;
  mime_type: string | null;
  file_name: string | null;
  byte_size: number | null;
  checksum_sha256: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};


type MeetingTagRow = {
  id: string;
  scope_key: string;
  name: string;
  normalized_name: string;
  meeting_count: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type MeetingTagAssignmentRow = {
  meeting_id: string;
  legacy_source_id: string | null;
  tag_id: string;
  tag_name: string;
};

type MeetingOrganizationBaseRow = {
  meeting_id: string;
  legacy_source_id: string | null;
  meeting_title: string;
  recorded_at_ms: number;
};

type MeetingPersonAggregationRow = MeetingOrganizationBaseRow & {
  speaker_profile_id: string | null;
  speaker_label_override: string | null;
  speaker_label: string | null;
  occurrence_count: number;
};

type MeetingTopicAggregationRow = MeetingOrganizationBaseRow & {
  tag_id: string;
  tag_name: string;
};

type MeetingSummaryTopicAggregationRow = MeetingOrganizationBaseRow & {
  content: string;
};

type MeetingSearchRow = {
  meeting_id: string;
  legacy_source_id: string | null;
  source_kind: string;
  source_id: string;
  start_ms: string | number;
  meeting_title: string;
  recorded_at_ms: number;
  snippet: string;
  rank: number;
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
  user_removed_at_ms: number | null;
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
  'realtime', 'offline',
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
    SELECT 1 FROM summary_citations ownership_citation
    INNER JOIN summary_sections ownership_citation_section
      ON ownership_citation_section.id = ownership_citation.section_id
    WHERE ownership_citation_section.version_id = version.id
      AND ownership_citation.user_removed_at_ms IS NOT NULL
  )
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
const CURRENT_MEETING_ACTION_VISIBILITY_SQL = `(
  action.source_kind <> 'generated'
  OR action.user_edited_at_ms IS NOT NULL
  OR action.status <> 'pending'
  OR action.source_summary_version_id = meeting.current_summary_version_id
)`;
const SUMMARY_VERSION_ACTION_VISIBILITY_SQL = `(
  action.source_kind <> 'generated'
  OR action.user_edited_at_ms IS NOT NULL
  OR action.status <> 'pending'
  OR action.source_summary_version_id = ?
)`;

function noteFromRow(row: MeetingRow): MeetingNote {
  assertScopeKey(row.scope_key);
  if (row.mode !== null && !MEETING_CAPTURE_MODES.has(row.mode)) {
    throw new Error('stored meeting mode is invalid');
  }
  return {
    id: row.id,
    scopeKey: row.scope_key,
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
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    deletedAtMs: row.deleted_at_ms,
    deletedFromLifecycle: row.deleted_from_lifecycle,
  };
}

function scopeRevisionStateFromRow(row: MeetingScopeRevisionRow): MeetingScopeRevisionState {
  assertScopeKey(row.scope_key);
  if (
    !Number.isSafeInteger(row.canonical_revision)
    || row.canonical_revision < 0
    || !Number.isSafeInteger(row.updated_at_ms)
    || row.updated_at_ms < 0
  ) throw new Error('stored meeting scope write state is invalid');
  return {
    scopeKey: row.scope_key,
    canonicalRevision: row.canonical_revision,
    updatedAtMs: row.updated_at_ms,
  };
}

function manualNoteFromRow(row: ManualNoteRow): ManualNoteRecord {
  return {
    meetingId: row.meeting_id,
    content: row.content,
    revision: row.revision,
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

async function reconcileSpeakerProcessingStageInDatabase(
  database: SQLiteDatabase,
  meetingId: string,
  scopeKey: ScopeKey,
  updatedAtMs: number,
  options: {
    attemptStarted?: boolean;
  } = {},
): Promise<boolean> {
  assertScopeKey(scopeKey);
  assertRecordId(meetingId, 'speaker processing meeting ID');
  assertNonNegativeInteger(updatedAtMs, 'speaker processing update time');
  const stageRow = await database.getFirstAsync<StageRow>(
    `SELECT stage.* FROM processing_stages stage
     INNER JOIN meeting_notes meeting ON meeting.id = stage.meeting_id
     WHERE stage.meeting_id = ? AND meeting.scope_key = ? AND stage.stage = 'speaker'`,
    meetingId,
    scopeKey,
  );
  if (!stageRow) throw new Error('speaker processing stage is missing');

  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM speaker_corrections
     WHERE meeting_id = ? AND scope_key = ?`,
    meetingId,
    scopeKey,
  );
  const status: SpeakerStatus = Number(row?.count ?? 0) > 0 ? 'ready' : 'none';
  const current = stageFromRow(stageRow);
  const next = transitionProcessingStage(current, {
    stage: 'speaker',
    status,
    attemptStarted: options.attemptStarted === true,
    errorCode: null,
    userMessageKey: null,
    retryable: false,
    nextRetryAtMs: null,
  }, Math.max(updatedAtMs, current.updatedAtMs));
  const changed = next.status !== current.status
    || next.attemptCount !== current.attemptCount
    || next.errorCode !== current.errorCode
    || next.userMessageKey !== current.userMessageKey
    || next.retryable !== current.retryable
    || next.nextRetryAtMs !== current.nextRetryAtMs;
  if (!changed) return false;
  const result = await database.runAsync(
    `UPDATE processing_stages SET
       status = ?, attempt_count = ?, progress = ?, job_id = ?,
       input_fingerprint = ?, error_code = ?, user_message_key = ?,
       retryable = ?, next_retry_at_ms = ?, updated_at_ms = ?
     WHERE meeting_id = ? AND stage = 'speaker'`,
    next.status,
    next.attemptCount,
    next.progress,
    next.jobId,
    next.inputFingerprint,
    next.errorCode,
    next.userMessageKey,
    next.retryable ? 1 : 0,
    next.nextRetryAtMs,
    next.updatedAtMs,
    meetingId,
  );
  if (result.changes !== 1) throw new Error('speaker processing stage changed concurrently');
  return true;
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
    assetGeneration: row.asset_generation,
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
    sourceSha256: row.source_sha256,
    waveformJson: row.waveform_json,
    localState: row.local_state,
    uploadOperationId: row.upload_operation_id,
    remoteObjectRevision: row.remote_object_revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    lastVerifiedAtMs: row.last_verified_at_ms,
  };
}


function recordingMergeTaskFromRow(row: MeetingRecordingMergeTaskRow): MeetingRecordingMergeTaskRecord {
  if (
    (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'completed')
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 0
    || (row.retryable !== 0 && row.retryable !== 1)
  ) throw new Error('recording merge task is invalid');
  return {
    id: row.id,
    scopeKey: row.scope_key as ScopeKey,
    detachedHistoryId: row.detached_history_id,
    sourceMeetingId: row.source_meeting_id,
    sourceRecordingAssetId: row.source_recording_asset_id,
    targetMeetingId: row.target_meeting_id,
    targetRecordingAssetId: row.target_recording_asset_id,
    targetAssetGeneration: row.target_asset_generation,
    sourceAssetSnapshotJson: row.source_asset_snapshot_json,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    retryable: row.retryable === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
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
    sourceManifestSha256: row.source_manifest_sha256,
    isActive: row.is_active === 1,
    createdAtMs: row.created_at_ms,
    finalizedAtMs: row.finalized_at_ms,
    textFinalAtMs: row.text_final_at_ms,
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
    sourceRecordingAssetId: row.source_recording_asset_id,
    sourceRecordingAssetRemoteId: row.source_recording_asset_remote_id,
    sourceTranscriptionJobId: row.source_transcription_job_id,
    stableSegmentKey: row.stable_segment_key,
    segmentRevision: row.segment_revision,
    textState: row.text_state,
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


function meetingAttachmentFromRow(row: MeetingAttachmentRow): MeetingAttachmentRecord {
  if (row.kind !== 'text' && row.kind !== 'image') {
    throw new Error('stored meeting attachment kind is invalid');
  }
  const textShape = row.kind === 'text'
    && Boolean(row.text_content?.trim())
    && row.local_uri === null
    && row.mime_type === null
    && row.file_name === null
    && row.byte_size === null;
  const imageShape = row.kind === 'image'
    && row.text_content === null
    && Boolean(row.local_uri?.trim())
    && Boolean(row.mime_type?.trim())
    && Boolean(row.file_name?.trim())
    && Number.isSafeInteger(row.byte_size)
    && (row.byte_size ?? 0) > 0;
  const checksumValid = row.checksum_sha256 === null
    || (row.kind === 'image' && /^sha256:[0-9a-f]{64}$/.test(row.checksum_sha256));
  if (
    (!textShape && !imageShape)
    || !Number.isSafeInteger(row.position_ms)
    || row.position_ms < 0
    || !checksumValid
  ) {
    throw new Error('stored meeting attachment is invalid');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    markerId: row.marker_id,
    positionMs: row.position_ms,
    kind: row.kind,
    textContent: row.text_content,
    localUri: row.local_uri,
    mimeType: row.mime_type,
    fileName: row.file_name,
    byteSize: row.byte_size,
    checksumSha256: row.checksum_sha256,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function meetingTagFromRow(row: MeetingTagRow): MeetingTagRecord {
  const scopeKey = row.scope_key as ScopeKey;
  assertScopeKey(scopeKey);
  if (!Number.isSafeInteger(row.meeting_count) || row.meeting_count < 0) {
    throw new Error('stored meeting tag count is invalid');
  }
  return {
    id: row.id,
    scopeKey,
    name: row.name,
    normalizedName: row.normalized_name,
    meetingCount: row.meeting_count,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

const MEETING_SEARCH_SOURCE_KINDS = new Set<MeetingSearchSourceKind>([
  'title',
  'tag',
  'manual_note',
  'transcript',
  'summary',
  'action',
]);

function meetingSearchSourceKind(value: string): MeetingSearchSourceKind {
  if (!MEETING_SEARCH_SOURCE_KINDS.has(value as MeetingSearchSourceKind)) {
    throw new Error('stored meeting search source is invalid');
  }
  return value as MeetingSearchSourceKind;
}

function meetingNavigationIdentity(
  row: Pick<MeetingSearchRow, 'meeting_id' | 'legacy_source_id'>,
  scopeKey: ScopeKey,
): string {
  const legacySourceId = row.legacy_source_id?.trim();
  if (legacySourceId) return legacySourceId;
  const prefix = `legacy:${encodeURIComponent(scopeKey)}:`;
  if (!row.meeting_id.startsWith(prefix)) return row.meeting_id;
  try {
    return decodeURIComponent(row.meeting_id.slice(prefix.length));
  } catch {
    return row.meeting_id;
  }
}

type MeetingSearchPredicate =
  | { kind: 'match'; query: string; terms: readonly string[]; filters: MeetingSearchFilters }
  | { kind: 'like'; patterns: readonly string[]; terms: readonly string[]; filters: MeetingSearchFilters }
  | { kind: 'all'; terms: readonly string[]; filters: MeetingSearchFilters };

function escapeMeetingSearchLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function meetingSearchPredicate(value: string): MeetingSearchPredicate | null {
  const parsed = parseMeetingSearchQuery(value);
  if (!parsed) return null;
  const terms = parsed.contentTokens
    .join(' ')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) return { kind: 'all', terms, filters: parsed.filters };
  if (terms.every(term => [...term].length >= 3)) {
    const expression = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ');
    // Every FTS row carries the meeting title for display, but only the row's
    // own content determines its source label. Without the column filter, a
    // title match incorrectly returns one result for every tag/note/section
    // in the same meeting.
    return { kind: 'match', query: `content : (${expression})`, terms, filters: parsed.filters };
  }
  // Every FTS row carries the meeting title for display, but only the row's
  // own content is searched. FTS5 trigram cannot match a one- or two-codepoint
  // Chinese term, so short queries use an escaped, bounded full-table LIKE
  // path instead of silently returning no result.
  return {
    kind: 'like',
    patterns: terms.map(term => `%${escapeMeetingSearchLike(term)}%`),
    terms,
    filters: parsed.filters,
  };
}

function meetingSearchFilterSql(filters: MeetingSearchFilters): {
  sql: string;
  arguments: readonly (string | number)[];
} {
  const clauses: string[] = [];
  const argumentsList: (string | number)[] = [];
  for (const tag of filters.tags) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM meeting_tag_links filter_link
      INNER JOIN meeting_tags filter_tag
        ON filter_tag.id = filter_link.tag_id AND filter_tag.scope_key = filter_link.scope_key
      WHERE filter_link.meeting_id = meeting.id
        AND filter_link.scope_key = meeting.scope_key
        AND lower(filter_tag.normalized_name) LIKE ? ESCAPE '\\'
    )`);
    argumentsList.push(`%${escapeMeetingSearchLike(tag)}%`);
  }
  for (const person of filters.people) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(
        CASE
          WHEN json_valid(COALESCE(meeting.participants_json, '[]'))
            THEN COALESCE(meeting.participants_json, '[]')
          ELSE '[]'
        END
      ) AS filter_person
      WHERE lower(CAST(filter_person.value AS TEXT)) LIKE ? ESCAPE '\\'
    )`);
    argumentsList.push(`%${escapeMeetingSearchLike(person)}%`);
  }
  if (filters.sourceKinds.length > 0) {
    clauses.push(`search.source_kind IN (${filters.sourceKinds.map(() => '?').join(', ')})`);
    argumentsList.push(...filters.sourceKinds);
  }
  const recordedAt = 'COALESCE(meeting.recorded_at_ms, meeting.started_at_ms, meeting.created_at_ms)';
  if (filters.fromDate) {
    // Meeting dates are user-facing local calendar days. SQLite's plain
    // unixepoch conversion is UTC and can move a late-night local meeting to
    // the adjacent day; localtime keeps the query aligned with the device UI.
    clauses.push(`date(${recordedAt} / 1000, 'unixepoch', 'localtime') >= date(?)`);
    argumentsList.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push(`date(${recordedAt} / 1000, 'unixepoch', 'localtime') < date(?, '+1 day')`);
    argumentsList.push(filters.toDate);
  }
  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
    arguments: argumentsList,
  };
}

function meetingSearchResultFromRow(row: MeetingSearchRow, scopeKey: ScopeKey): MeetingSearchResult {
  const startMs = Number(row.start_ms);
  const rank = Number(row.rank);
  return {
    resultId: `${row.meeting_id}:${row.source_kind}:${row.source_id}`,
    meetingId: row.meeting_id,
    navigationMeetingId: meetingNavigationIdentity(row, scopeKey),
    sourceKind: meetingSearchSourceKind(row.source_kind),
    sourceId: row.source_id,
    startMs: Number.isSafeInteger(startMs) && startMs >= 0 ? startMs : null,
    meetingTitle: row.meeting_title,
    recordedAtMs: row.recorded_at_ms,
    snippet: row.snippet.replace(/\s+/g, ' ').trim().slice(0, 240),
    rank: Number.isFinite(rank) ? rank : 0,
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
    userRemovedAtMs: row.user_removed_at_ms,
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

function assertRecordId(value: string, field: string): void {
  if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
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

function assertMeetingTagValue(name: string, normalizedName: string): void {
  if (
    !name.trim()
    || !normalizedName.trim()
    || [...name].length > 30
    || [...normalizedName].length > 30
    || /[\u0000-\u001f\u007f]/.test(name)
    || /[\u0000-\u001f\u007f]/.test(normalizedName)
  ) throw new Error('meeting tag name is invalid');
}

function assertMeetingAttachmentValue(attachment: MeetingAttachmentRecord): void {
  assertRecordId(attachment.id, 'meeting attachment ID');
  assertRecordId(attachment.meetingId, 'meeting attachment meeting ID');
  if (attachment.markerId !== null) assertRecordId(attachment.markerId, 'meeting attachment marker ID');
  assertNonNegativeInteger(attachment.positionMs, 'meeting attachment position');
  assertNonNegativeInteger(attachment.createdAtMs, 'meeting attachment creation time');
  assertNonNegativeInteger(attachment.updatedAtMs, 'meeting attachment update time');
  if (attachment.updatedAtMs < attachment.createdAtMs) {
    throw new Error('meeting attachment update time is invalid');
  }
  if (
    attachment.checksumSha256 !== null
    && (attachment.kind !== 'image' || !/^sha256:[0-9a-f]{64}$/.test(attachment.checksumSha256))
  ) throw new Error('meeting attachment checksum is invalid');
  if (attachment.kind === 'text') {
    const content = attachment.textContent?.trim() ?? '';
    if (
      !content
      || [...content].length > 500
      || /[\u0000]/.test(content)
      || attachment.localUri !== null
      || attachment.mimeType !== null
      || attachment.fileName !== null
      || attachment.byteSize !== null
    ) throw new Error('meeting text attachment is invalid');
    return;
  }
  if (attachment.kind === 'image') {
    if (
      attachment.textContent !== null
      || !attachment.localUri?.startsWith('file://')
      || !attachment.mimeType?.toLocaleLowerCase().startsWith('image/')
      || !attachment.fileName?.trim()
      || attachment.fileName.length > 240
      || !Number.isSafeInteger(attachment.byteSize)
      || (attachment.byteSize ?? 0) < 1
      || (attachment.byteSize ?? 0) > 25 * 1024 * 1024
      || /[\u0000-\u001f\u007f]/.test(attachment.fileName)
    ) throw new Error('meeting image attachment is invalid');
    return;
  }
  throw new Error('meeting attachment kind is invalid');
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
         asset.native_session_id = ? OR meeting.id = ? OR meeting.legacy_source_id = ?
       )
       ORDER BY CASE WHEN asset.native_session_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      scopeKey,
      normalized,
      normalized,
      normalized,
      normalized,
    );
    return row ? noteFromRow(row) : null;
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

  async getRecordingAsset(
    meetingId: string,
    recordingAssetId: string,
    scopeKey: ScopeKey,
  ): Promise<RecordingAssetRecord | null> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    assertRecordId(recordingAssetId, 'recording asset ID');
    const row = await this.database.getFirstAsync<RecordingAssetRow>(
      `SELECT asset.* FROM recording_assets asset
       INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
       WHERE asset.meeting_id = ? AND asset.id = ? AND meeting.scope_key = ?
       LIMIT 1`,
      meetingId,
      recordingAssetId,
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

  async getTranscriptRevisionContent(
    id: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null> {
    assertScopeKey(scopeKey);
    const revision = await this.database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.id = ? AND meeting.scope_key = ?`,
      id,
      scopeKey,
    );
    if (!revision) return null;
    const segments = await this.database.getAllAsync<TranscriptSegmentRow>(
      `SELECT segment.* FROM transcript_segments segment
       WHERE segment.revision_id = ? AND segment.meeting_id = ?
       ORDER BY segment.ordinal, segment.id`,
      revision.id,
      revision.meeting_id,
    );
    return {
      revision: transcriptRevisionFromRow(revision),
      segments: segments.map(transcriptSegmentFromRow),
    };
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

  async getSummarySection(
    sectionId: string,
    versionId: string,
    scopeKey: ScopeKey,
  ): Promise<SummarySectionRecord | null> {
    assertScopeKey(scopeKey);
    assertRecordId(sectionId, 'summary section ID');
    assertRecordId(versionId, 'summary version ID');
    const row = await this.database.getFirstAsync<SummarySectionRow>(
      `SELECT section.* FROM summary_sections section
       INNER JOIN summary_versions version ON version.id = section.version_id
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE section.id = ? AND section.version_id = ? AND meeting.scope_key = ?`,
      sectionId,
      versionId,
      scopeKey,
    );
    return row ? summarySectionFromRow(row) : null;
  }

  async getSummarySectionCitations(
    sectionId: string,
    versionId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly SummaryCitationRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(sectionId, 'summary section ID');
    assertRecordId(versionId, 'summary version ID');
    const rows = await this.database.getAllAsync<SummaryCitationRow>(
      `SELECT citation.*, segment.source_segment_id AS source_segment_id
       FROM summary_citations citation
       INNER JOIN summary_sections section ON section.id = citation.section_id
       INNER JOIN summary_versions version ON version.id = section.version_id
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       INNER JOIN transcript_segments segment ON segment.id = citation.segment_id
       WHERE citation.section_id = ? AND section.version_id = ? AND meeting.scope_key = ?
       ORDER BY citation.ordinal, citation.id`,
      sectionId,
      versionId,
      scopeKey,
    );
    return rows.map(summaryCitationFromRow);
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
           SELECT 1 FROM summary_citations citation
           INNER JOIN summary_sections section ON section.id = citation.section_id
           WHERE section.version_id = version.id
             AND citation.user_removed_at_ms IS NOT NULL
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
    if (result.changes > 0) {
      this.touchedMeetingIds.add(marker.meetingId);
    }
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
    const marker = await this.database.getFirstAsync<MarkerRow>(
      `SELECT marker.* FROM markers marker
       INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
       WHERE marker.id = ? AND marker.meeting_id = ?
         AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
      markerId,
      meetingId,
      scopeKey,
    );
    if (!marker) return false;
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
    if (result.changes > 0) {
      await this.database.runAsync(
        'DELETE FROM meeting_marker_sync_state WHERE scope_key = ? AND marker_id = ?',
        scopeKey,
        markerId,
      );
      this.touchedMeetingIds.add(meetingId);
    }
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
      null,
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
    const deletedAtMs = note.deletedAtMs ?? null;
    const deletedFromLifecycle = note.deletedFromLifecycle ?? null;
    assertNullableBoundedText(description, 100_000, 'meeting description');
    assertMeetingParticipants(participants);
    assertNullableBoundedText(location, 2_000, 'meeting location');
    assertMeetingMode(mode);
    if (clientRequestId) assertRecordId(clientRequestId, 'meeting client request ID');
    assertOptionalNonNegativeInteger(recordedAtMs, 'meeting recorded time');
    assertOptionalNonNegativeInteger(deletedAtMs, 'meeting deletion time');
    if (
      deletedFromLifecycle !== null
      && !['draft', 'active', 'ended'].includes(deletedFromLifecycle)
    ) throw new Error('meeting deletion source lifecycle is invalid');
    await this.database.runAsync(
      `INSERT INTO meeting_notes (
         id, scope_key, remote_id, legacy_source_id, origin, entry_point, title,
         description, participants_json, location, mode, client_request_id, recorded_at_ms, lifecycle,
         started_at_ms, ended_at_ms, current_summary_version_id, remote_revision,
         sync_state, created_at_ms, updated_at_ms, deleted_at_ms, deleted_from_lifecycle
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      note.id,
      note.scopeKey,
      null,
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
      null,
      note.lifecycle === 'deleted' ? 'deleted' : 'local',
      note.createdAtMs,
      note.createdAtMs,
      deletedAtMs,
      deletedFromLifecycle,
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
    if (Object.prototype.hasOwnProperty.call(patch, 'lifecycle')) {
      add('lifecycle', patch.lifecycle!);
      add('sync_state', patch.lifecycle === 'deleted' ? 'deleted' : 'local');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'startedAtMs')) add('started_at_ms', patch.startedAtMs ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'endedAtMs')) add('ended_at_ms', patch.endedAtMs ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'currentSummaryVersionId')) {
      add('current_summary_version_id', patch.currentSummaryVersionId ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'deletedAtMs')) add('deleted_at_ms', patch.deletedAtMs ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'deletedFromLifecycle')) {
      const value = patch.deletedFromLifecycle ?? null;
      if (value !== null && !['draft', 'active', 'ended'].includes(value)) {
        throw new Error('meeting deletion source lifecycle is invalid');
      }
      add('deleted_from_lifecycle', value);
    }
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
    assertScheduleSnapshot(snapshot, 'meeting schedule snapshot');
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
        'local_only',
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
        'local_only',
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

  async reconcileSpeakerProcessingStage(
    meetingId: string,
    scopeKey: ScopeKey,
    updatedAtMs: number,
  ): Promise<void> {
    await this.assertMeetingInScope(meetingId, scopeKey);
    await reconcileSpeakerProcessingStageInDatabase(
      this.database,
      meetingId,
      scopeKey,
      updatedAtMs,
    );
    this.touchedMeetingIds.add(meetingId);
  }

  async saveManualNote(note: ManualNoteRecord, scopeKey: ScopeKey): Promise<void> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(note.meetingId, scopeKey);
    const contentSha256 = await sha256Text(note.content);
    const current = await this.database.getFirstAsync<{
      revision_id: string;
      revision: number;
      content_sha256: string;
      format: string;
    }>(
      `SELECT revision_id, revision, content_sha256, format
         FROM manual_note_revisions
        WHERE meeting_id = ? ORDER BY revision DESC LIMIT 1`,
      note.meetingId,
    );
    const revision = current?.content_sha256 === contentSha256 && current.format === 'plain'
      ? current.revision
      : Math.max(1, current ? current.revision + 1 : note.revision);
    const revisionId = current?.content_sha256 === contentSha256 && current.format === 'plain'
      ? current.revision_id
      : `manual_note:${note.meetingId}:${revision}`;
    if (!current || current.revision_id !== revisionId) {
      await this.database.runAsync(
        `INSERT INTO manual_note_revisions (
           revision_id, meeting_id, revision, content, format, content_sha256,
           migrated_current, created_at_ms
         ) VALUES (?, ?, ?, ?, 'plain', ?, 0, ?)`,
        revisionId,
        note.meetingId,
        revision,
        note.content,
        contentSha256,
        note.lastSavedAtMs,
      );
    }
    await this.database.runAsync(
      `INSERT INTO manual_notes (
         meeting_id, content, format, revision, base_remote_revision,
         dirty, last_saved_at_ms, user_edited_at_ms, active_revision_id
       ) VALUES (?, ?, 'plain', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET
         content = excluded.content,
         format = excluded.format,
         revision = excluded.revision,
         base_remote_revision = excluded.base_remote_revision,
         dirty = excluded.dirty,
         last_saved_at_ms = excluded.last_saved_at_ms,
         user_edited_at_ms = excluded.user_edited_at_ms,
         active_revision_id = excluded.active_revision_id`,
      note.meetingId,
      note.content,
      revision,
      null,
      0,
      note.lastSavedAtMs,
      note.userEditedAtMs,
      revisionId,
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

  async restoreCurrentSummaryReady(
    meetingId: string,
    scopeKey: ScopeKey,
    expectedVersionId: string,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(meetingId, scopeKey);
    assertRecordId(expectedVersionId, 'summary version ID');
    const result = await this.database.runAsync(
      `UPDATE summary_versions
       SET status = 'ready'
       WHERE id = ? AND meeting_id = ? AND status = 'stale'
         AND id = (
           SELECT current_summary_version_id FROM meeting_notes
           WHERE id = ? AND scope_key = ?
         )`,
      expectedVersionId,
      meetingId,
      meetingId,
      scopeKey,
    );
    if (result.changes > 0) this.touchedMeetingIds.add(meetingId);
    return result.changes > 0;
  }

  async saveRecordingAsset(asset: RecordingAssetRecord, scopeKey: ScopeKey): Promise<void> {
    assertScopeKey(scopeKey);
    await this.assertMeetingInScope(asset.meetingId, scopeKey);
    if (!asset.id.trim() || !asset.meetingId.trim()) throw new Error('recording asset identity is invalid');
    if (!/^[0-9a-f]{32}$/.test(asset.assetGeneration)) {
      throw new Error('recording asset generation is invalid');
    }
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
    if (asset.sourceSha256 !== null && !/^sha256:[0-9a-f]{64}$/.test(asset.sourceSha256)) {
      throw new Error('recording asset source hash is invalid');
    }
    if (asset.remoteObjectRevision !== null && (
      !Number.isSafeInteger(asset.remoteObjectRevision) || asset.remoteObjectRevision < 1
    )) throw new Error('recording remote object revision is invalid');
    const existingOwner = await this.database.getFirstAsync<RecordingAssetRow>(
      'SELECT * FROM recording_assets WHERE id = ?',
      asset.id,
    );
    if (existingOwner && existingOwner.meeting_id !== asset.meetingId) {
      throw new Error('recording asset belongs to a different meeting');
    }
    if (existingOwner && existingOwner.asset_generation !== asset.assetGeneration) {
      throw new Error('recording asset generation cannot be changed');
    }
    if (
      existingOwner?.source_sha256
      && asset.sourceSha256
      && existingOwner.source_sha256 !== asset.sourceSha256
    ) throw new Error('recording asset source hash cannot be changed');
    if (
      existingOwner?.remote_asset_id
      && asset.remoteAssetId
      && existingOwner.remote_asset_id !== asset.remoteAssetId
    ) throw new Error('recording remote asset identity cannot be changed');
    if (
      existingOwner?.remote_object_revision !== null
      && existingOwner?.remote_object_revision !== undefined
      && asset.remoteObjectRevision !== null
      && asset.remoteObjectRevision < existingOwner.remote_object_revision
    ) throw new Error('recording remote object revision cannot move backwards');
    if (asset.remoteObjectRevision !== null && !asset.remoteAssetId && !existingOwner?.remote_asset_id) {
      throw new Error('recording remote object revision requires a remote asset');
    }
    if (asset.uploadOperationId) {
      const operation = await this.database.getFirstAsync<{
        entity_id: string;
        capability: string;
        generation_id: string;
      }>(
        `SELECT entity_id, capability, generation_id FROM device_operations
         WHERE operation_id = ?`,
        asset.uploadOperationId,
      );
      if (
        !operation
        || operation.entity_id !== asset.meetingId
        || operation.capability !== 'media.upload'
        || operation.generation_id !== asset.assetGeneration
      ) throw new Error('recording upload operation does not own this asset generation');
    }
    await this.database.runAsync(
      `INSERT INTO recording_assets (
         id, meeting_id, asset_generation, role, origin, native_session_id, local_uri, remote_asset_id,
         mime_type, file_name, byte_size, duration_ms, checksum_sha256, waveform_json,
         source_sha256, local_state, upload_operation_id, remote_object_revision,
         created_at_ms, updated_at_ms, last_verified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         origin = excluded.origin,
         native_session_id = excluded.native_session_id,
         local_uri = excluded.local_uri,
         remote_asset_id = COALESCE(recording_assets.remote_asset_id, excluded.remote_asset_id),
         mime_type = excluded.mime_type,
         file_name = excluded.file_name,
         byte_size = excluded.byte_size,
         duration_ms = excluded.duration_ms,
         checksum_sha256 = excluded.checksum_sha256,
         waveform_json = excluded.waveform_json,
         source_sha256 = COALESCE(recording_assets.source_sha256, excluded.source_sha256),
         local_state = excluded.local_state,
         upload_operation_id = COALESCE(excluded.upload_operation_id, recording_assets.upload_operation_id),
         remote_object_revision = COALESCE(excluded.remote_object_revision, recording_assets.remote_object_revision),
         updated_at_ms = excluded.updated_at_ms,
         last_verified_at_ms = excluded.last_verified_at_ms`,
      asset.id,
      asset.meetingId,
      asset.assetGeneration,
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
      asset.sourceSha256,
      asset.localState,
      asset.uploadOperationId,
      asset.remoteObjectRevision,
      asset.createdAtMs,
      asset.updatedAtMs,
      asset.lastVerifiedAtMs,
    );
    this.touchedMeetingIds.add(asset.meetingId);
  }

  async enrichTranscriptRecordingProvenance(
    meetingId: string,
    recordingAssetId: string,
    scopeKey: ScopeKey,
  ): Promise<number> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    assertRecordId(recordingAssetId, 'recording asset ID');
    const meeting = await this.getMeeting(meetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not accept transcript provenance in active scope');
    }
    const asset = await this.getRecordingAsset(meetingId, recordingAssetId, scopeKey);
    if (!asset) throw new Error('transcript recording asset does not belong to the meeting');
    if (asset.remoteAssetId) {
      const mismatch = Number((await this.database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM transcript_segments
         WHERE meeting_id = ? AND source_recording_asset_id = ?
           AND source_recording_asset_remote_id IS NOT NULL
           AND source_recording_asset_remote_id != ?`,
        meetingId,
        recordingAssetId,
        asset.remoteAssetId,
      ))?.count ?? 0);
      if (mismatch > 0) throw new Error('transcript recording asset remote identity changed');
    }
    let changed = 0;
    if (asset.remoteAssetId) {
      const remoteResult = await this.database.runAsync(
        `UPDATE transcript_segments
         SET source_recording_asset_remote_id = ?
         WHERE meeting_id = ? AND source_recording_asset_id = ?
           AND source_recording_asset_remote_id IS NULL`,
        asset.remoteAssetId,
        meetingId,
        recordingAssetId,
      );
      changed += remoteResult.changes;
    }
    const assetCount = Number((await this.database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM recording_assets WHERE meeting_id = ?',
      meetingId,
    ))?.count ?? 0);
    if (assetCount === 1) {
      const unassignedResult = await this.database.runAsync(
        `UPDATE transcript_segments SET
           source_recording_asset_id = ?,
           source_recording_asset_remote_id = COALESCE(source_recording_asset_remote_id, ?)
         WHERE meeting_id = ?
           AND source_recording_asset_id IS NULL
           AND source_recording_asset_remote_id IS NULL`,
        recordingAssetId,
        asset.remoteAssetId,
        meetingId,
      );
      changed += unassignedResult.changes;
    }
    if (changed > 0) this.touchedMeetingIds.add(meetingId);
    return changed;
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
    assertOptionalNonNegativeInteger(revision.textFinalAtMs, 'transcript text finalization time');
    if (
      revision.sourceManifestSha256 !== null
      && !/^sha256:[0-9a-f]{64}$/.test(revision.sourceManifestSha256)
    ) throw new Error('transcript source manifest hash is invalid');
    if (revision.finalizedAtMs !== null && revision.finalizedAtMs < revision.createdAtMs) {
      throw new Error('transcript revision finalization precedes creation');
    }
    if (revision.textFinalAtMs !== null && revision.textFinalAtMs < revision.createdAtMs) {
      throw new Error('transcript text finalization precedes creation');
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
    const stableSegmentKeys = new Set<string>();
    const ordinals = new Set<number>();
    const sourceRecordingAssets = new Map<string, RecordingAssetRecord | null>();
    for (const segment of segments) {
      assertRecordId(segment.id, 'transcript segment ID');
      if (segment.meetingId !== revision.meetingId) {
        throw new Error('transcript segment belongs to a different meeting');
      }
      assertNonNegativeInteger(segment.ordinal, 'transcript segment ordinal');
      assertNonNegativeInteger(segment.startMs, 'transcript segment start');
      assertNonNegativeInteger(segment.endMs, 'transcript segment end');
      assertNonNegativeInteger(segment.createdAtMs, 'transcript segment creation time');
      assertRecordId(segment.stableSegmentKey, 'stable transcript segment key');
      if (!Number.isSafeInteger(segment.segmentRevision) || segment.segmentRevision < 1) {
        throw new Error('transcript segment revision is invalid');
      }
      if (!['partial', 'stable', 'final'].includes(segment.textState)) {
        throw new Error('transcript segment text state is invalid');
      }
      if (segment.isFinal !== (segment.textState === 'final')) {
        throw new Error('transcript segment final state is inconsistent');
      }
      if (segment.endMs < segment.startMs) throw new Error('transcript segment end precedes start');
      if (segment.confidence !== null && (
        !Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1
      )) {
        throw new Error('transcript segment confidence is invalid');
      }
      if (
        segmentIds.has(segment.id)
        || ordinals.has(segment.ordinal)
        || stableSegmentKeys.has(segment.stableSegmentKey)
      ) {
        throw new Error('transcript revision contains duplicate segment identity');
      }
      if (segment.sourceId && sourceSegmentIds.has(segment.sourceId)) {
        throw new Error('transcript revision contains duplicate source segment identity');
      }
      assertNullableBoundedText(
        segment.sourceRecordingAssetId,
        512,
        'transcript recording asset ID',
      );
      assertNullableBoundedText(
        segment.sourceRecordingAssetRemoteId,
        512,
        'transcript recording asset remote ID',
      );
      assertNullableBoundedText(
        segment.sourceTranscriptionJobId,
        512,
        'transcript source job ID',
      );
      if (segment.sourceRecordingAssetId) {
        let sourceAsset = sourceRecordingAssets.get(segment.sourceRecordingAssetId);
        if (sourceAsset === undefined) {
          sourceAsset = await this.getRecordingAsset(
            revision.meetingId,
            segment.sourceRecordingAssetId,
            scopeKey,
          );
          sourceRecordingAssets.set(segment.sourceRecordingAssetId, sourceAsset);
        }
        if (!sourceAsset) throw new Error('transcript recording asset does not belong to the meeting');
        if (
          sourceAsset.remoteAssetId
          && segment.sourceRecordingAssetRemoteId
          && sourceAsset.remoteAssetId !== segment.sourceRecordingAssetRemoteId
        ) throw new Error('transcript recording asset remote identity is inconsistent');
      }
      segmentIds.add(segment.id);
      stableSegmentKeys.add(segment.stableSegmentKey);
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
    if (
      existingRow?.source_manifest_sha256
      && revision.sourceManifestSha256
      && existingRow.source_manifest_sha256 !== revision.sourceManifestSha256
    ) throw new Error('transcript source manifest cannot be changed');
    if (
      existingRow?.text_final_at_ms !== null
      && existingRow?.text_final_at_ms !== undefined
      && revision.textFinalAtMs !== null
      && existingRow.text_final_at_ms !== revision.textFinalAtMs
    ) throw new Error('transcript text finalization time cannot be changed');
    if (existingRow && revision.kind !== 'realtime_draft') {
      const existing = transcriptRevisionFromRow(existingRow);
      if (
        existing.kind !== revision.kind ||
        existing.status !== revision.status ||
        existing.sourceProvider !== revision.sourceProvider ||
        existing.sourceModel !== revision.sourceModel ||
        (existing.sourceManifestSha256 !== null
          && existing.sourceManifestSha256 !== revision.sourceManifestSha256) ||
        existing.createdAtMs !== revision.createdAtMs ||
        existing.finalizedAtMs !== revision.finalizedAtMs ||
        (existing.textFinalAtMs !== null && existing.textFinalAtMs !== revision.textFinalAtMs)
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
          && row.stable_segment_key === segment.stableSegmentKey
          && row.segment_revision === segment.segmentRevision
          && row.text_state === segment.textState
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
        const provenance = segments[index];
        if (
          row.source_recording_asset_id
          && provenance.sourceRecordingAssetId
          && row.source_recording_asset_id !== provenance.sourceRecordingAssetId
        ) throw new Error('immutable transcript recording asset identity cannot be replaced');
        if (
          row.source_recording_asset_remote_id
          && provenance.sourceRecordingAssetRemoteId
          && row.source_recording_asset_remote_id !== provenance.sourceRecordingAssetRemoteId
        ) throw new Error('immutable transcript remote recording asset identity cannot be replaced');
        if (
          row.source_transcription_job_id
          && provenance.sourceTranscriptionJobId
          && row.source_transcription_job_id !== provenance.sourceTranscriptionJobId
        ) throw new Error('immutable transcript source job identity cannot be replaced');
        if (
          (!row.source_recording_asset_id && provenance.sourceRecordingAssetId)
          || (!row.source_recording_asset_remote_id && provenance.sourceRecordingAssetRemoteId)
          || (!row.source_transcription_job_id && provenance.sourceTranscriptionJobId)
        ) {
          await this.database.runAsync(
            `UPDATE transcript_segments SET
               source_recording_asset_id = COALESCE(source_recording_asset_id, ?),
               source_recording_asset_remote_id = COALESCE(source_recording_asset_remote_id, ?),
               source_transcription_job_id = COALESCE(source_transcription_job_id, ?)
             WHERE id = ?`,
            provenance.sourceRecordingAssetId,
            provenance.sourceRecordingAssetRemoteId,
            provenance.sourceTranscriptionJobId,
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
      if (!existingRow.source_manifest_sha256 && revision.sourceManifestSha256) {
        await this.database.runAsync(
          'UPDATE transcript_revisions SET source_manifest_sha256 = ? WHERE id = ?',
          revision.sourceManifestSha256,
          revision.id,
        );
      }
      if (existingRow.text_final_at_ms === null && revision.textFinalAtMs !== null) {
        await this.database.runAsync(
          'UPDATE transcript_revisions SET text_final_at_ms = ? WHERE id = ?',
          revision.textFinalAtMs,
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
           source_manifest_sha256, is_active, created_at_ms, finalized_at_ms, text_final_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision.id,
        revision.meetingId,
        revision.remoteId,
        revision.kind,
        revision.status,
        revision.sourceProvider,
        revision.sourceModel,
        revision.sourceManifestSha256,
        options.activate ? 1 : 0,
        revision.createdAtMs,
        revision.finalizedAtMs,
        revision.textFinalAtMs,
      );
    } else if (revision.kind === 'realtime_draft') {
      if (!options.replaceSegments) {
        throw new Error('mutable transcript revision requires an explicit segment replacement');
      }
      const previousSegments = await this.database.getAllAsync<TranscriptSegmentRow>(
        'SELECT * FROM transcript_segments WHERE revision_id = ? ORDER BY ordinal',
        revision.id,
      );
      const nextByStableKey = new Map(segments.map(segment => [segment.stableSegmentKey, segment]));
      const stateRank: Record<TranscriptSegmentRecord['textState'], number> = {
        partial: 0,
        stable: 1,
        final: 2,
      };
      for (const previous of previousSegments) {
        const next = nextByStableKey.get(previous.stable_segment_key);
        if (!next) {
          if (previous.text_state !== 'partial') {
            throw new Error('stable transcript segment cannot disappear');
          }
          continue;
        }
        if (next.segmentRevision < previous.segment_revision) {
          throw new Error('transcript segment revision cannot move backwards');
        }
        if (stateRank[next.textState] < stateRank[previous.text_state]) {
          throw new Error('transcript segment text state cannot move backwards');
        }
        const changed = previous.id !== next.id
          || previous.source_segment_id !== next.sourceId
          || previous.source_recording_asset_id !== next.sourceRecordingAssetId
          || previous.source_recording_asset_remote_id !== next.sourceRecordingAssetRemoteId
          || previous.source_transcription_job_id !== next.sourceTranscriptionJobId
          || previous.ordinal !== next.ordinal
          || previous.start_ms !== next.startMs
          || previous.end_ms !== next.endMs
          || previous.text !== next.text
          || previous.normalized_text !== next.normalizedText
          || previous.confidence !== next.confidence
          || previous.text_state !== next.textState
          || previous.is_final !== (next.isFinal ? 1 : 0);
        if (changed && next.segmentRevision <= previous.segment_revision) {
          throw new Error('changed transcript segment did not advance its revision');
        }
        if (previous.text_state === 'final' && changed) {
          throw new Error('final transcript segment cannot be changed');
        }
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
           source_model = ?, source_manifest_sha256 = COALESCE(source_manifest_sha256, ?),
           is_active = ?, finalized_at_ms = ?, text_final_at_ms = COALESCE(text_final_at_ms, ?)
         WHERE id = ?`,
        revision.remoteId,
        revision.status,
        revision.sourceProvider,
        revision.sourceModel,
        revision.sourceManifestSha256,
        options.activate ? 1 : 0,
        revision.finalizedAtMs,
        revision.textFinalAtMs,
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
           id, revision_id, meeting_id, source_segment_id,
             source_recording_asset_id, source_recording_asset_remote_id,
             source_transcription_job_id, stable_segment_key, segment_revision, text_state,
             ordinal, start_ms, end_ms,
             speaker_cluster_id, speaker_profile_id, speaker_label,
             speaker_label_override, text, normalized_text, confidence,
             is_final, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          segment.id,
          revision.id,
          segment.meetingId,
          segment.sourceId,
          segment.sourceRecordingAssetId,
          segment.sourceRecordingAssetRemoteId,
          segment.sourceTranscriptionJobId,
          segment.stableSegmentKey,
          segment.segmentRevision,
          segment.textState,
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
    if (input.scope !== 'segment' && input.scope !== 'cluster' && input.scope !== 'future_profile') {
      throw new Error('speaker correction scope is invalid');
    }
    if (input.scope !== 'segment' && input.sourceClusterId === null) {
      throw new Error('speaker cluster correction has no source cluster');
    }
    if (
      input.scope === 'future_profile'
      && (!input.speakerProfileId || !input.consentToProfileUpdate)
    ) {
      throw new Error('future speaker correction has no authorized profile');
    }
    if (input.scope !== 'future_profile' && (input.speakerProfileId || input.consentToProfileUpdate)) {
      throw new Error('meeting-local speaker correction cannot update a voice profile');
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
        && existing.consent_to_profile_update === (input.consentToProfileUpdate ? 1 : 0);
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

    const affected = input.scope !== 'segment'
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.correctionId,
      scopeKey,
      input.meetingId,
      input.transcriptRevisionId,
      input.scope,
      input.targetSegmentId,
      input.sourceClusterId,
      input.speakerProfileId,
      displayName,
      input.consentToProfileUpdate ? 1 : 0,
      baseRevision,
      assignmentRevision,
      'local_only',
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
        `UPDATE transcript_segments SET speaker_label_override = ?,
           speaker_profile_id = CASE WHEN ? = 1 THEN ? ELSE speaker_profile_id END
         WHERE id = ? AND meeting_id = ? AND revision_id = ?`,
        displayName,
        input.scope === 'future_profile' ? 1 : 0,
        input.speakerProfileId,
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
    const activationFence = options.activationFenceV3;
    if (activationFence) {
      if (!options.factDocument) throw new SummaryV3ActivationFenceError();
      const authority = await this.database.getFirstAsync<{ current_epoch_id: string | null }>(
        'SELECT current_epoch_id FROM device_authority_state WHERE singleton_id = 1',
      );
      const binding = await this.database.getFirstAsync<{
        device_epoch_id: string;
        binding_id: string;
        binding_generation: string;
        binding_revision: number;
        state: string;
        cancel_revision: number;
      }>(
        `SELECT device_epoch_id, binding_id, binding_generation, binding_revision,
                state, cancel_revision
           FROM meeting_service_bindings WHERE meeting_id = ?`,
        version.meetingId,
      );
      const currentAttachments: {
        attachmentId: string;
        kind: string;
        positionMs: number;
        updatedAtMs: number;
        contentSha256: string;
      }[] = [];
      for (const expected of activationFence.attachments) {
        const current = await this.database.getFirstAsync<{
          position_ms: number;
          kind: string;
          text_content: string | null;
          updated_at_ms: number;
        }>(
          `SELECT position_ms, kind, text_content, updated_at_ms
             FROM meeting_attachments
            WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
          expected.attachmentId,
          version.meetingId,
          scopeKey,
        );
        if (current) currentAttachments.push({
          attachmentId: expected.attachmentId,
          kind: current.kind,
          positionMs: Number(current.position_ms),
          updatedAtMs: Number(current.updated_at_ms),
          contentSha256: await sha256Text((current.text_content ?? '').replace(/\r\n?/g, '\n').trim()),
        });
      }
      if (!meetingSummaryActivationFenceMatches(activationFence, {
        deviceEpochId: authority?.current_epoch_id ?? null,
        binding: binding
          ? {
              deviceEpochId: binding.device_epoch_id,
              bindingId: binding.binding_id,
              bindingGeneration: binding.binding_generation,
              bindingRevision: Number(binding.binding_revision),
              state: binding.state,
              cancelRevision: Number(binding.cancel_revision),
            }
          : null,
        attachments: currentAttachments,
      })) throw new SummaryV3ActivationFenceError();
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
    const factDocument = options.factDocument ?? null;
    if (factDocument) {
      assertRecordId(factDocument.id, 'summary fact document ID');
      if (
        factDocument.meetingId !== version.meetingId
        || factDocument.summaryVersionId !== version.id
        || !/^sha256:[0-9a-f]{64}$/.test(factDocument.sourceFingerprint)
        || !factDocument.transcriptRevision.trim()
        || !factDocument.modelRevision.trim()
        || !factDocument.promptRevision.trim()
      ) throw new Error('summary fact document identity is invalid');
      assertNonNegativeInteger(factDocument.generatedAtMs, 'summary fact generation time');
      assertNonNegativeInteger(factDocument.createdAtMs, 'summary fact persistence time');
      try {
        const document = JSON.parse(factDocument.documentJson);
        const coverage = JSON.parse(factDocument.coverageJson);
        if (
          !document || typeof document !== 'object' || Array.isArray(document)
          || !coverage || typeof coverage !== 'object' || Array.isArray(coverage)
        ) throw new Error('invalid');
      } catch {
        throw new Error('summary fact document payload is invalid');
      }
    }
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
      assertOptionalNonNegativeInteger(citation.userRemovedAtMs, 'summary citation removal time');
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
             id, section_id, segment_id, start_ms, end_ms, quote_hash, ordinal,
             user_removed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          citation.id,
          citation.sectionId,
          citation.segmentId,
          citation.startMs,
          citation.endMs,
          citation.quoteHash,
          citation.ordinal,
          citation.userRemovedAtMs,
        );
      }
    }

    if (factDocument) {
      const existingFact = await this.database.getFirstAsync<{
        meeting_id: string;
        summary_version_id: string | null;
        source_fingerprint: string;
        transcript_revision: string;
        model_revision: string;
        prompt_revision: string;
        document_json: string;
        coverage_json: string;
        generated_at_ms: number;
      }>(
        `SELECT meeting_id, summary_version_id, source_fingerprint,
                transcript_revision, model_revision, prompt_revision,
                document_json, coverage_json, generated_at_ms
           FROM summary_fact_documents WHERE id = ?`,
        factDocument.id,
      );
      if (existingFact) {
        if (
          existingFact.meeting_id !== factDocument.meetingId
          || (
            existingFact.summary_version_id !== null
            && existingFact.summary_version_id !== factDocument.summaryVersionId
          )
          || existingFact.source_fingerprint !== factDocument.sourceFingerprint
          || existingFact.transcript_revision !== factDocument.transcriptRevision
          || existingFact.model_revision !== factDocument.modelRevision
          || existingFact.prompt_revision !== factDocument.promptRevision
          || existingFact.document_json !== factDocument.documentJson
          || existingFact.coverage_json !== factDocument.coverageJson
          || existingFact.generated_at_ms !== factDocument.generatedAtMs
        ) throw new Error('immutable summary fact document cannot be replaced');
        if (existingFact.summary_version_id === null) {
          await this.database.runAsync(
            `UPDATE summary_fact_documents SET summary_version_id = ?
              WHERE id = ? AND meeting_id = ? AND summary_version_id IS NULL`,
            factDocument.summaryVersionId,
            factDocument.id,
            factDocument.meetingId,
          );
        }
      } else {
        await this.database.runAsync(
          `INSERT INTO summary_fact_documents (
             id, meeting_id, summary_version_id, source_fingerprint,
             transcript_revision, model_revision, prompt_revision,
             document_json, coverage_json, generated_at_ms, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          factDocument.id,
          factDocument.meetingId,
          factDocument.summaryVersionId,
          factDocument.sourceFingerprint,
          factDocument.transcriptRevision,
          factDocument.modelRevision,
          factDocument.promptRevision,
          factDocument.documentJson,
          factDocument.coverageJson,
          factDocument.generatedAtMs,
          factDocument.createdAtMs,
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
          null,
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

  async updateCurrentSummarySectionUserState(
    meetingId: string,
    versionId: string,
    sectionId: string,
    scopeKey: ScopeKey,
    userText: string | null,
    userEditedAtMs: number | null,
    visibleCitationIds: readonly string[],
    citationRemovedAtMs: number | null,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    assertRecordId(versionId, 'summary version ID');
    assertRecordId(sectionId, 'summary section ID');
    if ((userText === null) !== (userEditedAtMs === null)) {
      throw new Error('summary section user edit ownership is invalid');
    }
    if (
      userText !== null
      && (!userText.trim() || userText.length > 20_000 || userText.includes('\u0000'))
    ) throw new Error('summary section user text is invalid');
    assertOptionalNonNegativeInteger(userEditedAtMs, 'summary section edit time');
    assertOptionalNonNegativeInteger(citationRemovedAtMs, 'summary citation removal time');
    const normalizedVisibleCitationIds = visibleCitationIds.map(citationId => {
      assertRecordId(citationId, 'summary citation ID');
      return citationId.trim();
    });
    if (new Set(normalizedVisibleCitationIds).size !== normalizedVisibleCitationIds.length) {
      throw new Error('summary citation visibility contains duplicate IDs');
    }

    const citationRows = await this.database.getAllAsync<SummaryCitationRow>(
      `SELECT citation.* FROM summary_citations citation
       INNER JOIN summary_sections section ON section.id = citation.section_id
       INNER JOIN summary_versions version ON version.id = section.version_id
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE citation.section_id = ? AND section.version_id = ?
         AND version.meeting_id = ? AND meeting.scope_key = ?
         AND meeting.lifecycle <> 'deleted'
         AND meeting.current_summary_version_id = version.id
         AND version.status IN ('ready', 'stale')
       ORDER BY citation.ordinal, citation.id`,
      sectionId,
      versionId,
      meetingId,
      scopeKey,
    );
    const citationIds = new Set(citationRows.map(citation => citation.id));
    if (normalizedVisibleCitationIds.some(citationId => !citationIds.has(citationId))) {
      throw new Error('summary citation visibility contains an unknown ID');
    }
    if (normalizedVisibleCitationIds.length < citationRows.length && citationRemovedAtMs === null) {
      throw new Error('summary citation removal requires an edit time');
    }

    const updated = await this.database.runAsync(
      `UPDATE summary_sections SET user_text = ?, user_edited_at_ms = ?
       WHERE id = ? AND version_id = ?
         AND EXISTS (
           SELECT 1 FROM summary_versions version
           INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
           WHERE version.id = summary_sections.version_id
             AND version.meeting_id = ? AND meeting.scope_key = ?
             AND meeting.lifecycle <> 'deleted'
             AND meeting.current_summary_version_id = version.id
             AND version.status IN ('ready', 'stale')
         )`,
      userText,
      userEditedAtMs,
      sectionId,
      versionId,
      meetingId,
      scopeKey,
    );
    if (updated.changes !== 1) return false;

    const visibleCitationSet = new Set(normalizedVisibleCitationIds);
    for (const citation of citationRows) {
      const nextRemovedAtMs = visibleCitationSet.has(citation.id)
        ? null
        : citation.user_removed_at_ms ?? citationRemovedAtMs;
      if (nextRemovedAtMs === citation.user_removed_at_ms) continue;
      const citationUpdate = await this.database.runAsync(
        `UPDATE summary_citations SET user_removed_at_ms = ?
         WHERE id = ? AND section_id = ?`,
        nextRemovedAtMs,
        citation.id,
        sectionId,
      );
      if (citationUpdate.changes !== 1) {
        throw new Error('summary citation visibility could not be updated');
      }
    }

    const ownership = await this.database.runAsync(
      `UPDATE summary_versions SET user_edited = CASE WHEN
         EXISTS (
           SELECT 1 FROM summary_sections section
           WHERE section.version_id = summary_versions.id
             AND (section.user_text IS NOT NULL OR section.user_edited_at_ms IS NOT NULL)
         )
         OR EXISTS (
           SELECT 1 FROM summary_citations citation
           INNER JOIN summary_sections section ON section.id = citation.section_id
           WHERE section.version_id = summary_versions.id
             AND citation.user_removed_at_ms IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM action_items action
           WHERE action.source_summary_version_id = summary_versions.id
             AND (action.user_edited_at_ms IS NOT NULL OR action.status <> 'pending')
         )
         THEN 1 ELSE 0 END
       WHERE id = ? AND meeting_id = ?`,
      versionId,
      meetingId,
    );
    if (ownership.changes !== 1) {
      throw new Error('summary section ownership could not be updated');
    }
    this.touchedMeetingIds.add(meetingId);
    return true;
  }


  async advanceCanonicalWrite(scopeKey: ScopeKey, updatedAtMs: number): Promise<number> {
    assertScopeKey(scopeKey);
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new Error('meeting canonical write time is invalid');
    }
    const existingRow = await this.database.getFirstAsync<MeetingScopeRevisionRow>(
      'SELECT * FROM meeting_scope_write_state WHERE scope_key = ?',
      scopeKey,
    );
    if (!existingRow) {
      await this.database.runAsync(
         `INSERT INTO meeting_scope_write_state (
           scope_key, write_owner, canonical_revision, legacy_mirror_revision,
           legacy_mirror_status, last_error_code, updated_at_ms
         ) VALUES (?, 'canonical', 1, 0, 'clean', NULL, ?)`,
        scopeKey,
        updatedAtMs,
      );
      return 1;
    }
    const existing = scopeRevisionStateFromRow(existingRow);
    const canonicalRevision = existing.canonicalRevision + 1;
    if (!Number.isSafeInteger(canonicalRevision)) {
      throw new Error('meeting canonical revision overflow');
    }
    const result = await this.database.runAsync(
      `UPDATE meeting_scope_write_state SET
         write_owner = 'canonical',
         canonical_revision = ?,
         legacy_mirror_revision = 0,
         legacy_mirror_status = 'clean',
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

}

export class SqliteMeetingNoteRepository implements MeetingNoteRepository {
  private readonly meetingListeners = new Map<ScopeKey, Map<string, Set<() => void>>>();
  private readonly listListeners = new Map<ScopeKey, Set<() => void>>();
  private readonly indexedSearchScopes = new Map<ScopeKey, number>();
  private searchIndexGeneration = 0;

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
         COALESCE(meeting.legacy_source_id, meeting.id) AS legacy_meeting_id,
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
         AND ${CURRENT_MEETING_ACTION_VISIBILITY_SQL}
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
         asset.native_session_id = ? OR meeting.id = ? OR meeting.legacy_source_id = ?
       )
       ORDER BY CASE WHEN asset.native_session_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      scopeKey,
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
         AND ${CURRENT_MEETING_ACTION_VISIBILITY_SQL}
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

  async getScopeRevisionState(scopeKey: ScopeKey): Promise<MeetingScopeRevisionState> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const row = await database.getFirstAsync<MeetingScopeRevisionRow>(
      'SELECT * FROM meeting_scope_write_state WHERE scope_key = ?',
      scopeKey,
    );
    return row ? scopeRevisionStateFromRow(row) : {
      scopeKey,
      canonicalRevision: 0,
      updatedAtMs: 0,
    };
  }

  async listMeetingRecordingMergeTasks(
    targetMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingRecordingMergeTaskRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(targetMeetingId, 'recording merge target meeting ID');
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingRecordingMergeTaskRow>(
      `SELECT task.* FROM meeting_recording_merge_tasks task
       INNER JOIN meeting_notes target
         ON target.id = task.target_meeting_id AND target.scope_key = task.scope_key
       WHERE task.scope_key = ? AND task.target_meeting_id = ?
       ORDER BY task.created_at_ms, task.id`,
      scopeKey,
      targetMeetingId,
    );
    return rows.map(recordingMergeTaskFromRow);
  }

  async completeMeetingRecordingMergeTask(
    input: CompleteMeetingRecordingMergeTaskInput,
  ): Promise<boolean> {
    assertScopeKey(input.scopeKey);
    assertRecordId(input.taskId, 'recording merge task ID');
    assertRecordId(input.targetMeetingId, 'recording merge target meeting ID');
    assertRecordId(input.recordingAsset.id, 'recording merge target asset ID');
    assertNonNegativeInteger(input.completedAtMs, 'recording merge completion time');
    if (
      input.recordingAsset.meetingId !== input.targetMeetingId
      || input.recordingAsset.localState !== 'local_ready'
      || !input.recordingAsset.localUri?.trim()
    ) throw new Error('recording merge result is invalid');
    assertNullableBoundedText(input.recordingAsset.localUri, 16_384, 'recording merge local URI');
    assertNullableBoundedText(input.recordingAsset.mimeType, 512, 'recording merge MIME type');
    assertNullableBoundedText(input.recordingAsset.fileName, 2_000, 'recording merge file name');
    assertNullableBoundedText(input.recordingAsset.checksumSha256, 128, 'recording merge checksum');
    assertOptionalNonNegativeInteger(input.recordingAsset.byteSize, 'recording merge byte size');
    assertOptionalNonNegativeInteger(input.recordingAsset.durationMs, 'recording merge duration');

    let touched = false;
    const applied = await withMeetingDatabaseTransaction(async database => {
      const task = await database.getFirstAsync<MeetingRecordingMergeTaskRow>(
        `SELECT * FROM meeting_recording_merge_tasks
         WHERE id = ? AND scope_key = ? AND target_meeting_id = ?`,
        input.taskId,
        input.scopeKey,
        input.targetMeetingId,
      );
      if (!task) return false;
      if (task.target_recording_asset_id !== input.recordingAsset.id) {
        throw new Error('recording merge target asset changed');
      }
      if (task.target_asset_generation !== input.recordingAsset.assetGeneration) {
        throw new Error('recording merge target asset generation changed');
      }
      if (task.status === 'completed') {
        const existing = await database.getFirstAsync<RecordingAssetRow>(
          'SELECT * FROM recording_assets WHERE id = ? AND meeting_id = ?',
          task.target_recording_asset_id,
          task.target_meeting_id,
        );
        if (!existing || existing.local_uri !== input.recordingAsset.localUri) {
          throw new Error('completed recording merge asset is inconsistent');
        }
        return true;
      }
      const target = await database.getFirstAsync<MeetingRow>(
        `SELECT * FROM meeting_notes
         WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
        task.target_meeting_id,
        input.scopeKey,
      );
      if (!target) throw new Error('recording merge target meeting is unavailable');
      const source = await database.getFirstAsync<RecordingAssetRow>(
        `SELECT asset.* FROM recording_assets asset
         INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
         WHERE asset.id = ? AND asset.meeting_id = ? AND meeting.scope_key = ?
           AND meeting.lifecycle <> 'deleted'`,
        task.source_recording_asset_id,
        task.source_meeting_id,
        input.scopeKey,
      );
      if (!source || source.local_state !== 'local_ready' || !source.local_uri) {
        throw new Error('recording merge source is not ready');
      }
      if (
        source.checksum_sha256
        && input.recordingAsset.checksumSha256
        && source.checksum_sha256.toLowerCase() !== input.recordingAsset.checksumSha256.toLowerCase()
      ) throw new Error('recording merge source checksum changed');
      if (
        source.byte_size !== null
        && input.recordingAsset.byteSize !== null
        && source.byte_size !== input.recordingAsset.byteSize
      ) throw new Error('recording merge source size changed');
      const existingTargetAsset = await database.getFirstAsync<RecordingAssetRow>(
        'SELECT * FROM recording_assets WHERE id = ?',
        task.target_recording_asset_id,
      );
      if (existingTargetAsset) {
        throw new Error('recording merge target asset already exists');
      }
      const primary = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM recording_assets
         WHERE meeting_id = ? AND role = 'primary' LIMIT 1`,
        task.target_meeting_id,
      );
      // A remotely rooted conflict target may already own server audio that the
      // root feed cannot identify as a RecordingAsset. Keep the recovered copy
      // secondary in that case so it never hides the cloud recording.
      const role: RecordingAssetRecord['role'] = primary || target.remote_id
        ? 'secondary'
        : 'primary';
      await database.runAsync(
        `INSERT INTO recording_assets (
           id, meeting_id, asset_generation, role, origin, native_session_id, local_uri, remote_asset_id,
           mime_type, file_name, byte_size, duration_ms, checksum_sha256, waveform_json,
           source_sha256, local_state, upload_operation_id, remote_object_revision,
           created_at_ms, updated_at_ms, last_verified_at_ms
         ) VALUES (?, ?, ?, ?, 'recovered', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
           'local_ready', ?, ?, ?, ?, ?)`,
        task.target_recording_asset_id,
        task.target_meeting_id,
        task.target_asset_generation,
        role,
        input.recordingAsset.localUri,
        input.recordingAsset.mimeType,
        input.recordingAsset.fileName,
        input.recordingAsset.byteSize,
        input.recordingAsset.durationMs,
        input.recordingAsset.checksumSha256,
        input.recordingAsset.waveformJson,
        input.recordingAsset.sourceSha256,
        input.recordingAsset.uploadOperationId,
        input.recordingAsset.remoteObjectRevision,
        input.completedAtMs,
        input.completedAtMs,
        input.completedAtMs,
      );
      const completed = await database.runAsync(
        `UPDATE meeting_recording_merge_tasks
         SET status = 'completed', attempt_count = attempt_count + 1,
           last_error_code = NULL, retryable = 0,
           updated_at_ms = ?, completed_at_ms = ?
         WHERE id = ? AND scope_key = ? AND target_meeting_id = ?
           AND status <> 'completed'`,
        input.completedAtMs,
        input.completedAtMs,
        task.id,
        input.scopeKey,
        task.target_meeting_id,
      );
      if (completed.changes !== 1) throw new Error('recording merge task changed concurrently');
      await database.runAsync(
        `UPDATE meeting_notes SET updated_at_ms = MAX(updated_at_ms, ?)
         WHERE id = ? AND scope_key = ?`,
        input.completedAtMs,
        task.target_meeting_id,
        input.scopeKey,
      );
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(input.scopeKey, input.completedAtMs);
      touched = true;
      return true;
    });
    if (applied && touched) this.notify([input.targetMeetingId]);
    return applied;
  }

  async failMeetingRecordingMergeTask(input: FailMeetingRecordingMergeTaskInput): Promise<boolean> {
    assertScopeKey(input.scopeKey);
    assertRecordId(input.taskId, 'recording merge task ID');
    assertRecordId(input.targetMeetingId, 'recording merge target meeting ID');
    assertNullableBoundedText(input.errorCode, 160, 'recording merge error code');
    assertNonNegativeInteger(input.failedAtMs, 'recording merge failure time');
    const database = await openMeetingDatabase();
    const result = await database.runAsync(
      `UPDATE meeting_recording_merge_tasks
       SET status = 'failed', attempt_count = attempt_count + 1,
         last_error_code = ?, retryable = ?, updated_at_ms = ?, completed_at_ms = NULL
       WHERE id = ? AND scope_key = ? AND target_meeting_id = ?
         AND status <> 'completed'`,
      input.errorCode,
      input.retryable ? 1 : 0,
      input.failedAtMs,
      input.taskId,
      input.scopeKey,
      input.targetMeetingId,
    );
    if (result.changes > 0) this.notify([input.targetMeetingId]);
    return result.changes > 0;
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
        await database.runAsync(
          `UPDATE meeting_occurrence_links SET
             link_state = ?, client_updated_at_ms = ?,
             sync_state = 'local_only', last_sync_error_code = NULL
           WHERE meeting_id = ? AND scope_key = ?`,
          input.state,
          nextUpdatedAtMs,
          row.meeting_id,
          input.scopeKey,
        );
        meetingIds.push(row.meeting_id);
      }
      if (meetingIds.length > 0) {
        await transaction.advanceCanonicalWrite(input.scopeKey, input.updatedAtMs);
      }
      return meetingIds;
    });
    if (touched.length > 0) this.notify(touched);
    return touched.length;
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

  async getTranscriptRevisionContentByRemoteId(
    meetingId: string,
    remoteRevisionId: string,
    scopeKey: ScopeKey,
  ): Promise<TranscriptRevisionProjection | null> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    const normalizedRemoteRevisionId = remoteRevisionId.trim();
    assertRecordId(normalizedRemoteRevisionId, 'transcript remote revision ID');
    const database = await openMeetingDatabase();
    const revision = await database.getFirstAsync<TranscriptRevisionRow>(
      `SELECT revision.* FROM transcript_revisions revision
       INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
       WHERE revision.meeting_id = ? AND revision.remote_id = ? AND meeting.scope_key = ?
       LIMIT 1`,
      meetingId,
      normalizedRemoteRevisionId,
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

  async listMeetingAttachments(
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingAttachmentRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingAttachmentRow>(
      `SELECT attachment.id, attachment.meeting_id, attachment.marker_id,
         attachment.position_ms, attachment.kind, attachment.text_content,
         attachment.local_uri, attachment.mime_type, attachment.file_name,
         attachment.byte_size, attachment.checksum_sha256,
         attachment.created_at_ms, attachment.updated_at_ms
       FROM meeting_attachments attachment
       INNER JOIN meeting_notes meeting
         ON meeting.id = attachment.meeting_id AND meeting.scope_key = attachment.scope_key
       WHERE attachment.meeting_id = ? AND attachment.scope_key = ?
         AND meeting.lifecycle <> 'deleted'
       ORDER BY attachment.position_ms, attachment.created_at_ms, attachment.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(meetingAttachmentFromRow);
  }

  async createMeetingAttachment(
    attachment: MeetingAttachmentRecord,
    scopeKey: ScopeKey,
  ): Promise<MeetingAttachmentRecord> {
    assertScopeKey(scopeKey);
    assertMeetingAttachmentValue(attachment);
    const created = await withMeetingDatabaseTransaction(async database => {
      const meeting = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM meeting_notes
         WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
        attachment.meetingId,
        scopeKey,
      );
      if (!meeting) throw new Error('meeting attachment target is unavailable');
      if (attachment.markerId !== null) {
        const marker = await database.getFirstAsync<{ position_ms: number }>(
          `SELECT marker.position_ms
           FROM markers marker
           INNER JOIN meeting_notes meeting ON meeting.id = marker.meeting_id
           WHERE marker.id = ? AND marker.meeting_id = ? AND meeting.scope_key = ?
             AND meeting.lifecycle <> 'deleted'`,
          attachment.markerId,
          attachment.meetingId,
          scopeKey,
        );
        if (!marker || marker.position_ms !== attachment.positionMs) {
          throw new Error('meeting attachment marker changed');
        }
      }
      await database.runAsync(
        `INSERT INTO meeting_attachments (
           id, meeting_id, scope_key, marker_id, position_ms, kind,
           text_content, local_uri, mime_type, file_name, byte_size,
           checksum_sha256, remote_id, remote_revision, sync_state,
           pending_operation, last_error_code, remote_updated_at_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attachment.id,
        attachment.meetingId,
        scopeKey,
        attachment.markerId,
        attachment.positionMs,
        attachment.kind,
        attachment.textContent,
        attachment.localUri,
        attachment.mimeType,
        attachment.fileName,
        attachment.byteSize,
        attachment.checksumSha256,
        null,
        null,
        'local',
        null,
        null,
        null,
        attachment.createdAtMs,
        attachment.updatedAtMs,
      );
      if (attachment.kind === 'text') {
        const content = attachment.textContent ?? '';
        const revisionId = `attachment_text:${attachment.id}:1`;
        await database.runAsync(
          `INSERT INTO meeting_attachment_text_revisions (
             revision_id, attachment_id, meeting_id, revision, content_kind,
             content, content_sha256, migrated_current, created_at_ms
           ) VALUES (?, ?, ?, 1, 'text', ?, ?, 0, ?)`,
          revisionId,
          attachment.id,
          attachment.meetingId,
          content,
          await sha256Text(content),
          attachment.createdAtMs,
        );
        await database.runAsync(
          'UPDATE meeting_attachments SET active_text_revision_id = ? WHERE id = ? AND meeting_id = ?',
          revisionId,
          attachment.id,
          attachment.meetingId,
        );
      }
      const row = await database.getFirstAsync<MeetingAttachmentRow>(
        `SELECT id, meeting_id, marker_id, position_ms, kind, text_content,
           local_uri, mime_type, file_name, byte_size, checksum_sha256,
           created_at_ms, updated_at_ms
         FROM meeting_attachments WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
        attachment.id,
        attachment.meetingId,
        scopeKey,
      );
      if (!row) throw new Error('meeting attachment was not created');
      return meetingAttachmentFromRow(row);
    });
    this.notify([attachment.meetingId]);
    return created;
  }

  async deleteMeetingAttachment(
    attachmentId: string,
    meetingId: string,
    scopeKey: ScopeKey,
  ): Promise<MeetingAttachmentRecord | null> {
    assertScopeKey(scopeKey);
    assertRecordId(attachmentId, 'meeting attachment ID');
    assertRecordId(meetingId, 'meeting ID');
    const deleted = await withMeetingDatabaseTransaction(async database => {
      const row = await database.getFirstAsync<MeetingAttachmentRow>(
        `SELECT attachment.id, attachment.meeting_id, attachment.marker_id,
           attachment.position_ms, attachment.kind, attachment.text_content,
           attachment.local_uri, attachment.mime_type, attachment.file_name,
           attachment.byte_size, attachment.checksum_sha256,
           attachment.created_at_ms, attachment.updated_at_ms
         FROM meeting_attachments attachment
         INNER JOIN meeting_notes meeting
           ON meeting.id = attachment.meeting_id AND meeting.scope_key = attachment.scope_key
         WHERE attachment.id = ? AND attachment.meeting_id = ? AND attachment.scope_key = ?
           AND meeting.lifecycle <> 'deleted'`,
        attachmentId,
        meetingId,
        scopeKey,
      );
      if (!row) return null;
      const record = meetingAttachmentFromRow(row);
      const result = await database.runAsync(
        'DELETE FROM meeting_attachments WHERE id = ? AND meeting_id = ? AND scope_key = ?',
        attachmentId,
        meetingId,
        scopeKey,
      );
      if (result.changes !== 1) throw new Error('meeting attachment changed during deletion');
      return record;
    });
    if (deleted) this.notify([meetingId]);
    return deleted;
  }

  async listMeetingTags(meetingId: string, scopeKey: ScopeKey): Promise<readonly MeetingTagRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingTagRow>(
      `SELECT tag.*, COUNT(active_meeting.id) AS meeting_count
       FROM meeting_tag_links selected
       INNER JOIN meeting_tags tag
         ON tag.id = selected.tag_id AND tag.scope_key = selected.scope_key
       INNER JOIN meeting_notes meeting
         ON meeting.id = selected.meeting_id AND meeting.scope_key = selected.scope_key
       LEFT JOIN meeting_tag_links all_links
         ON all_links.tag_id = tag.id AND all_links.scope_key = tag.scope_key
       LEFT JOIN meeting_notes active_meeting
         ON active_meeting.id = all_links.meeting_id
           AND active_meeting.scope_key = all_links.scope_key
           AND active_meeting.lifecycle <> 'deleted'
       WHERE selected.meeting_id = ? AND selected.scope_key = ?
         AND meeting.lifecycle <> 'deleted'
       GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
         tag.created_at_ms, tag.updated_at_ms
       ORDER BY tag.normalized_name, tag.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(meetingTagFromRow);
  }

  async resolveCanonicalMeetingId(
    navigationMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<string | null> {
    assertScopeKey(scopeKey);
    assertRecordId(navigationMeetingId, 'meeting navigation ID');
    const database = await openMeetingDatabase();
    const legacyCanonicalId = `legacy:${encodeURIComponent(scopeKey)}:${encodeURIComponent(navigationMeetingId)}`;
    const row = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM meeting_notes
       WHERE scope_key = ? AND lifecycle <> 'deleted'
         AND (
           id = ? OR id = ? OR legacy_source_id = ?
         )
       ORDER BY CASE
         WHEN id = ? THEN 0 WHEN legacy_source_id = ? THEN 1
         WHEN id = ? THEN 2 ELSE 3 END
       LIMIT 1`,
      scopeKey,
      navigationMeetingId,
      legacyCanonicalId,
      navigationMeetingId,
      navigationMeetingId,
      navigationMeetingId,
      legacyCanonicalId,
    );
    return row?.id ?? null;
  }

  async listMeetingTagAssignments(scopeKey: ScopeKey): Promise<readonly MeetingTagAssignment[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingTagAssignmentRow>(
      `SELECT link.meeting_id, meeting.legacy_source_id,
         tag.id AS tag_id, tag.name AS tag_name
       FROM meeting_tag_links link
       INNER JOIN meeting_tags tag
         ON tag.id = link.tag_id AND tag.scope_key = link.scope_key
       INNER JOIN meeting_notes meeting
         ON meeting.id = link.meeting_id AND meeting.scope_key = link.scope_key
       WHERE link.scope_key = ? AND meeting.lifecycle <> 'deleted'
       ORDER BY link.meeting_id, tag.normalized_name, tag.id`,
      scopeKey,
    );
    return rows.map(row => ({
      meetingId: meetingNavigationIdentity(row, scopeKey),
      tagId: row.tag_id,
      tagName: row.tag_name,
    }));
  }

  async listMeetingTagsForScope(scopeKey: ScopeKey): Promise<readonly MeetingTagRecord[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<MeetingTagRow>(
      `SELECT tag.*, COUNT(active_meeting.id) AS meeting_count
       FROM meeting_tags tag
       LEFT JOIN meeting_tag_links link
         ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
       LEFT JOIN meeting_notes active_meeting
         ON active_meeting.id = link.meeting_id
           AND active_meeting.scope_key = link.scope_key
           AND active_meeting.lifecycle <> 'deleted'
       WHERE tag.scope_key = ?
       GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
         tag.created_at_ms, tag.updated_at_ms
       ORDER BY tag.normalized_name, tag.id`,
      scopeKey,
    );
    return rows.map(meetingTagFromRow);
  }

  async listMeetingOrganization(
    scopeKey: ScopeKey,
    options: MeetingOrganizationOptions = {},
  ): Promise<MeetingOrganizationProjection> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const personRows = await database.getAllAsync<MeetingPersonAggregationRow>(
      `SELECT meeting.id AS meeting_id, meeting.legacy_source_id,
         meeting.title AS meeting_title,
         COALESCE(meeting.recorded_at_ms, meeting.started_at_ms, meeting.created_at_ms)
           AS recorded_at_ms,
         segment.speaker_profile_id, segment.speaker_label_override, segment.speaker_label,
         COUNT(segment.id) AS occurrence_count
       FROM transcript_segments segment
       INNER JOIN transcript_revisions revision
         ON revision.id = segment.revision_id
           AND revision.meeting_id = segment.meeting_id
           AND revision.is_active = 1
       INNER JOIN meeting_notes meeting ON meeting.id = segment.meeting_id
       WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         AND (
           NULLIF(TRIM(segment.speaker_profile_id), '') IS NOT NULL
           OR NULLIF(TRIM(segment.speaker_label_override), '') IS NOT NULL
           OR NULLIF(TRIM(segment.speaker_label), '') IS NOT NULL
         )
       GROUP BY meeting.id, meeting.legacy_source_id, meeting.title, recorded_at_ms,
         segment.speaker_profile_id, segment.speaker_label_override, segment.speaker_label
       ORDER BY recorded_at_ms DESC, meeting.id, segment.speaker_profile_id,
         segment.speaker_label_override, segment.speaker_label`,
      scopeKey,
    );
    const topicRows = await database.getAllAsync<MeetingTopicAggregationRow>(
      `SELECT meeting.id AS meeting_id, meeting.legacy_source_id,
         meeting.title AS meeting_title,
         COALESCE(meeting.recorded_at_ms, meeting.started_at_ms, meeting.created_at_ms)
           AS recorded_at_ms,
         tag.id AS tag_id, tag.name AS tag_name
       FROM meeting_tag_links link
       INNER JOIN meeting_tags tag
         ON tag.id = link.tag_id AND tag.scope_key = link.scope_key
       INNER JOIN meeting_notes meeting
         ON meeting.id = link.meeting_id AND meeting.scope_key = link.scope_key
       WHERE link.scope_key = ? AND meeting.lifecycle <> 'deleted'
       ORDER BY tag.normalized_name, tag.id, recorded_at_ms DESC, meeting.id`,
      scopeKey,
    );
    const summaryTopicRows = options.includeSummaryTopics === true
      ? await database.getAllAsync<MeetingSummaryTopicAggregationRow>(
        `SELECT meeting.id AS meeting_id, meeting.legacy_source_id,
           meeting.title AS meeting_title,
           COALESCE(meeting.recorded_at_ms, meeting.started_at_ms, meeting.created_at_ms)
             AS recorded_at_ms,
           SUBSTR(COALESCE(section.user_text, section.generated_text), 1, 8000) AS content
         FROM summary_sections section
         INNER JOIN summary_versions version ON version.id = section.version_id
         INNER JOIN meeting_notes meeting
           ON meeting.id = version.meeting_id
             AND meeting.current_summary_version_id = version.id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND version.status IN ('ready', 'stale')
           AND LOWER(REPLACE(section.kind, '-', '_')) = 'topics'
           AND TRIM(COALESCE(section.user_text, section.generated_text)) <> ''
         ORDER BY recorded_at_ms DESC, meeting.id, section.ordinal, section.id`,
        scopeKey,
      )
      : [];

    type MutableMeeting = MeetingOrganizationMeeting;
    type MutablePerson = {
      key: string;
      profileId: string | null;
      labels: Map<string, number>;
      meetings: Map<string, MutableMeeting>;
    };
    const peopleByKey = new Map<string, MutablePerson>();
    for (const row of personRows) {
      const profileId = row.speaker_profile_id?.trim() || null;
      const name = namedSpeakerIdentityLabel(row.speaker_label_override)
        ?? namedSpeakerIdentityLabel(row.speaker_label);
      if (!profileId && !name) continue;
      if (!Number.isSafeInteger(row.occurrence_count) || row.occurrence_count < 1) {
        throw new Error('stored meeting person occurrence count is invalid');
      }
      const key = profileId ? `profile:${profileId}` : `name:${name}`;
      const aggregate = peopleByKey.get(key) ?? {
        key,
        profileId,
        labels: new Map<string, number>(),
        meetings: new Map<string, MutableMeeting>(),
      };
      if (name) aggregate.labels.set(name, (aggregate.labels.get(name) ?? 0) + row.occurrence_count);
      const currentMeeting = aggregate.meetings.get(row.meeting_id);
      aggregate.meetings.set(row.meeting_id, {
        meetingId: row.meeting_id,
        navigationMeetingId: meetingNavigationIdentity(row, scopeKey),
        title: row.meeting_title,
        recordedAtMs: row.recorded_at_ms,
        occurrenceCount: (currentMeeting?.occurrenceCount ?? 0) + row.occurrence_count,
      });
      peopleByKey.set(key, aggregate);
    }

    const people = [...peopleByKey.values()].flatMap<MeetingPersonAggregate>(aggregate => {
      const selectedName = [...aggregate.labels.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
      // A stable profile may still arrive with only an anonymous cluster label.
      // It remains hidden until a human-readable name exists instead of exposing
      // an opaque profile ID or inventing a person title.
      if (!selectedName) return [];
      const meetings = [...aggregate.meetings.values()]
        .sort((left, right) => right.recordedAtMs - left.recordedAtMs
          || left.meetingId.localeCompare(right.meetingId));
      return [{
        key: aggregate.key,
        profileId: aggregate.profileId,
        name: selectedName,
        confirmed: aggregate.profileId !== null,
        meetingCount: meetings.length,
        occurrenceCount: meetings.reduce((total, meeting) => total + meeting.occurrenceCount, 0),
        meetings,
      }];
    }).sort((left, right) => right.meetingCount - left.meetingCount
      || right.occurrenceCount - left.occurrenceCount
      || left.name.localeCompare(right.name));

    type MutableTopic = {
      key: string;
      source: MeetingTopicAggregate['source'];
      tagId: string | null;
      name: string;
      meetings: Map<string, MeetingOrganizationMeeting>;
    };
    const topicsById = new Map<string, MutableTopic>();
    for (const row of topicRows) {
      const key = `user-tag:${row.tag_id}`;
      const aggregate = topicsById.get(key) ?? {
        key,
        source: 'user_tag' as const,
        tagId: row.tag_id,
        name: row.tag_name,
        meetings: new Map<string, MeetingOrganizationMeeting>(),
      };
      aggregate.meetings.set(row.meeting_id, {
        meetingId: row.meeting_id,
        navigationMeetingId: meetingNavigationIdentity(row, scopeKey),
        title: row.meeting_title,
        recordedAtMs: row.recorded_at_ms,
        occurrenceCount: 1,
      });
      topicsById.set(key, aggregate);
    }

    type MutableSummaryTopic = MutableTopic & { labels: Map<string, number> };
    const summaryTopicsByName = new Map<string, MutableSummaryTopic>();
    const automaticCountByMeeting = new Map<string, number>();
    for (const row of summaryTopicRows) {
      for (const topic of automaticMeetingTopicsFromSummaryText(row.content)) {
        const meetingTopicCount = automaticCountByMeeting.get(row.meeting_id) ?? 0;
        if (meetingTopicCount >= 12) break;
        const key = `summary:${topic.normalizedName}`;
        const aggregate = summaryTopicsByName.get(key) ?? {
          key,
          source: 'summary' as const,
          tagId: null,
          name: topic.name,
          labels: new Map<string, number>(),
          meetings: new Map<string, MeetingOrganizationMeeting>(),
        };
        if (aggregate.meetings.has(row.meeting_id)) continue;
        aggregate.labels.set(topic.name, (aggregate.labels.get(topic.name) ?? 0) + 1);
        aggregate.meetings.set(row.meeting_id, {
          meetingId: row.meeting_id,
          navigationMeetingId: meetingNavigationIdentity(row, scopeKey),
          title: row.meeting_title,
          recordedAtMs: row.recorded_at_ms,
          occurrenceCount: 1,
        });
        summaryTopicsByName.set(key, aggregate);
        automaticCountByMeeting.set(row.meeting_id, meetingTopicCount + 1);
      }
    }
    for (const aggregate of summaryTopicsByName.values()) {
      aggregate.name = [...aggregate.labels.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
        ?? aggregate.name;
      topicsById.set(aggregate.key, aggregate);
    }
    const topics = [...topicsById.values()].map<MeetingTopicAggregate>(aggregate => {
      const meetings = [...aggregate.meetings.values()]
        .sort((left, right) => right.recordedAtMs - left.recordedAtMs
          || left.meetingId.localeCompare(right.meetingId));
      return {
        key: aggregate.key,
        source: aggregate.source,
        tagId: aggregate.tagId,
        name: aggregate.name,
        meetingCount: meetings.length,
        meetings,
      };
    }).sort((left, right) => right.meetingCount - left.meetingCount
      || (left.source === right.source ? 0 : left.source === 'user_tag' ? -1 : 1)
      || left.name.localeCompare(right.name));

    return { people, topics };
  }

  async createMeetingTag(
    tag: Omit<MeetingTagRecord, 'meetingCount'>,
  ): Promise<MeetingTagRecord> {
    assertScopeKey(tag.scopeKey);
    assertRecordId(tag.id, 'meeting tag ID');
    assertMeetingTagValue(tag.name, tag.normalizedName);
    assertNonNegativeInteger(tag.createdAtMs, 'meeting tag creation time');
    assertNonNegativeInteger(tag.updatedAtMs, 'meeting tag update time');
    if (tag.updatedAtMs < tag.createdAtMs) throw new Error('meeting tag update time is invalid');
    return withMeetingDatabaseTransaction(async database => {
      await database.runAsync(
        `INSERT OR IGNORE INTO meeting_tags (
           id, scope_key, name, normalized_name, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        tag.id,
        tag.scopeKey,
        tag.name,
        tag.normalizedName,
        tag.createdAtMs,
        tag.updatedAtMs,
      );
      const row = await database.getFirstAsync<MeetingTagRow>(
        `SELECT tag.*, COUNT(link.meeting_id) AS meeting_count
         FROM meeting_tags tag
         LEFT JOIN meeting_tag_links link
           ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
         WHERE tag.scope_key = ? AND tag.normalized_name = ?
         GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
           tag.created_at_ms, tag.updated_at_ms`,
        tag.scopeKey,
        tag.normalizedName,
      );
      if (!row) throw new Error('meeting tag was not created');
      return meetingTagFromRow(row);
    });
  }

  async renameOrMergeMeetingTag(
    tagId: string,
    scopeKey: ScopeKey,
    name: string,
    normalizedName: string,
    updatedAtMs: number,
  ): Promise<RenameMeetingTagResult> {
    assertScopeKey(scopeKey);
    assertRecordId(tagId, 'meeting tag ID');
    assertMeetingTagValue(name, normalizedName);
    assertNonNegativeInteger(updatedAtMs, 'meeting tag update time');
    let affectedMeetingIds: readonly string[] = [];
    const result = await withMeetingDatabaseTransaction(async database => {
      const source = await database.getFirstAsync<MeetingTagRow>(
        `SELECT tag.*, COUNT(link.meeting_id) AS meeting_count
         FROM meeting_tags tag
         LEFT JOIN meeting_tag_links link
           ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
         WHERE tag.id = ? AND tag.scope_key = ?
         GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
           tag.created_at_ms, tag.updated_at_ms`,
        tagId,
        scopeKey,
      );
      if (!source) throw new Error('meeting tag does not exist');
      const linked = await database.getAllAsync<{ meeting_id: string }>(
        `SELECT meeting_id FROM meeting_tag_links
         WHERE tag_id = ? AND scope_key = ? ORDER BY meeting_id`,
        tagId,
        scopeKey,
      );
      affectedMeetingIds = linked.map(row => row.meeting_id);
      const target = await database.getFirstAsync<MeetingTagRow>(
        `SELECT tag.*, COUNT(link.meeting_id) AS meeting_count
         FROM meeting_tags tag
         LEFT JOIN meeting_tag_links link
           ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
         WHERE tag.scope_key = ? AND tag.normalized_name = ?
         GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
           tag.created_at_ms, tag.updated_at_ms`,
        scopeKey,
        normalizedName,
      );
      const merged = Boolean(target && target.id !== tagId);
      const targetId = merged ? target!.id : tagId;
      if (merged) {
        await database.runAsync(
          `INSERT OR IGNORE INTO meeting_tag_links (meeting_id, tag_id, scope_key, created_at_ms)
           SELECT meeting_id, ?, scope_key, MIN(created_at_ms, ?)
           FROM meeting_tag_links WHERE tag_id = ? AND scope_key = ?`,
          targetId,
          updatedAtMs,
          tagId,
          scopeKey,
        );
        await database.runAsync(
          'DELETE FROM meeting_tags WHERE id = ? AND scope_key = ?',
          tagId,
          scopeKey,
        );
      } else {
        await database.runAsync(
          `UPDATE meeting_tags SET name = ?, normalized_name = ?, updated_at_ms = ?
           WHERE id = ? AND scope_key = ?`,
          name,
          normalizedName,
          Math.max(updatedAtMs, source.updated_at_ms),
          tagId,
          scopeKey,
        );
      }
      const row = await database.getFirstAsync<MeetingTagRow>(
        `SELECT tag.*, COUNT(link.meeting_id) AS meeting_count
         FROM meeting_tags tag
         LEFT JOIN meeting_tag_links link
           ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
         WHERE tag.id = ? AND tag.scope_key = ?
         GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
           tag.created_at_ms, tag.updated_at_ms`,
        targetId,
        scopeKey,
      );
      if (!row) throw new Error('meeting tag rename did not persist');
      return { tag: meetingTagFromRow(row), merged, affectedMeetingIds };
    });
    if (affectedMeetingIds.length > 0) this.notify(affectedMeetingIds);
    return result;
  }

  async deleteMeetingTag(tagId: string, scopeKey: ScopeKey): Promise<readonly string[]> {
    assertScopeKey(scopeKey);
    assertRecordId(tagId, 'meeting tag ID');
    const affected = await withMeetingDatabaseTransaction(async database => {
      const rows = await database.getAllAsync<{ meeting_id: string }>(
        `SELECT meeting_id FROM meeting_tag_links
         WHERE tag_id = ? AND scope_key = ? ORDER BY meeting_id`,
        tagId,
        scopeKey,
      );
      const deleted = await database.runAsync(
        'DELETE FROM meeting_tags WHERE id = ? AND scope_key = ?',
        tagId,
        scopeKey,
      );
      if (deleted.changes !== 1) throw new Error('meeting tag does not exist');
      return rows.map(row => row.meeting_id);
    });
    if (affected.length > 0) this.notify(affected);
    return affected;
  }

  async replaceMeetingTags(
    meetingId: string,
    scopeKey: ScopeKey,
    tagIds: readonly string[],
    updatedAtMs: number,
  ): Promise<readonly MeetingTagRecord[]> {
    assertScopeKey(scopeKey);
    assertRecordId(meetingId, 'meeting ID');
    assertNonNegativeInteger(updatedAtMs, 'meeting tag assignment time');
    const uniqueTagIds = [...new Set(tagIds.map(value => value.trim()).filter(Boolean))];
    if (uniqueTagIds.length > 20) throw new Error('meeting tag assignment limit was exceeded');
    uniqueTagIds.forEach(id => assertRecordId(id, 'meeting tag ID'));
    const tags = await withMeetingDatabaseTransaction(async database => {
      const meeting = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM meeting_notes
         WHERE id = ? AND scope_key = ? AND lifecycle <> 'deleted'`,
        meetingId,
        scopeKey,
      );
      if (!meeting) throw new Error('meeting does not exist');
      let selected: MeetingTagRow[] = [];
      if (uniqueTagIds.length > 0) {
        const placeholders = uniqueTagIds.map(() => '?').join(',');
        selected = await database.getAllAsync<MeetingTagRow>(
          `SELECT tag.*, COUNT(link.meeting_id) AS meeting_count
           FROM meeting_tags tag
           LEFT JOIN meeting_tag_links link
             ON link.tag_id = tag.id AND link.scope_key = tag.scope_key
           WHERE tag.scope_key = ? AND tag.id IN (${placeholders})
           GROUP BY tag.id, tag.scope_key, tag.name, tag.normalized_name,
             tag.created_at_ms, tag.updated_at_ms`,
          scopeKey,
          ...uniqueTagIds,
        );
        if (selected.length !== uniqueTagIds.length) throw new Error('meeting tag selection is invalid');
      }
      await database.runAsync(
        'DELETE FROM meeting_tag_links WHERE meeting_id = ? AND scope_key = ?',
        meetingId,
        scopeKey,
      );
      for (const tagId of uniqueTagIds) {
        await database.runAsync(
          `INSERT INTO meeting_tag_links (meeting_id, tag_id, scope_key, created_at_ms)
           VALUES (?, ?, ?, ?)`,
          meetingId,
          tagId,
          scopeKey,
          updatedAtMs,
        );
      }
      return selected
        .map(meetingTagFromRow)
        .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
    });
    this.notify([meetingId]);
    return tags;
  }

  async searchMeetingContent(
    scopeKey: ScopeKey,
    query: string,
    limit = 60,
  ): Promise<readonly MeetingSearchResult[]> {
    assertScopeKey(scopeKey);
    const predicate = meetingSearchPredicate(query);
    if (!predicate) return [];
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 60;
    while (this.indexedSearchScopes.get(scopeKey) !== this.searchIndexGeneration) {
      const generationAtStart = this.searchIndexGeneration;
      await withMeetingDatabaseTransaction(async database => {
        await database.runAsync(
          'DELETE FROM meeting_search_documents_v45 WHERE scope_key = ?',
          scopeKey,
        );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'title', meeting.id, '-1',
           meeting.title, meeting.title
         FROM meeting_notes meeting
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted' AND TRIM(meeting.title) <> ''`,
        scopeKey,
      );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'manual_note', note.meeting_id, '-1',
           meeting.title, note.content
         FROM manual_notes note
         INNER JOIN meeting_notes meeting ON meeting.id = note.meeting_id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND TRIM(note.content) <> ''`,
        scopeKey,
      );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'transcript',
           COALESCE(NULLIF(segment.source_segment_id, ''), segment.id),
           CAST(segment.start_ms AS TEXT), meeting.title, segment.text
         FROM transcript_segments segment
         INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
         INNER JOIN meeting_notes meeting ON meeting.id = revision.meeting_id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND revision.is_active = 1 AND TRIM(segment.text) <> ''`,
        scopeKey,
      );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'summary', section.id, '-1',
           meeting.title,
           TRIM(COALESCE(section.title, '') || ' ' ||
             COALESCE(NULLIF(section.user_text, ''), section.generated_text))
         FROM summary_sections section
         INNER JOIN summary_versions version ON version.id = section.version_id
         INNER JOIN meeting_notes meeting
           ON meeting.id = version.meeting_id
             AND meeting.current_summary_version_id = version.id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND TRIM(COALESCE(NULLIF(section.user_text, ''), section.generated_text)) <> ''`,
        scopeKey,
      );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'action', action.id,
           CAST(COALESCE(action.source_start_ms, -1) AS TEXT), meeting.title, action.content
         FROM action_items action
         INNER JOIN meeting_notes meeting ON meeting.id = action.meeting_id
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
           AND action.status <> 'dismissed'
           AND ${CURRENT_MEETING_ACTION_VISIBILITY_SQL}
           AND TRIM(action.content) <> ''`,
        scopeKey,
      );
      await database.runAsync(
        `INSERT INTO meeting_search_documents_v45 (
           scope_key, meeting_id, source_kind, source_id, start_ms, title, content
         )
         SELECT meeting.scope_key, meeting.id, 'tag', tag.id, '-1', meeting.title, tag.name
         FROM meeting_tag_links link
         INNER JOIN meeting_tags tag
           ON tag.id = link.tag_id AND tag.scope_key = link.scope_key
         INNER JOIN meeting_notes meeting
           ON meeting.id = link.meeting_id AND meeting.scope_key = link.scope_key
         WHERE meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'`,
        scopeKey,
      );
      });
      // A mutation can commit while the rebuild transaction is yielding. Do
      // not publish a snapshot that predates that mutation; the next loop
      // iteration rebuilds against the newer generation.
      if (generationAtStart === this.searchIndexGeneration) {
        this.indexedSearchScopes.set(scopeKey, generationAtStart);
      }
    }
    const database = await openMeetingDatabase();
    const filter = meetingSearchFilterSql(predicate.filters);
    const predicateSql = predicate.kind === 'match'
      ? 'meeting_search_fts_v45 MATCH ?'
      : predicate.kind === 'like'
        ? predicate.patterns.map(() => "search.content LIKE ? ESCAPE '\\'").join(' AND ')
        : '1 = 1';
    const predicateArguments = predicate.kind === 'match'
      ? [predicate.query]
      : predicate.kind === 'like' ? [...predicate.patterns] : [];
    const firstTerm = predicate.terms[0];
    const snippetSql = predicate.kind === 'match'
      ? "snippet(meeting_search_fts_v45, 1, '', '', '…', 24)"
      : predicate.kind === 'like'
        ? `CASE
           WHEN instr(lower(search.content), lower(?)) > 81 THEN
             '…' || substr(
               search.content,
               instr(lower(search.content), lower(?)) - 80,
               240
             )
           ELSE substr(search.content, 1, 240)
         END`
        : 'substr(search.content, 1, 240)';
    const rankSql = predicate.kind === 'match'
      ? 'bm25(meeting_search_fts_v45, 0.0, 1.0)'
      : '0.0';
    const snippetArguments = predicate.kind === 'like' ? [firstTerm, firstTerm] : [];
    const rows = await database.getAllAsync<MeetingSearchRow>(
      `SELECT search.meeting_id, meeting.legacy_source_id,
           search.source_kind, search.source_id, search.start_ms,
           meeting.title AS meeting_title,
           COALESCE(meeting.recorded_at_ms, meeting.started_at_ms, meeting.created_at_ms)
             AS recorded_at_ms,
           ${snippetSql} AS snippet,
           ${rankSql} AS rank
         FROM meeting_search_fts_v45 search_fts
         INNER JOIN meeting_search_documents_v45 search
           ON search.document_id = search_fts.rowid
         INNER JOIN meeting_notes meeting ON meeting.id = search.meeting_id
         WHERE ${predicateSql} AND ${filter.sql}
           AND search.scope_key = ?
           AND meeting.scope_key = ? AND meeting.lifecycle <> 'deleted'
         ORDER BY CASE search.source_kind
           WHEN 'title' THEN 0 WHEN 'tag' THEN 1 WHEN 'manual_note' THEN 2
           WHEN 'transcript' THEN 3 WHEN 'summary' THEN 4 ELSE 5 END,
           rank, meeting.updated_at_ms DESC, search.meeting_id, search.source_id
         LIMIT ?`,
        ...snippetArguments,
        ...predicateArguments,
        ...filter.arguments,
        scopeKey,
        scopeKey,
      safeLimit,
    );
    return rows.map(row => meetingSearchResultFromRow(row, scopeKey));
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
         AND ${CURRENT_MEETING_ACTION_VISIBILITY_SQL}
       ORDER BY CASE action.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
         CASE WHEN action.due_at_ms IS NULL THEN 1 ELSE 0 END,
         action.due_at_ms, action.created_at_ms, action.id`,
      meetingId,
      scopeKey,
    );
    return rows.map(actionItemFromRow);
  }

  async purgeDeletedGuestMeeting(
    meetingId: string,
    purgedAtMs: number,
    options: { allowRecoverable?: boolean } = {},
  ): Promise<boolean> {
    assertRecordId(meetingId, 'guest meeting purge ID');
    assertNonNegativeInteger(purgedAtMs, 'guest meeting purge time');
    const allowRecoverable = options.allowRecoverable === true;
    let purged = false;
    await withMeetingDatabaseTransaction(async database => {
      const candidate = await database.getFirstAsync<MeetingRow>(
        `SELECT * FROM meeting_notes
         WHERE id = ? AND scope_key = 'guest'`,
        meetingId,
      );
      if (!candidate) return;
      if (
        candidate.lifecycle !== 'deleted'
        || candidate.deleted_at_ms === null
        || (!allowRecoverable && candidate.deleted_from_lifecycle !== null)
      ) {
        throw new Error('guest meeting purge target is not a recoverable tombstone');
      }
      // Detached occurrence history predates the local-only owner but still
      // has a restrictive foreign key, so remove its rows before the root.
      await database.runAsync(
        `DELETE FROM meeting_recording_merge_tasks
         WHERE scope_key = 'guest' AND (source_meeting_id = ? OR target_meeting_id = ?)`,
        meetingId,
        meetingId,
      );
      await database.runAsync(
        `DELETE FROM meeting_occurrence_detached_history
         WHERE scope_key = 'guest' AND (local_meeting_id = ? OR remote_meeting_id = ?)`,
        meetingId,
        meetingId,
      );
      await database.runAsync(
        `DELETE FROM meeting_retention_cleanup_jobs
         WHERE scope_key = 'guest' AND canonical_meeting_id = ?`,
        meetingId,
      );
      await database.runAsync(
        `DELETE FROM meeting_search_documents_v45
         WHERE scope_key = 'guest' AND meeting_id = ?`,
        meetingId,
      );
      await database.runAsync(
        'DELETE FROM meeting_series_carry_imports WHERE source_meeting_id = ?',
        meetingId,
      );

      const deleted = await database.runAsync(
        `DELETE FROM meeting_notes
         WHERE id = ? AND scope_key = 'guest'
           AND lifecycle = 'deleted'
           AND deleted_at_ms IS NOT NULL
           AND (? = 1 OR deleted_from_lifecycle IS NULL)`,
        meetingId,
        allowRecoverable ? 1 : 0,
      );
      if (deleted.changes !== 1) {
        throw new Error('guest meeting purge target changed concurrently');
      }
      const transaction = new SqliteMeetingTransaction(database);
      await transaction.advanceCanonicalWrite(
        'guest',
        Math.max(purgedAtMs, candidate.updated_at_ms, candidate.deleted_at_ms),
      );
      purged = true;
    });
    if (purged) this.notify([meetingId]);
    return purged;
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
    if (query.onlyDeleted) {
      conditions.push("meeting.lifecycle = 'deleted'");
    } else if (!query.includeDeleted) {
      conditions.push("meeting.lifecycle != 'deleted'");
    }
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
         ) THEN 1 ELSE 0 END AS current_summary_ready,
         (SELECT SUBSTR(TRIM(COALESCE(section.user_text, section.generated_text)), 1, 220)
            FROM summary_versions version
            INNER JOIN summary_sections section ON section.version_id = version.id
           WHERE version.id = meeting.current_summary_version_id
             AND version.meeting_id = meeting.id
             AND version.status IN ('ready', 'stale')
             AND section.kind != 'action_items'
             AND LENGTH(TRIM(COALESCE(section.user_text, section.generated_text))) > 0
           ORDER BY CASE WHEN section.stable_key = 'overview' THEN 0 ELSE 1 END,
                    section.ordinal, section.id
           LIMIT 1) AS current_summary_preview
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
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      deletedAtMs: row.deleted_at_ms,
      deletedFromLifecycle: row.deleted_from_lifecycle,
      currentSummaryVersionId: row.current_summary_version_id,
      activeTranscriptSegmentCount: Number(row.active_transcript_segment_count ?? 0),
      currentSummaryReady: row.current_summary_ready === 1,
      currentSummaryPreview: row.current_summary_preview?.trim() || null,
      primaryRecording: primaryRecordingByMeeting.get(row.id) ?? null,
      stages: stagesByMeeting.get(row.id) ?? [],
    }));
    return { items, hasMore: rows.length > limit };
  }

  async listMeetingDisplayOrder(scopeKey: ScopeKey): Promise<readonly MeetingListOrderEntry[]> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const rows = await database.getAllAsync<{
      meeting_id: string;
      position: number;
      updated_at_ms: number;
    }>(
      `SELECT list_order.meeting_id, list_order.position, list_order.updated_at_ms
       FROM meeting_list_order list_order
       INNER JOIN meeting_notes meeting ON meeting.id = list_order.meeting_id
       WHERE list_order.scope_key = ? AND meeting.scope_key = ?
       ORDER BY list_order.position, list_order.meeting_id`,
      scopeKey,
      scopeKey,
    );
    return rows.map(row => ({
      meetingId: row.meeting_id,
      position: row.position,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  async replaceMeetingDisplayOrder(
    scopeKey: ScopeKey,
    orderedMeetingIds: readonly string[],
    updatedAtMs: number,
  ): Promise<boolean> {
    assertScopeKey(scopeKey);
    assertNonNegativeInteger(updatedAtMs, 'meeting list order update time');
    const normalizedIds = orderedMeetingIds.map(id => {
      assertRecordId(id, 'meeting list order ID');
      return id.trim();
    });
    if (new Set(normalizedIds).size !== normalizedIds.length) {
      throw new Error('meeting list order contains duplicate meetings');
    }
    const applied = await withMeetingDatabaseTransaction(async database => {
      const activeRows = await database.getAllAsync<{ id: string }>(
        `SELECT id FROM meeting_notes
         WHERE scope_key = ?
           AND (lifecycle != 'deleted' OR sync_state = 'conflicted')`,
        scopeKey,
      );
      const activeIds = activeRows.map(row => row.id);
      if (
        activeIds.length !== normalizedIds.length
        || activeIds.some(id => !normalizedIds.includes(id))
      ) return false;
      await database.runAsync(
        `DELETE FROM meeting_list_order WHERE scope_key = ?`,
        scopeKey,
      );
      for (let position = 0; position < normalizedIds.length; position += 1) {
        await database.runAsync(
          `INSERT INTO meeting_list_order(scope_key, meeting_id, position, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope_key, meeting_id) DO UPDATE SET
             position = excluded.position,
             updated_at_ms = excluded.updated_at_ms`,
          scopeKey,
          normalizedIds[position],
          position,
          updatedAtMs,
        );
      }
      return true;
    });
    if (applied && normalizedIds.length > 0) this.notify(normalizedIds);
    return applied;
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
           AND ${SUMMARY_VERSION_ACTION_VISIBILITY_SQL}
         ORDER BY CASE action.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
           CASE WHEN action.due_at_ms IS NULL THEN 1 ELSE 0 END,
           action.due_at_ms, action.created_at_ms, action.id`,
        version.meeting_id,
        scopeKey,
        version.id,
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
    this.searchIndexGeneration += 1;
    this.indexedSearchScopes.clear();
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
