import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Meeting, MeetingSummary, TranscriptLine } from '../../types';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import type { PendingMeetingAudioUpload } from '../../services/meetingRecording';
import type { PendingMeetingSummaryTask } from '../../services/meetingSummaryTasks';
import { meetingSummaryToText } from '../../services/meetingSummaryFormat';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from './openDatabase';

const LEGACY_SOURCE_VERSION = 'async-storage-meeting-v2-shadow-v5';
const PROCESSING_STAGES = ['capture', 'upload', 'transcript', 'summary', 'speaker'] as const;

export interface LegacyMeetingShadowSource {
  scopeKey: ScopeKey;
  meetings: readonly Meeting[];
  transcripts: Readonly<Record<string, readonly TranscriptLine[]>>;
  summaries: Readonly<Record<string, MeetingSummary | null>>;
  pendingAudioUploads: readonly PendingMeetingAudioUpload[];
  pendingSummaryTasks: readonly PendingMeetingSummaryTask[];
}

export interface LegacyMeetingImportCounts {
  meetingNotes: number;
  manualNotes: number;
  processingStages: number;
  recordingAssets: number;
  transcriptRevisions: number;
  transcriptSegments: number;
  summaryVersions: number;
  summarySections: number;
  actionItems: number;
}

export interface LegacyMeetingShadowReport {
  scopeKey: ScopeKey;
  sourceHash: string;
  counts: LegacyMeetingImportCounts;
  skipped: boolean;
}

