import type {
  ManualNoteRecord,
  MeetingManualNoteSyncConflictRecord,
  RemoteManualNoteRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';

type UnknownRecord = Record<string, unknown>;

export interface MeetingManualNoteSyncConflictView {
  id: string;
  meetingId: string;
  createdAtMs: number;
  localRevision: number | null;
  local: ManualNoteRecord;
  remote: RemoteManualNoteRecord | null;
  remoteMissing: boolean;
  invalidRemotePayload: boolean;
  contractCode: string | null;
  canKeepLocal: boolean;
  canUseRemote: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function integer(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = integer(value);
  return parsed === null ? undefined : parsed;
}

function serverTime(record: UnknownRecord, isoKey: string, msKey: string): number | null {
  const milliseconds = integer(record[msKey]);
  if (milliseconds !== null) return milliseconds;
  const iso = record[isoKey];
  if (typeof iso !== 'string') return null;
  const parsed = Date.parse(iso);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function missingRemote(meetingRemoteId: string): RemoteManualNoteRecord {
  return {
    exists: false,
    remoteId: null,
    revision: 0,
    clientNoteRevision: 0,
    clientUpdatedAtMs: 0,
    userEditedAtMs: null,
    content: '',
    serverCreatedAtMs: null,
    serverUpdatedAtMs: null,
  };
}

function parseRemote(
  current: unknown,
  expectedMeetingRemoteId: string,
  conflictRevision: number | null,
): { remote: RemoteManualNoteRecord | null; missing: boolean } {
  if (current === null) {
    return conflictRevision === null
      ? { remote: missingRemote(expectedMeetingRemoteId), missing: true }
      : { remote: null, missing: false };
  }
  if (!isRecord(current)) return { remote: null, missing: false };
  const exists = current.exists;
  if (exists === false) {
    const valid = current.id === null
      && identifier(current.meeting_id, 160) === expectedMeetingRemoteId
      && integer(current.revision) === 0
      && integer(current.client_note_revision) === 0
      && integer(current.client_updated_at_ms) === 0
      && current.user_edited_at_ms === null
      && current.content === ''
      && conflictRevision === null;
    return valid
      ? { remote: missingRemote(expectedMeetingRemoteId), missing: true }
      : { remote: null, missing: false };
  }
  if (exists !== true) return { remote: null, missing: false };
  const remoteId = identifier(current.id ?? current.remote_id, 160);
  const meetingRemoteId = identifier(current.meeting_id, 160);
  const revision = integer(current.revision, 1);
  const clientNoteRevision = integer(current.client_note_revision, 1);
  const clientUpdatedAtMs = integer(current.client_updated_at_ms);
  const userEditedAtMs = nullableInteger(current.user_edited_at_ms);
  const content = current.content;
  const serverCreatedAtMs = serverTime(current, 'created_at', 'created_at_ms');
  const serverUpdatedAtMs = serverTime(current, 'updated_at', 'updated_at_ms');
  const valid = Boolean(
    remoteId
    && meetingRemoteId === expectedMeetingRemoteId
    && revision !== null
    && (conflictRevision === null || revision === conflictRevision)
    && clientNoteRevision !== null
    && clientUpdatedAtMs !== null
    && userEditedAtMs !== undefined
    && (userEditedAtMs === null || userEditedAtMs <= clientUpdatedAtMs)
    && typeof content === 'string'
    && content.length <= 200_000
    && !content.includes('\u0000')
    && serverCreatedAtMs !== null
    && serverUpdatedAtMs !== null
    && serverCreatedAtMs <= serverUpdatedAtMs
  );
  return valid ? {
    remote: {
      exists: true,
      remoteId: remoteId!,
      revision: revision!,
      clientNoteRevision: clientNoteRevision!,
      clientUpdatedAtMs: clientUpdatedAtMs!,
      userEditedAtMs: userEditedAtMs ?? null,
      content: (content as string).replace(/\r\n?/g, '\n'),
      serverCreatedAtMs,
      serverUpdatedAtMs,
    },
    missing: false,
  } : { remote: null, missing: false };
}

export function meetingManualNoteSyncConflictView(
  local: ManualNoteRecord,
  conflict: MeetingManualNoteSyncConflictRecord,
  meetingRemoteId: string,
): MeetingManualNoteSyncConflictView {
  let payload: unknown;
  try {
    payload = JSON.parse(conflict.remotePayloadJson) as unknown;
  } catch {
    payload = Symbol('invalid');
  }
  const wrapper = isRecord(payload) && (
    Object.prototype.hasOwnProperty.call(payload, 'current')
    || Object.prototype.hasOwnProperty.call(payload, 'error_code')
  ) ? payload : null;
  const current = wrapper ? wrapper.current : payload;
  const parsed = parseRemote(current, meetingRemoteId, conflict.remoteRevision);
  const invalidRemotePayload = parsed.remote === null;
  return {
    id: conflict.id,
    meetingId: conflict.meetingId,
    createdAtMs: conflict.createdAtMs,
    localRevision: conflict.localRevision,
    local,
    remote: parsed.remote,
    remoteMissing: parsed.missing,
    invalidRemotePayload,
    contractCode: identifier(wrapper?.error_code, 160),
    canKeepLocal: !invalidRemotePayload,
    canUseRemote: !invalidRemotePayload,
  };
}

export async function loadMeetingManualNoteSyncConflict(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingManualNoteSyncConflictView | null> {
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted' || !aggregate.note.remoteId) return null;
  const conflict = await sqliteMeetingNoteRepository.getMeetingManualNoteSyncConflict(
    aggregate.note.id,
    scopeKey,
  );
  return conflict
    ? meetingManualNoteSyncConflictView(aggregate.manualNote, conflict, aggregate.note.remoteId)
    : null;
}
