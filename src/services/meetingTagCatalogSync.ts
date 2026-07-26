import {
  getMeetingTagCatalogV1,
  loadMeetingCapabilities,
  MeetingTagCatalogConflictResponseError,
  parseRemoteMeetingTagCatalogV1,
  replaceMeetingTagCatalogV1,
  type MeetingTagCatalogV1Mutation,
  type RemoteMeetingTagCatalogV1,
} from '../data/api/v2';
import {
  applyMeetingTagCatalogPull,
  claimMeetingTagCatalogSyncOperation,
  completeMeetingTagCatalogSyncClaim,
  ensureMeetingTagCatalogSyncOperation,
  failMeetingTagCatalogSyncClaim,
  getMeetingTagCatalogSyncOverview,
  getNextMeetingTagCatalogSyncAttemptAt,
  recordMeetingTagCatalogSyncConflict,
  type MeetingTagCatalogSyncClaim,
} from '../data/repositories';
import { requestMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import { notifyMeetingTagCatalogChanged } from '../application/meeting/tagCatalogSyncTrigger';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';

const STALE_CLAIM_MS = 90_000;
const CAPABILITY_RETRY_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMutation(claim: MeetingTagCatalogSyncClaim): MeetingTagCatalogV1Mutation {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (
    !isRecord(parsed) || parsed.schema_version !== 1
    || (parsed.expected_remote_revision !== null
      && (!Number.isSafeInteger(parsed.expected_remote_revision)
        || Number(parsed.expected_remote_revision) < 1))
    || !Number.isSafeInteger(parsed.client_updated_at_ms)
    || Number(parsed.client_updated_at_ms) < 0
    || !Array.isArray(parsed.tags)
    || !Array.isArray(parsed.assignments)
  ) throw new Error('meeting tag catalog sync payload schema is invalid');
  return parsed as unknown as MeetingTagCatalogV1Mutation;
}

function remoteFromConflict(value: unknown): RemoteMeetingTagCatalogV1 {
  return parseRemoteMeetingTagCatalogV1(value);
}

function responseAcknowledges(
  request: MeetingTagCatalogV1Mutation,
  remote: RemoteMeetingTagCatalogV1,
): boolean {
  const tags = request.tags.map(tag => ({
    clientTagId: tag.client_tag_id,
    name: tag.name.normalize('NFKC').replace(/\s+/g, ' ').trim(),
    createdAtMs: tag.created_at_ms,
    updatedAtMs: tag.updated_at_ms,
  })).sort((left, right) => left.clientTagId.localeCompare(right.clientTagId));
  const assignments = request.assignments.map(item => ({
    meetingRemoteId: item.meeting_remote_id,
    clientTagIds: [...item.client_tag_ids].sort(),
  })).sort((left, right) => left.meetingRemoteId.localeCompare(right.meetingRemoteId));
  return remote.exists
    && remote.clientUpdatedAtMs === request.client_updated_at_ms
    && JSON.stringify(remote.tags) === JSON.stringify(tags)
    && JSON.stringify(remote.assignments) === JSON.stringify(assignments);
}

function retryDelayMs(claim: MeetingTagCatalogSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  return Math.min(6 * 60 * 60_000, 15_000 * (2 ** exponent));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function processClaim(
  claim: MeetingTagCatalogSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<{ outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale'; retryAfterMs: number | null }> {
  let mutation: MeetingTagCatalogV1Mutation;
  try {
    mutation = parseMutation(claim);
  } catch (error) {
    await failMeetingTagCatalogSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[meeting-tag-sync] rejected invalid local payload', error);
    return { outcome: 'blocked', retryAfterMs: null };
  }
  try {
    const remote = await replaceMeetingTagCatalogV1({
      accessToken,
      idempotencyKey: claim.idempotencyKey,
      mutation,
      signal,
    });
    if (!responseAcknowledges(mutation, remote)) {
      throw new Error('meeting tag catalog response does not acknowledge the request snapshot');
    }
    if (!isCurrent() || signal.aborted) return { outcome: 'stale', retryAfterMs: STALE_CLAIM_MS };
    const completed = await completeMeetingTagCatalogSyncClaim(claim, remote, Date.now());
    return { outcome: completed ? 'completed' : 'stale', retryAfterMs: null };
  } catch (error) {
    if (!isCurrent() || signal.aborted) return { outcome: 'stale', retryAfterMs: STALE_CLAIM_MS };
    const nowMs = Date.now();
    if (error instanceof MeetingTagCatalogConflictResponseError) {
      try {
        const remote = remoteFromConflict(error.remotePayload);
        const recorded = await recordMeetingTagCatalogSyncConflict(claim, remote, nowMs);
        return { outcome: recorded ? 'conflict' : 'stale', retryAfterMs: null };
      } catch (contractError) {
        diagnosticWarn('[meeting-tag-sync] invalid conflict payload', contractError);
        await failMeetingTagCatalogSyncClaim(claim, {
          disposition: 'blocked',
          errorCode: 'meeting_tag_conflict_invalid',
          nextAttemptAtMs: null,
          updatedAtMs: nowMs,
        });
        return { outcome: 'blocked', retryAfterMs: null };
      }
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      await failMeetingTagCatalogSyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'auth_unauthorized',
        nextAttemptAtMs: nowMs + 60_000,
        updatedAtMs: nowMs,
      });
      return { outcome: 'retry', retryAfterMs: 60_000 };
    }
    if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      await failMeetingTagCatalogSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'meeting_tag_contract_unavailable',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { outcome: 'blocked', retryAfterMs: null };
    }
    if (error instanceof Error && /response|响应|标签同步响应/i.test(error.message)) {
      await failMeetingTagCatalogSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'meeting_tag_response_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { outcome: 'blocked', retryAfterMs: null };
    }
    const delayMs = retryDelayMs(claim);
    await failMeetingTagCatalogSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { outcome: 'retry', retryAfterMs: delayMs };
  }
}

export interface SynchronizeMeetingTagCatalogInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface SynchronizeMeetingTagCatalogResult {
  outcome: 'synchronized' | 'disabled' | 'capability_unavailable' | 'root_pending' | 'conflict' | 'blocked' | 'stale';
  pushed: number;
  pulled: boolean;
  retryAfterMs: number | null;
}

export async function synchronizeMeetingTagCatalog(
  input: SynchronizeMeetingTagCatalogInput,
): Promise<SynchronizeMeetingTagCatalogResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || !input.isCurrent()) {
    return { outcome: 'stale', pushed: 0, pulled: false, retryAfterMs: null };
  }
  let capability;
  try {
    capability = await loadMeetingCapabilities({
      accessToken: input.accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
  } catch (error) {
    if (input.isCurrent() && !input.signal.aborted) {
      diagnosticWarn('[meeting-tag-sync] capability refresh failed', error);
    }
    return {
      outcome: input.isCurrent() && !input.signal.aborted ? 'capability_unavailable' : 'stale',
      pushed: 0,
      pulled: false,
      retryAfterMs: input.isCurrent() && !input.signal.aborted ? CAPABILITY_RETRY_MS : null,
    };
  }
  if (!input.isCurrent() || input.signal.aborted) {
    return { outcome: 'stale', pushed: 0, pulled: false, retryAfterMs: null };
  }
  if (capability.source !== 'remote' || !capability.capabilities.meetingTagsV1) {
    return { outcome: 'disabled', pushed: 0, pulled: false, retryAfterMs: null };
  }

  let overview = await getMeetingTagCatalogSyncOverview(input.scopeKey);
  if (!overview.hasState && !overview.localHasContent && !overview.hasActiveOperation) {
    const remote = await getMeetingTagCatalogV1({
      accessToken: input.accessToken,
      signal: input.signal,
    });
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', pushed: 0, pulled: false, retryAfterMs: null };
    }
    const applied = await applyMeetingTagCatalogPull(input.scopeKey, remote, Date.now());
    if (applied.applied) notifyMeetingTagCatalogChanged(input.scopeKey);
    overview = await getMeetingTagCatalogSyncOverview(input.scopeKey);
  }
  if (overview.hasConflict) {
    return { outcome: 'conflict', pushed: 0, pulled: false, retryAfterMs: null };
  }

  await ensureMeetingTagCatalogSyncOperation(input.scopeKey, Date.now());
  let pushed = 0;
  let earliestRetryMs: number | null = null;
  for (let pass = 0; pass < 4; pass += 1) {
    const nowMs = Date.now();
    const claimed = await claimMeetingTagCatalogSyncOperation(input.scopeKey, {
      nowMs,
      staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
    });
    if (claimed.kind === 'conflict') {
      return { outcome: 'conflict', pushed, pulled: false, retryAfterMs: null };
    }
    if (claimed.kind === 'root_pending') {
      requestMeetingRootSync(input.scopeKey);
      return {
        outcome: 'root_pending',
        pushed,
        pulled: false,
        retryAfterMs: Math.max(1_000, claimed.retryAtMs - nowMs),
      };
    }
    if (claimed.kind === 'waiting') {
      earliestRetryMs = claimed.retryAtMs === null ? earliestRetryMs : Math.max(0, claimed.retryAtMs - nowMs);
      break;
    }
    const result = await processClaim(
      claimed.claim,
      input.accessToken,
      input.signal,
      input.isCurrent,
    );
    if (result.outcome === 'completed') {
      pushed += 1;
      await ensureMeetingTagCatalogSyncOperation(input.scopeKey, Date.now());
      continue;
    }
    if (result.outcome === 'conflict') {
      return { outcome: 'conflict', pushed, pulled: false, retryAfterMs: null };
    }
    if (result.outcome === 'blocked') {
      return { outcome: 'blocked', pushed, pulled: false, retryAfterMs: null };
    }
    if (result.outcome === 'stale') {
      return { outcome: 'stale', pushed, pulled: false, retryAfterMs: result.retryAfterMs };
    }
    earliestRetryMs = result.retryAfterMs;
    break;
  }

  overview = await getMeetingTagCatalogSyncOverview(input.scopeKey);
  let pulled = false;
  if (!overview.hasActiveOperation && !overview.hasConflict) {
    const remote = await getMeetingTagCatalogV1({
      accessToken: input.accessToken,
      signal: input.signal,
    });
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', pushed, pulled: false, retryAfterMs: null };
    }
    const applied = await applyMeetingTagCatalogPull(input.scopeKey, remote, Date.now());
    pulled = applied.applied;
    if (pulled) notifyMeetingTagCatalogChanged(input.scopeKey);
  }
  const nextAt = await getNextMeetingTagCatalogSyncAttemptAt(input.scopeKey, STALE_CLAIM_MS);
  if (nextAt !== null) {
    const afterMs = Math.max(0, nextAt - Date.now());
    earliestRetryMs = earliestRetryMs === null ? afterMs : Math.min(earliestRetryMs, afterMs);
  }
  diagnosticAudit('meeting_tag_catalog_sync', {
    status: 'synchronized',
    pushed,
    pulled,
    retry_scheduled: earliestRetryMs !== null,
  });
  return { outcome: 'synchronized', pushed, pulled, retryAfterMs: earliestRetryMs };
}
