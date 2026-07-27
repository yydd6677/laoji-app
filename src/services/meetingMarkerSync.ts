import {
  deleteMeetingMarkerV1,
  listMeetingMarkersV1,
  loadMeetingCapabilities,
  MeetingMarkerConflictResponseError,
  parseRemoteMeetingMarkerV1,
  registerMeetingMarkerV1,
  type MeetingMarkerV1Registration,
  type RemoteMeetingMarkerV1,
} from '../data/api/v2';
import {
  claimMeetingMarkerSyncOperations,
  completeMeetingMarkerCreateClaim,
  completeMeetingMarkerDeleteClaim,
  ensureMeetingMarkerSyncOperations,
  failMeetingMarkerSyncClaim,
  hasMeetingMarkerSyncWaitingForRoot,
  mergeRemoteMeetingMarker,
  nextMeetingMarkerSyncAttemptAt,
  sqliteMeetingNoteRepository,
  type MeetingListProjectionItem,
  type MeetingMarkerSyncFailure,
  type MeetingMarkerSyncClaim,
} from '../data/repositories';
import {
  notifyMeetingMarkersChanged,
} from '../application/meeting/markerSyncTrigger';
import { requestMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import type { ScopeKey } from '../domain/meeting';
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

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 500 || value.includes('\u0000')) {
    throw new Error('标记名称无效');
  }
  return value;
}

function parseCreateRegistration(claim: MeetingMarkerSyncClaim): MeetingMarkerV1Registration {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) throw new Error('标记同步请求格式无效');
  const clientMarkerId = identifier(parsed.client_marker_id, '标记本机标识');
  if (clientMarkerId !== claim.markerId) throw new Error('标记本机标识发生变化');
  if (parsed.kind !== 'important') throw new Error('标记类型无效');
  const clientCreatedAtMs = safeInteger(parsed.client_created_at_ms, '标记创建时间');
  const clientUpdatedAtMs = safeInteger(parsed.client_updated_at_ms, '标记更新时间');
  if (clientUpdatedAtMs < clientCreatedAtMs) throw new Error('标记更新时间无效');
  return {
    schema_version: 1,
    client_marker_id: clientMarkerId,
    position_ms: safeInteger(parsed.position_ms, '标记时间点'),
    label: nullableLabel(parsed.label),
    kind: 'important',
    client_created_at_ms: clientCreatedAtMs,
    client_updated_at_ms: clientUpdatedAtMs,
  };
}

function parseDeleteRequest(claim: MeetingMarkerSyncClaim): {
  remoteId: string;
  expectedRevision: number;
} {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) throw new Error('标记删除请求格式无效');
  if (identifier(parsed.client_marker_id, '标记本机标识') !== claim.markerId) {
    throw new Error('标记本机标识发生变化');
  }
  return {
    remoteId: identifier(parsed.remote_id, '标记云端标识', 160),
    expectedRevision: safeInteger(parsed.expected_remote_revision, '标记云端版本', 1),
  };
}

function remoteAcknowledgesRegistration(
  registration: MeetingMarkerV1Registration,
  remote: RemoteMeetingMarkerV1,
): boolean {
  return remote.clientMarkerId === registration.client_marker_id
    && remote.positionMs === registration.position_ms
    && remote.label === registration.label
    && remote.kind === registration.kind
    && remote.clientCreatedAtMs === registration.client_created_at_ms
    && remote.clientUpdatedAtMs === registration.client_updated_at_ms;
}

function currentFromConflict(
  error: MeetingMarkerConflictResponseError,
  claim: MeetingMarkerSyncClaim,
): RemoteMeetingMarkerV1 {
  return parseRemoteMeetingMarkerV1(error.remotePayload, {
    meetingRemoteId: claim.meetingRemoteId,
    clientMarkerId: claim.markerId,
  });
}

async function registerMarker(
  claim: MeetingMarkerSyncClaim,
  registration: MeetingMarkerV1Registration,
  accessToken: string,
  signal: AbortSignal,
): Promise<RemoteMeetingMarkerV1> {
  try {
    return await registerMeetingMarkerV1({
      accessToken,
      meetingRemoteId: claim.meetingRemoteId,
      idempotencyKey: claim.operationId,
      registration,
      signal,
    });
  } catch (error) {
    if (!(error instanceof MeetingMarkerConflictResponseError)) throw error;
    const current = currentFromConflict(error, claim);
    if (!remoteAcknowledgesRegistration(registration, current)) throw error;
    return current;
  }
}

