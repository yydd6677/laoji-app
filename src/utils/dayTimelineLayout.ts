import type { CalEvent } from '../types';
import { timeToMinutes } from './calendarDate';
import { eventDisplaysAsAllDay } from './eventAllDay';

const DAY_MINUTES = 24 * 60;

export type TimelineEvent = {
  event: CalEvent;
  start: number;
  end: number;
  column: number;
  columns: number;
  columnSpan: number;
  zIndex: number;
};

type TimelineCandidate = TimelineEvent & { stableKey: string };

export function layoutTimelineEvents(events: CalEvent[], selectedDate: string): TimelineEvent[] {
  const source: TimelineCandidate[] = events
    .filter(event => (
      !eventDisplaysAsAllDay(event)
      && Boolean(event.startTime)
      && Boolean(event.endTime)
    ))
    .map(event => {
      const range = eventRangeForDate(event, selectedDate);
      return range ? {
        event,
        ...range,
        column: 0,
        columns: 1,
        columnSpan: 1,
        zIndex: 1,
        stableKey: stableTimelineKey(event),
      } : null;
    })
    .filter((item): item is TimelineCandidate => item !== null)
    .sort(compareCandidates);

  splitOverlapGroups(source).forEach(group => layoutOverlapGroup(group));
  return source.map(({ stableKey: _stableKey, ...item }) => item);
}

function splitOverlapGroups(source: TimelineCandidate[]): TimelineCandidate[][] {
  const groups: TimelineCandidate[][] = [];
  let group: TimelineCandidate[] = [];
  let groupEnd = -1;
  source.forEach(item => {
    if (group.length > 0 && item.start >= groupEnd) {
      groups.push(group);
      group = [];
      groupEnd = -1;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  });
  if (group.length > 0) groups.push(group);
  return groups;
}

function layoutOverlapGroup(group: TimelineCandidate[]): void {
  const columnEnds: number[] = [];
  const columnItems: TimelineCandidate[][] = [];

  group.forEach((item, order) => {
    let column = columnEnds.findIndex(end => end <= item.start);
    if (column < 0) column = columnEnds.length;
    columnEnds[column] = item.end;
    if (!columnItems[column]) columnItems[column] = [];
    columnItems[column].push(item);
    item.column = column;
    item.zIndex = order + 1;
  });

  const columns = Math.max(1, columnEnds.length);
  group.forEach(item => {
    item.columns = columns;
    let span = 1;
    for (let column = item.column + 1; column < columns; column += 1) {
      const occupied = (columnItems[column] ?? []).some(other => intervalsOverlap(item, other));
      if (occupied) break;
      span += 1;
    }
    item.columnSpan = span;
  });
}

function intervalsOverlap(
  left: Pick<TimelineEvent, 'start' | 'end'>,
  right: Pick<TimelineEvent, 'start' | 'end'>,
): boolean {
  return left.start < right.end && right.start < left.end;
}

function compareCandidates(left: TimelineCandidate, right: TimelineCandidate): number {
  return left.start - right.start
    || right.end - left.end
    || left.stableKey.localeCompare(right.stableKey);
}

function stableTimelineKey(event: CalEvent): string {
  return [
    event.sourceEventId ?? event.id,
    event.occurrenceDate ?? event.startDate,
    event.id,
    event.title,
  ].join(':');
}

function eventRangeForDate(event: CalEvent, selectedDate: string): { start: number; end: number } | null {
  const startTime = timeToMinutes(event.startTime);
  if (startTime === null) return null;
  const spansDays = Boolean(event.endDate && event.endDate !== event.startDate);
  let start = selectedDate === event.startDate ? startTime : 0;
  let end = timeToMinutes(event.endTime);

  if (spansDays) {
    if (selectedDate < event.startDate || selectedDate > (event.endDate ?? event.startDate)) return null;
    if (selectedDate !== event.endDate) end = DAY_MINUTES;
    else {
      end = end ?? DAY_MINUTES;
      if (end === 0 && selectedDate !== event.startDate) return null;
    }
  } else {
    if (selectedDate !== event.startDate) return null;
    if (end === null || end <= start) end = Math.min(DAY_MINUTES, start + 60);
  }

  start = Math.max(0, Math.min(DAY_MINUTES - 1, start));
  end = Math.max(start + 15, Math.min(DAY_MINUTES, end));
  return { start, end };
}
