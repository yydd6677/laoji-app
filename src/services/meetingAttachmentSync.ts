import * as FileSystem from 'expo-file-system/legacy';
import {
  deleteMeetingAttachmentV1,
  listMeetingAttachmentsV1,
  loadMeetingCapabilities,
  MeetingAttachmentConflictResponseError,
  parseRemoteMeetingAttachmentV1,
  registerMeetingAttachmentV1,
  uploadMeetingAttachmentContentV1,
  type MeetingAttachmentV1Registration,
  type RemoteMeetingAttachmentV1,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type MeetingAttachmentSyncClaim,
  type MeetingListProjectionItem,
} from '../data/repositories';
import { notifyMeetingAttachmentsChanged } from '../application/meeting/attachmentSyncTrigger';
import { requestMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import type { ScopeKey } from '../domain/meeting';
import {
  deleteMeetingAttachmentFile,
  inspectMeetingAttachmentImage,
  storeMeetingAttachmentImage,
  verifyMeetingAttachmentImage,
} from './meetingAttachmentStorage';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';
import { mergeSyncRetryAfterMs } from './syncRetryWake';

const STALE_CLAIM_MS = 90_000;
const CAPABILITY_RETRY_MS = 5 * 60_000;
const ROOT_PENDING_RETRY_MS = 5_000;
const PULL_RETRY_MS = 60_000;
const MAX_BATCHES_PER_DRAIN = 20;
const MAX_PULL_PAGES = 20;
const MEETING_PAGE_SIZE = 200;

class LocalAttachmentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAttachmentFileError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function nullableChecksum(value: unknown, required: boolean): string | null {
  if (value === null && !required) return null;
  const normalized = identifier(value, '附件校验值', 71).toLocaleLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error('附件校验值无效');
  return normalized;
}

function parseCreateRegistration(claim: MeetingAttachmentSyncClaim): MeetingAttachmentV1Registration {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) throw new Error('附件同步请求格式无效');
  const clientAttachmentId = identifier(parsed.client_attachment_id, '附件本机标识');
  if (clientAttachmentId !== claim.attachmentId) throw new Error('附件本机标识发生变化');
  const kind = parsed.kind;
  if (kind !== 'text' && kind !== 'image') throw new Error('附件类型无效');
  const textContent = nullableText(parsed.text_content, '附件文字', 500);
  const mimeType = parsed.mime_type === null
    ? null
    : identifier(parsed.mime_type, '附件格式', 160).toLocaleLowerCase();
  const fileName = parsed.file_name === null
    ? null
    : identifier(parsed.file_name, '附件文件名', 255);
  const byteSize = nullableInteger(parsed.byte_size, '附件文件大小');
  const checksumSha256 = nullableChecksum(parsed.checksum_sha256, kind === 'image');
  if (kind === 'text') {
    if (!textContent?.trim() || mimeType !== null || fileName !== null || byteSize !== null || checksumSha256 !== null) {
      throw new Error('文字附件同步内容无效');
    }
  } else if (
    textContent !== null
    || !mimeType?.startsWith('image/')
    || !fileName
    || byteSize === null
    || byteSize < 1
  ) throw new Error('照片附件同步内容无效');
  const clientCreatedAtMs = safeInteger(parsed.client_created_at_ms, '附件创建时间');
  const clientUpdatedAtMs = safeInteger(parsed.client_updated_at_ms, '附件更新时间');
  if (clientUpdatedAtMs < clientCreatedAtMs) throw new Error('附件更新时间无效');
  return {
    schema_version: 1,
    client_attachment_id: clientAttachmentId,
    position_ms: safeInteger(parsed.position_ms, '附件时间点'),
    kind,
    text_content: textContent,
    mime_type: mimeType,
    file_name: fileName,
    byte_size: byteSize,
    checksum_sha256: checksumSha256,
    client_created_at_ms: clientCreatedAtMs,
    client_updated_at_ms: clientUpdatedAtMs,
  };
}