async function deleteMarker(
  claim: MeetingMarkerSyncClaim,
  remoteId: string,
  expectedRevision: number,
  accessToken: string,
  signal: AbortSignal,
): Promise<RemoteMeetingMarkerV1> {
  const remove = (revision: number) => deleteMeetingMarkerV1({
    accessToken,
    remoteMarkerId: remoteId,
    meetingRemoteId: claim.meetingRemoteId,
    clientMarkerId: claim.markerId,
    expectedRevision: revision,
    idempotencyKey: claim.operationId,
    signal,
  });
  try {
    return await remove(expectedRevision);
  } catch (error) {
    if (!(error instanceof MeetingMarkerConflictResponseError)) throw error;
    const current = currentFromConflict(error, claim);
    if (current.remoteId !== remoteId) throw error;
    if (current.lifecycle === 'deleted') return current;
    try {
      return await remove(current.revision);
    } catch (retryError) {
      if (!(retryError instanceof MeetingMarkerConflictResponseError)) throw retryError;
      const retryCurrent = currentFromConflict(retryError, claim);
      if (retryCurrent.remoteId === remoteId && retryCurrent.lifecycle === 'deleted') return retryCurrent;
      throw retryError;
    }
  }
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: MeetingMarkerSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60_000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.operationId));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

type ClaimResult = {
  outcome: 'completed' | 'retry' | 'blocked' | 'stale';
  retryAfterMs: number | null;
  changed: boolean;
};

