import {
  ActionItemConflictResponseError,
  loadMeetingCapabilities,
  upsertMeetingActionV2,
  type ActionItemV2Mutation,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type ActionSyncClaim,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { HttpResponseError } from './errors';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const STALE_CLAIM_MS = 90_000;
const MAX_BATCHES_PER_DRAIN = 20;
const CAPABILITY_RETRY_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = allowEmpty ? value : value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > 20_000 || /[\u0000]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  const normalized = requiredString(value, label);
  return normalized;
}

function nullableTime(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function requiredTime(value: unknown, label: string): number {
  const normalized = nullableTime(value, label);
  if (normalized === null) throw new Error(`${label} is missing`);
  return normalized;
}

function parseActionMutation(claim: ActionSyncClaim): ActionItemV2Mutation {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 2) {
    throw new Error('meeting action sync payload schema is invalid');
  }
  const actionId = requiredString(parsed.action_id, 'meeting action sync identity');
  if (actionId !== claim.actionId) throw new Error('meeting action sync identity changed');
  const status = parsed.status;
  if (status !== 'pending' && status !== 'completed' && status !== 'dismissed') {
    throw new Error('meeting action sync status is invalid');
  }
  const sourceKind = parsed.source_kind;
  if (sourceKind !== 'generated' && sourceKind !== 'manual' && sourceKind !== 'marker') {
    throw new Error('meeting action sync source is invalid');
  }
  const clientUpdatedAtMs = requiredTime(parsed.client_updated_at_ms, 'meeting action update time');
  const clientCreatedAtMs = parsed.client_created_at_ms === undefined
    ? clientUpdatedAtMs
    : requiredTime(parsed.client_created_at_ms, 'meeting action creation time');
  const userEditedAtMs = parsed.user_edited_at_ms === undefined
    ? sourceKind === 'manual' || sourceKind === 'marker' ? clientUpdatedAtMs : null
    : nullableTime(parsed.user_edited_at_ms, 'meeting action edit time');
  const completedAtMs = parsed.completed_at_ms === undefined
    ? status === 'completed' ? clientUpdatedAtMs : null
    : nullableTime(parsed.completed_at_ms, 'meeting action completion time');
  if (clientCreatedAtMs > clientUpdatedAtMs) {
    throw new Error('meeting action creation time moved after its update');
  }
  if (userEditedAtMs !== null && userEditedAtMs > clientUpdatedAtMs) {
    throw new Error('meeting action edit time moved after its update');
  }
  if ((status === 'completed') !== (completedAtMs !== null)) {
    throw new Error('meeting action completion time does not match status');
  }
  if (
    completedAtMs !== null
    && (completedAtMs < clientCreatedAtMs || completedAtMs > clientUpdatedAtMs)
  ) {
    throw new Error('meeting action completion time is outside its lifetime');
  }
  const generationFingerprint = parsed.generation_fingerprint === undefined
    ? null
    : nullableString(parsed.generation_fingerprint, 'meeting action generation identity');
  if (generationFingerprint !== null && generationFingerprint.length > 512) {
    throw new Error('meeting action generation identity is too long');
  }
  if (sourceKind !== 'generated' && generationFingerprint !== null) {
    throw new Error('manual meeting action cannot have a generation identity');
  }
  const dueAtMs = nullableTime(parsed.due_at_ms, 'meeting action due time');
  const reminderAtMs = nullableTime(parsed.reminder_at_ms, 'meeting action reminder time');
  if (reminderAtMs !== null && (dueAtMs === null || status !== 'pending')) {
    throw new Error('meeting action reminder does not match its state');
  }
  return {
    schema_version: 2,
    meeting_remote_id: requiredString(
      parsed.meeting_remote_id,
      'meeting action remote meeting identity',
    ),
    action_id: actionId,
    remote_id: nullableString(parsed.remote_id, 'meeting action remote identity'),
    expected_remote_revision: nullableTime(
      parsed.expected_remote_revision,
      'meeting action expected remote revision',
    ),
    client_created_at_ms: clientCreatedAtMs,
    client_updated_at_ms: clientUpdatedAtMs,
    user_edited_at_ms: userEditedAtMs,
    completed_at_ms: completedAtMs,
    content: requiredString(parsed.content, 'meeting action content'),
    status,
    assignee: nullableString(parsed.assignee, 'meeting action assignee'),
    due_at_ms: dueAtMs,
    reminder_at_ms: reminderAtMs,
    followup_event_source_id: nullableString(
      parsed.followup_event_source_id,
      'meeting action follow-up identity',
    ),
    source_kind: sourceKind,
    source_summary_version_id: nullableString(
      parsed.source_summary_version_id,
      'meeting action summary identity',
    ),
    source_segment_id: nullableString(parsed.source_segment_id, 'meeting action segment identity'),
    source_start_ms: nullableTime(parsed.source_start_ms, 'meeting action source time'),
    generation_fingerprint: generationFingerprint,
  };
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: ActionSyncClaim): number {
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

type ClaimResult = {
  processed: boolean;
  retryAfterMs: number | null;
  outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale';
};

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function processClaim(
  claim: ActionSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let mutation: ActionItemV2Mutation;
  try {
    mutation = parseActionMutation(claim);
    if (mutation.meeting_remote_id !== claim.meetingRemoteId) {
      throw new Error('meeting action remote meeting identity changed');
    }
  } catch (error) {
    const nowMs = Date.now();
    await sqliteMeetingNoteRepository.failActionSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: nowMs,
    });
    diagnosticWarn('[meeting-action-sync] rejected invalid local payload', error);
    return { processed: true, retryAfterMs: null, outcome: 'blocked' };
  }

  try {
    const response = await upsertMeetingActionV2({
      accessToken,
      meetingRemoteId: mutation.meeting_remote_id,
      idempotencyKey: claim.idempotencyKey,
      mutation,
      signal,
    });
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await sqliteMeetingNoteRepository.completeActionSyncClaim(
      claim,
      response.id,
      response.revision,
      Date.now(),
    );
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const nowMs = Date.now();
    if (error instanceof ActionItemConflictResponseError) {
      const recorded = await sqliteMeetingNoteRepository.recordActionSyncConflict(claim, {
        localRevision: mutation.expected_remote_revision,
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
      const retried = await sqliteMeetingNoteRepository.failActionSyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'auth_unauthorized',
        nextAttemptAtMs: nowMs + delayMs,
        updatedAtMs: nowMs,
      });
      return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
    }
    if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      const blocked = error.status === 403 || error.status === 404 || error.status === 405 || error.status === 501;
      const applied = await sqliteMeetingNoteRepository.failActionSyncClaim(claim, {
        disposition: blocked ? 'blocked' : 'permanent_error',
        errorCode: blocked ? 'action_contract_unavailable' : 'action_request_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    if (error instanceof Error && /响应.*(?:格式|版本)|remote identity|remote revision/i.test(error.message)) {
      const applied = await sqliteMeetingNoteRepository.failActionSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'action_response_contract_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await sqliteMeetingNoteRepository.failActionSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingActionSyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingActionSyncResult {
  outcome: 'drained' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

export async function drainMeetingActionSync(
  input: DrainMeetingActionSyncInput,
): Promise<DrainMeetingActionSyncResult> {
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
      diagnosticWarn('[meeting-action-sync] capability refresh failed', error);
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
  if (capability.source !== 'remote' || !capability.capabilities.actionItemsV2) {
    return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  }

  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimActionSyncOperations(input.scopeKey, {
      nowMs,
      staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
      maxMeetings: 3,
    });
    if (claims.length === 0) {
      diagnosticAudit('meeting_action_sync_drain', {
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
