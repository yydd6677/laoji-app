import type { CalEvent } from '../types';
import { isValidEventDate } from './eventDraftValidation';

const DAY_MS = 86_400_000;

type EventDateRange = Pick<
  CalEvent,
  'startDate' | 'endDate' | 'startTime' | 'endTime' | 'isAllDay'
>;

function dateOrdinal(value: string): number | null {
  if (!isValidEventDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateFromOrdinal(ordinal: number): string {
  const value = new Date(ordinal * DAY_MS);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export function addCalendarDays(value: string, days: number): string | null {
  const ordinal = dateOrdinal(value);
  return ordinal === null ? null : dateFromOrdinal(ordinal + days);
}

export function eventEndsAtExclusiveMidnight(event: EventDateRange): boolean {
  return event.isAllDay !== true
    && Boolean(event.startTime)
    && Boolean(event.endDate)
    && event.endDate! > event.startDate
    && event.endTime === '00:00';
}

/** Last calendar date containing any part of the event. */
export function eventEffectiveEndDate(event: EventDateRange): string {
  const storedEnd = isValidEventDate(event.endDate) && event.endDate! >= event.startDate
    ? event.endDate!
    : event.startDate;
  if (!eventEndsAtExclusiveMidnight(event)) return storedEnd;
  return addCalendarDays(storedEnd, -1) ?? event.startDate;
}

export function eventCoversDate(event: EventDateRange, date: string): boolean {
  if (!isValidEventDate(date) || !isValidEventDate(event.startDate)) return false;
  return event.startDate <= date && date <= eventEffectiveEndDate(event);
}

export function eventOverlapsDateRange(
  event: EventDateRange,
  rangeStart: string,
  rangeEnd: string,
): boolean {
  if (!isValidEventDate(rangeStart) || !isValidEventDate(rangeEnd) || rangeEnd < rangeStart) return false;
  return event.startDate <= rangeEnd && eventEffectiveEndDate(event) >= rangeStart;
}

export function eventOccupiedDateKeys(event: EventDateRange, limit = 120): string[] {
  const start = dateOrdinal(event.startDate);
  const end = dateOrdinal(eventEffectiveEndDate(event));
  if (start === null || end === null || end < start) return [];
  const keys: string[] = [];
  for (let ordinal = start; ordinal <= end && keys.length < limit; ordinal += 1) {
    keys.push(dateFromOrdinal(ordinal));
  }
  return keys;
}
