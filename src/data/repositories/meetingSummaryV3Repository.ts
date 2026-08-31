import type { MeetingFactsResultV3, MeetingTemplateId } from '../../domain/meeting';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../db/openDatabase';
import {
  meetingFactsResultV3ToWire,
  parseMeetingFactsResultV3,
} from '../../services/meetingSummaryV3';

export interface SummaryViewOverrideV3 {
  versionId: string;
  templateId: MeetingTemplateId;
  stableBlockKey: string;
  replacementKind: 'paragraph' | 'bullet_group';
  replacementText: string;
  userEditedAtMs: number;
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

function requireCurrentTemplateId(value: string): MeetingTemplateId {
  if (value !== 'general') throw new Error('summary presentation id is invalid');
  return 'general';
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
       WHERE id = ?`,
      result.documentId,
    );
    if (existing) {
      const decoded = parseStoredDocument(existing);
      if (
        existing.meeting_id !== meetingId
        || !decoded
        || JSON.stringify(meetingFactsResultV3ToWire(decoded)) !== documentJson
      ) {
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
    if (!version) throw new Error('summary v3 target version is unavailable');
    const row = await database.getFirstAsync<{ summary_version_id: string | null }>(
      'SELECT summary_version_id FROM summary_fact_documents WHERE id = ? AND meeting_id = ?',
      documentId,
      meetingId,
    );
    if (!row) throw new Error('summary v3 fact document is unavailable');
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

export async function loadSummaryViewOverrides(
  versionId: string,
  templateId: MeetingTemplateId,
): Promise<readonly SummaryViewOverrideV3[]> {
  requireCurrentTemplateId(templateId);
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
    templateId: requireCurrentTemplateId(row.template_id),
    stableBlockKey: row.stable_block_key,
    replacementKind: row.replacement_kind,
    replacementText: row.replacement_text,
    userEditedAtMs: row.user_edited_at_ms,
  }));
}

export async function saveSummaryViewOverride(value: SummaryViewOverrideV3): Promise<void> {
  requireCurrentTemplateId(value.templateId);
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
      requireCurrentTemplateId(templateId),
      stableBlockKey,
    );
  });
}
