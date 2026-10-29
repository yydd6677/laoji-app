import * as Crypto from 'expo-crypto';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryAttachmentItem,
  type ScopeKey,
} from '../domain/meeting';
import type { MeetingAttachmentRecord } from "../data/repositories/meetingNoteRepository";
import { loadMeetingAttachments } from './meetingAttachments';
import { loadDeviceServiceCapabilities } from './deviceApi';

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

function selectedRecords(
  records: readonly MeetingAttachmentRecord[],
  ids: readonly string[],
): MeetingAttachmentRecord[] {
  const byId = new Map(records.map(record => [record.id, record]));
  const matched = ids.map(id => byId.get(id) ?? null);
  if (matched.some(record => record === null)) {
    throw new MeetingSummaryAttachmentSelectionStaleError();
  }
  return matched as MeetingAttachmentRecord[];
}

export function meetingSummaryImageAttachmentIsSelectable(_record: MeetingAttachmentRecord): boolean {
  return false;
}

async function authorizedItem(record: MeetingAttachmentRecord): Promise<MeetingSummaryAttachmentItem> {
  const common = {
    attachmentId: normalizedId(record.id),
    positionMs: Math.max(0, Math.trunc(record.positionMs)),
    updatedAtMs: Math.max(0, Math.trunc(record.updatedAtMs)),
  };
  if (record.kind === 'text') {
    const content = normalizedContent(record.textContent);
    return {
      ...common,
      kind: 'text',
      content,
      contentSha256: await contentHash(content),
    };
  }
  throw new MeetingSummaryAttachmentCapabilityUnavailableError();
}

async function freshAttachmentCapabilities() {
  try {
    const capabilities = await loadDeviceServiceCapabilities({ forceRefresh: true });
    return {
      summaryAttachmentsText: capabilities.summaryAttachmentsText,
    };
  } catch {
    throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  }
}

export async function canUseMeetingSummaryImageAttachments(): Promise<boolean> {
  return false;
}

export async function authorizeMeetingSummaryAttachments(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  attachmentIds: readonly string[];
}): Promise<MeetingSummaryAttachmentAuthorization> {
  assertScopeKey(input.scopeKey);
  const ids = selectedAttachmentIds(input.attachmentIds);
  const records = selectedRecords(
    await loadMeetingAttachments(input.scopeKey, input.meetingId),
    ids,
  );
  const textRecords = records.filter(record => record.kind === 'text');
  const imageRecords = records.filter(record => record.kind === 'image');
  if (imageRecords.length > 0) throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  const capabilities = await freshAttachmentCapabilities();
  if (textRecords.length > 0 && !capabilities.summaryAttachmentsText) {
    throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  }
  const items = await Promise.all(records.map(authorizedItem));
  const textLength = items.reduce(
    (total, item) => total + (item.kind === 'text' ? item.content.length : 0),
    0,
  );
  if (textLength > MAX_TOTAL_ATTACHMENT_TEXT_LENGTH) {
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
    const records = selectedRecords(
      await loadMeetingAttachments(input.scopeKey, input.meetingId),
      ids,
    );
    const currentItems = await Promise.all(records.map(authorizedItem));
    if (currentItems.length !== input.authorization.items.length) return false;
    if (currentItems.some(item => item.kind === 'image')) return false;
    const expectedById = new Map(input.authorization.items.map(item => [item.attachmentId, item]));
    return currentItems.every(current => {
      const expected = expectedById.get(current.attachmentId);
      if (!expected || expected.kind !== current.kind) return false;
      if (
        expected.positionMs !== current.positionMs
        || expected.updatedAtMs !== current.updatedAtMs
      ) return false;
      return current.kind === 'text'
        && expected.kind === 'text'
        && expected.content === current.content
        && expected.contentSha256 === current.contentSha256;
    });
  } catch {
    return false;
  }
}
