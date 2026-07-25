import { parseMeetingNoteV2, type RemoteMeetingNoteV2 } from '../data/api/v2';
import type {
  MeetingNoteAggregate,
  MeetingRootSyncConflictRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { MeetingLifecycle, ScopeKey } from '../domain/meeting';

type UnknownRecord = Record<string, unknown>;

export interface MeetingRootSyncConflictView {
  id: string;
  meetingId: string;
  createdAtMs: number;
  localRevision: number | null;
  local: MeetingNoteAggregate['note'];
  remote: RemoteMeetingNoteV2 | null;
  remoteLifecycle: MeetingLifecycle | null;
  invalidRemotePayload: boolean;
  identityCompatible: boolean;
  occurrenceCompatible: boolean;
  contractCode: string | null;
  canKeepLocal: boolean;
  canUseRemote: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export function localLifecycleFromRemote(remote: RemoteMeetingNoteV2): MeetingLifecycle {
  if (remote.lifecycle === 'deleted') return 'deleted';
  if (remote.status === 'recording' || remote.status === 'paused' || remote.status === 'processing') {
    return 'active';
  }
  if (['completed', 'ended', 'done', 'processed', 'failed'].includes(remote.status)) {
    return 'ended';
  }
  return 'draft';
}

function parseStrictRemote(
  conflict: MeetingRootSyncConflictRecord,
): { remote: RemoteMeetingNoteV2 | null; contractCode: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(conflict.remotePayloadJson) as unknown;
  } catch {
    return { remote: null, contractCode: null };
  }
  if (
    !isRecord(payload)
    || (payload.status !== 409 && payload.status !== 412)
    || !Object.prototype.hasOwnProperty.call(payload, 'current')
  ) return { remote: null, contractCode: null };
  const contractCode = payload.code === null || payload.code === undefined
    ? null
    : identifier(payload.code);
  if (payload.code !== null && payload.code !== undefined && contractCode === null) {
    return { remote: null, contractCode: null };
  }
  try {
    const remote = parseMeetingNoteV2(payload.current);
    if (conflict.remoteRevision === null || conflict.remoteRevision !== remote.revision) {
      return { remote: null, contractCode };
    }
    return { remote, contractCode };
  } catch {
    return { remote: null, contractCode };
  }
}

function matchingOccurrence(
  aggregate: MeetingNoteAggregate,
  remote: RemoteMeetingNoteV2,
): boolean {
  const localOccurrence = aggregate.occurrence;
  const remoteOccurrence = remote.occurrenceRef;
  if (aggregate.note.origin !== 'calendar') {
    return localOccurrence === null && remoteOccurrence === null;
  }
  return Boolean(
    localOccurrence
    && remoteOccurrence
    && remoteOccurrence.link_state === 'active'
    && localOccurrence.sourceEventId === remoteOccurrence.source_event_id
    && localOccurrence.occurrenceDate === remoteOccurrence.occurrence_date,
  );
}

export function meetingRootSyncConflictView(
  aggregate: MeetingNoteAggregate,
  conflict: MeetingRootSyncConflictRecord,
): MeetingRootSyncConflictView {
  const parsed = parseStrictRemote(conflict);
  const remote = parsed.remote;
  const identityCompatible = Boolean(remote && (
    aggregate.note.remoteId !== null
      ? aggregate.note.remoteId === remote.remoteId
      : remote.clientNoteId === aggregate.note.id
  ));
  const immutableRootCompatible = Boolean(
    remote
    && aggregate.note.origin === remote.origin
    && aggregate.note.entryPoint === remote.entryPoint,
  );
  const occurrenceCompatible = Boolean(remote && matchingOccurrence(aggregate, remote));
  const safe = Boolean(remote && identityCompatible && immutableRootCompatible && occurrenceCompatible);
  return {
    id: conflict.id,
    meetingId: conflict.meetingId,
    createdAtMs: conflict.createdAtMs,
    localRevision: conflict.localRevision,
    local: aggregate.note,
    remote,
    remoteLifecycle: remote ? localLifecycleFromRemote(remote) : null,
    invalidRemotePayload: remote === null,
    identityCompatible: identityCompatible && immutableRootCompatible,
    occurrenceCompatible,
    contractCode: parsed.contractCode,
    canKeepLocal: safe,
    canUseRemote: safe,
  };
}

export async function loadMeetingRootSyncConflict(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingRootSyncConflictView | null> {
  if (scopeKey === 'guest') return null;
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate) return null;
  const conflict = await sqliteMeetingNoteRepository.getMeetingRootSyncConflict(
    aggregate.note.id,
    scopeKey,
  );
  return conflict ? meetingRootSyncConflictView(aggregate, conflict) : null;
}
