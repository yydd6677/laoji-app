import type {
  UpcomingEventMeetingAction,
  UpcomingEventProjectionItem,
  UpcomingEventsProjection,
} from 'laoji-native-platform';
import { UPCOMING_EVENTS_PROJECTION_SCHEMA_VERSION } from 'laoji-native-platform';
import type { CalEvent, EventRef } from '../types';
import type { ScopeKey } from '../domain/meeting';
import { expandEventsForMonths } from '../utils/eventRecurrence';
import { eventRefForEvent, eventRefKey, sourceEventId } from '../utils/eventIdentity';

const DAY_MS = 86_400_000;
const DEFAULT_TIMED_DURATION_MS = 60 * 60 * 1_000;
const TITLE_MAX_LENGTH = 256;

export type ResolveUpcomingEventMeetingAction = (
  ref: EventRef,
) => Promise<UpcomingEventMeetingAction>;

export interface BuildUpcomingEventsProjectionInput {
  scopeKey: ScopeKey;
  events: readonly CalEvent[];
  searchableEvents: readonly CalEvent[];
  hideTitles: boolean;
  resolveMeetingAction: ResolveUpcomingEventMeetingAction;
  nowMs?: number;
}

function localDateParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.getFullYear() === parts[0]
    && date.getMonth() === parts[1] - 1
    && date.getDate() === parts[2]
    ? parts
    : null;
}

function localTimestamp(dateKey: string, time: string | undefined): number | null {
  const date = localDateParts(dateKey);
  const match = /^(\d{2}):(\d{2})$/.exec(time ?? '00:00');
  if (!date || !match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return new Date(date[0], date[1] - 1, date[2], hour, minute, 0, 0).getTime();
}

function nextLocalMidnight(dateKey: string): number | null {
  const date = localDateParts(dateKey);
  return date
    ? new Date(date[0], date[1] - 1, date[2] + 1, 0, 0, 0, 0).getTime()
    : null;
}

function monthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function sourceCatalog(events: readonly CalEvent[]): CalEvent[] {
  const byIdentity = new Map<string, CalEvent>();
  for (const event of events) {
    const key = event.isExpandedOccurrence || event.isRecurrenceException
      ? `occurrence:${eventRefKey(eventRefForEvent(event))}`
      : `series:${sourceEventId(event)}:${String(event.recurrenceSegmentId ?? '')}:${event.startDate}`;
    const previous = byIdentity.get(key);
    if (!previous || event.isRecurrenceException) byIdentity.set(key, event);
  }
  return [...byIdentity.values()];
}

function occurrenceTimes(event: CalEvent): {
  startAtMs: number;
  endAtMs: number;
  allDay: boolean;
} | null {
  const allDay = Boolean(event.isAllDay || (!event.startTime && !event.endTime));
  const startAtMs = localTimestamp(event.startDate, allDay ? undefined : event.startTime);
  if (startAtMs === null) return null;
  const endDate = event.endDate ?? event.startDate;
  let endAtMs = allDay
    ? nextLocalMidnight(endDate)
    : localTimestamp(endDate, event.endTime ?? event.startTime);
  if (endAtMs === null || endAtMs <= startAtMs) {
    endAtMs = allDay ? startAtMs + DAY_MS : startAtMs + DEFAULT_TIMED_DURATION_MS;
  }
  return { startAtMs, endAtMs, allDay };
}

function displayTitle(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return (clean || '(无主题)').slice(0, TITLE_MAX_LENGTH);
}

export async function buildUpcomingEventsProjection(
  input: BuildUpcomingEventsProjectionInput,
): Promise<UpcomingEventsProjection> {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('invalid projection time');
  const horizonMs = nowMs + DAY_MS;
  const monthKeys = new Set([
    monthKey(new Date(nowMs)),
    monthKey(new Date(horizonMs)),
  ]);
  const expanded = expandEventsForMonths(
    sourceCatalog([...input.searchableEvents, ...input.events]),
    monthKeys,
  );
  const candidates = new Map<string, { event: CalEvent; item: Omit<UpcomingEventProjectionItem, 'meetingAction'> }>();
  for (const event of expanded) {
    const times = occurrenceTimes(event);
    if (!times || times.endAtMs <= nowMs || times.startAtMs > horizonMs) continue;
    const ref = eventRefForEvent(event);
    const key = eventRefKey(ref);
    const item = {
      sourceEventId: ref.sourceEventId,
      occurrenceDate: ref.occurrenceDate,
      title: displayTitle(event.title ?? ''),
      ...times,
    };
    const previous = candidates.get(key);
    if (!previous || item.startAtMs < previous.item.startAtMs || event.isRecurrenceException) {
      candidates.set(key, { event, item });
    }
  }
  const selected = [...candidates.values()]
    .sort((left, right) => (
      left.item.startAtMs - right.item.startAtMs
      || left.item.endAtMs - right.item.endAtMs
      || left.item.sourceEventId.localeCompare(right.item.sourceEventId)
    ))
    .slice(0, 5);
  const events = await Promise.all(selected.map(async ({ item }) => ({
    ...item,
    meetingAction: await input.resolveMeetingAction({
      sourceEventId: item.sourceEventId,
      occurrenceDate: item.occurrenceDate,
    }),
  })));
  return {
    schemaVersion: UPCOMING_EVENTS_PROJECTION_SCHEMA_VERSION,
    scopeKey: input.scopeKey,
    updatedAtMs: nowMs,
    expiresAtMs: horizonMs,
    hideTitles: input.hideTitles,
    events,
  };
}
