import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openMeetingDatabase, withMeetingDatabaseTransaction } from '../../db/openDatabase';

export interface ManualNoteRevisionRecord {
  revisionId: string;
  meetingId: string;
  revision: number;
  content: string;
  format: string;
  contentSha256: string;
  migratedCurrent: boolean;
  createdAtMs: number;
}

export interface AttachmentTextRevisionRecord {
  revisionId: string;
  attachmentId: string;
  meetingId: string;
  revision: number;
  contentKind: 'text' | 'extracted_text';
  content: string;
  contentSha256: string;
  sourceAssetSha256: string | null;
  extractorRevision: string | null;
  migratedCurrent: boolean;
  createdAtMs: number;
}

type NoteRow = {
  revision_id: string;
  meeting_id: string;
  revision: number;
  content: string;
  format: string;
  content_sha256: string;
  migrated_current: number;
  created_at_ms: number;
};

type AttachmentRow = {
  revision_id: string;
  attachment_id: string;
  meeting_id: string;
  revision: number;
  content_kind: 'text' | 'extracted_text';
  content: string;
  content_sha256: string;
  source_asset_sha256: string | null;
  extractor_revision: string | null;
  migrated_current: number;
  created_at_ms: number;
};

function text(value: string, field: string): string {
  if (typeof value !== 'string' || value.length > 2_000_000 || /[\u0000]/.test(value)) {
    throw new Error(`${field} 无效`);
  }
  return value;
}

function noteFromRow(row: NoteRow | null): ManualNoteRevisionRecord | null {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    meetingId: row.meeting_id,
    revision: Number(row.revision),
    content: row.content,
    format: row.format,
    contentSha256: row.content_sha256,
    migratedCurrent: row.migrated_current === 1,
    createdAtMs: Number(row.created_at_ms),
  };
}

function attachmentFromRow(row: AttachmentRow | null): AttachmentTextRevisionRecord | null {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    attachmentId: row.attachment_id,
    meetingId: row.meeting_id,
    revision: Number(row.revision),
    contentKind: row.content_kind,
    content: row.content,
    contentSha256: row.content_sha256,
    sourceAssetSha256: row.source_asset_sha256,
    extractorRevision: row.extractor_revision,
    migratedCurrent: row.migrated_current === 1,
    createdAtMs: Number(row.created_at_ms),
  };
}

export async function sha256Text(value: string): Promise<string> {
  return `sha256:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)}`;
}

export async function getCurrentManualNoteRevision(meetingId: string): Promise<ManualNoteRevisionRecord | null> {
  const database = await openMeetingDatabase();
  return noteFromRow(await database.getFirstAsync<NoteRow>(
    `SELECT revision_id, meeting_id, revision, content, format, content_sha256,
            migrated_current, created_at_ms
       FROM manual_note_revisions
      WHERE meeting_id = ? ORDER BY revision DESC, revision_id DESC LIMIT 1`,
    text(meetingId, 'meetingId'),
  ));
}

export interface SaveManualNoteRevisionInput {
  meetingId: string;
  content: string;
  format?: string;
  migratedCurrent?: boolean;
  nowMs?: number;
}

export async function saveManualNoteRevision(
  input: SaveManualNoteRevisionInput,
): Promise<ManualNoteRevisionRecord> {
  const meetingId = text(input.meetingId, 'meetingId');
  const content = text(input.content, 'content');
  const format = text(input.format ?? 'plain', 'format') || 'plain';
  const nowMs = input.nowMs ?? Date.now();
  return withMeetingDatabaseTransaction(async database => {
    const contentSha256 = await sha256Text(content);
    const current = await database.getFirstAsync<{
      revision: number;
      revision_id: string;
      meeting_id: string;
      content: string;
      format: string;
      content_sha256: string;
      migrated_current: number;
      created_at_ms: number;
    }>(
      `SELECT revision, revision_id, meeting_id, content, format, content_sha256,
              migrated_current, created_at_ms
         FROM manual_note_revisions WHERE meeting_id = ? ORDER BY revision DESC LIMIT 1`,
      meetingId,
    );
    if (current && current.content_sha256 === contentSha256 && current.format === format) {
      await database.runAsync(
        'UPDATE manual_notes SET active_revision_id = ?, content = ?, format = ?, revision = ?, last_saved_at_ms = ? WHERE meeting_id = ?',
        current.revision_id,
        content,
        format,
        current.revision,
        nowMs,
        meetingId,
      );
      return noteFromRow(current as NoteRow)!;
    }
    const revision = Math.max(1, Number(current?.revision ?? 0) + 1);
    const revisionId = `manual_note:${meetingId}:${revision}`;
    await database.runAsync(
      `INSERT INTO manual_note_revisions (
        revision_id, meeting_id, revision, content, format, content_sha256,
        migrated_current, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      revisionId,
      meetingId,
      revision,
      content,
      format,
      contentSha256,
      input.migratedCurrent === false ? 0 : 1,
      nowMs,
    );
    const updated = await database.runAsync(
      'UPDATE manual_notes SET active_revision_id = ?, content = ?, format = ?, revision = ?, last_saved_at_ms = ? WHERE meeting_id = ?',
      revisionId,
      content,
      format,
      revision,
      nowMs,
      meetingId,
    );
    if (Number(updated.changes) === 0) {
      await database.runAsync(
        `INSERT INTO manual_notes (
          meeting_id, content, format, revision, last_saved_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
        meetingId,
        content,
        format,
        revision,
        nowMs,
      );
      await database.runAsync(
        'UPDATE manual_notes SET active_revision_id = ? WHERE meeting_id = ?',
        revisionId,
        meetingId,
      );
    }
    return noteFromRow(await database.getFirstAsync<NoteRow>(
      `SELECT revision_id, meeting_id, revision, content, format, content_sha256,
              migrated_current, created_at_ms
         FROM manual_note_revisions WHERE revision_id = ?`,
      revisionId,
    ))!;
  });
}

