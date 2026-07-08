import { CalEvent } from '../types';

/**
 * Returns true if two half-open time intervals [s1,e1) and [s2,e2) overlap.
 */
export function timesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return s1 < e2 && s2 < e1;
}

/**
 * Checks whether a proposed time slot conflicts with any existing event on the same date.
 * Ignores all-day events, spanning events, and events without explicit times.
 */
export function checkConflict(
  events: CalEvent[],
  date: string,
  startTime: string,
  endTime: string,
  excludeId?: string,
): { hasConflict: boolean; conflicts: CalEvent[] } {
  const candidates = events.filter(
    e =>
      e.startDate === date &&
      e.isAllDay !== true &&
      e.spanning !== true &&
      e.startTime != null &&
      e.endTime != null &&
      (excludeId == null || e.id !== excludeId),
  );
  const conflicts = candidates.filter(e =>
    timesOverlap(startTime, endTime, e.startTime!, e.endTime!),
  );
  return { hasConflict: conflicts.length > 0, conflicts };
}
