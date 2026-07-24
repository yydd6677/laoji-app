import type { CalEvent, Meeting } from '../types';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type {
  OccurrenceReference,
  ScheduleSnapshot,
  ScopeKey,
} from '../domain/meeting';
import { assertScopeKey, calendarMeetingSeriesKey } from '../domain/meeting';
import { eventRefForEvent } from '../utils/eventIdentity';

export type OccurrenceMeetingActionKind = 'start' | 'continue' | 'view';

export interface OccurrenceMeetingProjection {
  meetingId: string;
  canonicalMeetingId: string;
  action: OccurrenceMeetingActionKind;
  label: '开始记录' | '继续记录' | '查看记录';
  statusLabel: string;
  syncConflict: boolean;
}

export interface CalendarMeetingContext {
  occurrence: OccurrenceReference;
  snapshot: ScheduleSnapshot;
  recurrenceSegmentId: string | null;
  seriesKey: string | null;
}

function localTimestamp(date: string | undefined, time: string | undefined): number | null {
  if (!date) return null;
  const value = new Date(`${date}T${time || '00:00'}:00`);
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function calendarMeetingContext(
  event: CalEvent,
  scopeKey: ScopeKey,
  nowMs = Date.now(),
): CalendarMeetingContext {
  assertScopeKey(scopeKey);
  const occurrence = eventRefForEvent(event);
  const allDay = Boolean(event.isAllDay || (!event.startTime && !event.endTime));
  return {
    occurrence,
    snapshot: {
      eventTitle: event.title ?? '',
      plannedStartMs: localTimestamp(event.startDate, allDay ? undefined : event.startTime),
      plannedEndMs: localTimestamp(
        event.endDate ?? event.startDate,
        allDay ? undefined : event.endTime ?? event.startTime,
      ),
      allDay,
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      location: event.location?.trim() || null,
      participants: [],
      description: (event.description ?? event.detail)?.trim() || null,
      capturedEventRevision: Number.isSafeInteger(event.revision) ? event.revision! : null,
      capturedAtMs: nowMs,
    },
    recurrenceSegmentId: event.recurrenceSegmentId == null
      ? null
      : String(event.recurrenceSegmentId),
    seriesKey: calendarMeetingSeriesKey(scopeKey, occurrence.sourceEventId),
  };
}

function legacyFacingMeetingId(aggregate: MeetingNoteAggregate): string {
  return aggregate.note.legacySourceId
    ?? aggregate.note.remoteId
    ?? aggregate.note.id;
}

function projectAggregate(aggregate: MeetingNoteAggregate): OccurrenceMeetingProjection {
  const capture = aggregate.processingStages.find(stage => stage.stage === 'capture');
  const hasContent = aggregate.recordingAssets.some(asset => (
    asset.localState === 'local_ready'
    || asset.localState === 'remote_only'
    || Boolean(asset.localUri || asset.remoteAssetId)
  ))
    || aggregate.note.currentSummaryVersionId !== null
    || aggregate.processingStages.some(stage => (
      stage.stage === 'transcript' && stage.status !== 'none'
      || stage.stage === 'summary' && stage.status !== 'none'
    ));
  if (
    aggregate.note.lifecycle === 'active'
    || ['preparing', 'recording', 'paused', 'finalizing', 'failed_recoverable'].includes(capture?.status ?? '')
  ) {
    return {
      meetingId: legacyFacingMeetingId(aggregate),
      canonicalMeetingId: aggregate.note.id,
      action: 'continue',
      label: '继续记录',
      statusLabel: capture?.status === 'paused' ? '录音已暂停' : '记录尚未结束',
      syncConflict: false,
    };
  }
  if (aggregate.note.lifecycle === 'ended' || hasContent) {
    return {
      meetingId: legacyFacingMeetingId(aggregate),
      canonicalMeetingId: aggregate.note.id,
      action: 'view',
      label: '查看记录',
      statusLabel: '已有会议记录',
      syncConflict: false,
    };
  }
  return {
    meetingId: legacyFacingMeetingId(aggregate),
    canonicalMeetingId: aggregate.note.id,
    action: 'start',
    label: '开始记录',
    statusLabel: '尚未开始',
    syncConflict: false,
  };
}

export async function resolveOccurrenceMeeting(
  scopeKey: ScopeKey,
  occurrence: OccurrenceReference,
  repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
): Promise<OccurrenceMeetingProjection | null> {
  assertScopeKey(scopeKey);
  const aggregate = await repository.findByOccurrence(occurrence, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  const projection = projectAggregate(aggregate);
  return {
    ...projection,
    syncConflict: await repository.hasOccurrenceSyncConflict(occurrence, scopeKey),
  };
}

export async function bindLegacyMeetingToOccurrence(
  scopeKey: ScopeKey,
  meeting: Pick<Meeting, 'id'>,
  context: CalendarMeetingContext,
  repository: MeetingNoteRepository = sqliteMeetingNoteRepository,
): Promise<OccurrenceMeetingProjection> {
  assertScopeKey(scopeKey);
  await repository.transaction(async transaction => {
    const existing = await transaction.findMeetingByOccurrence(context.occurrence, scopeKey);
    if (existing && existing.lifecycle !== 'deleted') return;
    const target = await transaction.findMeetingByNativeSessionId(meeting.id, scopeKey);
    if (!target || target.lifecycle === 'deleted') {
      throw new Error('日程对应的会议记录尚未准备好');
    }
    await transaction.bindOccurrence({
      meetingId: target.id,
      scopeKey,
      ...context.occurrence,
      calendarRevision: context.snapshot.capturedEventRevision,
      recurrenceSegmentId: context.recurrenceSegmentId,
      seriesKey: calendarMeetingSeriesKey(scopeKey, context.occurrence.sourceEventId),
      linkedAtMs: context.snapshot.capturedAtMs,
    }, context.snapshot);
  });
  const projection = await resolveOccurrenceMeeting(scopeKey, context.occurrence, repository);
  if (!projection) throw new Error('日程与会议记录关联失败');
  return projection;
}
