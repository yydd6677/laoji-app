import { CalEvent } from '../types';
import { sourceEventId } from '../services/eventMapper';

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function overlapsMonth(event: CalEvent, monthStart: string, monthEnd: string): boolean {
  return event.startDate <= monthEnd && (event.endDate ?? event.startDate) >= monthStart;
}

function eventDurationDays(base: CalEvent): number {
  const sourceStart = parseDate(base.seriesStartDate ?? base.startDate);
  const sourceEnd = parseDate(base.seriesEndDate ?? base.endDate ?? base.startDate);
  return sourceStart && sourceEnd
    ? Math.max(0, Math.round((sourceEnd.getTime() - sourceStart.getTime()) / 86_400_000))
    : 0;
}

function occurrenceFromBase(base: CalEvent, date: Date): CalEvent {
  const occurrenceDate = formatDate(date);
  const sourceId = sourceEventId(base);
  const durationDays = eventDurationDays(base);
  const end = new Date(date);
  end.setDate(end.getDate() + durationDays);
  const occurrenceEnd = durationDays > 0 ? formatDate(end) : undefined;
  return {
    ...base,
    id: `${sourceId}@${occurrenceDate}`,
    sourceEventId: sourceId,
    occurrenceId: `${sourceId}@${occurrenceDate}`,
    isExpandedOccurrence: true,
    seriesStartDate: base.seriesStartDate ?? base.startDate,
    seriesEndDate: base.seriesEndDate ?? base.endDate,
    startDate: occurrenceDate,
    endDate: occurrenceEnd,
    spanning: durationDays > 0,
    notificationId: null,
  };
}

export function expandEventForMonth(base: CalEvent, year: number, month: number): CalEvent[] {
  const monthStartDate = new Date(year, month - 1, 1);
  const monthEndDate = new Date(year, month, 0);
  const monthStart = formatDate(monthStartDate);
  const monthEnd = formatDate(monthEndDate);

  if (!base.repeat || base.repeat === 'once' || base.isExpandedOccurrence) {
    return overlapsMonth(base, monthStart, monthEnd) ? [base] : [];
  }

  const seriesStart = parseDate(base.seriesStartDate ?? base.startDate);
  if (!seriesStart) return [];
  const first = new Date(monthStartDate);
  first.setDate(first.getDate() - eventDurationDays(base));
  const results: CalEvent[] = [];

  for (let cursor = first; cursor <= monthEndDate; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    if (cursor < seriesStart) continue;
    const sameWeekday = cursor.getDay() === seriesStart.getDay();
    const sameDay = cursor.getDate() === seriesStart.getDate();
    const sameMonthAndDay = cursor.getMonth() === seriesStart.getMonth() && sameDay;
    const matches = base.repeat === 'daily'
      || (base.repeat === 'weekly' && sameWeekday)
      || (base.repeat === 'monthly' && sameDay)
      || (base.repeat === 'yearly' && sameMonthAndDay);
    if (matches) {
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
    .filter(event => event.startDate <= todayKey && (event.endDate ?? event.startDate) >= todayKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
  if (ongoing) return ongoing;
  const future = occurrences
    .filter(event => event.startDate > todayKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
  if (future) return future;
  return occurrences
    .filter(event => (event.endDate ?? event.startDate) < todayKey)
    .sort((left, right) => (right.endDate ?? right.startDate).localeCompare(left.endDate ?? left.startDate))[0] ?? null;
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
