import type { CalEvent } from '../types';
import { timeToMinutes } from './calendarDate';
import { eventEffectiveEndDate } from './eventDateSemantics';
import { eventDisplaysAsAllDay } from './eventAllDay';

const DAY_MS = 24 * 60 * 60 * 1000;

export type MonthEventSegment = {
  event: CalEvent;
  key: string;
  column: number;
  span: number;
  slot: number;
  visible: boolean;
};

export type MonthWeekLayout = {
  segments: MonthEventSegment[];
  eventCounts: number[];
  hiddenCounts: number[];
  capacity: number;
};

type NormalizedEvent = {
  event: CalEvent;
  key: string;
  startDay: number;
  endDay: number;
  allDay: boolean;
  startMinute: number;
  endMinute: number;
  sourceIndex: number;
};

export function layoutMonthWeekEvents(
  events: CalEvent[],
  weekDateKeys: string[],
  capacity: number,
): MonthWeekLayout {
  if (weekDateKeys.length !== 7) {
    throw new Error('Month week layout requires exactly seven dates');
  }

  const weekStart = utcDay(weekDateKeys[0]);
  const weekEnd = utcDay(weekDateKeys[6]);
  const normalized = events
    .map(normalizeEvent)
    .filter((item): item is NormalizedEvent => item !== null)
    .filter(item => item.startDay <= weekEnd && item.endDay >= weekStart)
    .sort(compareMonthEvents);

  const occupancy: boolean[][] = [];
  const segments = normalized.map(item => {
    const firstDay = Math.max(item.startDay, weekStart);
    const lastDay = Math.min(item.endDay, weekEnd);
    const column = firstDay - weekStart;
    const span = lastDay - firstDay + 1;
    let slot = 0;
    while (occupancy[slot]?.slice(column, column + span).some(Boolean)) slot += 1;
    if (!occupancy[slot]) occupancy[slot] = Array(7).fill(false);
    for (let day = column; day < column + span; day += 1) occupancy[slot][day] = true;
    return {
      event: item.event,
      key: item.key,
      column,
      span,
      slot,
      visible: slot < capacity,
    };
  });

  const eventCounts = Array.from({ length: 7 }, (_, column) => segments.filter(segment => (
    segment.column <= column && column < segment.column + segment.span
  )).length);
  const hiddenCounts = Array.from({ length: 7 }, (_, column) => segments.filter(segment => (
    !segment.visible && segment.column <= column && column < segment.column + segment.span
  )).length);

  return { segments, eventCounts, hiddenCounts, capacity };
}

function normalizeEvent(event: CalEvent, sourceIndex: number): NormalizedEvent | null {
  const startDay = safeUtcDay(event.startDate);
  if (startDay === null) return null;
  const parsedEnd = safeUtcDay(eventEffectiveEndDate(event));
  const endDay = Math.max(startDay, parsedEnd ?? startDay);
  const startMinute = timeToMinutes(event.startTime) ?? Number.MAX_SAFE_INTEGER;
  const endMinute = timeToMinutes(event.endTime) ?? Number.MAX_SAFE_INTEGER;
  return {
    event,
    key: monthEventKey(event, sourceIndex),
    startDay,
    endDay,
    allDay: eventDisplaysAsAllDay(event),
    startMinute,
    endMinute,
    sourceIndex,
  };
}

function compareMonthEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  return left.startDay - right.startDay
    || right.endDay - left.endDay
    || Number(right.allDay) - Number(left.allDay)
    || left.startMinute - right.startMinute
    || right.endMinute - left.endMinute
    || left.event.title.localeCompare(right.event.title, 'zh-Hans-CN')
    || left.key.localeCompare(right.key)
    || left.sourceIndex - right.sourceIndex;
}

function monthEventKey(event: CalEvent, sourceIndex: number): string {
  return [
    event.id,
    event.occurrenceId,
    event.startDate,
    event.endDate ?? event.startDate,
    sourceIndex,
  ].filter(value => value !== undefined).join(':');
}

function utcDay(value: string): number {
  const parsed = safeUtcDay(value);
  if (parsed === null) throw new Error(`Invalid calendar date: ${value}`);
  return parsed;
}

function safeUtcDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return Math.floor(timestamp / DAY_MS);
}
