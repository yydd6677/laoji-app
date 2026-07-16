import { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import {
  eventDateTimeValue,
  isValidEventDate,
  type EventDraftForValidation,
} from './eventDraftValidation';
import { eventRefForEvent, sameEventRef, sourceEventId } from './eventIdentity';
import { eventDisplaysAsAllDay } from './eventAllDay';

/**
 * Returns true if two half-open time intervals [s1,e1) and [s2,e2) overlap.
 */
export function timesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return s1 < e2 && s2 < e1;
}

export type EventConflictKind = 'timed-overlap' | 'all-day-overlap' | 'all-day-timed';

export interface EventConflict {
  ref: EventRef;
  event: CalEvent;
  kind: EventConflictKind;
  severity: 'overlap' | 'soft';
}

export interface EventConflictResult {
  hasConflict: boolean;
  conflicts: EventConflict[];
}

function nextDate(date: string): string | null {
  if (!isValidEventDate(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(year, month - 1, day + 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function allDayRange(event: Pick<CalEvent, 'startDate' | 'endDate'>): [number, number] | null {
  const exclusiveEndDate = nextDate(event.endDate ?? event.startDate);
  const start = eventDateTimeValue(event.startDate, '00:00');
  const end = exclusiveEndDate ? eventDateTimeValue(exclusiveEndDate, '00:00') : null;
  return start != null && end != null ? [start, end] : null;
}

function timedRange(event: Pick<CalEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'>): [number, number] | null {
  if (!event.startTime || !event.endTime) return null;
  const start = eventDateTimeValue(event.startDate, event.startTime);
  const end = eventDateTimeValue(event.endDate ?? event.startDate, event.endTime);
  return start != null && end != null && end > start ? [start, end] : null;
}

function rangesOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

export function evaluateEventConflicts(
  events: CalEvent[],
  proposed: EventDraftForValidation,
  excludeRef?: EventRef,
  excludeScope: EventRecurrenceScope = 'series',
): EventConflictResult {
  const proposedAllDay = eventDisplaysAsAllDay(proposed);
  const proposedRange = proposedAllDay ? allDayRange(proposed) : timedRange(proposed);
  if (!proposedRange) return { hasConflict: false, conflicts: [] };

  const conflicts: EventConflict[] = [];
  for (const event of events) {
    if (excludeRef) {
      const eventRef = eventRefForEvent(event);
      const sameSource = sourceEventId(event) === excludeRef.sourceEventId;
      const excluded = excludeScope === 'series'
        ? sameSource
        : excludeScope === 'following'
          ? sameSource && eventRef.occurrenceDate >= excludeRef.occurrenceDate
          : sameEventRef(eventRef, excludeRef);
      if (excluded) continue;
    }
    const eventAllDay = eventDisplaysAsAllDay(event);
    const eventRange = eventAllDay ? allDayRange(event) : timedRange(event);
    if (!eventRange || !rangesOverlap(proposedRange, eventRange)) continue;
    const mixed = proposedAllDay !== eventAllDay;
    conflicts.push({
      ref: eventRefForEvent(event),
      event,
      kind: mixed ? 'all-day-timed' : proposedAllDay ? 'all-day-overlap' : 'timed-overlap',
      severity: mixed ? 'soft' : 'overlap',
    });
  }
  return { hasConflict: conflicts.length > 0, conflicts };
}

/** Checks overlap across complete date-time ranges. All-day and untimed items stay non-blocking. */
export function checkConflict(
  events: CalEvent[],
  startDate: string,
  startTime: string,
  endTime: string,
  excludeId?: string,
  endDate = startDate,
): { hasConflict: boolean; conflicts: CalEvent[] } {
  const conflicts = evaluateEventConflicts(events, {
    title: '',
    startDate,
    endDate,
    startTime,
    endTime,
    isAllDay: false,
    repeat: 'once',
  }).conflicts
    .map(conflict => conflict.event)
    .filter(event => excludeId == null || event.id !== excludeId);
  return { hasConflict: conflicts.length > 0, conflicts };
}
