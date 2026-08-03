import { CalEvent } from '../types';
import type { ApiEvent, ApiEventEditPatch } from './api';
import {
  colorForEvent,
  inferEventCategory,
  isEventCategory,
  normalizeEventCategory,
} from '../utils/eventColors';
import { sourceEventId } from '../utils/eventIdentity';

export { sourceEventId } from '../utils/eventIdentity';

export type EventDisplayMetadata = Partial<Pick<
  CalEvent,
  'color' | 'location' | 'category' | 'detail' | 'reminderMinutes' | 'notificationId'
>>;

function categoryFromEventFields(
  candidate: string | null | undefined,
  title: string,
  text: string,
): ReturnType<typeof normalizeEventCategory> {
  if (isEventCategory(candidate) && candidate !== '其他') return candidate;
  const inferred = inferEventCategory(title, text);
  return inferred !== '其他' ? inferred : '其他';
}

function eventCategoryText(
  title: string,
  description?: string | null,
  detail?: string | null,
  rawText?: string | null,
): string {
  return [description, detail, rawText].filter((value): value is string => Boolean(value?.trim())).join(' ');
}

export function apiEventClientId(event: ApiEvent & { id: number }): string {
  if (event.occurrence_id) return event.occurrence_id;
  const sourceId = String(event.source_event_id ?? event.id);
  if (event.is_recurrence_exception && event.occurrence_date) {
    return `${sourceId}@${event.occurrence_date}:exception`;
  }
  if (event.segment_id != null && !event.is_expanded) return `${sourceId}:segment:${event.segment_id}`;
  return String(event.id);
}

export function applyEventMetadata(event: CalEvent, metadata?: EventDisplayMetadata): CalEvent {
  const sourceText = eventCategoryText(event.title, event.description, event.detail, event.rawText);
  if (!metadata) {
    const category = categoryFromEventFields(event.category, event.title, sourceText);
    return { ...event, category, color: colorForEvent({ category }) };
  }
  const category = categoryFromEventFields(metadata.category ?? event.category, event.title, sourceText);
  return { ...event, ...metadata, category, color: colorForEvent({ category }) };
}