async function processClaim(
  claim: MeetingMarkerSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  try {
    const completedAtMs = Date.now();
    if (claim.operationType === 'meeting_marker.create') {
      const registration = parseCreateRegistration(claim);
      const remote = await registerMarker(claim, registration, accessToken, signal);
      if (!remoteAcknowledgesRegistration(registration, remote)) {
        throw new Error('标记注册响应未确认本次请求');
      }
      if (!isCurrent() || signal.aborted) return { outcome: 'stale', retryAfterMs: STALE_CLAIM_MS, changed: false };
      const completed = await completeMeetingMarkerCreateClaim(claim, remote, completedAtMs);
      return {
        outcome: completed ? 'completed' : 'stale',
        retryAfterMs: completed ? null : STALE_CLAIM_MS,
        changed: completed,
      };
    }
    const request = parseDeleteRequest(claim);
    const remote = await deleteMarker(
      claim,
      request.remoteId,
      request.expectedRevision,
      accessToken,
      signal,
    );
    if (remote.lifecycle !== 'deleted' || remote.remoteId !== request.remoteId) {
      throw new Error('标记删除响应未确认本次请求');
    }
    if (!isCurrent() || signal.aborted) return { outcome: 'stale', retryAfterMs: STALE_CLAIM_MS, changed: false };
    const completed = await completeMeetingMarkerDeleteClaim(claim, remote, completedAtMs);
    return {
      outcome: completed ? 'completed' : 'stale',
      retryAfterMs: completed ? null : STALE_CLAIM_MS,
      changed: completed,
    };
  } catch (error) {
    if (!isCurrent() || signal.aborted || (error as Error)?.name === 'AbortError') {
      return { outcome: 'stale', retryAfterMs: STALE_CLAIM_MS, changed: false };
    }
    let invalidLocal = false;
    try {
      if (claim.operationType === 'meeting_marker.create') parseCreateRegistration(claim);
      else parseDeleteRequest(claim);
    } catch {
      invalidLocal = true;
    }
    const nowMs = Date.now();
    let disposition: MeetingMarkerSyncFailure['disposition'] = 'retry';
    let errorCode = 'network_or_timeout';
    let nextAttemptAtMs: number | null = nowMs + retryDelayMs(claim);
    if (invalidLocal) {
      disposition = 'permanent_error';
      errorCode = 'invalid_local_payload';
      nextAttemptAtMs = null;
    } else if (error instanceof MeetingMarkerConflictResponseError) {
      disposition = 'blocked';
      errorCode = 'meeting_marker_conflict';
      nextAttemptAtMs = null;
    } else if (error instanceof HttpResponseError && error.status === 401) {
      errorCode = 'auth_unauthorized';
      nextAttemptAtMs = nowMs + 60_000;
    } else if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      disposition = [403, 404, 405, 413, 415, 501].includes(error.status)
        ? 'blocked'
        : 'permanent_error';
      errorCode = disposition === 'blocked'
        ? 'meeting_marker_contract_unavailable'
        : 'meeting_marker_request_rejected';
      nextAttemptAtMs = null;
    } else if (error instanceof Error && /标记.*(?:响应|格式|标识|内容|版本)/.test(error.message)) {
      disposition = 'blocked';
      errorCode = 'meeting_marker_response_invalid';
      nextAttemptAtMs = null;
    } else if (error instanceof HttpResponseError) {
      errorCode = `http_${error.status}`;
    }
    const applied = await failMeetingMarkerSyncClaim(claim, {
      disposition,
      errorCode,
      nextAttemptAtMs,
      updatedAtMs: nowMs,
    });
    diagnosticWarn('[meeting-marker-sync] marker operation failed', error);
    return {
      outcome: applied && disposition === 'retry' ? 'retry' : applied ? 'blocked' : 'stale',
      retryAfterMs: applied && disposition === 'retry' ? Math.max(0, nextAttemptAtMs! - nowMs) : null,
      changed: applied,
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

async function pullMeetingMarkers(
  scopeKey: Exclude<ScopeKey, 'guest'>,
  meeting: MeetingListProjectionItem,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<{ changed: boolean; failed: boolean }> {
  if (!meeting.remoteId) return { changed: false, failed: false };
  const remotes = await listMeetingMarkersV1({
    accessToken,
    meetingRemoteId: meeting.remoteId,
    signal,
  });
  let changed = false;
  let failed = false;
  for (const remote of remotes) {
    if (!isCurrent() || signal.aborted) break;
    try {
      const merged = await mergeRemoteMeetingMarker({
        scopeKey,
        meetingId: meeting.id,
        meetingRemoteId: meeting.remoteId,
        remote,
        mergedAtMs: Date.now(),
      });
      if (merged.outcome !== 'unchanged') changed = true;
    } catch (error) {
      failed = true;
      diagnosticWarn('[meeting-marker-sync] remote marker pull failed', error);
    }
  }
  return { changed, failed };
}

export interface SynchronizeMeetingMarkersResult {
  outcome: 'synchronized' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  pushed: number;
  pulledMeetings: number;
  retryAfterMs: number | null;
}

export async function synchronizeMeetingMarkers(input: {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<SynchronizeMeetingMarkersResult> {
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
    if (current) diagnosticWarn('[meeting-marker-sync] capability refresh failed', error);
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
  if (capability.source !== 'remote' || !capability.capabilities.meetingMarkersV1) {
    return { outcome: 'disabled', pushed: 0, pulledMeetings: 0, retryAfterMs: null };
  }

  await ensureMeetingMarkerSyncOperations(input.scopeKey, Date.now());
  let pushed = 0;
  let earliestRetryMs: number | null = null;
  let markersChanged = false;
  let reachedBatchLimit = true;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', pushed, pulledMeetings: 0, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await claimMeetingMarkerSyncOperations(input.scopeKey, {
      nowMs,
      staleClaimAfterMs: STALE_CLAIM_MS,
      limit: 3,
    });
    if (claims.length === 0) {
      reachedBatchLimit = false;
      const nextAttemptAtMs = await nextMeetingMarkerSyncAttemptAt(input.scopeKey, STALE_CLAIM_MS);
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
    markersChanged = markersChanged || results.some(result => result.changed);
    results.forEach(result => {
      if (result.retryAfterMs === null) return;
      earliestRetryMs = earliestRetryMs === null
        ? result.retryAfterMs
        : Math.min(earliestRetryMs, result.retryAfterMs);
    });
    if (results.some(result => result.outcome === 'stale')) {
      if (markersChanged) notifyMeetingMarkersChanged(input.scopeKey);
      return { outcome: 'stale', pushed, pulledMeetings: 0, retryAfterMs: earliestRetryMs };
    }
  }

  const waitingForRoot = await hasMeetingMarkerSyncWaitingForRoot(input.scopeKey);
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
      const pulled = await pullMeetingMarkers(
        input.scopeKey,
        meeting,
        input.accessToken,
        input.signal,
        input.isCurrent,
      );
      pulledMeetings += 1;
      markersChanged = markersChanged || pulled.changed;
      pullFailed = pullFailed || pulled.failed;
    }
    pullFailed = pullFailed || projection.truncated;
  } catch (error) {
    pullFailed = true;
    diagnosticWarn('[meeting-marker-sync] marker list pull failed', error);
  }
  if (pullFailed && input.isCurrent() && !input.signal.aborted) {
    earliestRetryMs = earliestRetryMs === null
      ? PULL_RETRY_MS
      : Math.min(earliestRetryMs, PULL_RETRY_MS);
  }
  if (markersChanged) notifyMeetingMarkersChanged(input.scopeKey);
  diagnosticAudit('meeting_marker_sync', {
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