function parseDeleteRequest(claim: MeetingAttachmentSyncClaim): {
  remoteId: string;
  expectedRevision: number;
} {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) throw new Error('附件删除请求格式无效');
  if (identifier(parsed.client_attachment_id, '附件本机标识') !== claim.attachmentId) {
    throw new Error('附件本机标识发生变化');
  }
  return {
    remoteId: identifier(parsed.remote_id, '附件云端标识', 160),
    expectedRevision: safeInteger(parsed.expected_remote_revision, '附件云端版本', 1),
  };
}

function remoteAcknowledgesRegistration(
  registration: MeetingAttachmentV1Registration,
  remote: RemoteMeetingAttachmentV1,
): boolean {
  return remote.clientAttachmentId === registration.client_attachment_id
    && remote.positionMs === registration.position_ms
    && remote.kind === registration.kind
    && remote.textContent === registration.text_content
    && remote.mimeType === registration.mime_type
    && remote.fileName === registration.file_name
    && remote.byteSize === registration.byte_size
    && remote.checksumSha256 === registration.checksum_sha256
    && remote.clientCreatedAtMs === registration.client_created_at_ms
    && remote.clientUpdatedAtMs === registration.client_updated_at_ms
    && (registration.kind === 'image'
      ? remote.lifecycle === 'registered' || remote.lifecycle === 'ready'
      : remote.lifecycle === 'ready');
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: MeetingAttachmentSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60_000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.operationId));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function currentFromConflict(
  error: MeetingAttachmentConflictResponseError,
  claim: MeetingAttachmentSyncClaim,
): RemoteMeetingAttachmentV1 {
  return parseRemoteMeetingAttachmentV1(error.remotePayload, {
    meetingRemoteId: claim.meetingRemoteId,
    clientAttachmentId: claim.attachmentId,
  });
}

async function registerAttachment(
  claim: MeetingAttachmentSyncClaim,
  registration: MeetingAttachmentV1Registration,
  accessToken: string,
  signal: AbortSignal,
): Promise<RemoteMeetingAttachmentV1> {
  try {
    return await registerMeetingAttachmentV1({
      accessToken,
      meetingRemoteId: claim.meetingRemoteId,
      idempotencyKey: claim.operationId,
      registration,
      signal,
    });
  } catch (error) {
    if (!(error instanceof MeetingAttachmentConflictResponseError)) throw error;
    const current = currentFromConflict(error, claim);
    if (!remoteAcknowledgesRegistration(registration, current)) throw error;
    return current;
  }
}

async function requireVerifiedClaimImage(
  claim: MeetingAttachmentSyncClaim,
  registration: MeetingAttachmentV1Registration,
): Promise<string> {
  if (
    registration.kind !== 'image'
    || !claim.localUri
    || claim.mimeType !== registration.mime_type
    || claim.fileName !== registration.file_name
    || claim.byteSize !== registration.byte_size
    || claim.checksumSha256 !== registration.checksum_sha256
  ) throw new LocalAttachmentFileError('待同步照片的本机信息不完整。');
  const verified = await verifyMeetingAttachmentImage({
    uri: claim.localUri,
    expectedByteSize: registration.byte_size!,
    expectedChecksumSha256: registration.checksum_sha256!,
  });
  if (!verified) throw new LocalAttachmentFileError('待同步照片已丢失或发生变化。');
  return claim.localUri;
}

