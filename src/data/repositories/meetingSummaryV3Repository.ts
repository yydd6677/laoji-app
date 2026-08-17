import type { MeetingFactsResultV3, MeetingTemplateId } from '../../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';
import {
  meetingFactsResultV3ToWire,
  parseMeetingFactsResultV3,
} from '../../services/meetingSummaryV3';

const TEMPLATE_IDS = new Set<MeetingTemplateId>([
  'general', 'one_on_one', 'project_sync', 'interview',
]);

export interface SummaryViewOverrideV3 {
  versionId: string;
  templateId: MeetingTemplateId;
  stableBlockKey: string;
  replacementKind: 'paragraph' | 'bullet_group';
  replacementText: string;
  userEditedAtMs: number;
}

export interface SummaryV3UpgradeTask {
  meetingId: string;
  attemptCount: number;
  remoteTaskId: string | null;
}

export interface SummaryV3UpgradeMeetingContext {
  canonicalMeetingId: string;
  legacyMeetingId: string;
  title: string;
}

export interface StoredMeetingFactsV3 {
  canonicalMeetingId: string;
  summaryVersionId: string | null;
  result: MeetingFactsResultV3;
}

type FactDocumentRow = {
  id: string;
  meeting_id: string;
  summary_version_id: string | null;
  document_json: string;
};

function parseStoredDocument(row: FactDocumentRow | null): MeetingFactsResultV3 | null {
  if (!row) return null;
  try {
    return parseMeetingFactsResultV3(JSON.parse(row.document_json));
  } catch {
    return null;
  }
}

function requireTemplateId(value: string): MeetingTemplateId {
  if (!TEMPLATE_IDS.has(value as MeetingTemplateId)) throw new Error('summary template id is invalid');
  return value as MeetingTemplateId;
}

