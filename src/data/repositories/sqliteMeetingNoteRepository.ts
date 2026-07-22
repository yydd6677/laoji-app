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
  ManualNoteRecord,
  MeetingListProjection,
  MeetingListProjectionItem,
  MeetingListQuery,
  MeetingNoteAggregate,
  MeetingNoteRepository,
  MeetingRootPatch,
  MeetingTransaction,
  NewMeetingNote,
  OccurrenceLinkRecord,
  RecordingAssetRecord,
  SyncOperationRecord,
  TranscriptSegmentRecord,
  Unsubscribe,
} from './meetingNoteRepository';

type MeetingRow = {
  id: string;
  scope_key: string;
  remote_id: string | null;
  origin: MeetingNote['origin'];
  entry_point: MeetingNote['entryPoint'];
  title: string;
  lifecycle: MeetingNote['lifecycle'];
  started_at_ms: number | null;
  ended_at_ms: number | null;
  current_summary_version_id: string | null;
  remote_revision: number | null;
  sync_state: MeetingNote['syncState'];
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
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

function noteFromRow(row: MeetingRow): MeetingNote {
  assertScopeKey(row.scope_key);
  return {
    id: row.id,
    scopeKey: row.scope_key,
    remoteId: row.remote_id,
    origin: row.origin,
    entryPoint: row.entry_point,
    title: row.title,
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

  private async assertMeetingInScope(meetingId: string, scopeKey: ScopeKey): Promise<void> {
    if (!await this.getMeeting(meetingId, scopeKey)) {
      throw new Error('meeting does not exist in active scope');
    }
  }

  async insertMeeting(note: NewMeetingNote): Promise<void> {
    assertScopeKey(note.scopeKey);
    await this.database.runAsync(
      `INSERT INTO meeting_notes (
         id, scope_key, remote_id, legacy_source_id, origin, entry_point, title, lifecycle,
         started_at_ms, ended_at_ms, current_summary_version_id, remote_revision,
         sync_state, created_at_ms, updated_at_ms, deleted_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      note.id,
      note.scopeKey,
      note.remoteId ?? null,
      note.legacySourceId ?? null,
      note.origin,
      note.entryPoint,
      note.title,
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

  async appendTranscriptSegments(
    revisionId: string,
    segments: readonly TranscriptSegmentRecord[],
  ): Promise<void> {
    for (const segment of segments) {
      await this.database.runAsync(
        `INSERT INTO transcript_segments (
           id, revision_id, meeting_id, ordinal, start_ms, end_ms,
           speaker_cluster_id, speaker_profile_id, speaker_label,
           speaker_label_override, text, normalized_text, confidence,
           is_final, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        segment.id,
        revisionId,
        segment.meetingId,
        segment.ordinal,
        segment.startMs,
        segment.endMs,
        segment.speakerClusterId,
        segment.speakerProfileId,
        segment.speakerLabel,
        segment.text,
        segment.normalizedText,
        segment.confidence,
        segment.isFinal ? 1 : 0,
        segment.createdAtMs,
      );
      this.touchedMeetingIds.add(segment.meetingId);
    }
  }

  async insertOutbox(operation: SyncOperationRecord): Promise<void> {
    assertScopeKey(operation.scopeKey);
    await this.database.runAsync(
      `INSERT INTO sync_outbox (
         operation_id, scope_key, aggregate_type, aggregate_id, operation_type,
         base_revision, payload_json, status, attempt_count, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      operation.operationId,
      operation.scopeKey,
      operation.aggregateType,
      operation.aggregateId,
      operation.operationType,
      operation.baseRevision,
      operation.payloadJson,
      operation.createdAtMs,
      operation.createdAtMs,
    );
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
    this.notify(touchedMeetingIds);
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

  async listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection> {
    assertScopeKey(scopeKey);
    const database = await openMeetingDatabase();
    const requestedLimit = Math.trunc(query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, requestedLimit))
      : 50;
    const conditions = ['scope_key = ?'];
    const params: Array<string | number> = [scopeKey];
    if (!query.includeDeleted) conditions.push("lifecycle != 'deleted'");
    if (query.before) {
      conditions.push('(updated_at_ms < ? OR (updated_at_ms = ? AND id < ?))');
      params.push(query.before.updatedAtMs, query.before.updatedAtMs, query.before.id);
    }
    params.push(limit + 1);
    const rows = await database.getAllAsync<MeetingRow>(
      `SELECT * FROM meeting_notes
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at_ms DESC, id DESC
       LIMIT ?`,
      params,
    );
    const visibleRows = rows.slice(0, limit);
    const ids = visibleRows.map(row => row.id);
    const stagesByMeeting = new Map<string, ProcessingStage[]>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const stageRows = await database.getAllAsync<StageRow>(
        `SELECT stage.* FROM processing_stages stage
         INNER JOIN meeting_notes meeting ON meeting.id = stage.meeting_id
         WHERE meeting.scope_key = ? AND stage.meeting_id IN (${placeholders})
         ORDER BY stage.meeting_id, stage.stage`,
        [scopeKey, ...ids],
      );
      stageRows.forEach(row => {
        const stages = stagesByMeeting.get(row.meeting_id) ?? [];
        stages.push(stageFromRow(row));
        stagesByMeeting.set(row.meeting_id, stages);
      });
    }
    const items: MeetingListProjectionItem[] = visibleRows.map(row => ({
      id: row.id,
      remoteId: row.remote_id,
      origin: row.origin,
      title: row.title,
      lifecycle: row.lifecycle,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
      currentSummaryVersionId: row.current_summary_version_id,
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
