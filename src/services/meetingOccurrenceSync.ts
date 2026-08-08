import {
  loadMeetingCapabilities,
  OccurrenceLinkConflictResponseError,
  parseRemoteOccurrenceLinkV2,
  upsertMeetingOccurrenceLinkV2,
  type OccurrenceLinkV2Mutation,
  type OccurrenceScheduleSnapshotV2,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type OccurrenceSyncClaim,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
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
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function nullableIdentifier(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : identifier(value, label, maximum);
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

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw new Error(`${label} is invalid`);
  return value;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseSnapshot(value: unknown): OccurrenceScheduleSnapshotV2 {
  if (!isRecord(value) || typeof value.allDay !== 'boolean') {
    throw new Error('occurrence schedule snapshot is invalid');
  }
  const eventTitle = nullableText(value.eventTitle, 'occurrence title', 20_000);
  if (eventTitle === null) throw new Error('occurrence title is invalid');
  const plannedStartMs = nullableInteger(value.plannedStartMs, 'occurrence start time');
  const plannedEndMs = nullableInteger(value.plannedEndMs, 'occurrence end time');
  if (
    plannedStartMs !== null
    && plannedEndMs !== null
    && plannedEndMs < plannedStartMs
  ) throw new Error('occurrence schedule time is invalid');
  if (!Array.isArray(value.participants) || value.participants.length > 500) {
    throw new Error('occurrence participants are invalid');
  }
  const participants = value.participants.map(item => {
    if (
      typeof item !== 'string'
      || !item.trim()
      || item.length > 1_000
      || item.includes('\u0000')
    ) throw new Error('occurrence participants are invalid');
    return item;
  });
  return {
    eventTitle,
    plannedStartMs,
    plannedEndMs,
    allDay: value.allDay,
    timezoneId: nullableText(value.timezoneId, 'occurrence timezone', 160),
    location: nullableText(value.location, 'occurrence location', 2_000),
    participants,
    description: nullableText(value.description, 'occurrence description', 100_000),
    capturedEventRevision: nullableInteger(value.capturedEventRevision, 'occurrence revision'),
    capturedAtMs: safeInteger(value.capturedAtMs, 'occurrence capture time'),
  };
}

function parseOccurrenceMutation(claim: OccurrenceSyncClaim): OccurrenceLinkV2Mutation {
  const parsed = JSON.parse(claim.requestPayloadJson) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 2) {
    throw new Error('occurrence sync payload schema is invalid');
  }
  const meetingRemoteId = identifier(parsed.meeting_remote_id, 'occurrence remote meeting ID', 160);
  if (meetingRemoteId !== claim.meetingRemoteId) {
    throw new Error('occurrence remote meeting identity changed');
  }
  const expectedRemoteRevision = nullableInteger(
    parsed.expected_remote_revision,
    'occurrence expected remote revision',
  );
  if (expectedRemoteRevision !== null && expectedRemoteRevision < 1) {
    throw new Error('occurrence expected remote revision is invalid');
  }
  const linkState = parsed.link_state;
  if (linkState !== 'active' && linkState !== 'orphaned') {
    throw new Error('occurrence link state is invalid');
  }
  return {
    schema_version: 2,
    meeting_remote_id: meetingRemoteId,
    expected_remote_revision: expectedRemoteRevision,
    source_event_id: identifier(parsed.source_event_id, 'occurrence source event ID'),
    occurrence_date: date(parsed.occurrence_date, 'occurrence date'),
    calendar_revision: nullableInteger(parsed.calendar_revision, 'occurrence calendar revision'),
    recurrence_segment_id: nullableIdentifier(
      parsed.recurrence_segment_id,
      'occurrence recurrence segment ID',
    ),
    series_key: nullableIdentifier(parsed.series_key, 'occurrence series ID'),
    link_state: linkState,
    client_updated_at_ms: safeInteger(parsed.client_updated_at_ms, 'occurrence update time'),
    schedule_snapshot: parseSnapshot(parsed.schedule_snapshot),
  };
}

function snapshotsEqual(
  left: OccurrenceScheduleSnapshotV2,
  right: OccurrenceScheduleSnapshotV2,
): boolean {
  return left.eventTitle === right.eventTitle
    && left.plannedStartMs === right.plannedStartMs
    && left.plannedEndMs === right.plannedEndMs
    && left.allDay === right.allDay
    && left.timezoneId === right.timezoneId
    && left.location === right.location
    && left.description === right.description
    && left.capturedEventRevision === right.capturedEventRevision
    && left.capturedAtMs === right.capturedAtMs
    && left.participants.length === right.participants.length
    && left.participants.every((item, index) => item === right.participants[index]);
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function retryDelayMs(claim: OccurrenceSyncClaim): number {
  const exponent = Math.max(0, Math.min(10, claim.attemptCount - 1));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(claim.idempotencyKey));
}

function boundedRemotePayload(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length <= 1_048_576) return serialized;
  } catch {
    // Store the bounded fallback below.
  }
  return JSON.stringify({ error: 'remote_occurrence_conflict_payload_unavailable' });
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function attachMatchingConflictCurrent(
  claim: OccurrenceSyncClaim,
  mutation: OccurrenceLinkV2Mutation,
  error: OccurrenceLinkConflictResponseError,
  nowMs: number,
): Promise<'completed' | 'conflicted' | 'unavailable'> {
  try {
    const remote = parseRemoteOccurrenceLinkV2(error.remotePayload, {
      sourceEventId: mutation.source_event_id,
      occurrenceDate: mutation.occurrence_date,
    });
    if (
      !remote.exists
      || remote.remoteId === null
      || remote.meetingRemoteId === null
      || remote.sourceEventId === null
      || remote.occurrenceDate === null
      || remote.linkState === null
      || remote.scheduleSnapshot === null
      || remote.serverCreatedAtMs === null
      || remote.serverUpdatedAtMs === null
    ) return 'unavailable';
    const merged = await sqliteMeetingNoteRepository.mergeOccurrenceRemote({
      scopeKey: claim.scopeKey,
      pulledAtMs: nowMs,
      remote: {
        remoteId: remote.remoteId,
        meetingRemoteId: remote.meetingRemoteId,
        revision: remote.revision,
        sourceEventId: remote.sourceEventId,
        occurrenceDate: remote.occurrenceDate,
        calendarRevision: remote.calendarRevision,
        recurrenceSegmentId: remote.recurrenceSegmentId,
        seriesKey: remote.seriesKey,
        linkState: remote.linkState,
        clientUpdatedAtMs: remote.clientUpdatedAtMs,
        scheduleSnapshot: remote.scheduleSnapshot,
        serverCreatedAtMs: remote.serverCreatedAtMs,
        serverUpdatedAtMs: remote.serverUpdatedAtMs,
      },
    });
    // The merge may have recorded a conflict for a different local meeting
    // that currently owns the same calendar occurrence. That does not release
    // this claim; let the caller record the current operation as conflicted so
    // it cannot remain `in_flight` forever.
    if (merged.outcome === 'conflicted') return 'unavailable';
    if (merged.meetingId !== claim.meetingId) return 'unavailable';
    if (merged.outcome === 'unchanged') {
      const completed = await sqliteMeetingNoteRepository.completeOccurrenceSyncClaim(
        claim,
        remote.remoteId,
        remote.revision,
        nowMs,
      );
      return completed ? 'completed' : 'unavailable';
    }
    if (merged.outcome === 'attached' || merged.outcome === 'updated') return 'completed';
  } catch {
    // Preserve the original 409/412 payload below when it cannot be attached safely.
  }
  return 'unavailable';
}