export async function saveMeetingFactsResultV3(
  meetingId: string,
  result: MeetingFactsResultV3,
): Promise<void> {
  const generatedAtMs = Date.parse(result.generatedAt);
  if (!meetingId.trim() || !Number.isFinite(generatedAtMs)) throw new Error('summary v3 identity is invalid');
  const documentJson = JSON.stringify(meetingFactsResultV3ToWire(result));
  const coverageJson = JSON.stringify(meetingFactsResultV3ToWire(result).coverage);
  await withMeetingDatabaseTransaction(async database => {
    const meeting = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM meeting_notes WHERE id = ? AND lifecycle != ?',
      meetingId,
      'deleted',
    );
    if (!meeting) throw new Error('summary v3 meeting is unavailable');
    const existing = await database.getFirstAsync<FactDocumentRow>(
      `SELECT id, meeting_id, summary_version_id, document_json
       FROM summary_fact_documents
       WHERE meeting_id = ? AND source_fingerprint = ?
         AND model_revision = ? AND prompt_revision = ?`,
      meetingId,
      result.sourceFingerprint,
      result.modelRevision,
      result.promptRevision,
    );
    if (existing) {
      const decoded = parseStoredDocument(existing);
      if (!decoded || decoded.documentId !== result.documentId) {
        throw new Error('summary v3 immutable identity changed');
      }
      return;
    }
    await database.runAsync(
      `INSERT INTO summary_fact_documents (
         id, meeting_id, summary_version_id, source_fingerprint,
         transcript_revision, model_revision, prompt_revision,
         document_json, coverage_json, generated_at_ms, created_at_ms
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      result.documentId,
      meetingId,
      result.sourceFingerprint,
      result.transcriptRevision,
      result.modelRevision,
      result.promptRevision,
      documentJson,
      coverageJson,
      generatedAtMs,
      Date.now(),
    );
  });
}

export async function linkMeetingFactsToSummaryVersion(
  meetingId: string,
  documentId: string,
  versionId: string,
): Promise<boolean> {
  return withMeetingDatabaseTransaction(async database => {
    const version = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM summary_versions WHERE id = ? AND meeting_id = ?',
      versionId,
      meetingId,
    );
    if (!version) return false;
    const row = await database.getFirstAsync<{ summary_version_id: string | null }>(
      'SELECT summary_version_id FROM summary_fact_documents WHERE id = ? AND meeting_id = ?',
      documentId,
      meetingId,
    );
    if (!row) return false;
    if (row.summary_version_id && row.summary_version_id !== versionId) {
      throw new Error('summary v3 document is already linked to another version');
    }
    await database.runAsync(
      'UPDATE summary_fact_documents SET summary_version_id = ? WHERE id = ? AND meeting_id = ?',
      versionId,
      documentId,
      meetingId,
    );
    return true;
  });
}

export async function loadLatestMeetingFactsV3(meetingId: string): Promise<MeetingFactsResultV3 | null> {
  return (await loadLatestMeetingFactsRecordV3(meetingId))?.result ?? null;
}

export async function loadLatestMeetingFactsRecordV3(
  meetingId: string,
): Promise<StoredMeetingFactsV3 | null> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<FactDocumentRow>(
    `SELECT id, meeting_id, summary_version_id, document_json
     FROM summary_fact_documents WHERE meeting_id = ?
     ORDER BY generated_at_ms DESC, id DESC LIMIT 1`,
    meetingId,
  );
  const result = parseStoredDocument(row);
  return row && result ? {
    canonicalMeetingId: row.meeting_id,
    summaryVersionId: row.summary_version_id,
    result,
  } : null;
}

export async function loadMeetingFactsV3ForVersion(versionId: string): Promise<MeetingFactsResultV3 | null> {
  return (await loadMeetingFactsRecordV3ForVersion(versionId))?.result ?? null;
}

export async function loadMeetingFactsRecordV3ForVersion(
  versionId: string,
): Promise<StoredMeetingFactsV3 | null> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<FactDocumentRow>(
    `SELECT id, meeting_id, summary_version_id, document_json
     FROM summary_fact_documents WHERE summary_version_id = ? LIMIT 1`,
    versionId,
  );
  const result = parseStoredDocument(row);
  return row && result ? {
    canonicalMeetingId: row.meeting_id,
    summaryVersionId: row.summary_version_id,
    result,
  } : null;
}

export async function loadSummaryViewPreference(
  meetingId: string,
): Promise<{ templateId: MeetingTemplateId; templateRevision: 3 }> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{ template_id: string; template_revision: number }>(
    'SELECT template_id, template_revision FROM summary_view_preferences WHERE meeting_id = ?',
    meetingId,
  );
  if (!row || row.template_revision !== 3) return { templateId: 'general', templateRevision: 3 };
  return { templateId: requireTemplateId(row.template_id), templateRevision: 3 };
}

export async function saveSummaryViewPreference(
  meetingId: string,
  templateId: MeetingTemplateId,
): Promise<void> {
  requireTemplateId(templateId);
  await withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `INSERT INTO summary_view_preferences (meeting_id, template_id, template_revision, updated_at_ms)
       VALUES (?, ?, 3, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET
         template_id = excluded.template_id,
         template_revision = 3,
         updated_at_ms = excluded.updated_at_ms`,
      meetingId,
      templateId,
      Date.now(),
    );
  });
}

export async function loadSummaryViewOverrides(
  versionId: string,
  templateId: MeetingTemplateId,
): Promise<readonly SummaryViewOverrideV3[]> {
  requireTemplateId(templateId);
  const database = await openMeetingDatabase();
  const rows = await database.getAllAsync<{
    version_id: string;
    template_id: string;
    stable_block_key: string;
    replacement_kind: 'paragraph' | 'bullet_group';
    replacement_text: string;
    user_edited_at_ms: number;
  }>(
    `SELECT * FROM summary_view_overrides
     WHERE version_id = ? AND template_id = ?
     ORDER BY stable_block_key`,
    versionId,
    templateId,
  );
  return rows.map(row => ({
    versionId: row.version_id,
    templateId: requireTemplateId(row.template_id),
    stableBlockKey: row.stable_block_key,
    replacementKind: row.replacement_kind,
    replacementText: row.replacement_text,
    userEditedAtMs: row.user_edited_at_ms,
  }));
}

export async function saveSummaryViewOverride(value: SummaryViewOverrideV3): Promise<void> {
  requireTemplateId(value.templateId);
  const normalized = value.replacementText.replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > 20_000) throw new Error('summary override text is invalid');
  await withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `INSERT INTO summary_view_overrides (
         version_id, template_id, stable_block_key, replacement_kind,
         replacement_text, user_edited_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(version_id, template_id, stable_block_key) DO UPDATE SET
         replacement_kind = excluded.replacement_kind,
         replacement_text = excluded.replacement_text,
         user_edited_at_ms = excluded.user_edited_at_ms`,
      value.versionId,
      value.templateId,
      value.stableBlockKey,
      value.replacementKind,
      normalized,
      value.userEditedAtMs,
    );
  });
}

export async function deleteSummaryViewOverride(
  versionId: string,
  templateId: MeetingTemplateId,
  stableBlockKey: string,
): Promise<void> {
  await withMeetingDatabaseTransaction(async database => {
    await database.runAsync(
      `DELETE FROM summary_view_overrides
       WHERE version_id = ? AND template_id = ? AND stable_block_key = ?`,
      versionId,
      requireTemplateId(templateId),
      stableBlockKey,
    );
  });
}

export async function claimNextSummaryV3UpgradeTask(nowMs = Date.now()): Promise<SummaryV3UpgradeTask | null> {
  return withMeetingDatabaseTransaction(async database => {
    const active = await database.getFirstAsync<{ meeting_id: string }>(
      "SELECT meeting_id FROM summary_v3_upgrade_tasks WHERE status = 'running' LIMIT 1",
    );
    if (active) return null;
    const userWork = await database.getFirstAsync<{ meeting_id: string }>(
      `SELECT meeting_id FROM processing_stages
       WHERE (stage = 'capture' AND status IN ('preparing','recording','paused','finalizing'))
          OR (stage = 'upload' AND status IN ('queued','uploading'))
          OR (stage = 'transcript' AND status IN ('queued','realtime_draft','finalizing'))
          OR (stage = 'summary' AND status IN ('queued','generating'))
          OR (stage = 'speaker' AND status = 'processing')
       LIMIT 1`,
    );
    if (userWork) return null;
    const task = await database.getFirstAsync<{
      meeting_id: string;
      attempt_count: number;
      remote_task_id: string | null;
    }>(
      `SELECT meeting_id, attempt_count, remote_task_id
       FROM summary_v3_upgrade_tasks
       WHERE status IN ('pending','failure') AND attempt_count < 3
         AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
       ORDER BY updated_at_ms, meeting_id LIMIT 1`,
      nowMs,
    );
    if (!task) return null;
    await database.runAsync(
      `UPDATE summary_v3_upgrade_tasks
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error_code = NULL, updated_at_ms = ?
       WHERE meeting_id = ?`,
      nowMs,
      task.meeting_id,
    );
    return {
      meetingId: task.meeting_id,
      attemptCount: task.attempt_count + 1,
      remoteTaskId: task.remote_task_id,
    };
  });
}

export async function enqueueMissingSummaryV3UpgradeTasks(nowMs = Date.now()): Promise<number> {
  const database = await openMeetingDatabase();
  const result = await database.runAsync(
    `INSERT OR IGNORE INTO summary_v3_upgrade_tasks (
       meeting_id, status, attempt_count, remote_task_id, next_attempt_at_ms,
       last_error_code, created_at_ms, updated_at_ms, completed_at_ms
     )
     SELECT DISTINCT version.meeting_id, 'pending', 0, NULL, NULL, NULL, ?, ?, NULL
     FROM summary_versions version
     INNER JOIN meeting_notes meeting ON meeting.id = version.meeting_id
     WHERE meeting.scope_key = 'guest' AND meeting.lifecycle != 'deleted'
       AND version.status IN ('ready','stale')
       AND EXISTS (
         SELECT 1 FROM transcript_revisions transcript
         WHERE transcript.meeting_id = version.meeting_id
           AND transcript.is_active = 1 AND transcript.status = 'ready'
       )
       AND NOT EXISTS (
         SELECT 1 FROM summary_fact_documents facts
         WHERE facts.meeting_id = version.meeting_id
       )`,
    nowMs,
    nowMs,
  );
  return result.changes;
}

export async function recoverInterruptedSummaryV3UpgradeTasks(nowMs = Date.now()): Promise<number> {
  const database = await openMeetingDatabase();
  const result = await database.runAsync(
    `UPDATE summary_v3_upgrade_tasks
     SET status = 'pending', attempt_count = MAX(0, attempt_count - 1),
         next_attempt_at_ms = ?, last_error_code = 'app_interrupted',
         updated_at_ms = ?, completed_at_ms = NULL
     WHERE status = 'running'`,
    nowMs,
    nowMs,
  );
  return result.changes;
}

export async function saveSummaryV3UpgradeRemoteTaskId(
  meetingId: string,
  remoteTaskId: string,
): Promise<void> {
  const database = await openMeetingDatabase();
  await database.runAsync(
    `UPDATE summary_v3_upgrade_tasks SET remote_task_id = ?, updated_at_ms = ?
     WHERE meeting_id = ? AND status = 'running'`,
    remoteTaskId,
    Date.now(),
    meetingId,
  );
}

export async function deferSummaryV3UpgradeTask(
  meetingId: string,
  attemptCount: number,
  nowMs = Date.now(),
): Promise<void> {
  const database = await openMeetingDatabase();
  await database.runAsync(
    `UPDATE summary_v3_upgrade_tasks
     SET status = 'pending', attempt_count = ?, next_attempt_at_ms = ?,
         last_error_code = NULL, updated_at_ms = ?, completed_at_ms = NULL
     WHERE meeting_id = ? AND status = 'running'`,
    Math.max(0, attemptCount - 1),
    nowMs + 60_000,
    nowMs,
    meetingId,
  );
}

export async function hasInteractiveMeetingWork(): Promise<boolean> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{ active: number }>(
    `SELECT 1 AS active FROM processing_stages
     WHERE (stage = 'capture' AND status IN ('preparing','recording','paused','finalizing'))
        OR (stage = 'upload' AND status IN ('queued','uploading'))
        OR (stage = 'transcript' AND status IN ('queued','realtime_draft','finalizing'))
        OR (stage = 'summary' AND status IN ('queued','generating'))
        OR (stage = 'speaker' AND status = 'processing')
     LIMIT 1`,
  );
  return Boolean(row);
}

export async function loadSummaryV3UpgradeMeetingContext(
  canonicalMeetingId: string,
): Promise<SummaryV3UpgradeMeetingContext | null> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{
    canonical_meeting_id: string;
    legacy_meeting_id: string;
    title: string;
  }>(
    `SELECT meeting.id AS canonical_meeting_id, meeting.title,
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
     FROM meeting_notes meeting
     WHERE meeting.id = ? AND meeting.scope_key = 'guest' AND meeting.lifecycle != 'deleted'`,
    canonicalMeetingId,
  );
  return row ? {
    canonicalMeetingId: row.canonical_meeting_id,
    legacyMeetingId: row.legacy_meeting_id,
    title: row.title,
  } : null;
}

export async function summaryV3UpgradeIsRunning(meetingId: string): Promise<boolean> {
  const database = await openMeetingDatabase();
  const row = await database.getFirstAsync<{ status: string }>(
    'SELECT status FROM summary_v3_upgrade_tasks WHERE meeting_id = ?',
    meetingId,
  );
  return row?.status === 'running';
}

export async function settleSummaryV3UpgradeTask(
  meetingId: string,
  outcome: { success: true } | { success: false; errorCode: string; attemptCount: number },
): Promise<void> {
  const nowMs = Date.now();
  await withMeetingDatabaseTransaction(async database => {
    if (outcome.success) {
      await database.runAsync(
        `UPDATE summary_v3_upgrade_tasks
         SET status = 'success', remote_task_id = NULL, next_attempt_at_ms = NULL,
             last_error_code = NULL, updated_at_ms = ?, completed_at_ms = ?
         WHERE meeting_id = ?`,
        nowMs,
        nowMs,
        meetingId,
      );
      return;
    }
    const delays = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
    const delay = delays[Math.max(0, Math.min(delays.length - 1, outcome.attemptCount - 1))];
    await database.runAsync(
      `UPDATE summary_v3_upgrade_tasks
       SET status = 'failure', next_attempt_at_ms = ?, last_error_code = ?,
           updated_at_ms = ?, completed_at_ms = NULL
       WHERE meeting_id = ?`,
      nowMs + delay,
      outcome.errorCode.slice(0, 160),
      nowMs,
      meetingId,
    );
  });
}
