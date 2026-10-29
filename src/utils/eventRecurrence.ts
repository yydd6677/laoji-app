import { CalEvent, EventRef } from '../types';
import { eventMatchesRef, sourceEventId } from './eventIdentity';
import {
  eventCoversDate,
  eventEffectiveEndDate,
  eventOverlapsDateRange,
} from './eventDateSemantics';

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3])
    ? date
    : null;
}

function overlapsMonth(event: CalEvent, monthStart: string, monthEnd: string): boolean {
  return eventOverlapsDateRange(event, monthStart, monthEnd);
}

function eventDurationDays(base: CalEvent): number {
  const sourceStart = parseDate(base.startDate);
  const sourceEnd = parseDate(base.endDate ?? base.startDate);
  return sourceStart && sourceEnd
    ? Math.max(0, Math.round((sourceEnd.getTime() - sourceStart.getTime()) / 86_400_000))
    : 0;
}

function recurrenceAnchorDate(base: CalEvent): Date | null {
  return parseDate(
    base.recurrenceEffectiveFromDate
    ?? base.seriesStartDate
    ?? base.startDate,
  );
}

function displayOffsetDays(base: CalEvent): number {
  const anchor = recurrenceAnchorDate(base);
  const display = parseDate(base.startDate);
  return anchor && display ? dayOrdinal(display) - dayOrdinal(anchor) : 0;
}

function isoWeekday(date: Date): number {
  return date.getDay() || 7;
}

function occurrenceFromBase(base: CalEvent, date: Date): CalEvent {
  const occurrenceDate = formatDate(date);
  const sourceId = sourceEventId(base);
  const durationDays = eventDurationDays(base);
  const displayStart = new Date(date);
  displayStart.setDate(displayStart.getDate() + displayOffsetDays(base));
  const end = new Date(displayStart);
  end.setDate(end.getDate() + durationDays);
  const occurrenceEnd = durationDays > 0 ? formatDate(end) : undefined;
  return {
    ...base,
    id: `${sourceId}@${occurrenceDate}`,
    sourceEventId: sourceId,
    occurrenceDate,
    occurrenceId: `${sourceId}@${occurrenceDate}`,
    isExpandedOccurrence: true,
    seriesStartDate: base.seriesStartDate ?? base.startDate,
    seriesEndDate: base.seriesEndDate ?? base.endDate,
    startDate: formatDate(displayStart),
    endDate: occurrenceEnd,
    spanning: durationDays > 0,
    notificationId: null,
  };
}

