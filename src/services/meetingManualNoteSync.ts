import {
  loadMeetingCapabilities,
  ManualNoteConflictResponseError,
  upsertMeetingManualNoteV2,
  type ManualNoteV2Mutation,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type ManualNoteSyncClaim,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';

const STALE_CLAIM_MS = 90_000;
const MAX_BATCHES_PER_DRAIN = 20;
const CAPABILITY_RETRY_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function parseManualNoteMutation(claim: ManualNoteSyncClaim): ManualNoteV2Mutation {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 2) {
    throw new Error('manual note sync payload schema is invalid');
  }
  const meetingRemoteId = identifier(
    parsed.meeting_remote_id,
    'manual note remote meeting identity',
    160,
  );
  if (meetingRemoteId !== claim.meetingRemoteId) {
    throw new Error('manual note remote meeting identity changed');
  }
  if (
    typeof parsed.content !== 'string'
    || parsed.content.length > 200_000
    || parsed.content.includes('\u0000')
  ) throw new Error('manual note content is invalid');
  const clientNoteRevision = safeInteger(
    parsed.client_note_revision,
    'manual note client revision',
    1,
  );
  const clientUpdatedAtMs = safeInteger(parsed.client_updated_at_ms, 'manual note update time');
  const userEditedAtMs = nullableInteger(parsed.user_edited_at_ms, 'manual note edit time');
  if (userEditedAtMs !== null && userEditedAtMs > clientUpdatedAtMs) {
    throw new Error('manual note edit time is invalid');
  }
  return {
    schema_version: 2,
    meeting_remote_id: meetingRemoteId,
    expected_remote_revision: nullableInteger(
      parsed.expected_remote_revision,
      'manual note expected remote revision',
    ),
    client_note_revision: clientNoteRevision,
    client_updated_at_ms: clientUpdatedAtMs,
    user_edited_at_ms: userEditedAtMs,
    content: parsed.content.replace(/\r\n?/g, '\n'),
  };
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: ManualNoteSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.idempotencyKey));
}

function remotePayloadJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length <= 1_048_576) return serialized;
  } catch {
    // Store a bounded diagnostic object below.
  }
  return JSON.stringify({ error: 'remote_conflict_payload_unavailable' });
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

type ClaimResult = {
  processed: boolean;
  retryAfterMs: number | null;
  outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale';
};

async function processClaim(
  claim: ManualNoteSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let mutation: ManualNoteV2Mutation;
  try {
    mutation = parseManualNoteMutation(claim);
  } catch (error) {
    await sqliteMeetingNoteRepository.failManualNoteSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[manual-note-sync] rejected invalid local payload', error);
    return { processed: true, retryAfterMs: null, outcome: 'blocked' };
  }

  try {
    const response = await upsertMeetingManualNoteV2({
      accessToken,
      meetingRemoteId: mutation.meeting_remote_id,
      idempotencyKey: claim.idempotencyKey,
      mutation,
      signal,
    });
    if (
      !response.exists
      || response.meetingRemoteId !== mutation.meeting_remote_id
      || response.clientNoteRevision !== mutation.client_note_revision
      || response.clientUpdatedAtMs !== mutation.client_updated_at_ms
      || response.userEditedAtMs !== mutation.user_edited_at_ms
      || response.content !== mutation.content
    ) throw new Error('manual note sync response does not acknowledge the request snapshot');
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await sqliteMeetingNoteRepository.completeManualNoteSyncClaim(
      claim,
      response.revision,
      Date.now(),
    );
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const nowMs = Date.now();
    if (error instanceof ManualNoteConflictResponseError) {
      const recorded = await sqliteMeetingNoteRepository.recordManualNoteSyncConflict(claim, {
        remoteRevision: error.remoteRevision,
        remotePayloadJson: remotePayloadJson({
          error_code: error.contractCode,
          current: error.remotePayload,
        }),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      const delayMs = 60_000;
      const retried = await sqliteMeetingNoteRepository.failManualNoteSyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'auth_unauthorized',
        nextAttemptAtMs: nowMs + delayMs,
        updatedAtMs: nowMs,
      });
      return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
    }
    if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      const blocked = error.status === 403 || error.status === 404
        || error.status === 405 || error.status === 501;
      const applied = await sqliteMeetingNoteRepository.failManualNoteSyncClaim(claim, {
        disposition: blocked ? 'blocked' : 'permanent_error',
        errorCode: blocked ? 'manual_note_contract_unavailable' : 'manual_note_request_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    if (
      error instanceof Error
      && /响应.*(?:格式|版本)|manual note sync response|remote manual note|remote revision/i.test(error.message)
    ) {
      const applied = await sqliteMeetingNoteRepository.failManualNoteSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'manual_note_response_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await sqliteMeetingNoteRepository.failManualNoteSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingManualNoteSyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingManualNoteSyncResult {
  outcome: 'drained' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

export async function drainMeetingManualNoteSync(
  input: DrainMeetingManualNoteSyncInput,
): Promise<DrainMeetingManualNoteSyncResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || !input.isCurrent()) {
    return { outcome: 'stale', processedCount: 0, retryAfterMs: null };
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
      diagnosticWarn('[manual-note-sync] capability refresh failed', error);
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
  if (capability.source !== 'remote' || !capability.capabilities.manualNotesV2) {
    return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  }
  await sqliteMeetingNoteRepository.ensureManualNoteSyncOperations(input.scopeKey, Date.now());

  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimManualNoteSyncOperations(input.scopeKey, {
      nowMs,
      staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
      maxMeetings: 3,
    });
    if (claims.length === 0) {
      diagnosticAudit('manual_note_sync_drain', {
        status: 'drained',
        processed: processedCount,
        retry_scheduled: earliestRetryMs !== null,
      });
      return { outcome: 'drained', processedCount, retryAfterMs: earliestRetryMs };
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
