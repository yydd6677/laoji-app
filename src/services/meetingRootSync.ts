import {
  createMeeting,
  deleteMeeting,
  updateMeeting,
  type ApiMeeting,
} from './api';
import {
  sqliteMeetingNoteRepository,
  type MeetingRootSyncClaim,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';

const STALE_CLAIM_MS = 90_000;
const MAX_BATCHES_PER_DRAIN = 20;
const drainTailByScope = new Map<ScopeKey, Promise<unknown>>();

class InvalidMeetingRootPayloadError extends Error {}
class UnsupportedMeetingRootPayloadError extends Error {}
class MeetingRootResponseContractError extends Error {}

type CreateMutation = {
  kind: 'create';
  clientRequestId: string;
  payload: Parameters<typeof createMeeting>[0];
};

type UpdateMutation = {
  kind: 'update';
  payload: Parameters<typeof updateMeeting>[1];
};

type DeleteMutation = { kind: 'delete' };

type MeetingRootMutation = CreateMutation | UpdateMutation | DeleteMutation;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; maximum?: number } = {},
): string {
  if (typeof value !== 'string') throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  const normalized = options.allowEmpty ? value : value.trim();
  const maximum = options.maximum ?? 100_000;
  if (
    (!options.allowEmpty && !normalized)
    || normalized.length > maximum
    || /[\u0000]/.test(normalized)
  ) throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  return normalized;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  return requiredString(value, label, { allowEmpty: true, maximum });
}

function participants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new InvalidMeetingRootPayloadError('meeting participants are invalid');
  }
  const normalized = value.map(item => requiredString(
    item,
    'meeting participant',
    { maximum: 1_000 },
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new InvalidMeetingRootPayloadError('meeting participants are duplicated');
  }
  return normalized;
}

function meetingMode(value: unknown, nullable: false): NonNullable<ApiMeeting['mode']>;
function meetingMode(value: unknown, nullable: true): NonNullable<ApiMeeting['mode']> | null;
function meetingMode(
  value: unknown,
  nullable: boolean,
): NonNullable<ApiMeeting['mode']> | null {
  if (value === null && nullable) return null;
  if (value !== 'realtime' && value !== 'offline' && value !== 'whisper' && value !== 'qwen') {
    throw new InvalidMeetingRootPayloadError('meeting mode is invalid');
  }
  return value;
}

function optionalTime(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  }
  return Number(value);
}

function isoTime(value: number, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  }
  return date.toISOString();
}

function assertIdentity(payload: Record<string, unknown>, claim: MeetingRootSyncClaim): void {
  const meetingId = requiredString(
    payload.meeting_id ?? payload.client_note_id,
    'meeting root identity',
    { maximum: 512 },
  );
  if (meetingId !== claim.meetingId) {
    throw new InvalidMeetingRootPayloadError('meeting root identity changed');
  }
}

function parseCreateMutation(
  parsed: Record<string, unknown>,
  claim: MeetingRootSyncClaim,
): CreateMutation {
  assertIdentity(parsed, claim);
  const clientRequestId = requiredString(
    parsed.client_request_id,
    'meeting client request identity',
    { maximum: 512 },
  );
  const recordedAtMs = optionalTime(parsed.recorded_at_ms, 'meeting recorded time');
  return {
    kind: 'create',
    clientRequestId,
    payload: {
      title: requiredString(parsed.title, 'meeting title', { allowEmpty: true }),
      description: nullableString(parsed.description, 'meeting description', 100_000),
      participants: participants(parsed.participants),
      mode: parsed.mode === null ? 'realtime' : meetingMode(parsed.mode, false),
      clientRequestId,
      location: nullableString(parsed.location, 'meeting location', 2_000),
      recordedAt: recordedAtMs === null ? null : isoTime(recordedAtMs, 'meeting recorded time'),
    },
  };
}

function parseUpdateMutation(
  parsed: Record<string, unknown>,
  claim: MeetingRootSyncClaim,
): UpdateMutation {
  assertIdentity(parsed, claim);
  if (!isRecord(parsed.changes)) {
    throw new InvalidMeetingRootPayloadError('meeting update changes are invalid');
  }
  const source = parsed.changes;
  const keys = Object.keys(source);
  if (keys.length === 0) throw new InvalidMeetingRootPayloadError('meeting update is empty');
  const supported = new Set(['title', 'description', 'participants', 'location', 'mode', 'status']);
  if (keys.some(key => !supported.has(key))) {
    throw new UnsupportedMeetingRootPayloadError('meeting update field is not supported by legacy API');
  }
  const payload: Parameters<typeof updateMeeting>[1] = {};
  if (Object.prototype.hasOwnProperty.call(source, 'title')) {
    payload.title = requiredString(source.title, 'meeting title', { allowEmpty: true });
  }
  if (Object.prototype.hasOwnProperty.call(source, 'description')) {
    payload.description = nullableString(source.description, 'meeting description', 100_000);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'participants')) {
    payload.participants = participants(source.participants);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'location')) {
    payload.location = nullableString(source.location, 'meeting location', 2_000);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'mode')) {
    const mode = meetingMode(source.mode, true);
    if (mode === null) {
      throw new UnsupportedMeetingRootPayloadError('legacy meeting API cannot clear capture mode');
    }
    payload.mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'status')) {
    payload.status = requiredString(source.status, 'meeting status', { maximum: 160 });
  }
  return { kind: 'update', payload };
}

