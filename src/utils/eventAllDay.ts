import type { CalEvent } from '../types';

type EventTiming = Pick<CalEvent, 'isAllDay' | 'startTime' | 'endTime'>;

/** Date-only events share the all-day presentation lane; one-sided times are invalid. */
export function eventDisplaysAsAllDay(event: EventTiming): boolean {
  return event.isAllDay === true || (!event.startTime && !event.endTime);
}

export function sortAllDayEvents(
  candidates: CalEvent[],
  originalEvents: CalEvent[] = candidates,
): CalEvent[] {
  const originalIndexes = new Map<CalEvent, number>();
  originalEvents.forEach((event, index) => {
    if (!originalIndexes.has(event)) originalIndexes.set(event, index);
  });

  return candidates
    .map((event, candidateIndex) => ({
      event,
      originalIndex: originalIndexes.get(event) ?? originalEvents.length + candidateIndex,
    }))
    .sort((left, right) => (
      left.event.startDate.localeCompare(right.event.startDate)
      || (left.event.endDate ?? left.event.startDate)
        .localeCompare(right.event.endDate ?? right.event.startDate)
      || left.event.title.localeCompare(right.event.title, 'zh-Hans-CN')
      || left.originalIndex - right.originalIndex
    ))
    .map(({ event }) => event);
}