export interface SaveAttachmentTextRevisionInput {
  attachmentId: string;
  meetingId: string;
  content: string;
  contentKind?: 'text' | 'extracted_text';
  sourceAssetSha256?: string | null;
  extractorRevision?: string | null;
  migratedCurrent?: boolean;
  nowMs?: number;
}

export async function saveAttachmentTextRevision(
  input: SaveAttachmentTextRevisionInput,
): Promise<AttachmentTextRevisionRecord> {
  const attachmentId = text(input.attachmentId, 'attachmentId');
  const meetingId = text(input.meetingId, 'meetingId');
  const content = text(input.content, 'content');
  const nowMs = input.nowMs ?? Date.now();
  return withMeetingDatabaseTransaction(async database => {
    const contentSha256 = await sha256Text(content);
    const current = await database.getFirstAsync<AttachmentRow>(
      `SELECT revision_id, attachment_id, meeting_id, revision, content_kind, content,
              content_sha256, source_asset_sha256, extractor_revision, migrated_current, created_at_ms
         FROM meeting_attachment_text_revisions
        WHERE attachment_id = ? ORDER BY revision DESC LIMIT 1`,
      attachmentId,
    );
    if (current && current.content_sha256 === contentSha256
      && current.content_kind === (input.contentKind ?? 'text')
      && current.source_asset_sha256 === (input.sourceAssetSha256 ?? null)
      && current.extractor_revision === (input.extractorRevision ?? null)) {
      await database.runAsync(
        'UPDATE meeting_attachments SET active_text_revision_id = ?, text_content = ?, updated_at_ms = ? WHERE id = ? AND meeting_id = ?',
        current.revision_id,
        content,
        nowMs,
        attachmentId,
        meetingId,
      );
      return attachmentFromRow(current)!;
    }
    const revision = Math.max(1, Number(current?.revision ?? 0) + 1);
    const revisionId = `attachment_text:${attachmentId}:${revision}`;
    await database.runAsync(
      `INSERT INTO meeting_attachment_text_revisions (
        revision_id, attachment_id, meeting_id, revision, content_kind, content,
        content_sha256, source_asset_sha256, extractor_revision, migrated_current, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revisionId,
      attachmentId,
      meetingId,
      revision,
      input.contentKind ?? 'text',
      content,
      contentSha256,
      input.sourceAssetSha256 ?? null,
      input.extractorRevision ?? null,
      input.migratedCurrent === false ? 0 : 1,
      nowMs,
    );
    await database.runAsync(
      'UPDATE meeting_attachments SET active_text_revision_id = ?, text_content = ?, updated_at_ms = ? WHERE id = ? AND meeting_id = ?',
      revisionId,
      content,
      nowMs,
      attachmentId,
      meetingId,
    );
    return attachmentFromRow(await database.getFirstAsync<AttachmentRow>(
      `SELECT revision_id, attachment_id, meeting_id, revision, content_kind, content,
              content_sha256, source_asset_sha256, extractor_revision, migrated_current, created_at_ms
         FROM meeting_attachment_text_revisions WHERE revision_id = ?`,
      revisionId,
    ))!;
  });
}

export async function getCurrentAttachmentTextRevision(
  attachmentId: string,
): Promise<AttachmentTextRevisionRecord | null> {
  const database = await openMeetingDatabase();
  return attachmentFromRow(await database.getFirstAsync<AttachmentRow>(
    `SELECT revision_id, attachment_id, meeting_id, revision, content_kind, content,
            content_sha256, source_asset_sha256, extractor_revision, migrated_current, created_at_ms
       FROM meeting_attachment_text_revisions
      WHERE attachment_id = ? ORDER BY revision DESC, revision_id DESC LIMIT 1`,
    text(attachmentId, 'attachmentId'),
  ));
}

/**
 * Resolve only the immutable revision currently selected by the meeting
 * aggregate. Reading the newest history row is insufficient for a generation
 * fence: a failed or interrupted edit can leave a newer orphan revision while
 * the active pointer still owns the visible attachment text.
 */
export async function getActiveAttachmentTextRevision(input: {
  attachmentId: string;
  meetingId: string;
}): Promise<AttachmentTextRevisionRecord | null> {
  const database = await openMeetingDatabase();
  return attachmentFromRow(await database.getFirstAsync<AttachmentRow>(
    `SELECT immutable.revision_id, immutable.attachment_id, immutable.meeting_id,
            immutable.revision, immutable.content_kind, immutable.content,
            immutable.content_sha256, immutable.source_asset_sha256,
            immutable.extractor_revision, immutable.migrated_current,
            immutable.created_at_ms
       FROM meeting_attachments attachment
       INNER JOIN meeting_attachment_text_revisions immutable
         ON immutable.revision_id = attachment.active_text_revision_id
      WHERE attachment.id = ? AND attachment.meeting_id = ?
        AND attachment.kind = 'text' AND attachment.pending_operation IS NOT 'delete'
      LIMIT 1`,
    text(input.attachmentId, 'attachmentId'),
    text(input.meetingId, 'meetingId'),
  ));
}
