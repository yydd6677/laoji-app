import { secureClientIdFactory } from '../domain/meeting';
import type { ScopeKey } from '../domain/meeting';
import { ManageMeetingAttachmentsUseCase } from '../application/meeting';
import { sqliteMeetingNoteRepository, type MeetingAttachmentRecord } from '../data/repositories';
import {
  deleteMeetingAttachmentFile,
  storeMeetingAttachmentImage,
} from './meetingAttachmentStorage';

const attachments = new ManageMeetingAttachmentsUseCase(sqliteMeetingNoteRepository);

export function loadMeetingAttachments(
  scopeKey: ScopeKey,
  navigationMeetingId: string,
): Promise<readonly MeetingAttachmentRecord[]> {
  return attachments.list(navigationMeetingId, scopeKey);
}

export function addMeetingTextAttachment(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  markerId: string;
  positionMs: number;
  text: string;
}): Promise<MeetingAttachmentRecord> {
  return attachments.addText(input);
}

export async function addMeetingImageAttachment(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  markerId: string;
  positionMs: number;
  sourceUri: string;
  fileName?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
}): Promise<MeetingAttachmentRecord> {
  const attachmentId = secureClientIdFactory.create();
  const stored = await storeMeetingAttachmentImage({
    navigationMeetingId: input.navigationMeetingId,
    attachmentId,
    sourceUri: input.sourceUri,
    fileName: input.fileName,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
  });
  try {
    return await attachments.addImage({
      attachmentId,
      navigationMeetingId: input.navigationMeetingId,
      scopeKey: input.scopeKey,
      markerId: input.markerId,
      positionMs: input.positionMs,
      ...stored,
    });
  } catch (reason) {
    await deleteMeetingAttachmentFile(stored.localUri).catch(() => {});
    throw reason;
  }
}

export async function deleteMeetingAttachment(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  attachmentId: string;
}): Promise<{ attachment: MeetingAttachmentRecord | null; cleanupFailed: boolean }> {
  const attachment = await attachments.delete(input);
  if (!attachment?.localUri) return { attachment, cleanupFailed: false };
  try {
    await deleteMeetingAttachmentFile(attachment.localUri);
    return { attachment, cleanupFailed: false };
  } catch {
    return { attachment, cleanupFailed: true };
  }
}
