import { secureClientIdFactory } from '../domain/meeting';
import type { ScopeKey } from '../domain/meeting';
import { ManageMeetingAttachmentsUseCase } from '../application/meeting';
import { requestMeetingAttachmentSync } from '../application/meeting/attachmentSyncTrigger';
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
  // Account files stay available until the server acknowledges deletion. This
  // also preserves the create-then-delete path while the meeting root is still
  // waiting for its remote identity.
  if (input.scopeKey !== 'guest' || !attachment?.localUri) {
    return { attachment, cleanupFailed: false };
  }
  try {
    await deleteMeetingAttachmentFile(attachment.localUri);
    return { attachment, cleanupFailed: false };
  } catch {
    return { attachment, cleanupFailed: true };
  }
}

export async function retryMeetingAttachment(input: {
  scopeKey: Exclude<ScopeKey, 'guest'>;
  navigationMeetingId: string;
  attachmentId: string;
}): Promise<boolean> {
  const meetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
    input.navigationMeetingId,
    input.scopeKey,
  );
  if (!meetingId) throw new Error('会议记录尚未完成本机索引，请刷新后重试。');
  const retried = await sqliteMeetingNoteRepository.retryMeetingAttachmentSync(
    input.attachmentId,
    meetingId,
    input.scopeKey,
    Date.now(),
  );
  if (retried) requestMeetingAttachmentSync(input.scopeKey);
  return retried;
}
