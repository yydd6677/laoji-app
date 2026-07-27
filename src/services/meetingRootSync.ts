import {
  createMeeting,
  deleteMeeting,
  updateMeeting,
  type ApiMeeting,
} from './api';
import {
  sqliteMeetingNoteRepository,
  type MeetingRootSyncClaim,
  type MeetingRootSyncCompletion,
} from '../data/repositories';
import {
  createMeetingNoteV2,
  deleteMeetingNoteV2,
  getMeetingNoteV2,
  loadMeetingCapabilities,
  MeetingNoteConflictResponseError,
  MeetingNoteResponseContractError,
  restoreMeetingNoteV2,
  updateMeetingNoteV2,
  type CreateMeetingNoteV2Request,
  type RemoteMeetingNoteV2,
  type UpdateMeetingNoteV2Request,
} from '../data/api/v2';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';
import { mergeSyncRetryAfterMs } from './syncRetryWake';

const STALE_CLAIM_MS = 90_000;
const MAX_BATCHES_PER_DRAIN = 20;
const drainTailByScope = new Map<ScopeKey, Promise<unknown>>();

class InvalidMeetingRootPayloadError extends Error {}
class UnsupportedMeetingRootPayloadError extends Error {}
class MeetingRootResponseContractError extends Error {}

type CreateMutation = {
  kind: 'create';
  clientRequestId: string;
  legacyPayload: Parameters<typeof createMeeting>[0];
  v2Request: CreateMeetingNoteV2Request;
};

type UpdateMutation = {
  kind: 'update';
  baseRevision: number | null;
  legacyPayload: Parameters<typeof updateMeeting>[1];
  v2Request: UpdateMeetingNoteV2Request;
};

type DeleteMutation = { kind: 'delete'; baseRevision: number | null };
type RestoreMutation = { kind: 'restore'; baseRevision: number | null };

type MeetingRootMutation = CreateMutation | UpdateMutation | DeleteMutation | RestoreMutation;

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

function optionalRevision(value: unknown, label: string): number | null {
  const revision = optionalTime(value, label);
  if (revision !== null && revision < 1) {
    throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  }
  return revision;
}

function meetingOrigin(value: unknown): CreateMeetingNoteV2Request['origin'] {
  if (value !== 'calendar' && value !== 'ad_hoc' && value !== 'file_import' && value !== 'share_intent') {
    throw new InvalidMeetingRootPayloadError('meeting origin is invalid');
  }
  return value;
}

function meetingEntryPoint(value: unknown): CreateMeetingNoteV2Request['entry_point'] {
  if (value === null || value === undefined) return null;
  const supported = new Set<CreateMeetingNoteV2Request['entry_point']>([
    'calendar_detail',
    'notification',
    'widget',
    'meeting_tab',
    'quick_tile',
    'document_picker',
    'share_intent',
    'legacy_store',
    'recorder_recovery',
  ]);
  if (typeof value !== 'string' || !supported.has(value as CreateMeetingNoteV2Request['entry_point'])) {
    throw new InvalidMeetingRootPayloadError('meeting entry point is invalid');
  }
  return value as CreateMeetingNoteV2Request['entry_point'];
}

function nullableIdentifier(value: unknown, label: string, maximum = 512): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, { maximum });
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidMeetingRootPayloadError(`${label} is invalid`);
  return value;
}

function compatibleField(
  source: Record<string, unknown>,
  preferred: string,
  fallback: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(source, preferred)
    ? source[preferred]
    : source[fallback];
}

