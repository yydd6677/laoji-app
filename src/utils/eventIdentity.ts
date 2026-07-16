import type { CalEvent, EventRef } from '../types';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_OCCURRENCE_ID_PATTERN = /^(.*)@(\d{4}-\d{2}-\d{2})$/;

/**
 * Legacy caches encoded the source id into `id`. New code must persist
 * `sourceEventId`; the fallback only keeps already-installed builds readable.
 */
export function sourceEventId(event: Pick<CalEvent, 'id' | 'sourceEventId'>): string {
  if (event.sourceEventId) return event.sourceEventId;
  const legacy = LEGACY_OCCURRENCE_ID_PATTERN.exec(event.id);
  return legacy?.[1] || event.id;
}

export function eventRefForEvent(
  event: Pick<CalEvent, 'id' | 'sourceEventId' | 'occurrenceDate' | 'startDate'>,
): EventRef {
  return {
    sourceEventId: sourceEventId(event),
    occurrenceDate: event.occurrenceDate ?? event.startDate,
  };
}

export function eventRefKey(ref: EventRef): string {
  return JSON.stringify([ref.sourceEventId, ref.occurrenceDate]);
}

export function sameEventRef(left: EventRef, right: EventRef): boolean {
  return left.sourceEventId === right.sourceEventId
    && left.occurrenceDate === right.occurrenceDate;
}

export function eventMatchesRef(
  event: Pick<CalEvent, 'id' | 'sourceEventId' | 'occurrenceDate' | 'startDate'>,
  ref: EventRef,
): boolean {
  return sourceEventId(event) === ref.sourceEventId
    && (event.occurrenceDate ?? event.startDate) === ref.occurrenceDate;
}

export function isEventRef(value: unknown): value is EventRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EventRef>;
  return typeof candidate.sourceEventId === 'string'
    && candidate.sourceEventId.length > 0
    && typeof candidate.occurrenceDate === 'string'
    && DATE_KEY_PATTERN.test(candidate.occurrenceDate);
}

export function eventRefNotificationData(ref: EventRef): Record<string, string> {
  return {
    eventSourceId: ref.sourceEventId,
    eventOccurrenceDate: ref.occurrenceDate,
  };
}

export function eventRefFromNotificationData(data: unknown): EventRef | null {
  if (!data || typeof data !== 'object') return null;
  const values = data as Record<string, unknown>;
  const ref = {
    sourceEventId: values.eventSourceId,
    occurrenceDate: values.eventOccurrenceDate,
  };
  return isEventRef(ref) ? ref : null;
}
