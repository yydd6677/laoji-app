import type {
  MeetingMediaClip,
  MeetingMediaClipStatus,
  ScopeKey,
} from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';

type MediaClipRow = {
  id: string;
  meeting_id: string;
  source_recording_asset_id: string | null;
  source_recording_checksum_sha256: string | null;
  source_recording_updated_at_ms: number;
  source_kind: MeetingMediaClip['sourceKind'];
  source_marker_id: string | null;
  source_segment_id: string | null;
  start_ms: number;
  end_ms: number;
  include_speaker: number;
  include_text: number;
  speaker_text: string | null;
  transcript_text: string | null;
  status: MeetingMediaClipStatus;
  local_uri: string | null;
  mime_type: string | null;
  file_name: string | null;
  byte_size: number | null;
  checksum_sha256: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type PendingMeetingMediaClip = Omit<
  MeetingMediaClip,
  'status' | 'localUri' | 'mimeType' | 'fileName' | 'byteSize' | 'checksumSha256' | 'errorCode'
>;

export interface ReadyMeetingMediaClipFile {
  localUri: string;
  mimeType: 'audio/wav';
  fileName: string;
  byteSize: number;
  checksumSha256: string;
}

function assertId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function optionalText(value: string | null, maximum: number, label: string): string | null {
  if (value === null) return null;
  const normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function assertTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
  return value;
}

function fromRow(row: MediaClipRow): MeetingMediaClip {
  if (
    !['marker', 'transcript'].includes(row.source_kind)
    || !['pending', 'ready', 'failed', 'deleting'].includes(row.status)
    || ![0, 1].includes(row.include_speaker)
    || ![0, 1].includes(row.include_text)
  ) throw new Error('音频片段记录已损坏');
  if (row.status === 'ready' && row.mime_type !== 'audio/wav') {
    throw new Error('音频片段格式无效');
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    sourceRecordingAssetId: row.source_recording_asset_id,
    sourceRecordingChecksumSha256: row.source_recording_checksum_sha256,
    sourceRecordingUpdatedAtMs: row.source_recording_updated_at_ms,
    sourceKind: row.source_kind,
    sourceMarkerId: row.source_marker_id,
    sourceSegmentId: row.source_segment_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    includeSpeaker: row.include_speaker === 1,
    includeText: row.include_text === 1,
    speakerText: row.speaker_text,
    transcriptText: row.transcript_text,
    status: row.status,
    localUri: row.local_uri,
    mimeType: row.mime_type as 'audio/wav' | null,
    fileName: row.file_name,
    byteSize: row.byte_size,
    checksumSha256: row.checksum_sha256,
    errorCode: row.error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

async function rowForClip(
  database: Awaited<ReturnType<typeof openMeetingDatabase>>,
  clipId: string,
  meetingId: string,
  scopeKey: ScopeKey,
): Promise<MediaClipRow | null> {
  return database.getFirstAsync<MediaClipRow>(
    `SELECT clip.*
     FROM meeting_media_clips clip
     INNER JOIN meeting_notes meeting
       ON meeting.id = clip.meeting_id AND meeting.scope_key = clip.scope_key
     WHERE clip.id = ? AND clip.meeting_id = ? AND clip.scope_key = ?`,
    clipId,
    meetingId,
    scopeKey,
  );
}

export async function listMeetingMediaClips(
  meetingId: string,
  scopeKey: ScopeKey,
): Promise<readonly MeetingMediaClip[]> {
  assertScopeKey(scopeKey);
  const normalizedMeetingId = assertId(meetingId, '会议标识');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<MediaClipRow>(
    `SELECT clip.*
     FROM meeting_media_clips clip
     INNER JOIN meeting_notes meeting
       ON meeting.id = clip.meeting_id AND meeting.scope_key = clip.scope_key
     WHERE clip.meeting_id = ? AND clip.scope_key = ?
     ORDER BY clip.created_at_ms DESC, clip.id DESC`,
    normalizedMeetingId,
    scopeKey,
  );
  return rows.map(fromRow);
}

export async function insertPendingMeetingMediaClip(
  input: PendingMeetingMediaClip & { scopeKey: ScopeKey },
): Promise<MeetingMediaClip> {
  assertScopeKey(input.scopeKey);
  const id = assertId(input.id, '片段标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const recordingAssetId = input.sourceRecordingAssetId
    ? assertId(input.sourceRecordingAssetId, '录音标识')
    : null;
  if (!recordingAssetId) throw new Error('生成片段需要本机录音');
  const sourceRecordingChecksumSha256 = input.sourceRecordingChecksumSha256?.trim().toLowerCase() || null;
  if (sourceRecordingChecksumSha256 && !/^sha256:[0-9a-f]{64}$/.test(sourceRecordingChecksumSha256)) {
    throw new Error('录音校验值无效');
  }
  const sourceRecordingUpdatedAtMs = assertTime(input.sourceRecordingUpdatedAtMs, '录音更新时间');
  const sourceMarkerId = input.sourceMarkerId ? assertId(input.sourceMarkerId, '标记标识') : null;
  const sourceSegmentId = input.sourceSegmentId ? assertId(input.sourceSegmentId, '文字片段标识') : null;
  const startMs = assertTime(input.startMs, '片段开始时间');
  const endMs = assertTime(input.endMs, '片段结束时间');
  if (endMs <= startMs) throw new Error('片段时间范围无效');
  const createdAtMs = assertTime(input.createdAtMs, '片段创建时间');
  const updatedAtMs = assertTime(input.updatedAtMs, '片段更新时间');
  if (updatedAtMs < createdAtMs) throw new Error('片段更新时间无效');
  const speakerText = optionalText(input.speakerText, 2_000, '讲话人内容');
  const transcriptText = optionalText(input.transcriptText, 20_000, '文字内容');
  if (input.includeSpeaker && !speakerText) throw new Error('没有可包含的讲话人');
  if (input.includeText && !transcriptText) throw new Error('没有可包含的文字');
  if (input.sourceKind === 'marker' && !sourceMarkerId) throw new Error('标记来源无效');
  if (input.sourceKind === 'transcript' && !sourceSegmentId) throw new Error('文字来源无效');

  const row = await withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{ lifecycle: string }>(
      'SELECT lifecycle FROM meeting_notes WHERE id = ? AND scope_key = ?',
      meetingId,
      input.scopeKey,
    );
    if (!meeting || meeting.lifecycle === 'deleted') throw new Error('会议记录已不可用');
    const recording = await database.getFirstAsync<{
      local_uri: string | null;
      local_state: string;
      checksum_sha256: string | null;
      updated_at_ms: number;
    }>(
      `SELECT local_uri, local_state, checksum_sha256, updated_at_ms FROM recording_assets
       WHERE id = ? AND meeting_id = ?`,
      recordingAssetId,
      meetingId,
    );
    if (!recording || recording.local_state !== 'local_ready' || !recording.local_uri) {
      throw new Error('本机录音已发生变化');
    }
    if (
      recording.updated_at_ms !== sourceRecordingUpdatedAtMs
      || recording.checksum_sha256 !== sourceRecordingChecksumSha256
    ) throw new Error('本机录音已发生变化');
    if (sourceMarkerId) {
      const marker = await database.getFirstAsync<{ id: string }>(
        'SELECT id FROM markers WHERE id = ? AND meeting_id = ?',
        sourceMarkerId,
        meetingId,
      );
      if (!marker) throw new Error('标记已发生变化');
    }
    if (sourceSegmentId) {
      const segment = await database.getFirstAsync<{ id: string }>(
        `SELECT segment.id
         FROM transcript_segments segment
         INNER JOIN transcript_revisions revision ON revision.id = segment.revision_id
         WHERE segment.id = ? AND segment.meeting_id = ? AND revision.is_active = 1`,
        sourceSegmentId,
        meetingId,
      );
      if (!segment) throw new Error('文字记录已发生变化');
    }
    await database.runAsync(
      `INSERT INTO meeting_media_clips (
         id, meeting_id, scope_key, source_recording_asset_id,
         source_recording_checksum_sha256, source_recording_updated_at_ms, source_kind,
         source_marker_id, source_segment_id, start_ms, end_ms,
         include_speaker, include_text, speaker_text, transcript_text,
         status, local_uri, mime_type, file_name, byte_size, checksum_sha256,
         error_code, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
         NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      id,
      meetingId,
      input.scopeKey,
      recordingAssetId,
      sourceRecordingChecksumSha256,
      sourceRecordingUpdatedAtMs,
      input.sourceKind,
      sourceMarkerId,
      sourceSegmentId,
      startMs,
      endMs,
      input.includeSpeaker ? 1 : 0,
      input.includeText ? 1 : 0,
      speakerText,
      transcriptText,
      createdAtMs,
      updatedAtMs,
    );
    return rowForClip(database, id, meetingId, input.scopeKey);
  });
  if (!row) throw new Error('音频片段未能保存');
  return fromRow(row);
}

export async function markMeetingMediaClipPending(input: {
  clipId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  updatedAtMs: number;
}): Promise<MeetingMediaClip> {
  assertScopeKey(input.scopeKey);
  const clipId = assertId(input.clipId, '片段标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const updatedAtMs = assertTime(input.updatedAtMs, '片段更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForClip(database, clipId, meetingId, input.scopeKey);
    if (!existing) throw new Error('音频片段已不可用');
    if (existing.status === 'ready') return existing;
    if (existing.status === 'deleting') throw new Error('音频片段正在删除');
    await database.runAsync(
      `UPDATE meeting_media_clips SET status = 'pending', error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
      Math.max(updatedAtMs, existing.created_at_ms),
      clipId,
      meetingId,
      input.scopeKey,
    );
    return rowForClip(database, clipId, meetingId, input.scopeKey);
  });
  if (!row) throw new Error('音频片段未能更新');
  return fromRow(row);
}

export async function completeMeetingMediaClip(input: {
  clipId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  file: ReadyMeetingMediaClipFile;
  updatedAtMs: number;
}): Promise<MeetingMediaClip> {
  assertScopeKey(input.scopeKey);
  const clipId = assertId(input.clipId, '片段标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const localUri = assertId(input.file.localUri, '片段文件');
  const fileName = assertId(input.file.fileName, '片段文件名');
  if (!Number.isSafeInteger(input.file.byteSize) || input.file.byteSize <= 44) {
    throw new Error('片段文件大小无效');
  }
  const checksum = input.file.checksumSha256.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) throw new Error('片段文件校验值无效');
  const updatedAtMs = assertTime(input.updatedAtMs, '片段更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForClip(database, clipId, meetingId, input.scopeKey);
    if (!existing || existing.status === 'deleting') throw new Error('音频片段已不可用');
    if (existing.status === 'ready') {
      if (
        existing.local_uri !== localUri
        || existing.file_name !== fileName
        || existing.byte_size !== input.file.byteSize
        || existing.checksum_sha256 !== checksum
      ) throw new Error('同一音频片段生成了不同文件');
      return existing;
    }
    await database.runAsync(
      `UPDATE meeting_media_clips
       SET status = 'ready', local_uri = ?, mime_type = 'audio/wav', file_name = ?,
           byte_size = ?, checksum_sha256 = ?, error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
      localUri,
      fileName,
      input.file.byteSize,
      checksum,
      Math.max(updatedAtMs, existing.created_at_ms),
      clipId,
      meetingId,
      input.scopeKey,
    );
    return rowForClip(database, clipId, meetingId, input.scopeKey);
  });
  if (!row) throw new Error('音频片段未能保存');
  return fromRow(row);
}

export async function failMeetingMediaClip(input: {
  clipId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  errorCode: string;
  updatedAtMs: number;
}): Promise<MeetingMediaClip | null> {
  assertScopeKey(input.scopeKey);
  const clipId = assertId(input.clipId, '片段标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const errorCode = assertId(input.errorCode, '片段错误');
  const updatedAtMs = assertTime(input.updatedAtMs, '片段更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForClip(database, clipId, meetingId, input.scopeKey);
    if (!existing || existing.status === 'ready' || existing.status === 'deleting') return existing;
    await database.runAsync(
      `UPDATE meeting_media_clips
       SET status = 'failed', error_code = ?, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
      errorCode,
      Math.max(updatedAtMs, existing.created_at_ms),
      clipId,
      meetingId,
      input.scopeKey,
    );
    return rowForClip(database, clipId, meetingId, input.scopeKey);
  });
  return row ? fromRow(row) : null;
}

export async function beginDeletingMeetingMediaClip(input: {
  clipId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  updatedAtMs: number;
}): Promise<MeetingMediaClip | null> {
  assertScopeKey(input.scopeKey);
  const clipId = assertId(input.clipId, '片段标识');
  const meetingId = assertId(input.meetingId, '会议标识');
  const updatedAtMs = assertTime(input.updatedAtMs, '片段更新时间');
  const row = await withMeetingDatabaseTransaction(async database => {
    const existing = await rowForClip(database, clipId, meetingId, input.scopeKey);
    if (!existing) return null;
    await database.runAsync(
      `UPDATE meeting_media_clips
       SET status = 'deleting', local_uri = NULL, mime_type = NULL, file_name = NULL,
           byte_size = NULL, checksum_sha256 = NULL, error_code = NULL, updated_at_ms = ?
       WHERE id = ? AND meeting_id = ? AND scope_key = ?`,
      Math.max(updatedAtMs, existing.created_at_ms),
      clipId,
      meetingId,
      input.scopeKey,
    );
    return rowForClip(database, clipId, meetingId, input.scopeKey);
  });
  return row ? fromRow(row) : null;
}

export async function finishDeletingMeetingMediaClip(input: {
  clipId: string;
  meetingId: string;
  scopeKey: ScopeKey;
}): Promise<boolean> {
  assertScopeKey(input.scopeKey);
  const result = await withMeetingDatabaseTransaction(database => database.runAsync(
    `DELETE FROM meeting_media_clips
     WHERE id = ? AND meeting_id = ? AND scope_key = ? AND status = 'deleting'`,
    assertId(input.clipId, '片段标识'),
    assertId(input.meetingId, '会议标识'),
    input.scopeKey,
  ));
  return result.changes === 1;
}

export async function countMeetingMediaClipsForRecording(
  recordingAssetId: string,
  scopeKey: ScopeKey,
): Promise<number> {
  assertScopeKey(scopeKey);
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM meeting_media_clips
     WHERE scope_key = ? AND source_recording_asset_id = ? AND status != 'deleting'`,
    scopeKey,
    assertId(recordingAssetId, '录音标识'),
  );
  return Number(row?.count ?? 0);
}
