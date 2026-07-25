import { parseRemoteOccurrenceLinkV2 } from '../data/api/v2';
import type {
  MeetingNoteRepository,
  MeetingOccurrenceSyncConflictRecord,
  RemoteOccurrenceLinkRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { OccurrenceReference, ScheduleSnapshot, ScopeKey } from '../domain/meeting';

type UnknownRecord = Record<string, unknown>;

export interface MeetingOccurrenceConflictMeetingView {
  id: string;
  title: string;
  statusLabel: string;
  mergeableRecordingCount: number;
}

export interface MeetingOccurrenceSyncConflictView {
  id: string;
  meetingId: string;
  createdAtMs: number;
  occurrence: OccurrenceReference;
  local: MeetingOccurrenceConflictMeetingView;
  remote: MeetingOccurrenceConflictMeetingView | null;
  remoteLink: RemoteOccurrenceLinkRecord | null;
  expectedRemotePayloadJson: string;
  contractCode: string | null;
  kind: 'different_meetings' | 'remote_meeting_unavailable' | 'same_meeting_divergence' | 'target_not_attachable' | 'invalid_payload';
  canResolve: boolean;
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

function isoFromMs(value: unknown): string | null {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
  try {
    return new Date(Number(value)).toISOString();
  } catch {
    return null;
  }
}

function normalizeScheduleSnapshot(value: unknown): unknown {
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, 'all_day')) return value;
  return {
    event_title: value.eventTitle,
    planned_start_ms: value.plannedStartMs,
    planned_end_ms: value.plannedEndMs,
    all_day: value.allDay,
    timezone_id: value.timezoneId,
    location: value.location,
    participants: value.participants,
    description: value.description,
    captured_event_revision: value.capturedEventRevision,
    captured_at_ms: value.capturedAtMs,
  };
}

function normalizeRemoteCurrent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    schedule_snapshot: normalizeScheduleSnapshot(value.schedule_snapshot),
    created_at: value.created_at ?? isoFromMs(value.created_at_ms),
    updated_at: value.updated_at ?? isoFromMs(value.updated_at_ms),
  };
}

function parseRemoteLink(
  conflict: MeetingOccurrenceSyncConflictRecord,
  occurrence: OccurrenceReference,
): { remote: RemoteOccurrenceLinkRecord | null; contractCode: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(conflict.remotePayloadJson) as unknown;
  } catch {
    return { remote: null, contractCode: null };
  }
  const wrapper = isRecord(payload) && (
    Object.prototype.hasOwnProperty.call(payload, 'current')
    || Object.prototype.hasOwnProperty.call(payload, 'error_code')
  ) ? payload : null;
  const contractCode = identifier(wrapper?.error_code);
  try {
    const parsed = parseRemoteOccurrenceLinkV2(
      normalizeRemoteCurrent(wrapper ? wrapper.current : payload),
      {
        sourceEventId: occurrence.sourceEventId,
        occurrenceDate: occurrence.occurrenceDate,
      },
    );
    if (
      !parsed.exists
      || parsed.remoteId === null
      || parsed.meetingRemoteId === null
      || parsed.sourceEventId === null
      || parsed.occurrenceDate === null
      || parsed.linkState === null
      || parsed.scheduleSnapshot === null
      || parsed.serverCreatedAtMs === null
      || parsed.serverUpdatedAtMs === null
      || (conflict.remoteRevision !== null && conflict.remoteRevision !== parsed.revision)
    ) return { remote: null, contractCode };
    return {
      remote: {
        remoteId: parsed.remoteId,
        meetingRemoteId: parsed.meetingRemoteId,
        revision: parsed.revision,
        sourceEventId: parsed.sourceEventId,
        occurrenceDate: parsed.occurrenceDate,
        calendarRevision: parsed.calendarRevision,
        recurrenceSegmentId: parsed.recurrenceSegmentId,
        seriesKey: parsed.seriesKey,
        linkState: parsed.linkState,
        clientUpdatedAtMs: parsed.clientUpdatedAtMs,
        scheduleSnapshot: parsed.scheduleSnapshot,
        serverCreatedAtMs: parsed.serverCreatedAtMs,
        serverUpdatedAtMs: parsed.serverUpdatedAtMs,
      },
      contractCode,
    };
  } catch {
    return { remote: null, contractCode };
  }
}

