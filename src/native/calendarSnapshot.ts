import type {
  NativeCalendarEventSnapshot,
  NativeCalendarMutationRequest,
  NativeCalendarRangeSnapshot,
  NativeCalendarSettings,
} from 'laoji-native-platform';
import type { CalEvent } from '../types';
import { timeToMinutes } from '../utils/calendarDate';
import { eventEffectiveEndDate, eventEndsAtExclusiveMidnight } from '../utils/eventDateSemantics';
import { eventRefForEvent } from '../utils/eventIdentity';
import { isValidEventDate } from '../utils/eventDraftValidation';
import { normalizeEventCategory } from '../utils/eventColors';

const DAY_MS = 86_400_000;

export function calendarDateFromEpochDay(epochDay: number): string {
  if (!Number.isInteger(epochDay)) throw new Error('Calendar epoch day must be an integer.');
  const value = new Date(epochDay * DAY_MS);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function calendarTimeFromMinutes(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    throw new Error('Calendar minutes must be between 0 and 1440.');
  }
  const canonical = minutes === 24 * 60 ? 0 : minutes;
  return `${String(Math.floor(canonical / 60)).padStart(2, '0')}:${String(canonical % 60).padStart(2, '0')}`;
}

export function localCalendarDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
    value.getDate(),
  ).padStart(2, '0')}`;
}

/** CAL-DAY-DRAG-001: convert a native semantic mutation back to repository fields. */
export function nativeCalendarMutationChanges(
  mutation: NativeCalendarMutationRequest,
): Pick<CalEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'> {
  if (mutation.startMinutes == null || mutation.endMinutes == null) {
    throw new Error('Timed calendar mutations require start and end minutes.');
  }
  return {
    startDate: calendarDateFromEpochDay(mutation.startEpochDay),
    endDate: calendarDateFromEpochDay(
      mutation.endEpochDay + (mutation.endMinutes === 24 * 60 ? 1 : 0),
    ),
    startTime: calendarTimeFromMinutes(mutation.startMinutes),
    endTime: calendarTimeFromMinutes(mutation.endMinutes),
  };
}

export function calendarEpochDay(value: string): number {
  if (!isValidEventDate(value)) throw new Error(`Invalid calendar date: ${value}`);
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function deviceTimeZoneId(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function nativeCalendarEventSnapshot(
  event: CalEvent,
  timeZoneId = deviceTimeZoneId(),
): NativeCalendarEventSnapshot {
  const ref = eventRefForEvent(event);
  const exclusiveMidnight = eventEndsAtExclusiveMidnight(event);
  const startMinutes = event.isAllDay ? null : timeToMinutes(event.startTime);
  const parsedEndMinutes = event.isAllDay ? null : timeToMinutes(event.endTime);
  const endEpochDay = calendarEpochDay(eventEffectiveEndDate(event));
  const allDay = event.isAllDay === true || startMinutes === null;
  return {
    sourceEventId: ref.sourceEventId,
    occurrenceDate: ref.occurrenceDate,
    title: event.title,
    category: normalizeEventCategory(event.category),
    startEpochDay: calendarEpochDay(event.startDate),
    endEpochDay,
    endEpochDayExclusive: allDay ? endEpochDay + 1 : null,
    startMinutes,
    endMinutes: exclusiveMidnight ? 24 * 60 : parsedEndMinutes,
    timeZoneId,
    allDay,
    editable: true,
    revision: Number.isInteger(event.revision) ? event.revision! : 0,
    // CAL-DAY-COMPOSE-001: preserve a server/source rectangle without recomputing it in JS.
    instanceLayout: event.instanceLayout ?? null,
  };
}

export function buildNativeCalendarRangeSnapshot({
  generation,
  rangeStart,
  rangeEndExclusive,
  selectedDate,
  today,
  events,
  settings = { defaultEventDurationMinutes: 30, firstDayOfWeek: 0 },
  timeZoneId = deviceTimeZoneId(),
}: {
  generation: number;
  rangeStart: string;
  rangeEndExclusive: string;
  selectedDate: string;
  today: string;
  events: CalEvent[];
  settings?: NativeCalendarSettings;
  timeZoneId?: string;
}): NativeCalendarRangeSnapshot {
  const rangeStartEpochDay = calendarEpochDay(rangeStart);
  const rangeEndEpochDayExclusive = calendarEpochDay(rangeEndExclusive);
  if (rangeEndEpochDayExclusive <= rangeStartEpochDay) {
    throw new Error('Native calendar range must be non-empty.');
  }
  return {
    schemaVersion: 1,
    generation,
    rangeStartEpochDay,
    rangeEndEpochDayExclusive,
    selectedEpochDay: calendarEpochDay(selectedDate),
    todayEpochDay: calendarEpochDay(today),
    settings,
    events: events.map(event => nativeCalendarEventSnapshot(event, timeZoneId)),
  };
}
