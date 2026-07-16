import { CalEvent } from '../types';
import { eventCoversDate, eventEffectiveEndDate } from './eventDateSemantics';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIME_MAX = Number.MAX_SAFE_INTEGER;

type SortKey = {
  bucket: number;
  distance: number;
};

export function sortEventsForSearch(events: CalEvent[], today = new Date()): CalEvent[] {
  const todayDate = startOfLocalDay(today);
  return events
    .map((event, index) => ({ event, index, key: relativeDateKey(event, todayDate) }))
    .sort((left, right) =>
      left.key.bucket - right.key.bucket
      || left.key.distance - right.key.distance
      || compareEventTime(left.event, right.event)
      || left.event.title.localeCompare(right.event.title, 'zh-Hans-CN')
      || left.index - right.index
    )
    .map(({ event }) => event);
}

function relativeDateKey(event: CalEvent, todayDate: Date): SortKey {
  const start = parseLocalDate(event.startDate);
  if (!start) return { bucket: 3, distance: TIME_MAX };

  const todayKey = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;
  const end = event.endDate ? parseLocalDate(eventEffectiveEndDate(event)) : null;
  if (end) {
    const rangeEnd = end.getTime() < start.getTime() ? start : end;
    if (eventCoversDate(event, todayKey)) {
      return { bucket: 0, distance: 0 };
    }
    if (start.getTime() > todayDate.getTime()) {
      return { bucket: 1, distance: dayDistance(start, todayDate) };
    }
    return { bucket: 2, distance: dayDistance(rangeEnd, todayDate) };
  }

  const diff = Math.round((start.getTime() - todayDate.getTime()) / MS_PER_DAY);
  if (diff === 0) return { bucket: 0, distance: 0 };
  if (diff > 0) return { bucket: 1, distance: diff };
  return { bucket: 2, distance: Math.abs(diff) };
}

function compareEventTime(left: CalEvent, right: CalEvent): number {
  return timeToMinutes(left.startTime) - timeToMinutes(right.startTime)
    || timeToMinutes(left.endTime) - timeToMinutes(right.endTime);
}

function timeToMinutes(time?: string): number {
  if (!time) return TIME_MAX;
  const match = /^(\d{1,2})[:：](\d{2})$/.exec(time.trim());
  if (!match) return TIME_MAX;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return TIME_MAX;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return TIME_MAX;
  return hour * 60 + minute;
}

function parseLocalDate(value?: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return startOfLocalDay(date);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayDistance(left: Date, right: Date): number {
  return Math.abs(Math.round((left.getTime() - right.getTime()) / MS_PER_DAY));
}