type ClaimResult = {
  processed: boolean;
  retryAfterMs: number | null;
  outcome: 'completed' | 'retry' | 'blocked' | 'conflict' | 'stale';
};

async function processClaim(
  claim: OccurrenceSyncClaim,
  accessToken: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ClaimResult> {
  let mutation: OccurrenceLinkV2Mutation;
  try {
    mutation = parseOccurrenceMutation(claim);
  } catch (error) {
    await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
      disposition: 'permanent_error',
      errorCode: 'invalid_local_payload',
      nextAttemptAtMs: null,
      updatedAtMs: Date.now(),
    });
    diagnosticWarn('[occurrence-sync] rejected invalid local payload', error);
    return { processed: true, retryAfterMs: null, outcome: 'blocked' };
  }

  try {
    const response = await upsertMeetingOccurrenceLinkV2({
      accessToken,
      meetingRemoteId: mutation.meeting_remote_id,
      idempotencyKey: claim.idempotencyKey,
      mutation,
      signal,
    });
    if (
      !response.exists
      || response.meetingRemoteId !== mutation.meeting_remote_id
      || response.sourceEventId !== mutation.source_event_id
      || response.occurrenceDate !== mutation.occurrence_date
      || response.calendarRevision !== mutation.calendar_revision
      || response.recurrenceSegmentId !== mutation.recurrence_segment_id
      || response.seriesKey !== mutation.series_key
      || response.linkState !== mutation.link_state
      || response.clientUpdatedAtMs !== mutation.client_updated_at_ms
      || response.scheduleSnapshot === null
      || !snapshotsEqual(response.scheduleSnapshot, mutation.schedule_snapshot)
    ) throw new Error('occurrence sync response does not acknowledge the request snapshot');
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await sqliteMeetingNoteRepository.completeOccurrenceSyncClaim(
      claim,
      response.remoteId!,
      response.revision,
      Date.now(),
    );
    return { processed: completed, retryAfterMs: null, outcome: completed ? 'completed' : 'stale' };
  } catch (error) {
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const nowMs = Date.now();
    if (error instanceof OccurrenceLinkConflictResponseError) {
      const attached = await attachMatchingConflictCurrent(claim, mutation, error, nowMs);
      if (attached === 'completed') {
        return { processed: true, retryAfterMs: null, outcome: 'completed' };
      }
      if (attached === 'conflicted') {
        return { processed: true, retryAfterMs: null, outcome: 'conflict' };
      }
      const recorded = await sqliteMeetingNoteRepository.recordOccurrenceSyncConflict(claim, {
        remoteRevision: error.remoteRevision,
        remotePayloadJson: boundedRemotePayload({
          error_code: error.contractCode,
          current: error.remotePayload,
        }),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof HttpResponseError && error.status === 401) {
      const delayMs = 60_000;
      const retried = await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
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
      const applied = await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
        disposition: blocked ? 'blocked' : 'permanent_error',
        errorCode: blocked ? 'occurrence_contract_unavailable' : 'occurrence_request_rejected',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    if (
      error instanceof Error
      && /响应.*(?:格式|版本)|occurrence sync response|remote occurrence|remote revision/i.test(error.message)
    ) {
      const applied = await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'occurrence_response_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: applied, retryAfterMs: null, outcome: applied ? 'blocked' : 'stale' };
    }
    const delayMs = retryDelayMs(claim);
    const retried = await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
      disposition: 'retry',
      errorCode: error instanceof HttpResponseError ? `http_${error.status}` : 'network_or_timeout',
      nextAttemptAtMs: nowMs + delayMs,
      updatedAtMs: nowMs,
    });
    return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
  }
}