async function uploadAttachment(
  claim: MeetingAttachmentSyncClaim,
  registration: MeetingAttachmentV1Registration,
  registered: RemoteMeetingAttachmentV1,
  accessToken: string,
  signal: AbortSignal,
): Promise<RemoteMeetingAttachmentV1> {
  if (registered.lifecycle === 'ready') return registered;
  const localUri = await requireVerifiedClaimImage(claim, registration);
  const upload = (remoteAttachment: RemoteMeetingAttachmentV1) => uploadMeetingAttachmentContentV1({
    accessToken,
    remoteAttachment,
    idempotencyKey: `${claim.operationId}:content`,
    localUri,
    signal,
  });
  try {
    return await upload(registered);
  } catch (error) {
    if (!(error instanceof MeetingAttachmentConflictResponseError)) throw error;
    const current = currentFromConflict(error, claim);
    if (!remoteAcknowledgesRegistration(registration, current)) throw error;
    if (current.lifecycle === 'ready') return current;
    try {
      return await upload(current);
    } catch (retryError) {
      if (!(retryError instanceof MeetingAttachmentConflictResponseError)) throw retryError;
      const retryCurrent = currentFromConflict(retryError, claim);
      if (retryCurrent.lifecycle === 'ready'
        && remoteAcknowledgesRegistration(registration, retryCurrent)) return retryCurrent;
      throw retryError;
    }
  }
}

type ClaimResult = {
  outcome: 'completed' | 'retry' | 'blocked' | 'stale';
  processed: boolean;
  retryAfterMs: number | null;
  attachmentsChanged: boolean;
};

async function processCreateClaim(
  claim: MeetingAttachmentSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  const registration = parseCreateRegistration(claim);
  let remote = await registerAttachment(claim, registration, accessToken, signal);
  if (!remoteAcknowledgesRegistration(registration, remote)) {
    throw new Error('附件注册响应未确认本次请求');
  }
  if (registration.kind === 'image') {
    remote = await uploadAttachment(claim, registration, remote, accessToken, signal);
  }
  if (!remoteAcknowledgesRegistration(registration, remote) || remote.lifecycle !== 'ready') {
    throw new Error('附件上传响应未确认本次请求');
  }
  if (!isCurrent() || signal.aborted) {
    return { outcome: 'stale', processed: false, retryAfterMs: STALE_CLAIM_MS, attachmentsChanged: false };
  }
  const completed = await sqliteMeetingNoteRepository.completeMeetingAttachmentCreateClaim(
    claim,
    remote,
    Date.now(),
  );
  return {
    outcome: completed ? 'completed' : 'stale',
    processed: completed,
    retryAfterMs: completed ? null : STALE_CLAIM_MS,
    attachmentsChanged: completed,
  };
}

async function deleteAttachment(
  claim: MeetingAttachmentSyncClaim,
  remoteId: string,
  expectedRevision: number,
  accessToken: string,
  signal: AbortSignal,
): Promise<RemoteMeetingAttachmentV1> {
  const remove = (revision: number) => deleteMeetingAttachmentV1({
    accessToken,
    remoteAttachmentId: remoteId,
    meetingRemoteId: claim.meetingRemoteId,
    clientAttachmentId: claim.attachmentId,
    expectedRevision: revision,
    idempotencyKey: claim.operationId,
    signal,
  });
  try {
    return await remove(expectedRevision);
  } catch (error) {
    if (!(error instanceof MeetingAttachmentConflictResponseError)) throw error;
    const current = currentFromConflict(error, claim);
    if (current.remoteId !== remoteId) throw error;
    if (current.lifecycle === 'deleted') return current;
    try {
      return await remove(current.revision);
    } catch (retryError) {
      if (!(retryError instanceof MeetingAttachmentConflictResponseError)) throw retryError;
      const retryCurrent = currentFromConflict(retryError, claim);
      if (retryCurrent.remoteId === remoteId && retryCurrent.lifecycle === 'deleted') return retryCurrent;
      throw retryError;
    }
  }
}