export function apiEventToCalEvent(
  event: ApiEvent & { id: number },
  metadata?: EventDisplayMetadata,
): CalEvent {
  const endDate = event.end_date ?? undefined;
  const category = categoryFromEventFields(
    metadata?.category ?? event.category,
    event.title,
    eventCategoryText(event.title, event.description, event.detail, event.raw_text),
  );
  const local: CalEvent = {
    id: apiEventClientId(event),
    sourceEventId: String(event.source_event_id ?? event.id),
    occurrenceDate: event.occurrence_date ?? event.start_date,
    occurrenceId: event.occurrence_id ?? undefined,
    isExpandedOccurrence: event.is_expanded ?? false,
    isRecurrenceException: event.is_recurrence_exception ?? false,
    seriesStartDate: event.series_start_date ?? undefined,
    seriesEndDate: event.series_end_date ?? undefined,
    revision: event.revision,
    recurrenceSegmentId: event.segment_id ?? undefined,
    recurrenceInterval: event.recurrence_interval ?? undefined,
    recurrenceWeekdays: event.recurrence_weekdays ?? undefined,
    recurrenceUntilDate: event.recurrence_until_date ?? undefined,
    recurrenceEffectiveFromDate: event.recurrence_effective_from_date ?? undefined,
    excludedOccurrenceDates: event.excluded_occurrence_dates ?? undefined,
    excludedAfterDate: event.excluded_after_date ?? undefined,
    title: event.title,
    startDate: event.start_date,
    endDate,
    startTime: event.start_time ?? undefined,
    endTime: event.end_time ?? undefined,
    isAllDay: event.is_all_day ?? false,
    repeat: event.event_type as CalEvent['repeat'],
    description: event.description ?? event.detail ?? undefined,
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
  const category = categoryFromEventFields(
    event.category,
    event.title,
    eventCategoryText(event.title, event.description, event.detail, event.rawText),
  );
  return {
    title: event.title,
    event_type: event.repeat || 'once',
    start_date: event.startDate,
    end_date: event.endDate ?? null,
    color: colorForEvent({ category }),
    spanning: event.spanning ?? Boolean(event.endDate && event.endDate !== event.startDate),
    start_time: event.startTime ?? null,
    end_time: event.endTime ?? null,
    is_all_day: event.isAllDay ?? false,
    description: event.description ?? null,
    raw_text: event.rawText ?? null,
    client_request_id: event.clientRequestId ?? null,
    location: event.location ?? null,
    category,
    detail: event.detail ?? null,
    status: event.status ?? null,
    reminder_minutes: event.reminderMinutes ?? null,
    recurrence_interval: event.recurrenceInterval ?? 1,
    recurrence_weekdays: event.recurrenceWeekdays ?? null,
    recurrence_until_date: event.recurrenceUntilDate ?? null,
  };
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizedNumberArray(value?: number[] | null): number[] | undefined {
  if (!value) return undefined;
  return [...new Set(value)].sort((left, right) => left - right);
}

function sameNumberArray(left?: number[] | null, right?: number[] | null): boolean {
  if (left === right) return true;
  const normalizedLeft = normalizedNumberArray(left);
  const normalizedRight = normalizedNumberArray(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function nullableText(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

/** Build a sparse edit patch. Undefined hidden fields are intentionally omitted. */
export function calEventChangesToApiEditPatch(
  base: CalEvent,
  changes: Partial<CalEvent>,
): ApiEventEditPatch {
  const patch: ApiEventEditPatch = {};
  if (changes.title !== undefined && changes.title !== base.title) patch.title = changes.title;
  if (changes.repeat !== undefined && changes.repeat !== base.repeat) patch.event_type = changes.repeat;
  if (changes.startDate !== undefined && changes.startDate !== base.startDate) patch.start_date = changes.startDate;
  if (hasOwn(changes, 'endDate') && changes.endDate !== base.endDate) patch.end_date = changes.endDate ?? null;
  if (hasOwn(changes, 'startTime') && changes.startTime !== base.startTime) patch.start_time = changes.startTime ?? null;
  if (hasOwn(changes, 'endTime') && changes.endTime !== base.endTime) patch.end_time = changes.endTime ?? null;
  if (changes.isAllDay !== undefined && changes.isAllDay !== base.isAllDay) patch.is_all_day = changes.isAllDay;
  if (changes.spanning !== undefined && changes.spanning !== base.spanning) patch.spanning = changes.spanning;
  if (hasOwn(changes, 'description') && changes.description !== base.description) {
    patch.description = nullableText(changes.description);
  }
  if (hasOwn(changes, 'location') && changes.location !== base.location) {
    patch.location = nullableText(changes.location);
  }
  if (changes.category !== undefined && changes.category !== base.category) {
    patch.category = normalizeEventCategory(changes.category);
  }
  if (changes.detail !== undefined && changes.detail !== base.detail) patch.detail = nullableText(changes.detail);
  if (changes.status !== undefined && changes.status !== base.status) patch.status = nullableText(changes.status);
  if (changes.rawText !== undefined && changes.rawText !== base.rawText) patch.raw_text = nullableText(changes.rawText);
  if (hasOwn(changes, 'reminderMinutes') && changes.reminderMinutes !== base.reminderMinutes) {
    patch.reminder_minutes = changes.reminderMinutes ?? null;
  }

  const recurrence: NonNullable<ApiEventEditPatch['recurrence']> = {};
  if (changes.repeat !== undefined && changes.repeat !== base.repeat) recurrence.frequency = changes.repeat;
  if (changes.recurrenceInterval !== undefined && changes.recurrenceInterval !== base.recurrenceInterval) {
    recurrence.interval = changes.recurrenceInterval;
  }
  if (hasOwn(changes, 'recurrenceWeekdays')
    && !sameNumberArray(changes.recurrenceWeekdays, base.recurrenceWeekdays)) {
    recurrence.weekdays = normalizedNumberArray(changes.recurrenceWeekdays) ?? null;
  }
  if (hasOwn(changes, 'recurrenceUntilDate')
    && changes.recurrenceUntilDate !== base.recurrenceUntilDate) {
    recurrence.until_date = changes.recurrenceUntilDate ?? null;
  }
  if (Object.keys(recurrence).length > 0) patch.recurrence = recurrence;
  return patch;
}

export function eventSeriesDraft(event: CalEvent): Omit<CalEvent, 'id'> {
  const {
    id: _id,
    sourceEventId: _sourceEventId,
    occurrenceDate: _occurrenceDate,
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
