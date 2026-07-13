import { CalEvent } from '../types';

/**
 * Returns true if two half-open time intervals [s1,e1) and [s2,e2) overlap.
 */
export function timesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return s1 < e2 && s2 < e1;
}

function dateTimeValue(date: string, time: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !timeMatch) return null;
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  ).getTime();
  return Number.isFinite(value) ? value : null;
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
  const proposedStart = dateTimeValue(startDate, startTime);
  const proposedEnd = dateTimeValue(endDate, endTime);
  if (proposedStart == null || proposedEnd == null || proposedEnd <= proposedStart) {
    return { hasConflict: false, conflicts: [] };
  }
  const candidates = events.filter(
    e =>
      e.isAllDay !== true &&
      e.startTime != null &&
      e.endTime != null &&
      (excludeId == null || e.id !== excludeId),
  );
  const conflicts = candidates.filter(e => {
    const existingStart = dateTimeValue(e.startDate, e.startTime!);
    const existingEnd = dateTimeValue(e.endDate ?? e.startDate, e.endTime!);
    return existingStart != null && existingEnd != null
      && proposedStart < existingEnd
      && existingStart < proposedEnd;
  });
  return { hasConflict: conflicts.length > 0, conflicts };
}
