import type { SQLiteDatabase } from 'expo-sqlite';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';

export interface SpeakerOverlayAssignment {
  stableSegmentKey: string;
  automaticLabel: string | null;
  speakerClusterId: string | null;
  speakerProfileId: string | null;
  confidence: number | null;
}

export interface SpeakerOverlayRevision {
  revisionId: string;
  meetingId: string;
  transcriptRevisionId: string;
  overlayRevision: number;
  sourceManifestSha256: string | null;
  modelRevision: string | null;
  status: 'active' | 'archived';
  createdAtMs: number;
  activatedAtMs: number | null;
  assignments: readonly SpeakerOverlayAssignment[];
}

export interface SpeakerManualOverride {
  overrideId: string;
  meetingId: string;
  stableSegmentKey: string;
  expectedTranscriptRevision: string;
  label: string;
  speakerProfileId: string | null;
  overrideRevision: number;
  needsReview: boolean;
  sourceCorrectionId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

type OverlayRow = {
  revision_id: string;
  meeting_id: string;
  transcript_revision_id: string;
  overlay_revision: number;
  source_manifest_sha256: string | null;
  model_revision: string | null;
  status: 'active' | 'archived';
  created_at_ms: number;
  activated_at_ms: number | null;
};

type AssignmentRow = {
  stable_segment_key: string;
  automatic_label: string | null;
  speaker_cluster_id: string | null;
  speaker_profile_id: string | null;
  confidence: number | null;
};

type ManualRow = {
  override_id: string;
  meeting_id: string;
  stable_segment_key: string;
  expected_transcript_revision: string;
  label: string;
  speaker_profile_id: string | null;
  override_revision: number;
  needs_review: number;
  source_correction_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} 无效`);
  }
  return normalized;
}

function optionalIdentifier(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  return identifier(value, field);
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 无效`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 无效`);
  return value;
}

function sha256(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${field} 无效`);
  return value;
}

function assignmentFromRow(row: AssignmentRow): SpeakerOverlayAssignment {
  return {
    stableSegmentKey: row.stable_segment_key,
    automaticLabel: row.automatic_label,
    speakerClusterId: row.speaker_cluster_id,
    speakerProfileId: row.speaker_profile_id,
    confidence: row.confidence,
  };
}

