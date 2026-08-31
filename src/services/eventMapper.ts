import { CalEvent } from '../types';
import {
  colorForEvent,
  inferEventCategory,
  isEventCategory,
  normalizeEventCategory,
} from '../utils/eventColors';
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
  description?: string | null,
  detail?: string | null,
  rawText?: string | null,
): string {
  return [description, detail, rawText].filter((value): value is string => Boolean(value?.trim())).join(' ');
}

export function applyEventMetadata(event: CalEvent, metadata?: EventDisplayMetadata): CalEvent {
  const sourceText = eventCategoryText(event.description, event.detail, event.rawText);
  if (!metadata) {
    const category = categoryFromEventFields(event.category, event.title, sourceText);
    return { ...event, category, color: colorForEvent({ category }) };
  }
  const category = categoryFromEventFields(metadata.category ?? event.category, event.title, sourceText);
  return { ...event, ...metadata, category, color: colorForEvent({ category }) };
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