function aggregateHasContent(aggregate: Awaited<ReturnType<MeetingNoteRepository['get']>>): boolean {
  if (!aggregate) return false;
  return aggregate.recordingAssets.some(asset => (
    asset.localState !== 'missing'
    || Boolean(asset.localUri || asset.remoteAssetId)
  ))
    || aggregate.manualNote.content.length > 0
    || aggregate.note.currentSummaryVersionId !== null
    || aggregate.processingStages.some(stage => (
      (stage.stage === 'transcript' || stage.stage === 'summary') && stage.status !== 'none'
    ));
}

function displayTitle(value: string): string {
  return value.trim() || '(无主题)';
}

function scheduleSnapshotsEqual(left: ScheduleSnapshot, right: ScheduleSnapshot): boolean {
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

export async function loadMeetingOccurrenceSyncConflict(
  scopeKey: ScopeKey,
  occurrence: OccurrenceReference,
  repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
): Promise<MeetingOccurrenceSyncConflictView | null> {
  const conflict = await repository.getOccurrenceSyncConflict(occurrence, scopeKey);
  if (!conflict) return null;
  const local = await repository.get(conflict.meetingId, scopeKey);
  if (
    !local
    || local.note.lifecycle === 'deleted'
    || local.occurrence?.sourceEventId !== occurrence.sourceEventId
    || local.occurrence.occurrenceDate !== occurrence.occurrenceDate
  ) return null;
  const parsed = parseRemoteLink(conflict, occurrence);
  if (!parsed.remote || !local.scheduleSnapshot) {
    return {
      id: conflict.id,
      meetingId: conflict.meetingId,
      createdAtMs: conflict.createdAtMs,
      occurrence,
      local: {
        id: local.note.id,
        title: displayTitle(local.note.title),
        statusLabel: aggregateHasContent(local) ? '本机内容将完整保留' : '本机记录将独立保留',
        mergeableRecordingCount: local.recordingAssets.filter(asset => Boolean(
          asset.localUri
          || asset.localState === 'capturing'
          || asset.localState === 'ingesting'
        )).length,
      },
      remote: null,
      remoteLink: null,
      expectedRemotePayloadJson: conflict.remotePayloadJson,
      contractCode: parsed.contractCode,
      kind: 'invalid_payload',
      canResolve: false,
    };
  }
  const target = await repository.transaction(transaction => (
    transaction.findMeetingByRemoteIdentity(
      parsed.remote!.meetingRemoteId,
      null,
      null,
      scopeKey,
    )
  ));
  const sameMeeting = target?.id === local.note.id;
  const targetAggregate = target && !sameMeeting ? await repository.get(target.id, scopeKey) : null;
  const targetAttachable = Boolean(
    targetAggregate
    && targetAggregate.note.lifecycle !== 'deleted'
    && targetAggregate.occurrence === null
    && (
      targetAggregate.scheduleSnapshot === null
      || scheduleSnapshotsEqual(targetAggregate.scheduleSnapshot, parsed.remote.scheduleSnapshot)
    )
  );
  return {
    id: conflict.id,
    meetingId: conflict.meetingId,
    createdAtMs: conflict.createdAtMs,
    occurrence,
    local: {
      id: local.note.id,
      title: displayTitle(local.note.title),
      statusLabel: aggregateHasContent(local) ? '本机内容将完整保留' : '本机记录将独立保留',
      mergeableRecordingCount: local.recordingAssets.filter(asset => Boolean(
        asset.localUri
        || asset.localState === 'capturing'
        || asset.localState === 'ingesting'
      )).length,
    },
    remote: targetAggregate && targetAggregate.note.lifecycle !== 'deleted' ? {
      id: targetAggregate.note.id,
      title: displayTitle(targetAggregate.note.title || parsed.remote.scheduleSnapshot.eventTitle),
      statusLabel: '日程将使用此关联',
      mergeableRecordingCount: 0,
    } : null,
    remoteLink: parsed.remote,
    expectedRemotePayloadJson: conflict.remotePayloadJson,
    contractCode: parsed.contractCode,
    kind: sameMeeting
      ? 'same_meeting_divergence'
      : targetAggregate && targetAggregate.note.lifecycle !== 'deleted' && !targetAttachable
        ? 'target_not_attachable'
        : targetAttachable
        ? 'different_meetings'
        : 'remote_meeting_unavailable',
    canResolve: Boolean(targetAttachable && !sameMeeting),
  };
}