function manualFromRow(row: ManualRow): SpeakerManualOverride {
  return {
    overrideId: row.override_id,
    meetingId: row.meeting_id,
    stableSegmentKey: row.stable_segment_key,
    expectedTranscriptRevision: row.expected_transcript_revision,
    label: row.label,
    speakerProfileId: row.speaker_profile_id,
    overrideRevision: Number(row.override_revision),
    needsReview: row.needs_review === 1,
    sourceCorrectionId: row.source_correction_id,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

async function readAssignments(
  database: SQLiteDatabase,
  revisionId: string,
): Promise<readonly SpeakerOverlayAssignment[]> {
  const rows = await database.getAllAsync<AssignmentRow>(
    `SELECT stable_segment_key, automatic_label, speaker_cluster_id,
            speaker_profile_id, confidence
       FROM speaker_overlay_assignments
      WHERE revision_id = ? ORDER BY stable_segment_key`,
    revisionId,
  );
  return rows.map(assignmentFromRow);
}

async function overlayFromRow(
  database: SQLiteDatabase,
  row: OverlayRow | null,
): Promise<SpeakerOverlayRevision | null> {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    meetingId: row.meeting_id,
    transcriptRevisionId: row.transcript_revision_id,
    overlayRevision: Number(row.overlay_revision),
    sourceManifestSha256: row.source_manifest_sha256,
    modelRevision: row.model_revision,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    activatedAtMs: row.activated_at_ms === null ? null : Number(row.activated_at_ms),
    assignments: await readAssignments(database, row.revision_id),
  };
}

export async function getActiveSpeakerOverlay(
  transcriptRevisionId: string,
): Promise<SpeakerOverlayRevision | null> {
  const revisionId = identifier(transcriptRevisionId, '转写版本');
  const database = await openMeetingDatabase();
  return overlayFromRow(database, await database.getFirstAsync<OverlayRow>(
    `SELECT * FROM speaker_overlay_revisions
      WHERE transcript_revision_id = ? AND status = 'active'`,
    revisionId,
  ));
}

export interface ActivateSpeakerOverlayInput {
  revisionId: string;
  meetingId: string;
  transcriptRevisionId: string;
  overlayRevision: number;
  sourceManifestSha256?: string | null;
  modelRevision?: string | null;
  assignments: readonly SpeakerOverlayAssignment[];
  createdAtMs: number;
  activatedAtMs?: number;
}

export async function activateSpeakerOverlay(
  input: ActivateSpeakerOverlayInput,
): Promise<SpeakerOverlayRevision> {
  const revisionId = identifier(input.revisionId, '讲话人覆盖版本');
  const meetingId = identifier(input.meetingId, '会议');
  const transcriptRevisionId = identifier(input.transcriptRevisionId, '转写版本');
  const overlayRevision = positiveInteger(input.overlayRevision, '讲话人覆盖序号');
  const manifestSha256 = sha256(input.sourceManifestSha256, '来源清单哈希');
  const modelRevision = optionalIdentifier(input.modelRevision, '讲话人模型版本');
  const createdAtMs = timestamp(input.createdAtMs, '讲话人覆盖创建时间');
  const activatedAtMs = timestamp(input.activatedAtMs ?? createdAtMs, '讲话人覆盖激活时间');
  if (activatedAtMs < createdAtMs) throw new Error('讲话人覆盖激活时间早于创建时间');
  if (input.assignments.length > 20_000) throw new Error('讲话人覆盖片段过多');

  const assignments = input.assignments.map(item => ({
    stableSegmentKey: identifier(item.stableSegmentKey, '稳定转写片段'),
    automaticLabel: optionalIdentifier(item.automaticLabel, '自动讲话人名称'),
    speakerClusterId: optionalIdentifier(item.speakerClusterId, '讲话人聚类'),
    speakerProfileId: optionalIdentifier(item.speakerProfileId, '讲话人档案'),
    confidence: item.confidence,
  })).sort((left, right) => left.stableSegmentKey.localeCompare(right.stableSegmentKey));
  if (new Set(assignments.map(item => item.stableSegmentKey)).size !== assignments.length) {
    throw new Error('讲话人覆盖包含重复片段');
  }
  assignments.forEach(item => {
    if (item.confidence !== null && (
      !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
    )) throw new Error('讲话人置信度无效');
  });

  return withMeetingDatabaseTransaction(async database => {
    const transcript = await database.getFirstAsync<{
      meeting_id: string;
      source_manifest_sha256: string | null;
      is_active: number;
    }>(
      `SELECT meeting_id, source_manifest_sha256, is_active
         FROM transcript_revisions WHERE id = ?`,
      transcriptRevisionId,
    );
    if (!transcript || transcript.meeting_id !== meetingId || transcript.is_active !== 1) {
      throw new Error('讲话人覆盖不属于该会议转写');
    }
    if (
      transcript.source_manifest_sha256
      && transcript.source_manifest_sha256 !== manifestSha256
    ) throw new Error('讲话人覆盖来源清单已变化');

    const stableRows = await database.getAllAsync<{ stable_segment_key: string }>(
      `SELECT stable_segment_key FROM transcript_segments WHERE revision_id = ?`,
      transcriptRevisionId,
    );
    const stableKeys = new Set(stableRows.map(row => row.stable_segment_key));
    if (assignments.some(item => !stableKeys.has(item.stableSegmentKey))) {
      throw new Error('讲话人覆盖引用了其他转写片段');
    }

    const existing = await database.getFirstAsync<OverlayRow>(
      'SELECT * FROM speaker_overlay_revisions WHERE revision_id = ?',
      revisionId,
    );
    if (existing) {
      if (
        existing.meeting_id !== meetingId
        || existing.transcript_revision_id !== transcriptRevisionId
        || Number(existing.overlay_revision) !== overlayRevision
        || existing.source_manifest_sha256 !== manifestSha256
        || existing.model_revision !== modelRevision
      ) throw new Error('讲话人覆盖版本身份被重复使用');
      const result = await overlayFromRow(database, existing);
      if (!result) throw new Error('讲话人覆盖版本读取失败');
      const sameAssignments = result.assignments.length === assignments.length
        && result.assignments.every((item, index) => {
          const candidate = assignments[index];
          return item.stableSegmentKey === candidate.stableSegmentKey
            && item.automaticLabel === candidate.automaticLabel
            && item.speakerClusterId === candidate.speakerClusterId
            && item.speakerProfileId === candidate.speakerProfileId
            && item.confidence === candidate.confidence;
        });
      if (!sameAssignments) throw new Error('讲话人覆盖版本内容被重复使用');
      return result;
    }

    const active = await database.getFirstAsync<OverlayRow>(
      `SELECT * FROM speaker_overlay_revisions
        WHERE transcript_revision_id = ? AND status = 'active'`,
      transcriptRevisionId,
    );
    if (active && Number(active.overlay_revision) >= overlayRevision) {
      throw new Error('讲话人覆盖序号没有前进');
    }
    if (active) {
      await database.runAsync(
        `UPDATE speaker_overlay_revisions SET status = 'archived'
          WHERE revision_id = ? AND status = 'active'`,
        active.revision_id,
      );
    }
    await database.runAsync(
      `INSERT INTO speaker_overlay_revisions(
         revision_id, meeting_id, transcript_revision_id, overlay_revision,
         source_manifest_sha256, model_revision, status, created_at_ms, activated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      revisionId,
      meetingId,
      transcriptRevisionId,
      overlayRevision,
      manifestSha256,
      modelRevision,
      createdAtMs,
      activatedAtMs,
    );
    for (const item of assignments) {
      await database.runAsync(
        `INSERT INTO speaker_overlay_assignments(
           revision_id, stable_segment_key, automatic_label,
           speaker_cluster_id, speaker_profile_id, confidence
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        revisionId,
        item.stableSegmentKey,
        item.automaticLabel,
        item.speakerClusterId,
        item.speakerProfileId,
        item.confidence,
      );
    }
    const result = await overlayFromRow(database, await database.getFirstAsync<OverlayRow>(
      'SELECT * FROM speaker_overlay_revisions WHERE revision_id = ?',
      revisionId,
    ));
    if (!result) throw new Error('讲话人覆盖版本创建失败');
    return result;
  });
}

export async function listSpeakerManualOverrides(
  meetingIdValue: string,
): Promise<readonly SpeakerManualOverride[]> {
  const meetingId = identifier(meetingIdValue, '会议');
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<ManualRow>(
    `SELECT * FROM speaker_manual_overrides
      WHERE meeting_id = ? ORDER BY stable_segment_key`,
    meetingId,
  );
  return rows.map(manualFromRow);
}

export interface SaveSpeakerManualOverrideInput {
  overrideId: string;
  meetingId: string;
  stableSegmentKey: string;
  expectedTranscriptRevision: string;
  expectedOverrideRevision: number | null;
  label: string;
  speakerProfileId?: string | null;
  sourceCorrectionId?: string | null;
  nowMs: number;
}

export async function saveSpeakerManualOverride(
  input: SaveSpeakerManualOverrideInput,
): Promise<SpeakerManualOverride | null> {
  const overrideId = identifier(input.overrideId, '手动讲话人覆盖');
  const meetingId = identifier(input.meetingId, '会议');
  const stableSegmentKey = identifier(input.stableSegmentKey, '稳定转写片段');
  const expectedTranscriptRevision = identifier(input.expectedTranscriptRevision, '预期转写版本');
  const label = identifier(input.label, '讲话人名称');
  const speakerProfileId = optionalIdentifier(input.speakerProfileId, '讲话人档案');
  const sourceCorrectionId = optionalIdentifier(input.sourceCorrectionId, '讲话人修正来源');
  const nowMs = timestamp(input.nowMs, '讲话人修正时间');
  if (
    input.expectedOverrideRevision !== null
    && (!Number.isSafeInteger(input.expectedOverrideRevision) || input.expectedOverrideRevision < 1)
  ) throw new Error('预期讲话人修订无效');

  return withMeetingDatabaseTransaction(async database => {
    const segment = await database.getFirstAsync<{ meeting_id: string }>(
      `SELECT meeting_id FROM transcript_segments
        WHERE revision_id = ? AND stable_segment_key = ?`,
      expectedTranscriptRevision,
      stableSegmentKey,
    );
    const active = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM transcript_revisions
        WHERE id = ? AND meeting_id = ? AND is_active = 1`,
      expectedTranscriptRevision,
      meetingId,
    );
    if (!segment || segment.meeting_id !== meetingId || !active) {
      throw new Error('讲话人修正所依据的转写已变化');
    }
    const existing = await database.getFirstAsync<ManualRow>(
      `SELECT * FROM speaker_manual_overrides
        WHERE meeting_id = ? AND stable_segment_key = ?`,
      meetingId,
      stableSegmentKey,
    );
    if (!existing) {
      if (input.expectedOverrideRevision !== null) return null;
      await database.runAsync(
        `INSERT INTO speaker_manual_overrides(
           override_id, meeting_id, stable_segment_key, expected_transcript_revision,
           label, speaker_profile_id, override_revision, needs_review,
           source_correction_id, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
        overrideId,
        meetingId,
        stableSegmentKey,
        expectedTranscriptRevision,
        label,
        speakerProfileId,
        sourceCorrectionId,
        nowMs,
        nowMs,
      );
    } else {
      if (
        existing.override_id !== overrideId
        || existing.expected_transcript_revision !== expectedTranscriptRevision
        || input.expectedOverrideRevision !== Number(existing.override_revision)
      ) return null;
      const updated = await database.runAsync(
        `UPDATE speaker_manual_overrides
            SET label = ?, speaker_profile_id = ?,
                source_correction_id = ?, override_revision = override_revision + 1,
                needs_review = 0, updated_at_ms = ?
          WHERE override_id = ? AND override_revision = ?`,
        label,
        speakerProfileId,
        sourceCorrectionId,
        nowMs,
        overrideId,
        input.expectedOverrideRevision,
      );
      if (Number(updated.changes) !== 1) return null;
    }
    const row = await database.getFirstAsync<ManualRow>(
      'SELECT * FROM speaker_manual_overrides WHERE override_id = ?',
      overrideId,
    );
    return row ? manualFromRow(row) : null;
  });
}