function localOccurrenceContext(
  occurrenceValue: unknown,
  snapshotValue: unknown,
): Pick<CreateMeetingNoteV2Request, 'occurrence_ref' | 'schedule_snapshot'> {
  const occurrenceMissing = occurrenceValue === null || occurrenceValue === undefined;
  const snapshotMissing = snapshotValue === null || snapshotValue === undefined;
  if (occurrenceMissing && snapshotMissing) return {};
  if (!isRecord(occurrenceValue) || !isRecord(snapshotValue)) {
    throw new InvalidMeetingRootPayloadError('meeting occurrence context is incomplete');
  }
  const occurrenceDate = requiredString(
    compatibleField(occurrenceValue, 'occurrenceDate', 'occurrence_date'),
    'meeting occurrence date',
    { maximum: 10 },
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
    throw new InvalidMeetingRootPayloadError('meeting occurrence date is invalid');
  }
  const plannedStartMs = optionalTime(
    compatibleField(snapshotValue, 'plannedStartMs', 'planned_start_ms'),
    'meeting planned start',
  );
  const plannedEndMs = optionalTime(
    compatibleField(snapshotValue, 'plannedEndMs', 'planned_end_ms'),
    'meeting planned end',
  );
  if (plannedStartMs !== null && plannedEndMs !== null && plannedEndMs < plannedStartMs) {
    throw new InvalidMeetingRootPayloadError('meeting planned range is invalid');
  }
  const capturedAtMs = optionalTime(
    compatibleField(snapshotValue, 'capturedAtMs', 'captured_at_ms'),
    'meeting schedule capture time',
  );
  if (capturedAtMs === null) {
    throw new InvalidMeetingRootPayloadError('meeting schedule capture time is missing');
  }
  return {
    occurrence_ref: {
      source_event_id: requiredString(
        compatibleField(occurrenceValue, 'sourceEventId', 'source_event_id'),
        'meeting occurrence source',
        { maximum: 512 },
      ),
      occurrence_date: occurrenceDate,
      calendar_revision: optionalTime(
        compatibleField(occurrenceValue, 'calendarRevision', 'calendar_revision'),
        'meeting calendar revision',
      ),
      recurrence_segment_id: nullableIdentifier(
        compatibleField(occurrenceValue, 'recurrenceSegmentId', 'recurrence_segment_id'),
        'meeting recurrence segment',
      ),
      series_key: nullableIdentifier(
        compatibleField(occurrenceValue, 'seriesKey', 'series_key'),
        'meeting series key',
      ),
    },
    schedule_snapshot: {
      event_title: requiredString(
        compatibleField(snapshotValue, 'eventTitle', 'event_title'),
        'meeting schedule title',
        { allowEmpty: true, maximum: 20_000 },
      ),
      planned_start_ms: plannedStartMs,
      planned_end_ms: plannedEndMs,
      all_day: requiredBoolean(
        compatibleField(snapshotValue, 'allDay', 'all_day'),
        'meeting schedule all-day state',
      ),
      timezone_id: nullableIdentifier(
        compatibleField(snapshotValue, 'timezoneId', 'timezone_id'),
        'meeting schedule timezone',
        160,
      ),
      location: nullableString(
        snapshotValue.location,
        'meeting schedule location',
        2_000,
      ),
      participants: participants(snapshotValue.participants),
      description: nullableString(
        snapshotValue.description,
        'meeting schedule description',
        100_000,
      ),
      captured_event_revision: optionalTime(
        compatibleField(snapshotValue, 'capturedEventRevision', 'captured_event_revision'),
        'meeting captured event revision',
      ),
      captured_at_ms: capturedAtMs,
    },
  };
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
    { maximum: 96 },
  );
  const recordedAtMs = optionalTime(parsed.recorded_at_ms, 'meeting recorded time');
  const origin = meetingOrigin(parsed.origin);
  const occurrenceContext = localOccurrenceContext(
    parsed.occurrence_ref,
    parsed.schedule_snapshot,
  );
  if (
    Object.prototype.hasOwnProperty.call(parsed, 'defer_remote_occurrence_link')
    && parsed.defer_remote_occurrence_link === true
  ) {
    throw new UnsupportedMeetingRootPayloadError(
      'legacy deferred calendar create requires local replacement repair',
    );
  }
  const supersededRemoteMeetingId = nullableIdentifier(
    parsed.superseded_remote_meeting_id,
    'superseded meeting remote identity',
    160,
  );
  if ((origin === 'calendar') !== Boolean(occurrenceContext.occurrence_ref)) {
    throw new InvalidMeetingRootPayloadError('meeting origin and occurrence context differ');
  }
  if (supersededRemoteMeetingId && origin !== 'calendar') {
    throw new InvalidMeetingRootPayloadError('only a calendar meeting can supersede an occurrence root');
  }
  const title = requiredString(parsed.title, 'meeting title', {
    allowEmpty: true,
    maximum: 255,
  });
  const description = nullableString(parsed.description, 'meeting description', 100_000);
  const meetingParticipants = participants(parsed.participants);
  const mode = parsed.mode === null ? 'realtime' : meetingMode(parsed.mode, false);
  const location = nullableString(parsed.location, 'meeting location', 500);
  const recordedAt = recordedAtMs === null ? null : isoTime(recordedAtMs, 'meeting recorded time');
  return {
    kind: 'create',
    clientRequestId,
    legacyPayload: {
      title,
      description,
      participants: meetingParticipants,
      mode,
      clientRequestId,
      location,
      recordedAt,
    },
    v2Request: {
      schema_version: 2,
      client_note_id: claim.meetingId,
      client_request_id: clientRequestId,
      origin,
      entry_point: meetingEntryPoint(parsed.entry_point),
      title,
      description,
      participants: meetingParticipants,
      location,
      mode,
      recorded_at: recordedAt,
      ...occurrenceContext,
      ...(supersededRemoteMeetingId
        ? { supersedes_meeting_id: supersededRemoteMeetingId }
        : {}),
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
  const supported = new Set([
    'title', 'description', 'participants', 'location', 'mode', 'status', 'recordedAtMs',
  ]);
  if (keys.some(key => !supported.has(key))) {
    throw new UnsupportedMeetingRootPayloadError('meeting update field is not supported by legacy API');
  }
  const legacyPayload: Parameters<typeof updateMeeting>[1] = {};
  const v2Request: UpdateMeetingNoteV2Request = { schema_version: 2 };
  if (Object.prototype.hasOwnProperty.call(source, 'title')) {
    const title = requiredString(source.title, 'meeting title', { allowEmpty: true, maximum: 255 });
    legacyPayload.title = title;
    v2Request.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'description')) {
    const description = nullableString(source.description, 'meeting description', 100_000);
    legacyPayload.description = description;
    v2Request.description = description;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'participants')) {
    const meetingParticipants = participants(source.participants);
    legacyPayload.participants = meetingParticipants;
    v2Request.participants = meetingParticipants;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'location')) {
    const location = nullableString(source.location, 'meeting location', 500);
    legacyPayload.location = location;
    v2Request.location = location;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'mode')) {
    const mode = meetingMode(source.mode, true);
    if (mode === null) {
      throw new UnsupportedMeetingRootPayloadError('legacy meeting API cannot clear capture mode');
    }
    legacyPayload.mode = mode;
    v2Request.mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'status')) {
    const status = requiredString(source.status, 'meeting status', { maximum: 160 });
    legacyPayload.status = status;
    v2Request.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'recordedAtMs')) {
    const recordedAtMs = optionalTime(source.recordedAtMs, 'meeting recorded time');
    v2Request.recorded_at = recordedAtMs === null
      ? null
      : isoTime(recordedAtMs, 'meeting recorded time');
  }
  return {
    kind: 'update',
    baseRevision: optionalRevision(parsed.base_revision, 'meeting base revision'),
    legacyPayload,
    v2Request,
  };
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
    return {
      kind: 'delete',
      baseRevision: optionalRevision(parsed.base_revision, 'meeting base revision'),
    };
  }
  if (claim.operationType === 'meeting.restore') {
    assertIdentity(parsed, claim);
    return {
      kind: 'restore',
      baseRevision: optionalRevision(parsed.base_revision, 'meeting base revision'),
    };
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

type RootTransport = 'v2' | 'legacy';

class MeetingRootV2CapabilityUnavailableError extends Error {}

async function resolveRootTransport(accessToken: string): Promise<RootTransport> {
  try {
    const state = await loadMeetingCapabilities({
      accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
    return state.source === 'remote' && state.capabilities.meetingNotesV2 ? 'v2' : 'legacy';
  } catch (error) {
    diagnosticWarn('[meeting-root-sync] fresh capability unavailable; retaining legacy transport', error);
    return 'legacy';
  }
}

function v2Completion(
  response: RemoteMeetingNoteV2,
  includeOccurrence: boolean,
): MeetingRootSyncCompletion {
  return {
    remoteId: response.remoteId,
    remoteRevision: response.revision,
    occurrence: includeOccurrence && response.occurrenceRef ? {
      remoteId: response.occurrenceRef.id,
      remoteRevision: response.occurrenceRef.revision,
      sourceEventId: response.occurrenceRef.source_event_id,
      occurrenceDate: response.occurrenceRef.occurrence_date,
    } : null,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertV2CreateResponse(
  request: CreateMeetingNoteV2Request,
  response: RemoteMeetingNoteV2,
): void {
  const recordedAtMs = request.recorded_at === null ? null : Date.parse(request.recorded_at);
  if (
    response.clientNoteId !== request.client_note_id
    || response.origin !== request.origin
    || response.entryPoint !== request.entry_point
    || response.title !== request.title
    || response.description !== request.description
    || !sameStrings(response.participants, request.participants)
    || response.location !== request.location
    || response.mode !== request.mode
    || response.recordedAtMs !== recordedAtMs
  ) throw new MeetingNoteResponseContractError('会议创建响应与本机请求不一致');

  const requestOccurrence = request.occurrence_ref ?? null;
  const responseOccurrence = response.occurrenceRef;
  const requestSnapshot = request.schedule_snapshot ?? null;
  const responseSnapshot = response.scheduleSnapshot;
  if ((requestOccurrence === null) !== (responseOccurrence === null)) {
    throw new MeetingNoteResponseContractError('会议创建响应的日程关联不一致');
  }
  if ((requestSnapshot === null) !== (responseSnapshot === null)) {
    throw new MeetingNoteResponseContractError('会议创建响应的日程快照不一致');
  }
  if (requestOccurrence && responseOccurrence && (
    responseOccurrence.source_event_id !== requestOccurrence.source_event_id
    || responseOccurrence.occurrence_date !== requestOccurrence.occurrence_date
    || responseOccurrence.calendar_revision !== (requestOccurrence.calendar_revision ?? null)
    || responseOccurrence.recurrence_segment_id !== (requestOccurrence.recurrence_segment_id ?? null)
    || responseOccurrence.series_key !== (requestOccurrence.series_key ?? null)
    || responseOccurrence.link_state !== 'active'
  )) throw new MeetingNoteResponseContractError('会议创建响应的日程身份不一致');
  if (requestSnapshot && responseSnapshot && (
    responseSnapshot.event_title !== requestSnapshot.event_title
    || responseSnapshot.planned_start_ms !== requestSnapshot.planned_start_ms
    || responseSnapshot.planned_end_ms !== requestSnapshot.planned_end_ms
    || responseSnapshot.all_day !== requestSnapshot.all_day
    || responseSnapshot.timezone_id !== requestSnapshot.timezone_id
    || responseSnapshot.location !== requestSnapshot.location
    || !sameStrings(responseSnapshot.participants, requestSnapshot.participants)
    || responseSnapshot.description !== requestSnapshot.description
    || responseSnapshot.captured_event_revision !== requestSnapshot.captured_event_revision
    || responseSnapshot.captured_at_ms !== requestSnapshot.captured_at_ms
  )) throw new MeetingNoteResponseContractError('会议创建响应的日程快照不一致');
}

function assertV2UpdateResponse(
  request: UpdateMeetingNoteV2Request,
  expectedRevision: number,
  response: RemoteMeetingNoteV2,
): void {
  if (response.revision < expectedRevision) {
    throw new MeetingNoteResponseContractError('会议修改响应版本倒退');
  }
  if (
    (request.title !== undefined && response.title !== request.title)
    || (request.description !== undefined && response.description !== request.description)
    || (request.participants !== undefined && !sameStrings(response.participants, request.participants))
    || (request.location !== undefined && response.location !== request.location)
    || (request.mode !== undefined && response.mode !== request.mode)
    || (request.status !== undefined && response.status !== request.status)
    || (
      request.recorded_at !== undefined
      && response.recordedAtMs !== (
        request.recorded_at === null ? null : Date.parse(request.recorded_at)
      )
    )
  ) throw new MeetingNoteResponseContractError('会议修改响应未应用本机字段');
}

function requiresV2Transport(
  claim: MeetingRootSyncClaim,
  mutation: MeetingRootMutation,
): boolean {
  return claim.remoteRevision !== null
    || (mutation.kind !== 'create' && mutation.baseRevision !== null)
    || (mutation.kind === 'create' && Boolean(mutation.v2Request.supersedes_meeting_id));
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
  transport: RootTransport,
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
    if (transport === 'legacy' && requiresV2Transport(claim, mutation)) {
      throw new MeetingRootV2CapabilityUnavailableError('meeting root v2 capability is unavailable');
    }
    let completion: MeetingRootSyncCompletion;
    if (transport === 'v2') {
      let response: RemoteMeetingNoteV2;
      if (mutation.kind === 'create') {
        const alreadyRemote = Boolean(claim.remoteId);
        if (claim.remoteId) {
          response = await getMeetingNoteV2({
            accessToken,
            meetingRemoteId: claim.remoteId,
            signal,
          });
          if (response.clientNoteId !== claim.meetingId) {
            throw new MeetingNoteResponseContractError('会议本机标识发生变化');
          }
        } else {
          response = await createMeetingNoteV2({
            accessToken,
            idempotencyKey: claim.idempotencyKey,
            request: mutation.v2Request,
            signal,
          });
        }
        if (!alreadyRemote) assertV2CreateResponse(mutation.v2Request, response);
        if (response.lifecycle !== 'active') {
          throw new MeetingNoteResponseContractError('新建会议记录返回了删除状态');
        }
        completion = v2Completion(response, true);
      } else {
        if (!claim.remoteId) {
          throw new UnsupportedMeetingRootPayloadError('meeting remote identity is missing');
        }
        let expectedRevision = claim.remoteRevision ?? mutation.baseRevision;
        if (expectedRevision === null) {
          const current = await getMeetingNoteV2({
            accessToken,
            meetingRemoteId: claim.remoteId,
            signal,
          });
          expectedRevision = current.revision;
        }
        response = mutation.kind === 'update'
          ? await updateMeetingNoteV2({
            accessToken,
            meetingRemoteId: claim.remoteId,
            expectedRevision,
            idempotencyKey: claim.idempotencyKey,
            request: mutation.v2Request,
            signal,
          })
          : mutation.kind === 'delete'
            ? await deleteMeetingNoteV2({
              accessToken,
              meetingRemoteId: claim.remoteId,
              expectedRevision,
              idempotencyKey: claim.idempotencyKey,
              signal,
            })
            : await restoreMeetingNoteV2({
              accessToken,
              meetingRemoteId: claim.remoteId,
              expectedRevision,
              idempotencyKey: claim.idempotencyKey,
              signal,
            });
        // A pulled or legacy-imported remote root keeps this device's local ID.
        // The server's client_note_id belongs to the creating device, so existing
        // roots are identified by the already-validated remote ID and revision.
        if (mutation.kind === 'update') {
          assertV2UpdateResponse(mutation.v2Request, expectedRevision, response);
        } else if (response.revision < expectedRevision) {
          throw new MeetingNoteResponseContractError('会议删除响应版本倒退');
        }
        if (mutation.kind === 'update' && response.lifecycle !== 'active') {
          throw new MeetingNoteResponseContractError('会议修改返回了删除状态');
        }
        if (mutation.kind === 'delete' && response.lifecycle !== 'deleted') {
          throw new MeetingNoteResponseContractError('会议删除未返回删除状态');
        }
        if (mutation.kind === 'restore' && response.lifecycle !== 'active') {
          throw new MeetingNoteResponseContractError('会议恢复未返回可用状态');
        }
        completion = v2Completion(response, false);
      }
    } else {
      let remoteId = claim.remoteId;
      if (mutation.kind === 'create') {
        if (!remoteId) {
          const response = await createMeeting(mutation.legacyPayload, accessToken, signal);
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
          const response = await updateMeeting(remoteId, mutation.legacyPayload, accessToken, signal);
          if (remoteMeetingId(response) !== remoteId) {
            throw new MeetingRootResponseContractError('meeting update identity changed');
          }
        } else if (mutation.kind === 'delete') {
          await deleteMeeting(remoteId, accessToken, signal);
        } else {
          throw new UnsupportedMeetingRootPayloadError('legacy meeting API cannot restore a meeting');
        }
      }
      if (!remoteId) throw new MeetingRootResponseContractError('meeting remote identity is missing');
      completion = { remoteId, remoteRevision: null, occurrence: null };
    }
    if (!isCurrent() || signal.aborted) {
      return { processed: false, retryAfterMs: STALE_CLAIM_MS, outcome: 'stale' };
    }
    const completed = await sqliteMeetingNoteRepository.completeMeetingRootSyncClaim(
      claim,
      completion,
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
    if (error instanceof MeetingNoteConflictResponseError) {
      const recorded = await sqliteMeetingNoteRepository.recordMeetingRootSyncConflict(claim, {
        remoteRevision: error.remoteRevision,
        remotePayloadJson: JSON.stringify({
          status: error.status,
          code: error.contractCode,
          current: error.remotePayload,
        }),
        createdAtMs: nowMs,
      });
      return { processed: recorded, retryAfterMs: null, outcome: recorded ? 'conflict' : 'stale' };
    }
    if (error instanceof HttpResponseError && (error.status === 409 || error.status === 412)) {
      const recorded = await sqliteMeetingNoteRepository.recordMeetingRootSyncConflict(claim, {
        remoteRevision: null,
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
      || error instanceof MeetingNoteResponseContractError
      || (error instanceof Error && /remote identity|remote ID/i.test(error.message))) {
      const blocked = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
        disposition: 'blocked',
        errorCode: 'root_response_contract_invalid',
        nextAttemptAtMs: null,
        updatedAtMs: nowMs,
      });
      return { processed: blocked, retryAfterMs: null, outcome: blocked ? 'blocked' : 'stale' };
    }
    if (error instanceof MeetingRootV2CapabilityUnavailableError) {
      const delayMs = 60_000;
      const retried = await sqliteMeetingNoteRepository.failMeetingRootSyncClaim(claim, {
        disposition: 'retry',
        errorCode: 'root_v2_capability_unavailable',
        nextAttemptAtMs: nowMs + delayMs,
        updatedAtMs: nowMs,
      });
      return { processed: retried, retryAfterMs: delayMs, outcome: retried ? 'retry' : 'stale' };
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
  try {
    const repaired = await sqliteMeetingNoteRepository.repairLegacyCalendarMeetingRootCreates(
      input.scopeKey,
      Date.now(),
    );
    if (repaired > 0) {
      diagnosticAudit('meeting_root_legacy_calendar_repair', {
        status: 'repaired',
        count: repaired,
      });
    }
  } catch (error) {
    diagnosticWarn('[meeting-root-sync] legacy calendar repair failed', error);
  }
  let processedCount = 0;
  let earliestRetryMs: number | null = null;
  let transport: RootTransport | null = null;
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
      const nextAttemptAtMs = await sqliteMeetingNoteRepository.getNextMeetingRootSyncAttemptAt(
        input.scopeKey,
        STALE_CLAIM_MS,
      );
      const retryAfterMs = mergeSyncRetryAfterMs(
        nowMs,
        nextAttemptAtMs,
        earliestRetryMs,
      );
      diagnosticAudit('meeting_root_sync_drain', {
        status: 'drained',
        processed: processedCount,
        retry_scheduled: retryAfterMs !== null,
      });
      return { outcome: 'drained', processedCount, retryAfterMs };
    }
    if (transport === null) {
      transport = await resolveRootTransport(input.accessToken);
    }
    const selectedTransport = transport;
    const results = await Promise.all(claims.map(claim => processClaim(
      claim,
      input.accessToken,
      input.signal,
      input.isCurrent,
      selectedTransport,
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
