import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  MeetingNote,
  ProcessingStage,
  ScheduleSnapshot,
  ScopeKey,
} from '../../domain/meeting';
import { assertProcessingStage, assertScopeKey } from '../../domain/meeting';
import { withMeetingDatabaseTransaction, openMeetingDatabase } from '../db/openDatabase';
import type {
  ActionItemRecord,
  ManualNoteRecord,
  MeetingListProjection,
  MeetingListProjectionItem,
  MeetingListQuery,
  MeetingNoteAggregate,
  MeetingNoteRepository,
  MeetingRootPatch,
  MeetingScopeWriteState,
  MeetingTransaction,
  NewMeetingNote,
  OccurrenceLinkRecord,
  RecordingAssetRecord,
  SaveSummaryVersionOptions,
  SaveTranscriptRevisionOptions,
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

type ActionItemRow = {
  id: string;
  meeting_id: string;
  remote_id: string | null;
  content: string;
  status: ActionItemRecord['status'];
  assignee_text: string | null;
  due_at_ms: number | null;
  source_kind: ActionItemRecord['sourceKind'];
  source_summary_version_id: string | null;
  source_segment_id: string | null;
  source_start_ms: number | null;
  generation_fingerprint: string | null;
  user_edited_at_ms: number | null;
  completed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type OccurrenceRow = {
  calendar_source_event_id: string;
  occurrence_date: string;
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
      AND ownership_action.user_edited_at_ms IS NOT NULL
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

function actionItemFromRow(row: ActionItemRow): ActionItemRecord {
  actionStatus(row.status);
  if (row.source_kind !== 'generated' && row.source_kind !== 'manual' && row.source_kind !== 'marker') {
    throw new Error('stored meeting action source is invalid');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    remoteId: row.remote_id,
    content: row.content,
    status: row.status,
    assigneeText: row.assignee_text,
    dueAtMs: row.due_at_ms,
    sourceKind: row.source_kind,
    sourceSummaryVersionId: row.source_summary_version_id,
    sourceSegmentId: row.source_segment_id,
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
         AND link.link_state = 'active'
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
           series_key = ?, link_state = 'active', linked_at_ms = ?
         WHERE meeting_id = ? AND scope_key = ?`,
        link.meetingId,
        link.calendarRevision,
        link.recurrenceSegmentId,
        link.seriesKey,
        link.linkedAtMs,
        existing.meeting_id,
        link.scopeKey,
      );
      if (rebound.changes !== 1) throw new Error('calendar occurrence changed during binding');
    } else {
      await this.database.runAsync(
        `INSERT INTO meeting_occurrence_links (
           meeting_id, scope_key, calendar_source_event_id, occurrence_date,
           calendar_revision, recurrence_segment_id, series_key, link_state, linked_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        link.meetingId,
        link.scopeKey,
        link.sourceEventId,
        link.occurrenceDate,
        link.calendarRevision,
        link.recurrenceSegmentId,
        link.seriesKey,
        link.linkedAtMs,
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
      segmentIds.add(segment.id);
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
           id, meeting_id, kind, status, source_provider, source_model,
           is_active, created_at_ms, finalized_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision.id,
        revision.meetingId,
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
           status = ?, source_provider = ?, source_model = ?, is_active = ?, finalized_at_ms = ?
         WHERE id = ?`,
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
             id, revision_id, meeting_id, ordinal, start_ms, end_ms,
             speaker_cluster_id, speaker_profile_id, speaker_label,
             speaker_label_override, text, normalized_text, confidence,
             is_final, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          segment.id,
          revision.id,
          segment.meetingId,
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
    this.touchedMeetingIds.add(revision.meetingId);
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
        const source = await this.database.getFirstAsync<{ meeting_id: string }>(
          `SELECT segment.meeting_id FROM transcript_segments segment
           INNER JOIN meeting_notes meeting ON meeting.id = segment.meeting_id
           WHERE segment.id = ? AND meeting.scope_key = ?`,
          action.sourceSegmentId,
          scopeKey,
        );
        if (!source || source.meeting_id !== version.meetingId) {
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
    const result = await withMeetingDatabaseTransaction(async database => {
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
         AND link.link_state = 'active'
       LIMIT 1`,
      scopeKey,
      scopeKey,
      reference.sourceEventId,
      reference.occurrenceDate,
    );
    if (!noteRow) return null;
    return this.aggregateFromRow(database, noteRow, scopeKey);
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
    const [sectionRows, actionRows] = await Promise.all([
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
      database.getAllAsync<ActionItemRow>(
        `SELECT action.* FROM action_items action
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