async function processDeleteClaim(
  claim: MeetingAttachmentSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  const request = parseDeleteRequest(claim);
  const remote = await deleteAttachment(
    claim,
    request.remoteId,
    request.expectedRevision,
    accessToken,
    signal,
  );
  if (remote.lifecycle !== 'deleted' || remote.remoteId !== request.remoteId) {
    throw new Error('附件删除响应未确认本次请求');
  }
  if (!isCurrent() || signal.aborted) {
    return { outcome: 'stale', processed: false, retryAfterMs: STALE_CLAIM_MS, attachmentsChanged: false };
  }
  const removed = await sqliteMeetingNoteRepository.completeMeetingAttachmentDeleteClaim(
    claim,
    remote,
    Date.now(),
  );
  if (!removed) {
    return { outcome: 'stale', processed: false, retryAfterMs: STALE_CLAIM_MS, attachmentsChanged: false };
  }
  if (removed.localUri) {
    await deleteMeetingAttachmentFile(removed.localUri).catch(error => {
      diagnosticWarn('[meeting-attachment-sync] local file cleanup failed after delete acknowledgement', error);
    });
  }
  return { outcome: 'completed', processed: true, retryAfterMs: null, attachmentsChanged: true };
}

async function processClaim(
  claim: MeetingAttachmentSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  try {
    if (claim.operationType === 'meeting_attachment.create') parseCreateRegistration(claim);
    else parseDeleteRequest(claim);
  } catch (error) {
    const applied = await sqliteMeetingNoteRepository.failMeetingAttachmentSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[meeting-attachment-sync] rejected invalid local payload', error);
    return {
      outcome: applied ? 'blocked' : 'stale',
      processed: applied,
      retryAfterMs: null,
      attachmentsChanged: applied,
    };
  }
  try {
    return claim.operationType === 'meeting_attachment.create'
      ? await processCreateClaim(claim, accessToken, signal, isCurrent)
      : await processDeleteClaim(claim, accessToken, signal, isCurrent);
  } catch (error) {
    if (!isCurrent() || signal.aborted || (error as Error)?.name === 'AbortError') {
      return { outcome: 'stale', processed: false, retryAfterMs: STALE_CLAIM_MS, attachmentsChanged: false };
    }
    const nowMs = Date.now();
    let disposition: 'retry' | 'blocked' | 'permanent_error' = 'retry';
    let errorCode = 'network_or_timeout';
    let nextAttemptAtMs: number | null = nowMs + retryDelayMs(claim);
    if (error instanceof MeetingAttachmentConflictResponseError) {
      disposition = 'blocked';
      errorCode = 'meeting_attachment_conflict';
      nextAttemptAtMs = null;
    } else if (error instanceof LocalAttachmentFileError) {
      disposition = 'blocked';
      errorCode = 'meeting_attachment_local_file_invalid';
      nextAttemptAtMs = null;
    } else if (error instanceof HttpResponseError && error.status === 401) {
      errorCode = 'auth_unauthorized';
      nextAttemptAtMs = nowMs + 60_000;
    } else if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      disposition = error.status === 403 || error.status === 404
        || error.status === 405 || error.status === 413 || error.status === 415 || error.status === 501
        ? 'blocked'
        : 'permanent_error';
      errorCode = disposition === 'blocked'
        ? 'meeting_attachment_contract_unavailable'
        : 'meeting_attachment_request_rejected';
      nextAttemptAtMs = null;
    } else if (error instanceof Error && /附件.*(?:响应|格式|标识|内容|版本)|request snapshot/i.test(error.message)) {
      disposition = 'blocked';
      errorCode = 'meeting_attachment_response_invalid';
      nextAttemptAtMs = null;
    } else if (error instanceof HttpResponseError) {
      errorCode = `http_${error.status}`;
    }
    const applied = await sqliteMeetingNoteRepository.failMeetingAttachmentSyncClaim(claim, {
      disposition,
      errorCode,
      nextAttemptAtMs,
      updatedAtMs: nowMs,
    });
    diagnosticWarn('[meeting-attachment-sync] attachment operation failed', error);
    return {
      outcome: applied && disposition === 'retry' ? 'retry' : applied ? 'blocked' : 'stale',
      processed: applied,
      retryAfterMs: applied && disposition === 'retry' ? Math.max(0, nextAttemptAtMs! - nowMs) : null,
      attachmentsChanged: applied,
    };
  }
}

