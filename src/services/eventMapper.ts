import { CalEvent } from '../types';
import type { ApiEvent } from './api';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';

export type EventDisplayMetadata = Partial<Pick<
  CalEvent,
  'color' | 'location' | 'category' | 'detail' | 'reminderMinutes' | 'notificationId'
>>;

export function apiEventClientId(event: ApiEvent & { id: number }): string {
  return event.occurrence_id || String(event.id);
}

export function sourceEventId(event: Pick<CalEvent, 'id' | 'sourceEventId'>): string {
  return event.sourceEventId || event.id.split('@', 1)[0];
}

export function applyEventMetadata(event: CalEvent, metadata?: EventDisplayMetadata): CalEvent {
  if (!metadata) {
    const category = normalizeEventCategory(event.category);
    return { ...event, category, color: colorForEvent({ category }) };
  }
  const category = normalizeEventCategory(metadata.category ?? event.category);
  return { ...event, ...metadata, category, color: colorForEvent({ category }) };
}

export function apiEventToCalEvent(
  event: ApiEvent & { id: number },
  metadata?: EventDisplayMetadata,
): CalEvent {
  const endDate = event.end_date ?? undefined;
  const category = normalizeEventCategory(event.category ?? metadata?.category);
  const local: CalEvent = {
    id: apiEventClientId(event),
    sourceEventId: String(event.source_event_id ?? event.id),
    occurrenceId: event.occurrence_id ?? undefined,
    isExpandedOccurrence: event.is_expanded ?? false,
    seriesStartDate: event.series_start_date ?? undefined,
    seriesEndDate: event.series_end_date ?? undefined,
    title: event.title,
    startDate: event.start_date,
    endDate,
    startTime: event.start_time ?? undefined,
    endTime: event.end_time ?? undefined,
    isAllDay: event.is_all_day ?? false,
    repeat: event.event_type as CalEvent['repeat'],
    description: event.description ?? undefined,
    rawText: event.raw_text ?? undefined,
    clientRequestId: event.client_request_id ?? undefined,
    location: event.location ?? metadata?.location,
    category,
    detail: event.detail ?? metadata?.detail,
    status: event.status ?? undefined,
    spanning: event.spanning ?? Boolean(endDate && endDate !== event.start_date),
    reminderMinutes: event.reminder_minutes ?? metadata?.reminderMinutes ?? null,
    notificationId: metadata?.notificationId ?? null,
    color: colorForEvent({ category }),
  };
  return applyEventMetadata(local, metadata);
}

export function calEventToApiEvent(event: Omit<CalEvent, 'id'>): ApiEvent {
  return {
    title: event.title,
    event_type: event.repeat || 'once',
    start_date: event.startDate,
    end_date: event.endDate ?? null,
    color: colorForEvent({ category: event.category }),
    spanning: event.spanning ?? Boolean(event.endDate && event.endDate !== event.startDate),
    start_time: event.startTime ?? null,
    end_time: event.endTime ?? null,
    is_all_day: event.isAllDay ?? false,
    description: event.description ?? null,
    raw_text: event.rawText ?? null,
    client_request_id: event.clientRequestId ?? null,
    location: event.location ?? null,
    category: normalizeEventCategory(event.category),
    detail: event.detail ?? null,
    status: event.status ?? null,
    reminder_minutes: event.reminderMinutes ?? null,
  };
}

export function eventSeriesDraft(event: CalEvent): Omit<CalEvent, 'id'> {
  const {
    id: _id,
    sourceEventId: _sourceEventId,
    occurrenceId: _occurrenceId,
    isExpandedOccurrence: _isExpandedOccurrence,
    seriesStartDate,
    seriesEndDate,
    ...rest
  } = event;
  if (event.repeat && event.repeat !== 'once' && seriesStartDate) {
    return {
      ...rest,
      startDate: seriesStartDate,
      endDate: seriesEndDate,
      spanning: Boolean(seriesEndDate && seriesEndDate !== seriesStartDate),
    };
  }
  return rest;
}