function dayOrdinal(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function recurrenceMatches(base: CalEvent, date: Date): boolean {
  const seriesStart = recurrenceAnchorDate(base);
  const displayOrigin = parseDate(base.startDate);
  if (!seriesStart || !displayOrigin || date < seriesStart) return false;
  const occurrenceDate = formatDate(date);
  if (base.recurrenceUntilDate && occurrenceDate > base.recurrenceUntilDate) return false;
  if (base.excludedAfterDate && occurrenceDate >= base.excludedAfterDate) return false;
  if (base.excludedOccurrenceDates?.includes(occurrenceDate)) return false;
  if (date.getTime() === seriesStart.getTime()) return true;
  const displayDate = new Date(displayOrigin);
  displayDate.setDate(displayDate.getDate() + dayOrdinal(date) - dayOrdinal(seriesStart));
  const elapsedDays = dayOrdinal(displayDate) - dayOrdinal(displayOrigin);
  const interval = Math.max(1, Math.trunc(base.recurrenceInterval ?? 1));
  if (base.repeat === 'daily') return elapsedDays % interval === 0;
  if (base.repeat === 'weekly') {
    const weekdays = base.recurrenceWeekdays?.length
      ? new Set(base.recurrenceWeekdays)
      : new Set([isoWeekday(displayOrigin)]);
    const originWeekStart = new Date(displayOrigin);
    originWeekStart.setDate(originWeekStart.getDate() - (isoWeekday(displayOrigin) - 1));
    const displayWeekStart = new Date(displayDate);
    displayWeekStart.setDate(displayWeekStart.getDate() - (isoWeekday(displayDate) - 1));
    const weekIndex = Math.floor((dayOrdinal(displayWeekStart) - dayOrdinal(originWeekStart)) / 7);
    return weekIndex >= 0 && weekIndex % interval === 0 && weekdays.has(isoWeekday(displayDate));
  }
  if (base.repeat === 'monthly') {
    const elapsedMonths = (displayDate.getFullYear() - displayOrigin.getFullYear()) * 12
      + displayDate.getMonth() - displayOrigin.getMonth();
    return elapsedMonths >= 0
      && elapsedMonths % interval === 0
      && displayDate.getDate() === displayOrigin.getDate();
  }
  if (base.repeat === 'yearly') {
    const elapsedYears = displayDate.getFullYear() - displayOrigin.getFullYear();
    return elapsedYears >= 0
      && elapsedYears % interval === 0
      && displayDate.getMonth() === displayOrigin.getMonth()
      && displayDate.getDate() === displayOrigin.getDate();
  }
  return formatDate(date) === base.startDate;
}

/** Materialize one exact occurrence without relying on the currently loaded month. */
export function materializeEventOccurrence(base: CalEvent, occurrenceDate: string): CalEvent | null {
  const date = parseDate(occurrenceDate);
  if (!date) return null;
  if (base.isRecurrenceException) {
    return (base.occurrenceDate ?? base.startDate) === occurrenceDate ? base : null;
  }
  if (!base.repeat || base.repeat === 'once') {
    return (base.occurrenceDate ?? base.startDate) === occurrenceDate ? base : null;
  }
  if (!recurrenceMatches(base, date)) return null;
  return occurrenceFromBase(base, date);
}

/** Materialize recurring occurrences that occupy a date, including spans that began earlier. */
export function materializeEventOccurrencesCoveringDate(base: CalEvent, dateKey: string): CalEvent[] {
  if (!base.repeat || base.repeat === 'once' || base.isExpandedOccurrence) {
    return eventCoversDate(base, dateKey) ? [base] : [];
  }
  const target = parseDate(dateKey);
  if (!target) return [];
  return expandEventForMonth(base, target.getFullYear(), target.getMonth() + 1)
    .filter(event => eventCoversDate(event, dateKey));
}

/** Resolve an occurrence ref from expanded events or a recurring-series catalog. */
export function resolveEventReference(events: CalEvent[], ref: EventRef): CalEvent | null {
  const exact = events.find(event => eventMatchesRef(event, ref));
  if (exact && (
    exact.isExpandedOccurrence
    || exact.isRecurrenceException
    || !exact.repeat
    || exact.repeat === 'once'
  )) return exact;

  const sources = [
    ...(exact ? [exact] : []),
    ...events.filter(event => sourceEventId(event) === ref.sourceEventId && !event.isExpandedOccurrence),
  ];
  for (const source of sources) {
    const occurrence = materializeEventOccurrence(source, ref.occurrenceDate);
    if (occurrence) return occurrence;
  }

  const expanded = events.find(event => sourceEventId(event) === ref.sourceEventId);
  if (!expanded?.seriesStartDate) return null;
  const base: CalEvent = {
    ...expanded,
    id: ref.sourceEventId,
    sourceEventId: ref.sourceEventId,
    occurrenceDate: expanded.seriesStartDate,
    occurrenceId: undefined,
    isExpandedOccurrence: false,
    startDate: expanded.seriesStartDate,
    endDate: expanded.seriesEndDate,
  };
  return materializeEventOccurrence(base, ref.occurrenceDate);
}

export function expandEventForMonth(base: CalEvent, year: number, month: number): CalEvent[] {
  const monthStartDate = new Date(year, month - 1, 1);
  const monthEndDate = new Date(year, month, 0);
  const monthStart = formatDate(monthStartDate);
  const monthEnd = formatDate(monthEndDate);

  if (!base.repeat || base.repeat === 'once' || base.isExpandedOccurrence || base.isRecurrenceException) {
    return overlapsMonth(base, monthStart, monthEnd) ? [base] : [];
  }

  const seriesStart = recurrenceAnchorDate(base);
  if (!seriesStart) return [];
  const offsetDays = displayOffsetDays(base);
  const first = new Date(monthStartDate);
  first.setDate(first.getDate() - offsetDays - eventDurationDays(base));
  const last = new Date(monthEndDate);
  last.setDate(last.getDate() - offsetDays);
  const results: CalEvent[] = [];

  for (let cursor = first; cursor <= last; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    if (cursor < seriesStart) continue;
    if (recurrenceMatches(base, cursor)) {
      const occurrence = occurrenceFromBase(base, cursor);
      if (overlapsMonth(occurrence, monthStart, monthEnd)) results.push(occurrence);
    }
  }
  return results;
}

export function expandEventsForMonths(events: CalEvent[], monthKeys: Iterable<string>): CalEvent[] {
  const byId = new Map<string, CalEvent>();
  for (const key of monthKeys) {
    const [year, month] = key.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
    for (const event of events) {
      for (const occurrence of expandEventForMonth(event, year, month)) byId.set(occurrence.id, occurrence);
    }
  }
  return [...byId.values()];
}

function monthKeyAtOffset(today: Date, offset: number): string {
  const value = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function nearestOccurrence(occurrences: CalEvent[], todayKey: string): CalEvent | null {
  const ongoing = occurrences
    .filter(event => eventCoversDate(event, todayKey))
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
  if (ongoing) return ongoing;
  const future = occurrences
    .filter(event => event.startDate > todayKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
  if (future) return future;
  return occurrences
    .filter(event => eventEffectiveEndDate(event) < todayKey)
    .sort((left, right) => eventEffectiveEndDate(right).localeCompare(eventEffectiveEndDate(left)))[0] ?? null;
}

/** Materialize one nearest occurrence per recurring series for global search. */
export function materializeEventsForSearch(events: CalEvent[], today = new Date()): CalEvent[] {
  const todayKey = formatDate(today);
  const monthKeys = Array.from({ length: 14 }, (_, index) => monthKeyAtOffset(today, index - 1));
  return events.map(event => {
    if (!event.repeat || event.repeat === 'once' || event.isExpandedOccurrence) return event;
    return nearestOccurrence(expandEventsForMonths([event], monthKeys), todayKey) ?? event;
  });
}
