import type { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import { materializeEventOccurrence } from '../utils/eventRecurrence';
import { sourceEventId } from '../utils/eventIdentity';

function dateAtMidnight(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(value: string | undefined, days: number): string | undefined {
  if (!value) return undefined;
  const date = dateAtMidnight(value);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateDeltaDays(from: string, through: string): number {
  return Math.round((dateAtMidnight(through).getTime() - dateAtMidnight(from).getTime()) / 86_400_000);
}

function sourceEntries(events: CalEvent[], ref: EventRef): CalEvent[] {
  return events.filter(event => sourceEventId(event) === ref.sourceEventId);
}

function entryContainsAnchor(event: CalEvent, ref: EventRef): boolean {
  return !event.isRecurrenceException && Boolean(materializeEventOccurrence(event, ref.occurrenceDate));
}

function recurrenceException(
  target: CalEvent,
  ref: EventRef,
  validated: Omit<CalEvent, 'id'>,
): CalEvent {
  return {
    ...target,
    ...validated,
    id: `${ref.sourceEventId}@${ref.occurrenceDate}:exception`,
    sourceEventId: ref.sourceEventId,
    occurrenceDate: ref.occurrenceDate,
    occurrenceId: undefined,
    isExpandedOccurrence: false,
    isRecurrenceException: true,
    notificationId: null,
  };
}

export function applyGuestRecurrenceEdit({
  events,
  target,
  ref,
  scope,
  validated,
  segmentId,
}: {
  events: CalEvent[];
  target: CalEvent;
  ref: EventRef;
  scope: EventRecurrenceScope;
  validated: Omit<CalEvent, 'id'>;
  segmentId: string;
}): CalEvent[] {
  const entries = sourceEntries(events, ref);
  if (entries.length === 0) throw new Error('event series not found');
  const unrelated = events.filter(event => sourceEventId(event) !== ref.sourceEventId);
  const recurring = target.repeat && target.repeat !== 'once';

  if (!recurring || scope === 'series') {
    const root = entries.find(event => !event.isRecurrenceException && event.recurrenceSegmentId == null)
      ?? entries.find(event => !event.isRecurrenceException)
      ?? target;
    const deltaDays = dateDeltaDays(target.startDate, validated.startDate);
    const startDate = shiftDate(root.startDate, deltaDays) ?? validated.startDate;
    const endDate = shiftDate(root.endDate, deltaDays);
    const updated: CalEvent = {
      ...root,
      ...validated,
      id: root.id,
      sourceEventId: ref.sourceEventId,
      occurrenceDate: startDate,
      occurrenceId: undefined,
      isExpandedOccurrence: false,
      isRecurrenceException: false,
      recurrenceSegmentId: undefined,
      recurrenceEffectiveFromDate: startDate,
      seriesStartDate: startDate,
      seriesEndDate: endDate,
      startDate,
      endDate,
      spanning: Boolean(endDate && endDate !== startDate),
      excludedOccurrenceDates: undefined,
      excludedAfterDate: undefined,
      notificationId: null,
    };
    return [...unrelated, updated];
  }

  const exception = recurrenceException(target, ref, validated);
  if (scope === 'occurrence') {
    const nextEntries = entries
      .filter(event => !(
        event.isRecurrenceException
        && (event.occurrenceDate ?? event.startDate) === ref.occurrenceDate
      ))
      .map(event => entryContainsAnchor(event, ref)
        ? {
          ...event,
          excludedOccurrenceDates: [...new Set([
            ...(event.excludedOccurrenceDates ?? []),
            ref.occurrenceDate,
          ])].sort(),
        }
        : event);
    return [...unrelated, ...nextEntries, exception];
  }

  const retainedEntries = entries
    .filter(event => {
      if (event.isRecurrenceException) {
        return (event.occurrenceDate ?? event.startDate) < ref.occurrenceDate;
      }
      if (event.recurrenceSegmentId == null) return true;
      return (event.seriesStartDate ?? event.startDate) < ref.occurrenceDate;
    })
    .map(event => entryContainsAnchor(event, ref)
      ? { ...event, excludedAfterDate: ref.occurrenceDate }
      : event);

  if (!validated.repeat || validated.repeat === 'once') {
    return [...unrelated, ...retainedEntries, { ...exception, repeat: 'once' }];
  }
  const segment: CalEvent = {
    ...target,
    ...validated,
    id: `${ref.sourceEventId}:segment:${segmentId}`,
    sourceEventId: ref.sourceEventId,
    occurrenceDate: validated.startDate,
    occurrenceId: undefined,
    isExpandedOccurrence: false,
    isRecurrenceException: false,
    recurrenceSegmentId: segmentId,
    recurrenceEffectiveFromDate: validated.startDate,
    seriesStartDate: validated.startDate,
    seriesEndDate: validated.endDate,
    excludedOccurrenceDates: [validated.startDate],
    excludedAfterDate: undefined,
    notificationId: null,
  };
  return [...unrelated, ...retainedEntries, exception, segment];
}