export async function rebaseSpeakerManualOverrides(
  meetingIdValue: string,
  previousTranscriptRevisionValue: string,
  nextTranscriptRevisionValue: string,
  nowMsValue: number,
): Promise<{ rebased: number; needsReview: number }> {
  const meetingId = identifier(meetingIdValue, '会议');
  const previousRevision = identifier(previousTranscriptRevisionValue, '旧转写版本');
  const nextRevision = identifier(nextTranscriptRevisionValue, '新转写版本');
  const nowMs = timestamp(nowMsValue, '讲话人修正迁移时间');
  if (previousRevision === nextRevision) return { rebased: 0, needsReview: 0 };

  return withMeetingDatabaseTransaction(async database => {
    const next = await database.getFirstAsync<{ meeting_id: string }>(
      `SELECT meeting_id FROM transcript_revisions WHERE id = ? AND is_active = 1`,
      nextRevision,
    );
    if (!next || next.meeting_id !== meetingId) throw new Error('新转写版本尚未激活');
    const rows = await database.getAllAsync<ManualRow>(
      `SELECT * FROM speaker_manual_overrides
        WHERE meeting_id = ? AND expected_transcript_revision = ?`,
      meetingId,
      previousRevision,
    );
    let rebased = 0;
    let needsReview = 0;
    for (const row of rows) {
      const pair = await database.getFirstAsync<{
        previous_text: string;
        next_text: string;
      }>(
        `SELECT previous.text AS previous_text, next.text AS next_text
           FROM transcript_segments previous
           INNER JOIN transcript_segments next
             ON next.stable_segment_key = previous.stable_segment_key
          WHERE previous.revision_id = ? AND next.revision_id = ?
            AND previous.stable_segment_key = ?`,
        previousRevision,
        nextRevision,
        row.stable_segment_key,
      );
      const canRebase = Boolean(pair && pair.previous_text === pair.next_text);
      await database.runAsync(
        `UPDATE speaker_manual_overrides
            SET expected_transcript_revision = ?, needs_review = ?,
                override_revision = override_revision + 1, updated_at_ms = ?
          WHERE override_id = ? AND override_revision = ?`,
        nextRevision,
        canRebase ? 0 : 1,
        nowMs,
        row.override_id,
        row.override_revision,
      );
      if (canRebase) rebased += 1;
      else needsReview += 1;
    }
    return { rebased, needsReview };
  });
}

export async function deleteSpeakerManualOverride(
  overrideIdValue: string,
  meetingIdValue: string,
  expectedOverrideRevision: number,
): Promise<boolean> {
  const overrideId = identifier(overrideIdValue, '手动讲话人覆盖');
  const meetingId = identifier(meetingIdValue, '会议');
  positiveInteger(expectedOverrideRevision, '预期讲话人修订');
  return withMeetingDatabaseTransaction(async database => {
    const result = await database.runAsync(
      `DELETE FROM speaker_manual_overrides
        WHERE override_id = ? AND meeting_id = ? AND override_revision = ?`,
      overrideId,
      meetingId,
      expectedOverrideRevision,
    );
    return Number(result.changes) === 1;
  });
}
