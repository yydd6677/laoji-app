import { CalEvent } from '../types';

const TIME_MAX = Number.MAX_SAFE_INTEGER;

export function selectTasksForDate(events: CalEvent[], date: string): CalEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => eventCoversDate(event, date))
    .sort((left, right) => compareTaskEntries(left, right))
    .map(({ event }) => event);
}

function eventCoversDate(event: CalEvent, date: string): boolean {
  if (event.endDate && event.endDate >= event.startDate) {
    return event.startDate <= date && date <= event.endDate;
  }
  return event.startDate === date;
}

function compareTaskEntries(
  left: { event: CalEvent; index: number },
  right: { event: CalEvent; index: number },
): number {
  return timeToMinutes(left.event.startTime) - timeToMinutes(right.event.startTime)
    || timeToMinutes(left.event.endTime) - timeToMinutes(right.event.endTime)
    || left.event.title.localeCompare(right.event.title, 'zh-Hans-CN')
    || left.index - right.index;
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