function parseMeetingRootMutation(claim: MeetingRootSyncClaim): MeetingRootMutation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(claim.requestPayloadJson);
  } catch {
    throw new InvalidMeetingRootPayloadError('meeting root sync payload is not JSON');
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1) {
    throw new InvalidMeetingRootPayloadError('meeting root sync payload schema is invalid');
  }
  if (claim.operationType === 'meeting.create') return parseCreateMutation(parsed, claim);
  if (claim.operationType === 'meeting.update') return parseUpdateMutation(parsed, claim);
  if (claim.operationType === 'meeting.delete') {
    assertIdentity(parsed, claim);
    return { kind: 'delete' };
  }
  throw new UnsupportedMeetingRootPayloadError('meeting root operation is not supported');
}

function remoteMeetingId(value: ApiMeeting): string {
  const remoteId = typeof value?.id === 'string' ? value.id.trim() : '';
  if (!remoteId || remoteId.length > 512 || /[\u0000-\u001f\u007f]/.test(remoteId)) {
    throw new MeetingRootResponseContractError('meeting response remote identity is invalid');
  }
  return remoteId;
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: MeetingRootSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.idempotencyKey));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function conflictPayload(error: HttpResponseError): string {
  return JSON.stringify({
    status: error.status,
    detail: error.detail,
  });
}

type ClaimResult = {
  processed: boolean;
  retryAfterMs: number | null;
  outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale';
};

async function rejectLocalClaim(
  claim: MeetingRootSyncClaim,
  error: InvalidMeetingRootPayloadError | UnsupportedMeetingRootPayloadError,
): Promise<ClaimResult> {
  const blocked = error instanceof UnsupportedMeetingRootPayloadError;
  const applied = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
    disposition: blocked ? 'blocked' : 'permanent_error',
    errorCode: blocked ? 'root_contract_unsupported' : 'invalid_local_payload',
    nextAttemptAtMs: null,
    updatedAtMs: Date.now(),
  });
  diagnosticWarn('[meeting-root-sync] rejected local payload', error);
  return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
}

async function processClaim(
  claim: MeetingRootSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let mutation: MeetingRootMutation;
  try {
    mutation = parseMeetingRootMutation(claim);
  } catch (error) {
    if (error instanceof InvalidMeetingRootPayloadError
      || error instanceof UnsupportedMeetingRootPayloadError) {
      return rejectLocalClaim(claim, error);
    }
    throw error;
  }

  try {
    let remoteId = claim.remoteId;
    if (mutation.kind === 'create') {
      if (!remoteId) {
        const response = await createMeeting(mutation.payload, accessToken, signal);
        remoteId = remoteMeetingId(response);
        if (response.client_request_id != null
          && response.client_request_id.trim() !== mutation.clientRequestId) {
          throw new MeetingRootResponseContractError('meeting create identity changed');
        }
      }
    } else {
      if (!remoteId) {
        throw new UnsupportedMeetingRootPayloadError('meeting remote identity is missing');
      }
      if (mutation.kind === 'update') {
        const response = await updateMeeting(remoteId, mutation.payload, accessToken, signal);
        if (remoteMeetingId(response) !== remoteId) {
          throw new MeetingRootResponseContractError('meeting update identity changed');
        }
      } else {
        await deleteMeeting(remoteId, accessToken, signal);
      }
    }
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    if (!remoteId) throw new MeetingRootResponseContractError('meeting remote identity is missing');
    const completed = await sqliteMeetingNoteRepository.completeMeetingRootSyncClaim(
      claim,
      remoteId,
      Date.now(),
    );
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    if (error instanceof InvalidMeetingRootPayloadError
      || error instanceof UnsupportedMeetingRootPayloadError) {
      return rejectLocalClaim(claim, error);
    }
    const nowMs = Date.now();
    if (error instanceof HttpResponseError && error.status === 409) {
      const recorded = await sqliteMeetingNoteRepository.recordMeetingRootSyncConflict(claim, {
        remotePayloadJson: conflictPayload(error),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      const delayMs = 60_000;
      const retried = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'auth_unauthorized',
        nextAttemptAtMs: nowMs + delayMs,
        updatedAtMs: nowMs,
      });
      return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
    }
    if (error instanceof MeetingRootResponseContractError
      || (error instanceof Error && /remote identity|remote ID/i.test(error.message))) {
      const blocked = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'root_response_contract_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
    }
    if (error instanceof HttpResponseError && !transientHttpStatus(error.status)) {
      const contractUnavailable = error.status === 403 || error.status === 404
        || error.status === 405 || error.status === 501;
      const applied = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
        disposition: contractUnavailable ? 'blocked' : 'permanent_error',
        errorCode: contractUnavailable ? 'root_contract_unavailable' : 'root_request_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingRootSyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingRootSyncResult {
  outcome: 'drained' | 'not_owned' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

async function drainMeetingRootSyncOnce(
  input: DrainMeetingRootSyncInput,
): Promise<DrainMeetingRootSyncResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || !input.isCurrent()) {
    return { outcome: 'stale', processedCount: 0, retryAfterMs: null };
  }
  const writeState = await sqliteMeetingNoteRepository.getScopeWriteState(input.scopeKey);
  if (writeState.writeOwner !== 'canonical') {
    return { outcome: 'not_owned', processedCount: 0, retryAfterMs: null };
  }
  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimMeetingRootSyncOperations(
      input.scopeKey,
      {
        nowMs,
        staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
        maxMeetings: 3,
      },
    );
    if (claims.length === 0) {
      diagnosticAudit('meeting_root_sync_drain', {
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

export function drainMeetingRootSync(
  input: DrainMeetingRootSyncInput,
): Promise<DrainMeetingRootSyncResult> {
  const previous = drainTailByScope.get(input.scopeKey) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => drainMeetingRootSyncOnce(input));
  drainTailByScope.set(input.scopeKey, operation);
  void operation.finally(() => {
    if (drainTailByScope.get(input.scopeKey) === operation) {
      drainTailByScope.delete(input.scopeKey);
    }
  }).catch(() => undefined);
  return operation;
}