type PreparedMeeting = {
  legacyId: string;
  localId: string;
  meeting: Meeting;
  pendingAudio: PendingMeetingAudioUpload | null;
  pendingSummaryTask: PendingMeetingSummaryTask | null;
  transcript: readonly TranscriptLine[];
  summary: MeetingSummary | null;
  summaryText: string;
  summaryFingerprint: string | null;
  actionFingerprints: readonly string[];
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

function encodedPart(value: string): string {
  return encodeURIComponent(value);
}

function legacyMeetingId(scopeKey: ScopeKey, meetingId: string): string {
  return `legacy:${encodedPart(scopeKey)}:${encodedPart(meetingId)}`;
}

function timestamp(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function timeMs(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(Number(value) * 1000));
}

function normalizeTranscriptText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function lifecycleFor(meeting: Meeting): 'draft' | 'active' | 'ended' | 'deleted' {
  const status = meeting.status?.toLowerCase();
  if (status === 'deleted') return 'deleted';
  if (status === 'recording' || status === 'paused' || status === 'processing') return 'active';
  if (['completed', 'ended', 'done', 'processed', 'failed'].includes(status ?? '')) return 'ended';
  return 'draft';
}

function captureStatus(meeting: Meeting): string {
  const status = meeting.status?.toLowerCase();
  if (status === 'recording') return 'recording';
  if (status === 'paused') return 'paused';
  if (status === 'failed') return 'failed_recoverable';
  if (meeting.audioLocalUri || meeting.audioAvailable || lifecycleFor(meeting) === 'ended') return 'local_ready';
  return 'not_started';
}

function uploadStatus(
  scopeKey: ScopeKey,
  meeting: Meeting,
  pending: PendingMeetingAudioUpload | null,
): string {
  if (scopeKey === 'guest') return 'not_required';
  if (pending?.uploadState === 'blocked') return 'blocked';
  if (pending) return 'queued';
  if (meeting.audioAvailable && !meeting.audioSyncPending) return 'uploaded';
  if (meeting.audioLocalUri || meeting.audioSyncPending) return 'queued';
  return 'not_required';
}

function summaryStatus(
  summary: MeetingSummary | null,
  summaryText: string,
  task: PendingMeetingSummaryTask | null,
): string {
  if (summary) return summaryText ? 'ready' : 'failed_retryable';
  if (task) return 'generating';
  return 'none';
}

function transcriptStatus(meeting: Meeting, lines: readonly TranscriptLine[]): string {
  if (lines.length > 0) return meeting.status === 'recording' ? 'realtime_draft' : 'ready';
  if (meeting.status === 'processing') return 'finalizing';
  return 'none';
}

function speakerStatus(lines: readonly TranscriptLine[]): string {
  return lines.some(line => Boolean(line.speaker_id || line.speaker_label)) ? 'partial' : 'none';
}

function emptyRecoveredMeeting(id: string, nowMs: number): Meeting {
  const iso = new Date(nowMs).toISOString();
  return {
    id,
    title: '',
    date: '',
    duration: '—',
    tags: [],
    status: 'ended',
    source: 'guest',
    createdAt: iso,
    updatedAt: iso,
  };
}

function actionStatus(value: string | undefined): 'pending' | 'completed' | 'dismissed' {
  const normalized = value?.trim().toLowerCase();
  if (['completed', 'complete', 'done'].includes(normalized ?? '')) return 'completed';
  if (['dismissed', 'cancelled', 'canceled'].includes(normalized ?? '')) return 'dismissed';
  return 'pending';
}

async function prepareSource(source: LegacyMeetingShadowSource, nowMs: number): Promise<PreparedMeeting[]> {
  const meetingById = new Map<string, Meeting>();
  source.meetings.forEach(meeting => {
    const id = typeof meeting?.id === 'string' ? meeting.id.trim() : '';
    if (!id) throw new Error('legacy meeting without ID');
    if (meetingById.has(id)) throw new Error('duplicate legacy meeting ID');
    meetingById.set(id, meeting);
  });

  const referencedIds = new Set<string>(meetingById.keys());
  Object.entries(source.transcripts).forEach(([id, lines]) => {
    if (Array.isArray(lines) && lines.length > 0) referencedIds.add(id);
  });
  Object.entries(source.summaries).forEach(([id, summary]) => {
    if (summary) referencedIds.add(id);
  });
  source.pendingAudioUploads.forEach(item => referencedIds.add(item.meetingId));
  source.pendingSummaryTasks.forEach(item => referencedIds.add(item.meetingId));

  const pendingAudioById = new Map(source.pendingAudioUploads.map(item => [item.meetingId, item]));
  const pendingSummaryById = new Map(source.pendingSummaryTasks.map(item => [item.meetingId, item]));

  return Promise.all([...referencedIds].sort().map(async legacyId => {
    const meeting = meetingById.get(legacyId) ?? emptyRecoveredMeeting(legacyId, nowMs);
    const transcript = Array.isArray(source.transcripts[legacyId]) ? source.transcripts[legacyId] : [];
    const summary = source.summaries[legacyId] ?? null;
    const summaryText = meetingSummaryToText(summary);
    const summaryFingerprint = summary
      ? `sha256:${await sha256(stableJson(summary))}`
      : null;
    const actions = summary?.action_items ?? [];
    const actionFingerprints = await Promise.all(actions.map(action => sha256(stableJson({
      content: action.content.trim(),
      assignee: action.assignee?.trim() ?? null,
      dueDate: action.due_date?.trim() ?? null,
    }))));
    return {
      legacyId,
      localId: legacyMeetingId(source.scopeKey, legacyId),
      meeting,
      pendingAudio: pendingAudioById.get(legacyId) ?? null,
      pendingSummaryTask: pendingSummaryById.get(legacyId) ?? null,
      transcript,
      summary,
      summaryText,
      summaryFingerprint,
      actionFingerprints,
    };
  }));
}

function expectedCounts(prepared: readonly PreparedMeeting[]): LegacyMeetingImportCounts {
  return prepared.reduce<LegacyMeetingImportCounts>((counts, item) => {
    const hasRecording = Boolean(
      item.meeting.audioLocalUri
      || item.meeting.audioAvailable
      || item.pendingAudio?.audioUri,
    );
    const hasTranscript = item.transcript.length > 0;
    const hasSummary = Boolean(item.summary);
    return {
      meetingNotes: counts.meetingNotes + 1,
      manualNotes: counts.manualNotes + 1,
      processingStages: counts.processingStages + PROCESSING_STAGES.length,
      recordingAssets: counts.recordingAssets + (hasRecording ? 1 : 0),
      transcriptRevisions: counts.transcriptRevisions + (hasTranscript ? 1 : 0),
      transcriptSegments: counts.transcriptSegments + item.transcript.length,
      summaryVersions: counts.summaryVersions + (hasSummary ? 1 : 0),
      summarySections: counts.summarySections + (hasSummary ? 1 : 0),
      actionItems: counts.actionItems + (hasSummary ? item.summary?.action_items?.length ?? 0 : 0),
    };
  }, {
    meetingNotes: 0,
    manualNotes: 0,
    processingStages: 0,
    recordingAssets: 0,
    transcriptRevisions: 0,
    transcriptSegments: 0,
    summaryVersions: 0,
    summarySections: 0,
    actionItems: 0,
  });
}

async function countImported(
  scopeKey: ScopeKey,
  database?: SQLiteDatabase,
): Promise<LegacyMeetingImportCounts> {
  const activeDatabase = database ?? await openMeetingDatabase();
  const query = async (table: string): Promise<number> => {
    const scopedDirect = table === 'meeting_notes';
    const row = scopedDirect
      ? await activeDatabase.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) AS count FROM meeting_notes WHERE scope_key = ? AND entry_point = 'legacy_store'",
        scopeKey,
      )
      : await activeDatabase.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} child
         INNER JOIN meeting_notes meeting ON meeting.id = child.meeting_id
         WHERE meeting.scope_key = ? AND meeting.entry_point = 'legacy_store'`,
        scopeKey,
      );
    return Number(row?.count ?? 0);
  };
  return {
    meetingNotes: await query('meeting_notes'),
    manualNotes: await query('manual_notes'),
    processingStages: await query('processing_stages'),
    recordingAssets: await query('recording_assets'),
    transcriptRevisions: await query('transcript_revisions'),
    transcriptSegments: await query('transcript_segments'),
    summaryVersions: await query('summary_versions'),
    summarySections: Number((await activeDatabase.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM summary_sections section
       INNER JOIN summary_versions version ON version.id = section.version_id
       INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
       WHERE meeting.scope_key = ? AND meeting.entry_point = 'legacy_store'`,
      scopeKey,
    ))?.count ?? 0),
    actionItems: await query('action_items'),
  };
}

