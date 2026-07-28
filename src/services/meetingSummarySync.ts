import {
  loadMeetingCapabilities,
  selectMeetingSummaryCurrentV1,
  SummarySyncConflictResponseError,
  updateMeetingSummarySectionV1,
  type SummaryCurrentV1Mutation,
  type SummarySectionOverrideV1Mutation,
} from '../data/api/v2';
import {
  claimMeetingSummarySyncOperations,
  completeMeetingSummaryCurrentSyncClaim,
  completeMeetingSummarySectionSyncClaim,
  ensureMeetingSummarySyncOperations,
  failMeetingSummarySyncClaim,
  nextMeetingSummarySyncAttemptAt,
  recordMeetingSummarySyncConflict,
  type SummarySyncClaim,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { getFeatureFlags } from '../config/featureFlags';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';
import { mergeSyncRetryAfterMs } from './syncRetryWake';

const STALE_CLAIM_MS = 90_000;
const MAX_BATCHES_PER_DRAIN = 20;
const CAPABILITY_RETRY_MS = 5 * 60_000;

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

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\u0000')) {
    throw new Error('整理内容人工修改无效');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function ids(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}无效`);
  const result = value.map(item => identifier(item, label));
  if (new Set(result).size !== result.length) throw new Error(`${label}存在重复项`);
  return result;
}

type ParsedSectionClaim = {
  remoteVersionId: string;
  remoteSectionId: string;
  stableKey: string;
  ordinal: number;
  expectedRemoteRevision: number;
  generatedCitationIds: readonly string[];
  mutation: SummarySectionOverrideV1Mutation;
};

function parseSectionClaim(claim: SummarySyncClaim): ParsedSectionClaim {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) {
    throw new Error('整理内容同步请求格式无效');
  }
  if (identifier(parsed.meeting_id, '整理内容会议标识') !== claim.meetingId) {
    throw new Error('整理内容同步会议身份已变化');
  }
  const visibleCitationIds = ids(parsed.visible_citation_ids, '整理结果引用标识');
  const generatedCitationIds = ids(parsed.generated_citation_ids, '整理结果生成引用标识');
  if (visibleCitationIds.some(id => !generatedCitationIds.includes(id))) {
    throw new Error('整理结果引用不属于生成内容');
  }
  return {
    remoteVersionId: identifier(parsed.remote_version_id, '整理结果云端标识', 160),
    remoteSectionId: identifier(parsed.remote_section_id, '整理内容云端标识'),
    stableKey: identifier(parsed.stable_key, '整理内容稳定标识', 160),
    ordinal: safeInteger(parsed.ordinal, '整理内容顺序'),
    expectedRemoteRevision: safeInteger(
      parsed.expected_remote_revision,
      '整理内容云端版本',
      1,
    ),
    generatedCitationIds,
    mutation: {
      schema_version: 1,
      user_text: nullableText(parsed.user_text),
      visible_citation_ids: visibleCitationIds,
      client_updated_at_ms: safeInteger(parsed.client_updated_at_ms, '整理内容更新时间'),
    },
  };
}

function parseCurrentClaim(claim: SummarySyncClaim): {
  expectedRemoteRevision: number;
  mutation: SummaryCurrentV1Mutation;
} {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1) {
    throw new Error('当前整理结果同步请求格式无效');
  }
  if (identifier(parsed.meeting_id, '当前整理结果会议标识') !== claim.meetingId) {
    throw new Error('当前整理结果同步会议身份已变化');
  }
  return {
    expectedRemoteRevision: safeInteger(
      parsed.expected_remote_revision,
      '当前整理结果云端版本',
      1,
    ),
    mutation: {
      schema_version: 1,
      version_id: identifier(parsed.remote_version_id, '当前整理结果云端标识', 160),
      client_updated_at_ms: safeInteger(parsed.client_updated_at_ms, '当前整理结果更新时间'),
    },
  };
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: SummarySyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.operationId));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function remotePayloadJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length <= 1_048_576) return serialized;
  } catch {
    // Store a bounded diagnostic payload below.
  }
  return JSON.stringify({ error: 'remote_conflict_payload_unavailable' });
}

type ClaimResult = {
  processed: boolean;
  retryAfterMs: number | null;
  outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale';
};

async function processClaim(
  claim: SummarySyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let sectionClaim: ParsedSectionClaim | null = null;
  let currentClaim: ReturnType<typeof parseCurrentClaim> | null = null;
  try {
    if (claim.kind === 'section') sectionClaim = parseSectionClaim(claim);
    else currentClaim = parseCurrentClaim(claim);
  } catch (error) {
    const blocked = await failMeetingSummarySyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[summary-sync] rejected invalid local payload', error);
    return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
  }

  try {
    if (claim.kind === 'section') {
      const parsed = sectionClaim!;
      const remote = await updateMeetingSummarySectionV1({
        accessToken,
        remoteVersionId: parsed.remoteVersionId,
        remoteSectionId: parsed.remoteSectionId,
        expectedRevision: parsed.expectedRemoteRevision,
        idempotencyKey: claim.operationId,
        mutation: parsed.mutation,
        expectedMeetingRemoteId: claim.meetingRemoteId,
        expectedStableKey: parsed.stableKey,
        expectedOrdinal: parsed.ordinal,
        generatedCitationIds: parsed.generatedCitationIds,
        signal,
      });
      if (
        remote.userText !== parsed.mutation.user_text
        || remote.clientUpdatedAtMs !== parsed.mutation.client_updated_at_ms
        || remote.visibleCitationIds.length !== parsed.mutation.visible_citation_ids.length
        || remote.visibleCitationIds.some((id, index) => id !== parsed.mutation.visible_citation_ids[index])
      ) throw new Error('整理内容同步响应未确认请求快照');
      if (!isCurrent() || signal.aborted) {
        return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
      }
      const completed = await completeMeetingSummarySectionSyncClaim(claim, remote, Date.now());
      return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
    }
    const parsed = currentClaim!;
    const remote = await selectMeetingSummaryCurrentV1({
      accessToken,
      meetingRemoteId: claim.meetingRemoteId,
      expectedRevision: parsed.expectedRemoteRevision,
      idempotencyKey: claim.operationId,
      mutation: parsed.mutation,
      signal,
    });
    if (
      remote.remoteVersionId !== parsed.mutation.version_id
      || remote.clientUpdatedAtMs !== parsed.mutation.client_updated_at_ms
    ) throw new Error('当前整理结果同步响应未确认请求快照');
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await completeMeetingSummaryCurrentSyncClaim(claim, remote, Date.now());
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const nowMs = Date.now();
    if (error instanceof SummarySyncConflictResponseError) {
      const recorded = await recordMeetingSummarySyncConflict(claim, {
        remoteRevision: error.remoteRevision,
        remotePayloadJson: remotePayloadJson({
          error_code: error.contractCode,
          current: error.remotePayload,
        }),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof Error && /本机映射/.test(error.message)) {
      const blocked = await failMeetingSummarySyncClaim(claim, {
        disposition: 'permanent_error',
        errorCode: 'invalid_local_payload',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      diagnosticWarn('[summary-sync] rejected invalid local payload', error);
      return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      const delayMs = 60_000;
      const retried = await failMeetingSummarySyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'auth_unauthorized',
        nextAttemptAtMs: nowMs + delayMs,
        updatedAtMs: nowMs,
      });
      return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
    }
    if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      const blocked = await failMeetingSummarySyncClaim(claim, {
        disposition: [403, 404, 405, 501].includes(error.status) ? 'blocked' : 'permanent_error',
        errorCode: [403, 404, 405, 501].includes(error.status)
          ? 'summary_contract_unavailable'
          : 'summary_request_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
    }
    if (error instanceof Error && /响应.*(?:格式|身份|版本)|同步响应未确认/.test(error.message)) {
      const blocked = await failMeetingSummarySyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'summary_response_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await failMeetingSummarySyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingSummarySyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingSummarySyncResult {
  outcome: 'drained' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

export async function drainMeetingSummarySync(
  input: DrainMeetingSummarySyncInput,
): Promise<DrainMeetingSummarySyncResult> {
  if (
    input.scopeKey === 'guest'
    || !input.accessToken
    || !input.isCurrent()
    || !getFeatureFlags().meetingSummarySyncV1
  ) return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  let capability;
  try {
    capability = await loadMeetingCapabilities({
      accessToken: input.accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
  } catch (error) {
    if (input.isCurrent() && !input.signal.aborted) {
      diagnosticWarn('[summary-sync] capability refresh failed', error);
    }
    return {
      outcome: input.isCurrent() && !input.signal.aborted ? 'capability_unavailable' : 'stale',
      processedCount: 0,
      retryAfterMs: input.isCurrent() && !input.signal.aborted ? CAPABILITY_RETRY_MS : null,
    };
  }
  if (!input.isCurrent() || input.signal.aborted) {
    return { outcome: 'stale', processedCount: 0, retryAfterMs: null };
  }
  if (capability.source !== 'remote' || !capability.capabilities.summaryVersionsV1) {
    return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  }
  await ensureMeetingSummarySyncOperations(input.scopeKey, Date.now());
  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await claimMeetingSummarySyncOperations(input.scopeKey, {
      nowMs,
      staleClaimAfterMs: STALE_CLAIM_MS,
      limit: 3,
    });
    if (claims.length === 0) {
      const retryAfterMs = mergeSyncRetryAfterMs(
        nowMs,
        await nextMeetingSummarySyncAttemptAt(input.scopeKey, STALE_CLAIM_MS),
        earliestRetryMs,
      );
      diagnosticAudit('summary_sync_drain', {
        status: 'drained',
        processed: processedCount,
        retry_scheduled: retryAfterMs !== null,
      });
      return { outcome: 'drained', processedCount, retryAfterMs };
    }
    const results = await Promise.all(claims.map(claim => processClaim(
      claim,
      input.accessToken,
      input.signal,
      input.isCurrent,
    )));
    processedCount += results.filter(result => result.processed).length;
    results.forEach(result => {
      if (result.retryAfterMs === null) return;
      earliestRetryMs = earliestRetryMs === null
        ? result.retryAfterMs
        : Math.min(earliestRetryMs, result.retryAfterMs);
    });
    if (results.some(result => result.outcome === 'stale')) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
  }
  return { outcome: 'batch_limit', processedCount, retryAfterMs: 0 };
}