async function listRemoteMeetings(
  scopeKey: Exclude<ScopeKey, 'guest'>,
): Promise<{ meetings: readonly MeetingListProjectionItem[]; truncated: boolean }> {
  const meetings: MeetingListProjectionItem[] = [];
  let before: { updatedAtMs: number; id: string } | null = null;
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const projection = await sqliteMeetingNoteRepository.listProjection(scopeKey, {
      limit: MEETING_PAGE_SIZE,
      before,
    });
    meetings.push(...projection.items.filter(item => item.remoteId && item.lifecycle !== 'deleted'));
    if (!projection.hasMore || projection.items.length === 0) return { meetings, truncated: false };
    const last = projection.items[projection.items.length - 1];
    before = { updatedAtMs: last.updatedAtMs, id: last.id };
  }
  return { meetings, truncated: true };
}

async function repairLegacyImageChecksums(
  scopeKey: Exclude<ScopeKey, 'guest'>,
): Promise<boolean> {
  let repairedAny = false;
  for (let page = 0; page < 20; page += 1) {
    const attachments = await sqliteMeetingNoteRepository
      .listMeetingAttachmentImagesMissingChecksum(scopeKey, 50);
    if (attachments.length === 0) break;
    let repairedThisPage = 0;
    for (const attachment of attachments) {
      if (!attachment.localUri || !attachment.byteSize) continue;
      try {
        const inspected = await inspectMeetingAttachmentImage(attachment.localUri);
        if (inspected.byteSize !== attachment.byteSize) {
          throw new Error('附件文件大小发生变化');
        }
        const repaired = await sqliteMeetingNoteRepository.repairMeetingAttachmentImageChecksum({
          attachmentId: attachment.id,
          meetingId: attachment.meetingId,
          scopeKey,
          localUri: attachment.localUri,
          byteSize: attachment.byteSize,
          checksumSha256: inspected.checksumSha256,
        });
        if (repaired) {
          repairedAny = true;
          repairedThisPage += 1;
        }
      } catch (error) {
        diagnosticWarn('[meeting-attachment-sync] legacy image checksum repair failed', error);
      }
    }
    if (attachments.length < 50 || repairedThisPage === 0) break;
  }
  return repairedAny;
}

function safeTemporaryName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'attachment';
}

async function downloadRemoteImage(
  meeting: MeetingListProjectionItem,
  remote: RemoteMeetingAttachmentV1,
  accessToken: string,
): Promise<string> {
  if (
    remote.kind !== 'image'
    || remote.lifecycle !== 'ready'
    || !remote.contentUrl
    || !remote.byteSize
    || !remote.checksumSha256
    || !remote.mimeType
    || !remote.fileName
  ) throw new Error('照片附件云端内容不完整');
  if (!FileSystem.cacheDirectory) throw new Error('附件下载缓存暂时不可用');
  const directory = `${FileSystem.cacheDirectory}meeting-attachment-sync/${safeTemporaryName(remote.remoteId)}/`;
  const temporaryUri = `${directory}${safeTemporaryName(remote.fileName)}.part`;
  let storedUri: string | null = null;
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const downloaded = await FileSystem.downloadAsync(remote.contentUrl, temporaryUri, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (downloaded.status < 200 || downloaded.status >= 300) {
      throw new Error(`附件下载失败（${downloaded.status}）`);
    }
    const stored = await storeMeetingAttachmentImage({
      navigationMeetingId: meeting.id,
      attachmentId: remote.clientAttachmentId,
      sourceUri: temporaryUri,
      fileName: remote.fileName,
      mimeType: remote.mimeType,
      byteSize: remote.byteSize,
    });
    storedUri = stored.localUri;
    if (stored.byteSize !== remote.byteSize || stored.checksumSha256 !== remote.checksumSha256) {
      throw new Error('附件下载内容校验失败');
    }
    return stored.localUri;
  } catch (error) {
    if (storedUri) await deleteMeetingAttachmentFile(storedUri).catch(() => {});
    throw error;
  } finally {
    await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
  }
}