function countsMatch(left: LegacyMeetingImportCounts, right: LegacyMeetingImportCounts): boolean {
  return (Object.keys(left) as Array<keyof LegacyMeetingImportCounts>)
    .every(key => left[key] === right[key]);
}

function migrationId(scopeKey: ScopeKey): string {
  return `legacy-shadow-v4:${encodedPart(scopeKey)}`;
}

async function insertPreparedMeeting(
  database: SQLiteDatabase,
  scopeKey: ScopeKey,
  item: PreparedMeeting,
  nowMs: number,
): Promise<void> {
  const { meeting, localId, pendingAudio, pendingSummaryTask, transcript, summary } = item;
  const createdAtMs = timestamp(meeting.createdAt, nowMs);
  const updatedAtMs = timestamp(meeting.updatedAt, createdAtMs);
  const lifecycle = lifecycleFor(meeting);
  const remoteId = meeting.source === 'cloud' ? item.legacyId : null;
  const syncState = meeting.source === 'cloud' ? 'synced' : 'local';
  const summaryId = summary ? `${localId}:summary:legacy` : null;
  const activeSummaryId = summaryId && item.summaryText ? summaryId : null;
  const transcriptRevisionId = transcript.length > 0 ? `${localId}:transcript:legacy` : null;

  await database.runAsync(
    `INSERT INTO meeting_notes (
       id, scope_key, remote_id, legacy_source_id, origin, entry_point, title,
       description, participants_json, location, mode, client_request_id, recorded_at_ms, lifecycle,
       started_at_ms, ended_at_ms, current_summary_version_id, remote_revision,
       sync_state, created_at_ms, updated_at_ms, deleted_at_ms
     ) VALUES (?, ?, ?, ?, 'ad_hoc', 'legacy_store', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    localId,
    scopeKey,
    remoteId,
    item.legacyId,
    meeting.title ?? '',
    meeting.description ?? null,
    JSON.stringify((meeting.participants ?? []).map(value => value.trim()).filter(Boolean)),
    meeting.location?.trim() || null,
    meeting.mode ?? null,
    meeting.clientRequestId?.trim() || null,
    createdAtMs,
    lifecycle,
    createdAtMs,
    lifecycle === 'ended' ? updatedAtMs : null,
    activeSummaryId,
    syncState,
    createdAtMs,
    updatedAtMs,
    lifecycle === 'deleted' ? updatedAtMs : null,
  );
  await database.runAsync(
    `INSERT INTO manual_notes (
       meeting_id, content, format, revision, dirty, last_saved_at_ms
     ) VALUES (?, '', 'plain', 0, 0, ?)`,
    localId,
    updatedAtMs,
  );

  const statuses: Record<(typeof PROCESSING_STAGES)[number], string> = {
    capture: captureStatus(meeting),
    upload: uploadStatus(scopeKey, meeting, pendingAudio),
    transcript: transcriptStatus(meeting, transcript),
    summary: summaryStatus(summary, item.summaryText, pendingSummaryTask),
    speaker: speakerStatus(transcript),
  };
  for (const stage of PROCESSING_STAGES) {
    const blocked = stage === 'upload' && statuses[stage] === 'blocked';
    const retryable = statuses[stage] === 'failed_retryable';
    await database.runAsync(
      `INSERT INTO processing_stages (
         meeting_id, stage, status, attempt_count, job_id, input_fingerprint,
         error_code, user_message_key, retryable, next_retry_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      localId,
      stage,
      statuses[stage],
      stage === 'upload' ? pendingAudio?.attemptCount ?? 0 : 0,
      stage === 'summary' ? pendingSummaryTask?.taskId ?? null : null,
      stage === 'summary' ? pendingSummaryTask?.inputFingerprint ?? null : null,
      stage === 'upload' ? pendingAudio?.failureCode ?? null : null,
      blocked
        ? 'meeting.upload.blocked'
        : retryable
          ? `meeting.${stage}.retryable`
          : null,
      retryable ? 1 : 0,
      stage === 'upload' ? timestamp(pendingAudio?.nextAttemptAt, 0) || null : null,
      updatedAtMs,
    );
  }

  const localUri = pendingAudio?.audioUri ?? meeting.audioLocalUri ?? null;
  const legacyRecordingAssetId = localUri || meeting.audioAvailable
    ? `${localId}:recording:primary`
    : null;
  if (localUri || meeting.audioAvailable) {
    const assetCreatedAtMs = timestamp(pendingAudio?.createdAt, createdAtMs);
    await database.runAsync(
      `INSERT INTO recording_assets (
         id, meeting_id, role, origin, native_session_id, local_uri, remote_asset_id, mime_type,
         file_name, duration_ms, waveform_json, local_state, created_at_ms, updated_at_ms,
         last_verified_at_ms
       ) VALUES (?, ?, 'primary', 'captured', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      legacyRecordingAssetId,
      localId,
      item.legacyId,
      localUri,
      pendingAudio?.mimeType ?? 'audio/wav',
      pendingAudio?.fileName ?? `${item.legacyId}.wav`,
      Number.isFinite(meeting.audioDurationSec) ? Math.round(Number(meeting.audioDurationSec) * 1000) : null,
      meeting.audioBars?.length ? JSON.stringify(meeting.audioBars) : null,
      localUri ? 'local_ready' : 'remote_only',
      assetCreatedAtMs,
      updatedAtMs,
      localUri ? updatedAtMs : null,
    );
  }

  if (transcriptRevisionId) {
    const isDraft = meeting.status === 'recording';
    await database.runAsync(
      `INSERT INTO transcript_revisions (
         id, meeting_id, kind, status, source_provider, is_active, created_at_ms, finalized_at_ms
       ) VALUES (?, ?, ?, ?, 'legacy', 1, ?, ?)`,
      transcriptRevisionId,
      localId,
      isDraft ? 'realtime_draft' : 'final',
      isDraft ? 'realtime_draft' : 'ready',
      createdAtMs,
      isDraft ? null : updatedAtMs,
    );
    for (let ordinal = 0; ordinal < transcript.length; ordinal += 1) {
      const line = transcript[ordinal];
      const startMs = timeMs(line.start_time);
      const endMs = Math.max(startMs, timeMs(line.end_time));
      await database.runAsync(
        `INSERT INTO transcript_segments (
           id, revision_id, meeting_id, source_segment_id,
           source_recording_asset_id, source_recording_asset_remote_id,
           source_transcription_job_id, ordinal, start_ms, end_ms,
           speaker_cluster_id, speaker_profile_id, speaker_label, text,
           normalized_text, confidence, is_final, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${transcriptRevisionId}:segment:${ordinal}:${encodedPart(line.id || String(ordinal))}`,
        transcriptRevisionId,
        localId,
        line.id?.trim() || null,
        legacyRecordingAssetId,
        line.recording_asset_id?.trim() || line.recordingAssetRemoteId?.trim() || null,
        line.transcription_job_id?.trim() || line.transcriptionJobId?.trim() || null,
        ordinal,
        startMs,
        endMs,
        line.speaker_id ?? null,
        null,
        line.speaker_label ?? null,
        typeof line.text === 'string' ? line.text : '',
        normalizeTranscriptText(typeof line.text === 'string' ? line.text : ''),
        Number.isFinite(line.confidence) ? Number(line.confidence) : null,
        isDraft ? 0 : 1,
        timestamp(line.created_at, createdAtMs),
      );
    }
  }

  if (summaryId && summary && item.summaryFingerprint) {
    const summaryCreatedAtMs = timestamp(summary.generated_at, updatedAtMs);
    const summaryReady = Boolean(item.summaryText);
    await database.runAsync(
      `INSERT INTO summary_versions (
         id, meeting_id, template_id, template_revision, input_fingerprint,
         transcript_revision_id, manual_note_revision, status, generated_by,
         user_edited, created_at_ms, completed_at_ms
       ) VALUES (?, ?, 'legacy', 1, ?, ?, 0, ?, 'legacy', 0, ?, ?)`,
      summaryId,
      localId,
      item.summaryFingerprint,
      transcriptRevisionId,
      summaryReady ? 'ready' : 'failed',
      summaryCreatedAtMs,
      summaryCreatedAtMs,
    );
    await database.runAsync(
      `INSERT INTO summary_sections (
         id, version_id, stable_key, kind, title, generated_text, ordinal
       ) VALUES (?, ?, ?, ?, NULL, ?, 0)`,
      `${summaryId}:section:${summaryReady ? 'legacy_content' : 'legacy_backup'}`,
      summaryId,
      summaryReady ? 'legacy_content' : 'legacy_backup',
      summaryReady ? 'legacy' : 'legacy_raw_backup',
      summaryReady ? item.summaryText : stableJson(summary),
    );
    const actions = summary.action_items ?? [];
    for (let ordinal = 0; ordinal < actions.length; ordinal += 1) {
      const action = actions[ordinal];
      const fingerprint = `sha256:${item.actionFingerprints[ordinal]}`;
      const status = actionStatus(action.status);
      await database.runAsync(
        `INSERT INTO action_items (
           id, meeting_id, remote_id, content, status, assignee_text, due_at_ms,
           source_kind, source_summary_version_id, generation_fingerprint,
           completed_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?)`,
        `${localId}:action:${item.actionFingerprints[ordinal].slice(0, 24)}:${ordinal}`,
        localId,
        action.content.trim(),
        status,
        action.assignee?.trim() || null,
        timestamp(action.due_date, 0) || null,
        summaryId,
        fingerprint,
        status === 'completed' ? summaryCreatedAtMs : null,
        summaryCreatedAtMs,
        summaryCreatedAtMs,
      );
    }
  }
}

export async function runLegacyMeetingShadowImport(
  input: LegacyMeetingShadowSource,
): Promise<LegacyMeetingShadowReport> {
  assertScopeKey(input.scopeKey);
  const sourceHash = await sha256(stableJson({
    sourceVersion: LEGACY_SOURCE_VERSION,
    meetings: input.meetings,
    transcripts: input.transcripts,
    summaries: input.summaries,
    pendingAudioUploads: input.pendingAudioUploads,
    pendingSummaryTasks: input.pendingSummaryTasks,
  }));
  const database = await openMeetingDatabase();
  const id = migrationId(input.scopeKey);
  const nowMs = Date.now();
  const prepared = await prepareSource(input, nowMs);
  const canonicalIdentities = await database.getAllAsync<{
    id: string;
    remote_id: string | null;
    legacy_source_id: string | null;
  }>(
    `SELECT id, remote_id, legacy_source_id
     FROM meeting_notes
     WHERE scope_key = ? AND entry_point != 'legacy_store'`,
    input.scopeKey,
  );
  const representedLegacyIds = new Set<string>();
  canonicalIdentities.forEach(row => {
    representedLegacyIds.add(row.id);
    if (row.remote_id) representedLegacyIds.add(row.remote_id);
    if (row.legacy_source_id) representedLegacyIds.add(row.legacy_source_id);
  });
  const legacyItems = prepared.filter(item => !representedLegacyIds.has(item.legacyId));
  const expected = expectedCounts(legacyItems);
  const previous = await database.getFirstAsync<{
    source_hash: string | null;
    phase: string;
    imported_counts_json: string | null;
  }>(
    `SELECT source_hash, phase, imported_counts_json
     FROM migration_runs WHERE migration_id = ?`,
    id,
  );
  if (previous?.source_hash === sourceHash && previous.phase === 'completed') {
    const counts = await countImported(input.scopeKey);
    if (countsMatch(counts, expected)) {
      return { scopeKey: input.scopeKey, sourceHash, counts, skipped: true };
    }
  }
  try {
    await withMeetingDatabaseTransaction(async transactionDatabase => {
      await transactionDatabase.runAsync(
        "DELETE FROM meeting_notes WHERE scope_key = ? AND entry_point = 'legacy_store'",
        input.scopeKey,
      );
      for (const item of legacyItems) {
        await insertPreparedMeeting(transactionDatabase, input.scopeKey, item, nowMs);
      }
      const imported = await countImported(input.scopeKey, transactionDatabase);
      if (!countsMatch(imported, expected)) throw new Error('legacy meeting shadow count mismatch');
      const foreignKeyIssues = await transactionDatabase.getAllAsync<{ table: string }>('PRAGMA foreign_key_check');
      if (foreignKeyIssues.length > 0) throw new Error('legacy meeting shadow foreign key mismatch');
      await transactionDatabase.runAsync(
        `INSERT INTO migration_runs (
           migration_id, scope_key, source_version, phase, source_hash,
           imported_counts_json, last_error, started_at_ms, updated_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, 'completed', ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(migration_id) DO UPDATE SET
           source_version = excluded.source_version,
           phase = excluded.phase,
           source_hash = excluded.source_hash,
           imported_counts_json = excluded.imported_counts_json,
           last_error = NULL,
           started_at_ms = excluded.started_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           completed_at_ms = excluded.completed_at_ms`,
        id,
        input.scopeKey,
        LEGACY_SOURCE_VERSION,
        sourceHash,
        JSON.stringify(imported),
        nowMs,
        Date.now(),
        Date.now(),
      );
    });
  } catch (error) {
    const failure = error instanceof Error ? error.name : 'UnknownError';
    await withMeetingDatabaseTransaction(async failureDatabase => {
      await failureDatabase.runAsync(
        `INSERT INTO migration_runs (
           migration_id, scope_key, source_version, phase, source_hash,
           imported_counts_json, last_error, started_at_ms, updated_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, 'failed', ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT(migration_id) DO UPDATE SET
           source_version = excluded.source_version,
           phase = excluded.phase,
           source_hash = excluded.source_hash,
           imported_counts_json = NULL,
           last_error = excluded.last_error,
           started_at_ms = excluded.started_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           completed_at_ms = NULL`,
        id,
        input.scopeKey,
        LEGACY_SOURCE_VERSION,
        sourceHash,
        failure,
        nowMs,
        Date.now(),
      );
    }).catch(() => undefined);
    throw error;
  }
  return { scopeKey: input.scopeKey, sourceHash, counts: expected, skipped: false };
}

export async function getLegacyMeetingShadowReport(
  scopeKey: ScopeKey,
): Promise<LegacyMeetingShadowReport | null> {
  assertScopeKey(scopeKey);
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{
    phase: string;
    source_hash: string | null;
    imported_counts_json: string | null;
  }>(
    `SELECT phase, source_hash, imported_counts_json
     FROM migration_runs WHERE migration_id = ?`,
    migrationId(scopeKey),
  );
  if (!row || row.phase !== 'completed' || !row.source_hash || !row.imported_counts_json) return null;
  return {
    scopeKey,
    sourceHash: row.source_hash,
    counts: JSON.parse(row.imported_counts_json) as LegacyMeetingImportCounts,
    skipped: true,
  };
}
