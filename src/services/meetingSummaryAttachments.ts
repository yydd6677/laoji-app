import * as Crypto from 'expo-crypto';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryAttachmentItem,
  type ScopeKey,
} from '../domain/meeting';
import type { MeetingAttachmentRecord } from '../data/repositories';
import { requireFreshMeetingCapability } from '../data/api/v2';
import { loadMeetingAttachments } from './meetingAttachments';

const MAX_SUMMARY_ATTACHMENTS = 12;
const MAX_ATTACHMENT_TEXT_LENGTH = 2_000;
const MAX_TOTAL_ATTACHMENT_TEXT_LENGTH = 12_000;

export class MeetingSummaryAttachmentSelectionStaleError extends Error {
  constructor() {
    super('所选附件已变化，请重新选择后再生成。');
    this.name = 'MeetingSummaryAttachmentSelectionStaleError';
  }
}

export class MeetingSummaryAttachmentCapabilityUnavailableError extends Error {
  constructor() {
    super('附件暂时无法用于整理。');
    this.name = 'MeetingSummaryAttachmentCapabilityUnavailableError';
  }
}

function normalizedId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new MeetingSummaryAttachmentSelectionStaleError();
  }
  return normalized;
}

function normalizedContent(value: string | null): string {
  const normalized = (value ?? '').replace(/\r\n?/g, '\n').trim();
  if (
    !normalized
    || normalized.length > MAX_ATTACHMENT_TEXT_LENGTH
    || /\u0000/.test(normalized)
  ) throw new MeetingSummaryAttachmentSelectionStaleError();
  return normalized;
}

async function contentHash(content: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content);
  return `sha256:${digest.toLocaleLowerCase()}`;
}

function selectedAttachmentIds(values: readonly string[]): string[] {
  const normalized = values.map(normalizedId);
  if (
    normalized.length < 1
    || normalized.length > MAX_SUMMARY_ATTACHMENTS
    || new Set(normalized).size !== normalized.length
  ) throw new MeetingSummaryAttachmentSelectionStaleError();
  return normalized;
}

function selectedTextRecords(
  records: readonly MeetingAttachmentRecord[],
  ids: readonly string[],
): MeetingAttachmentRecord[] {
  const selected = new Set(ids);
  const matched = records.filter(record => selected.has(record.id));
  if (
    matched.length !== selected.size
    || matched.some(record => record.kind !== 'text')
  ) throw new MeetingSummaryAttachmentSelectionStaleError();
  return matched;
}

async function authorizedItem(record: MeetingAttachmentRecord): Promise<MeetingSummaryAttachmentItem> {
  const content = normalizedContent(record.textContent);
  return {
    attachmentId: normalizedId(record.id),
    kind: 'text',
    positionMs: Math.max(0, Math.trunc(record.positionMs)),
    content,
    contentSha256: await contentHash(content),
    updatedAtMs: Math.max(0, Math.trunc(record.updatedAtMs)),
  };
}

export async function authorizeMeetingSummaryAttachments(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  attachmentIds: readonly string[];
  accessToken?: string | null;
}): Promise<MeetingSummaryAttachmentAuthorization> {
  assertScopeKey(input.scopeKey);
  const ids = selectedAttachmentIds(input.attachmentIds);
  try {
    await requireFreshMeetingCapability('summaryAttachmentsText', input.accessToken);
  } catch {
    throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  }
  const records = selectedTextRecords(
    await loadMeetingAttachments(input.scopeKey, input.meetingId),
    ids,
  );
  const items = await Promise.all(records.map(authorizedItem));
  if (items.reduce((total, item) => total + item.content.length, 0) > MAX_TOTAL_ATTACHMENT_TEXT_LENGTH) {
    throw new MeetingSummaryAttachmentSelectionStaleError();
  }
  return { requestId: secureClientIdFactory.create(), items };
}

export async function meetingSummaryAttachmentAuthorizationIsCurrent(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  authorization: MeetingSummaryAttachmentAuthorization;
}): Promise<boolean> {
  assertScopeKey(input.scopeKey);
  try {
    const ids = selectedAttachmentIds(input.authorization.items.map(item => item.attachmentId));
    const records = selectedTextRecords(
      await loadMeetingAttachments(input.scopeKey, input.meetingId),
      ids,
    );
    const currentItems = await Promise.all(records.map(authorizedItem));
    if (currentItems.length !== input.authorization.items.length) return false;
    const expectedById = new Map(input.authorization.items.map(item => [item.attachmentId, item]));
    return currentItems.every(current => {
      const expected = expectedById.get(current.attachmentId);
      return Boolean(
        expected
        && expected.kind === current.kind
        && expected.positionMs === current.positionMs
        && expected.content === current.content
        && expected.contentSha256 === current.contentSha256
        && expected.updatedAtMs === current.updatedAtMs,
      );
    });
  } catch {
    return false;
  }
}
