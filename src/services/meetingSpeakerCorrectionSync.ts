import {
  loadMeetingCapabilities,
  SpeakerCorrectionConflictResponseError,
  submitSpeakerCorrectionV2,
  type SpeakerCorrectionV2Mutation,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type SpeakerCorrectionSyncClaim,
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

function requiredString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function requiredRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function segmentIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new Error('speaker correction segment identities are invalid');
  }
  const normalized = value.map(item => requiredString(
    item,
    'speaker correction segment identity',
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('speaker correction segment identities are duplicated');
  }
  return normalized;
}

function parseSpeakerCorrectionMutation(
  claim: SpeakerCorrectionSyncClaim,
): SpeakerCorrectionV2Mutation {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 2) {
    throw new Error('speaker correction sync payload schema is invalid');
  }
  const clientRequestId = requiredString(
    parsed.client_request_id,
    'speaker correction sync identity',
  );
  if (clientRequestId !== claim.correctionId) {
    throw new Error('speaker correction sync identity changed');
  }
  const baseRevision = requiredRevision(
    parsed.base_revision,
    'speaker correction base revision',
  );
  if (baseRevision !== claim.baseRevision) {
    throw new Error('speaker correction base revision changed');
  }
  const scope = parsed.scope;
  if (scope !== 'segment' && scope !== 'cluster' && scope !== 'future_profile') {
    throw new Error('speaker correction scope is invalid');
  }
  const clusterId = nullableString(parsed.cluster_id, 'speaker correction cluster identity');
  const speakerProfileId = nullableString(
    parsed.speaker_profile_id,
    'speaker correction profile identity',
  );
  const consentToProfileUpdate = parsed.consent_to_profile_update;
  if (typeof consentToProfileUpdate !== 'boolean') {
    throw new Error('speaker correction consent state is invalid');
  }
  if (scope !== 'segment' && clusterId === null) {
    throw new Error('speaker correction cluster identity is missing');
  }
  if (scope === 'future_profile' && (speakerProfileId === null || !consentToProfileUpdate)) {
    throw new Error('speaker correction future profile consent is missing');
  }
  if (scope !== 'future_profile' && consentToProfileUpdate) {
    throw new Error('speaker correction profile consent has invalid scope');
  }
  return {
    schema_version: 2,
    client_request_id: clientRequestId,
    transcript_revision_id: requiredString(
      parsed.transcript_revision_id,
      'speaker correction transcript revision',
    ),
    scope,
    segment_ids: segmentIds(parsed.segment_ids),
    cluster_id: clusterId,
    speaker_profile_id: speakerProfileId,
    display_name: requiredString(parsed.display_name, 'speaker correction name', 120),
    consent_to_profile_update: consentToProfileUpdate,
    base_revision: baseRevision,
  };
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: SpeakerCorrectionSyncClaim): number {
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
  claim: SpeakerCorrectionSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let mutation: SpeakerCorrectionV2Mutation;
  try {
    mutation = parseSpeakerCorrectionMutation(claim);
    const parsed = JSON.parse(claim.requestPayloadJson) as Record<string, unknown>;
    if (requiredString(parsed.meeting_remote_id, 'speaker correction remote meeting identity') !== claim.meetingRemoteId) {
      throw new Error('speaker correction remote meeting identity changed');
    }
  } catch (error) {
    await sqliteMeetingNoteRepository.failSpeakerCorrectionSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[speaker-correction-sync] rejected invalid local payload', error);
    return { processed: true, retryAfterMs: null, outcome: 'blocked' };
  }

  try {
    const response = await submitSpeakerCorrectionV2({
      accessToken,
      meetingRemoteId: claim.meetingRemoteId,
      idempotencyKey: claim.idempotencyKey,
      mutation,
      signal,
    });
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await sqliteMeetingNoteRepository.completeSpeakerCorrectionSyncClaim(
      claim,
      response.assignmentRevision,
      Date.now(),
    );
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const nowMs = Date.now();
    if (error instanceof SpeakerCorrectionConflictResponseError) {
      const recorded = await sqliteMeetingNoteRepository.recordSpeakerCorrectionSyncConflict(claim, {
        remoteRevision: error.remoteRevision,
        remotePayloadJson: remotePayloadJson(error.remotePayload),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      const delayMs = 60_000;
      const retried = await sqliteMeetingNoteRepository.failSpeakerCorrectionSyncClaim(claim, {
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
      const applied = await sqliteMeetingNoteRepository.failSpeakerCorrectionSyncClaim(claim, {
        disposition: blocked ? 'blocked' : 'permanent_error',
        errorCode: blocked ? 'speaker_correction_contract_unavailable' : 'speaker_correction_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    if (error instanceof Error && /响应.*(?:格式|版本)|remote meeting identity/i.test(error.message)) {
      const applied = await sqliteMeetingNoteRepository.failSpeakerCorrectionSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'speaker_correction_response_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await sqliteMeetingNoteRepository.failSpeakerCorrectionSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingSpeakerCorrectionSyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingSpeakerCorrectionSyncResult {
  outcome: 'drained' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

export async function drainMeetingSpeakerCorrectionSync(
  input: DrainMeetingSpeakerCorrectionSyncInput,
): Promise<DrainMeetingSpeakerCorrectionSyncResult> {
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
      diagnosticWarn('[speaker-correction-sync] capability refresh failed', error);
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
  if (capability.source !== 'remote' || !capability.capabilities.speakerCorrections) {
    return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  }

  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimSpeakerCorrectionSyncOperations(
      input.scopeKey,
      {
        nowMs,
        staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
        maxMeetings: 3,
      },
    );
    if (claims.length === 0) {
      diagnosticAudit('speaker_correction_sync_drain', {
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