export interface DrainMeetingOccurrenceSyncInput {
  scopeKey: ScopeKey;
  accessToken: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingOccurrenceSyncResult {
  outcome: 'drained' | 'disabled' | 'capability_unavailable' | 'stale' | 'batch_limit';
  processedCount: number;
  retryAfterMs: number | null;
}

export async function drainMeetingOccurrenceSync(
  input: DrainMeetingOccurrenceSyncInput,
): Promise<DrainMeetingOccurrenceSyncResult> {
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
      diagnosticWarn('[occurrence-sync] capability refresh failed', error);
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
  if (capability.source !== 'remote' || !capability.capabilities.occurrenceLinksV2) {
    return { outcome: 'disabled', processedCount: 0, retryAfterMs: null };
  }
  const repairedInvalidLinks = await sqliteMeetingNoteRepository
    .repairInvalidOccurrenceSyncOperations(input.scopeKey, Date.now());
  if (repairedInvalidLinks > 0) {
    diagnosticAudit('occurrence_sync_repair', {
      status: 'detached_invalid_local_links',
      count: repairedInvalidLinks,
    });
  }
  await sqliteMeetingNoteRepository.ensureOccurrenceSyncOperations(input.scopeKey, Date.now());

  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
    if (!input.isCurrent() || input.signal.aborted) {
      return { outcome: 'stale', processedCount, retryAfterMs: earliestRetryMs };
    }
    const nowMs = Date.now();
    const claims = await sqliteMeetingNoteRepository.claimOccurrenceSyncOperations(input.scopeKey, {
      nowMs,
      staleBeforeMs: Math.max(0, nowMs - STALE_CLAIM_MS),
      maxMeetings: 3,
    });
    if (claims.length === 0) {
      const nextAttemptAtMs = await sqliteMeetingNoteRepository.getNextOccurrenceSyncAttemptAt(
        input.scopeKey,
        STALE_CLAIM_MS,
      );
      const retryAfterMs = mergeSyncRetryAfterMs(
        nowMs,
        nextAttemptAtMs,
        earliestRetryMs,
      );
      diagnosticAudit('occurrence_sync_drain', {
        status: 'drained',
        processed: processedCount,
        retry_scheduled: retryAfterMs !== null,
      });
      return { outcome: 'drained', processedCount, retryAfterMs };
    }
    const results = await Promise.all(claims.map(async claim => {
      try {
        return await processClaim(
          claim,
          input.accessToken,
          input.signal,
          input.isCurrent,
        );
      } catch (error) {
        // A failure in conflict handling must not strand the durable claim in
        // `in_flight`; the next foreground heartbeat can then retry it.
        if (!input.isCurrent() || input.signal.aborted) {
          return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' } as const;
        }
        let released = false;
        try {
          const nowMs = Date.now();
          released = await sqliteMeetingNoteRepository.failOccurrenceSyncClaim(claim, {
            disposition: 'retry',
            errorCode: 'sync_handler_failure',
            nextAttemptAtMs: nowMs + 30_000,
            updatedAtMs: nowMs,
          });
        } catch (releaseError) {
          // A later heartbeat can reclaim a stale claim if the release itself
          // races with another database writer.
          diagnosticWarn('[occurrence-sync] failed to release stale claim', releaseError);
        }
        diagnosticWarn('[occurrence-sync] claim handler failed; claim released', error);
        return {
          processed: released,
          retryAfterMs: 30_000,
          outcome: released ? 'retry' : 'stale',
        } as const;
      }
    }));
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
