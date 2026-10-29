import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingSummaryAttachmentAuthorization,
  type ScopeKey,
} from '../domain/meeting';
import { getActiveAttachmentTextRevision } from '../data/repositories/vnext/immutableSourceRepository';
import { loadMeetingAttachments } from './meetingAttachments';

const MAX_QUESTION_ATTACHMENTS = 12;
const MAX_ATTACHMENT_TEXT_LENGTH = 2_000;
const MAX_TOTAL_ATTACHMENT_TEXT_LENGTH = 12_000;

export class MeetingQuestionAttachmentSelectionStaleError extends Error {
  constructor() {
    super('所选附件已变化，请重新选择。');
    this.name = 'MeetingQuestionAttachmentSelectionStaleError';
  }
}

function normalizedId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new MeetingQuestionAttachmentSelectionStaleError();
  }
  return normalized;
}

function normalizedContent(value: string | null): string {
  const normalized = (value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > MAX_ATTACHMENT_TEXT_LENGTH || normalized.includes('\u0000')) {
    throw new MeetingQuestionAttachmentSelectionStaleError();
  }
  return normalized;
}

/**
 * Create a generation-scoped authorization from device-primary text
 * attachments. Q2 uploads the selected immutable text through source.stream.v2;
 * the immutable authorization below is the only attachment contract it needs.
 */
export async function authorizeMeetingQuestionAttachments(input: {
  scopeKey: ScopeKey;
  navigationMeetingId: string;
  attachmentIds: readonly string[];
}): Promise<MeetingSummaryAttachmentAuthorization> {
  assertScopeKey(input.scopeKey);
  const ids = input.attachmentIds.map(normalizedId);
  if (
    ids.length < 1
    || ids.length > MAX_QUESTION_ATTACHMENTS
    || new Set(ids).size !== ids.length
  ) throw new MeetingQuestionAttachmentSelectionStaleError();
  const records = await loadMeetingAttachments(input.scopeKey, input.navigationMeetingId);
  const byId = new Map(records.map(record => [record.id, record]));
  const items = [];
  let totalLength = 0;
  for (const attachmentId of ids) {
    const record = byId.get(attachmentId);
    if (!record || record.kind !== 'text') {
      throw new MeetingQuestionAttachmentSelectionStaleError();
    }
    const content = normalizedContent(record.textContent);
    const immutable = await getActiveAttachmentTextRevision({
      attachmentId,
      meetingId: record.meetingId,
    });
    if (
      !immutable
      || immutable.content !== content
      || !/^sha256:[0-9a-f]{64}$/.test(immutable.contentSha256)
    ) throw new MeetingQuestionAttachmentSelectionStaleError();
    totalLength += content.length;
    if (totalLength > MAX_TOTAL_ATTACHMENT_TEXT_LENGTH) {
      throw new MeetingQuestionAttachmentSelectionStaleError();
    }
    items.push({
      attachmentId,
      kind: 'text' as const,
      positionMs: Math.max(0, Math.trunc(record.positionMs)),
      content,
      contentSha256: immutable.contentSha256,
      updatedAtMs: Math.max(0, Math.trunc(record.updatedAtMs)),
    });
  }
  return { requestId: secureClientIdFactory.create(), items };
}