async function pullMeetingAttachments(
  scopeKey: Exclude<ScopeKey, 'guest'>,
  meeting: MeetingListProjectionItem,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<{ changed: boolean; failed: boolean }> {
  if (!meeting.remoteId) return { changed: false, failed: false };
  const remotes = await listMeetingAttachmentsV1({
    accessToken,
    meetingRemoteId: meeting.remoteId,
    signal,
  });
  let changed = false;
  let failed = false;
  for (const remote of remotes) {
    if (!isCurrent() || signal.aborted) break;
    let localUri: string | null = null;
    let downloadedUri: string | null = null;
    try {
      if (remote.kind === 'image' && remote.lifecycle === 'ready') {
        const existing = await sqliteMeetingNoteRepository.getMeetingAttachmentForSync(
          remote.clientAttachmentId,
          meeting.id,
          scopeKey,
        );
        const existingValid = Boolean(
          existing?.localUri
          && remote.byteSize
          && remote.checksumSha256
          && await verifyMeetingAttachmentImage({
            uri: existing.localUri,
            expectedByteSize: remote.byteSize,
            expectedChecksumSha256: remote.checksumSha256,
          }),
        );
        if (existingValid) localUri = existing!.localUri;
        else {
          downloadedUri = await downloadRemoteImage(meeting, remote, accessToken);
          localUri = downloadedUri;
        }
      }
      const merged = await sqliteMeetingNoteRepository.mergeRemoteMeetingAttachment({
        scopeKey,
        meetingId: meeting.id,
        meetingRemoteId: meeting.remoteId,
        remote,
        localUri,
        mergedAtMs: Date.now(),
      });
      if (merged.cleanupUri) {
        await deleteMeetingAttachmentFile(merged.cleanupUri).catch(error => {
          diagnosticWarn('[meeting-attachment-sync] replaced local file cleanup failed', error);
        });
      }
      if (merged.outcome !== 'unchanged') changed = true;
    } catch (error) {
      failed = true;
      if (downloadedUri) await deleteMeetingAttachmentFile(downloadedUri).catch(() => {});
      diagnosticWarn('[meeting-attachment-sync] remote attachment pull failed', error);
    }
  }
  return { changed, failed };
}

export interface SynchronizeMeetingAttachmentsInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface SynchronizeMeetingAttachmentsResult {
  outcome: 'synchronized' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  pushed: number;
  pulledMeetings: number;
  retryAfterMs: number | null;
}

export async function synchronizeMeetingAttachments(
  input: SynchronizeMeetingAttachmentsInput,
): Promise<SynchronizeMeetingAttachmentsResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || !input.isCurrent()) {
    return { outcome: 'stale', pushed: 0, pulledMeetings: 0, retryAfterMs: null };
  }
  let capability;
  try {
    capability = await loadMeetingCapabilities({
      accessToken: input.accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
  } catch (error) {
    const current = input.isCurrent() && !input.signal.aborted;
    if (current) diagnosticWarn('[meeting-attachment-sync] capability refresh failed', error);
    return {
      outcome: current ? 'capability_unavailable' : 'stale',
      pushed: 0,
      pulledMeetings: 0,
      retryAfterMs: current ? CAPABILITY_RETRY_MS : null,
    };
  }
  if (!input.isCurrent() || input.signal.aborted) {
    return { outcome: 'stale', pushed: 0, pulledMeetings: 0, retryAfterMs: null };
  }
  if (capability.source !== 'remote' || !capability.capabilities.meetingAttachmentsV1) {
    return { outcome: 'disabled', pushed: 0, pulledMeetings: 0, retryAfterMs: null };
  }

  const repairedLegacyImages = await repairLegacyImageChecksums(input.scopeKey);
  await sqliteMeetingNoteRepository.ensureMeetingAttachmentSyncOperations(input.scopeKey, Date.now());
  let pushed = 0;
  let earliestRetryMs: number | null = null;
  let attachmentsChanged = repairedLegacyImages;
  let reachedBatchLimit = true;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', pushed, pulledMeetings: 0, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimMeetingAttachmentSyncOperations(
      input.scopeKey,
      { nowMs, staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS), limit: 3 },
    );
    if (claims.length === 0) {
      reachedBatchLimit = false;
      const nextAttemptAtMs = await sqliteMeetingNoteRepository.getNextMeetingAttachmentSyncAttemptAt(
        input.scopeKey,
        STALE_CLAIM_MS,
      );
      earliestRetryMs = mergeSyncRetryAfterMs(nowMs, nextAttemptAtMs, earliestRetryMs);
      break;
    }
    const results = await Promise.all(claims.map(claim => processClaim(
      claim,
      input.accessToken,
      input.signal,
      input.isCurrent,
    )));
    pushed += results.filter(result => result.outcome === 'completed').length;
    attachmentsChanged = attachmentsChanged || results.some(result => result.attachmentsChanged);
    results.forEach(result => {
      if (result.retryAfterMs === null) return;
      earliestRetryMs = earliestRetryMs === null
        ? result.retryAfterMs
        : Math.min(earliestRetryMs, result.retryAfterMs);
    });
    if (results.some(result => result.outcome === 'stale')) {
      if (attachmentsChanged) notifyMeetingAttachmentsChanged(input.scopeKey);
      return { outcome: 'stale', pushed, pulledMeetings: 0, retryAfterMs: earliestRetryMs };
    }
  }

  const waitingForRoot = await sqliteMeetingNoteRepository
    .hasMeetingAttachmentSyncOperationsWaitingForRoot(input.scopeKey);
  if (waitingForRoot) {
    requestMeetingRootSync(input.scopeKey);
    earliestRetryMs = earliestRetryMs === null
      ? ROOT_PENDING_RETRY_MS
      : Math.min(earliestRetryMs, ROOT_PENDING_RETRY_MS);
  }

  let pulledMeetings = 0;
  let pullFailed = false;
  try {
    const projection = await listRemoteMeetings(input.scopeKey);
    for (const meeting of projection.meetings) {
      if (!input.isCurrent() || input.signal.aborted) break;
      const pulled = await pullMeetingAttachments(
        input.scopeKey,
        meeting,
        input.accessToken,
        input.signal,
        input.isCurrent,
      );
      pulledMeetings += 1;
      attachmentsChanged = attachmentsChanged || pulled.changed;
      pullFailed = pullFailed || pulled.failed;
    }
    pullFailed = pullFailed || projection.truncated;
  } catch (error) {
    pullFailed = true;
    diagnosticWarn('[meeting-attachment-sync] attachment list pull failed', error);
  }
  if (pullFailed && input.isCurrent() && !input.signal.aborted) {
    earliestRetryMs = earliestRetryMs === null
      ? PULL_RETRY_MS
      : Math.min(earliestRetryMs, PULL_RETRY_MS);
  }
  if (attachmentsChanged) notifyMeetingAttachmentsChanged(input.scopeKey);
  diagnosticAudit('meeting_attachment_sync', {
    status: reachedBatchLimit ? 'batch_limit' : 'synchronized',
    pushed,
    pulled_meetings: pulledMeetings,
    waiting_for_root: waitingForRoot,
    retry_scheduled: earliestRetryMs !== null,
  });
  return {
    outcome: reachedBatchLimit ? 'batch_limit' : 'synchronized',
    pushed,
    pulledMeetings,
    retryAfterMs: reachedBatchLimit ? 0 : earliestRetryMs,
  };
}
