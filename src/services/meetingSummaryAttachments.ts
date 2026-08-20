import * as Crypto from 'expo-crypto';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryAttachmentItem,
  type ScopeKey,
} from '../domain/meeting';
import type { MeetingAttachmentRecord } from '../data/repositories';
import { loadMeetingCapabilities } from '../data/api/v2';
import { loadMeetingAttachments } from './meetingAttachments';
import { loadDeviceServiceCapabilities } from './deviceApi';

const MAX_SUMMARY_ATTACHMENTS = 12;
const MAX_SUMMARY_IMAGE_ATTACHMENTS = 4;
const MAX_SINGLE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_LENGTH = 2_000;
const MAX_TOTAL_ATTACHMENT_TEXT_LENGTH = 12_000;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

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

export function meetingSummaryImageAttachmentIsSelectable(record: MeetingAttachmentRecord): boolean {
  return record.kind === 'image'
    && record.syncState === 'synced'
    && record.pendingOperation === null
    && Boolean(record.remoteId)
    && Number.isSafeInteger(record.remoteRevision)
    && (record.remoteRevision ?? 0) >= 1
    && Boolean(record.mimeType && ALLOWED_IMAGE_MIME_TYPES.has(record.mimeType.toLowerCase()))
    && Number.isSafeInteger(record.byteSize)
    && (record.byteSize ?? 0) >= 1
    && (record.byteSize ?? 0) <= MAX_SINGLE_IMAGE_BYTES
    && Boolean(record.checksumSha256 && /^sha256:[0-9a-f]{64}$/.test(record.checksumSha256));
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
  if (!meetingSummaryImageAttachmentIsSelectable(record)) {
    throw new MeetingSummaryAttachmentSelectionStaleError();
  }
  return {
    ...common,
    kind: 'image',
    remoteAttachmentId: normalizedId(record.remoteId!),
    remoteRevision: record.remoteRevision!,
    mimeType: record.mimeType!.toLowerCase(),
    byteSize: record.byteSize!,
    checksumSha256: record.checksumSha256!,
  };
}

async function freshAttachmentCapabilities(input: {
  scopeKey: ScopeKey;
  accessToken?: string | null;
}) {
  if (input.scopeKey === 'guest') {
    try {
      const capabilities = await loadDeviceServiceCapabilities({ forceRefresh: true });
      return {
        summaryAttachmentsText: capabilities.summaryAttachmentsText,
        summaryAttachmentsImage: false,
        meetingAttachmentsV1: false,
      };
    } catch {
      throw new MeetingSummaryAttachmentCapabilityUnavailableError();
    }
  }
  try {
    const state = await loadMeetingCapabilities({
      accessToken: input.accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
    if (state.source !== 'remote') throw new Error('capability source is stale');
    return state.capabilities;
  } catch {
    throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  }
}

export async function canUseMeetingSummaryImageAttachments(input: {
  scopeKey: ScopeKey;
  accessToken?: string | null;
}): Promise<boolean> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) return false;
  const capabilities = await freshAttachmentCapabilities(input);
  return capabilities.summaryAttachmentsImage && capabilities.meetingAttachmentsV1;
}

export async function authorizeMeetingSummaryAttachments(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  attachmentIds: readonly string[];
  accessToken?: string | null;
}): Promise<MeetingSummaryAttachmentAuthorization> {
  assertScopeKey(input.scopeKey);
  const ids = selectedAttachmentIds(input.attachmentIds);
  const records = selectedRecords(
    await loadMeetingAttachments(input.scopeKey, input.meetingId),
    ids,
  );
  const textRecords = records.filter(record => record.kind === 'text');
  const imageRecords = records.filter(record => record.kind === 'image');
  if (
    imageRecords.length > MAX_SUMMARY_IMAGE_ATTACHMENTS
    || imageRecords.reduce((total, record) => total + (record.byteSize ?? 0), 0) > MAX_TOTAL_IMAGE_BYTES
    || imageRecords.some(record => !meetingSummaryImageAttachmentIsSelectable(record))
  ) throw new MeetingSummaryAttachmentSelectionStaleError();
  const capabilities = await freshAttachmentCapabilities(input);
  if (textRecords.length > 0 && !capabilities.summaryAttachmentsText) {
    throw new MeetingSummaryAttachmentCapabilityUnavailableError();
  }
  if (
    imageRecords.length > 0
    && (
      input.scopeKey === 'guest'
      || !input.accessToken
      || !capabilities.summaryAttachmentsImage
      || !capabilities.meetingAttachmentsV1
    )
  ) throw new MeetingSummaryAttachmentCapabilityUnavailableError();
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
  accessToken?: string | null;
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
    if (currentItems.some(item => item.kind === 'image')) {
      if (!await canUseMeetingSummaryImageAttachments({
        scopeKey: input.scopeKey,
        accessToken: input.accessToken,
      })) return false;
    }
    const expectedById = new Map(input.authorization.items.map(item => [item.attachmentId, item]));
    return currentItems.every(current => {
      const expected = expectedById.get(current.attachmentId);
      if (!expected || expected.kind !== current.kind) return false;
      if (
        expected.positionMs !== current.positionMs
        || expected.updatedAtMs !== current.updatedAtMs
      ) return false;
      return current.kind === 'text'
        ? expected.kind === 'text'
          && expected.content === current.content
          && expected.contentSha256 === current.contentSha256
        : expected.kind === 'image'
          && expected.remoteAttachmentId === current.remoteAttachmentId
          && expected.remoteRevision === current.remoteRevision
          && expected.mimeType === current.mimeType
          && expected.byteSize === current.byteSize
          && expected.checksumSha256 === current.checksumSha256;
    });
  } catch {
    return false;
  }
}
