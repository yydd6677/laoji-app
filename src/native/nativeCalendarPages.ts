import type {
  NativeCalendarDetailSnapshot,
  NativeCalendarEditDraftSnapshot,
  NativeCalendarEditSnapshot,
  NativeCalendarSearchSnapshot,
} from 'laoji-native-platform';
import type { CalEvent } from '../types';
import { dateFromKey, formatMonthTitle } from '../utils/calendarDate';
import { sortEventsForSearch } from '../utils/eventOrdering';
import {
  materializeEventOccurrencesCoveringDate,
  materializeEventsForSearch,
} from '../utils/eventRecurrence';
import { isValidEventDate } from '../utils/eventDraftValidation';
import { eventRefForEvent, eventRefKey } from '../utils/eventIdentity';
import { labelForReminder } from '../services/notifications';

// CAL-SEARCH-001 / CAL-DETAIL-001 / CAL-EDIT-001: pure builders keep native pages deterministic.
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function searchableValues(event: CalEvent): string[] {
  const date = dateFromKey(event.startDate);
  const endDate = event.endDate ? dateFromKey(event.endDate) : null;
  return [
    event.title,
    event.startDate,
    event.endDate,
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    `${date.getMonth() + 1}月${date.getDate()}日`,
    endDate ? `${endDate.getMonth() + 1}月${endDate.getDate()}日` : '',
    event.startTime,
    event.endTime,
    event.location,
    event.description,
    event.detail,
    event.rawText,
    event.category,
  ].filter((value): value is string => Boolean(value));
}

function validDateKey(year: number, month: number, day: number): string | null {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidEventDate(value) ? value : null;
}

function requestedDateKeys(query: string, today: Date): string[] {
  const values = new Set<string>();
  const full = /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g;
  for (const match of query.matchAll(full)) {
    const key = validDateKey(Number(match[1]), Number(match[2]), Number(match[3]));
    if (key) values.add(key);
  }
  if (values.size === 0) {
    const monthDay = /(^|\D)(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
    for (const match of query.matchAll(monthDay)) {
      const key = validDateKey(today.getFullYear(), Number(match[2]), Number(match[3]));
      if (key) values.add(key);
    }
  }
  return [...values];
}

function withoutDateTokens(query: string): string {
  return query
    .replace(/\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/g, ' ');
}

function searchMatches(events: readonly CalEvent[], query: string, today: Date): CalEvent[] {
  const dates = requestedDateKeys(query, today);
  if (dates.length === 0) {
    const normalized = query.trim().toLocaleLowerCase();
    return sortEventsForSearch(
      materializeEventsForSearch(
        events.filter(event => searchableValues(event)
          .some(value => value.toLocaleLowerCase().includes(normalized))),
        today,
      ),
      today,
    );
  }

  const textQuery = withoutDateTokens(query).trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const projected: CalEvent[] = [];
  dates.forEach(groupDate => {
    events.forEach(event => {
      materializeEventOccurrencesCoveringDate(event, groupDate).forEach(occurrence => {
        const key = `${groupDate}:${eventRefKey(eventRefForEvent(occurrence))}`;
        if (seen.has(key)) return;
        if (textQuery && !searchableValues(occurrence)
          .some(value => value.toLocaleLowerCase().includes(textQuery))) return;
        seen.add(key);
        projected.push({ ...occurrence, startDate: groupDate, endDate: undefined, spanning: false });
      });
    });
  });
  return sortEventsForSearch(projected, today);
}

function eventTimeLabel(event: CalEvent): string {
  if (event.isAllDay) return '全天';
  if (!event.startTime && !event.endTime) return '无具体时间';
  if (event.startTime && event.endTime) return `${event.startTime} - ${event.endTime}`;
  return event.startTime ?? event.endTime ?? '';
}

export function buildNativeCalendarSearchSnapshot(
  events: readonly CalEvent[],
  query: string,
  today = new Date(),
): NativeCalendarSearchSnapshot {
  const normalized = query.trim();
  if (!normalized) {
    return { schemaVersion: 1, query, state: 'empty', message: '', results: [] };
  }
  const matches = searchMatches(events, query, today);
  const previousDate = new Map<number, string>();
  const results = matches.map((event, index) => {
    const date = dateFromKey(event.startDate);
    const ref = eventRefForEvent(event);
    const prior = index > 0 ? matches[index - 1]?.startDate : undefined;
    previousDate.set(index, event.startDate);
    return {
      ...ref,
      title: event.title,
      dateLabel: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
      timeLabel: eventTimeLabel(event),
      monthLabel: formatMonthTitle(date),
      dayLabel: String(date.getDate()),
      weekdayLabel: WEEKDAYS[date.getDay()],
      showDate: prior !== event.startDate,
    };
  });
  return {
    schemaVersion: 1,
    query,
    state: results.length > 0 ? 'ready' : 'empty',
    message: results.length > 0 ? '' : '无相关结果',
    results,
  };
}

function conciseDate(value: string): string {
  const date = dateFromKey(value);
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

export function nativeCalendarDetailTimeLabel(event: CalEvent): string {
  const start = conciseDate(event.startDate);
  const end = event.endDate && event.endDate !== event.startDate ? conciseDate(event.endDate) : undefined;
  if (event.isAllDay || (!event.startTime && !event.endTime)) return end ? `${start} - ${end}` : start;
  const startWithTime = event.startTime ? `${start} ${event.startTime}` : start;
  if (end) return `${startWithTime} - ${end}${event.endTime ? ` ${event.endTime}` : ''}`;
  return event.endTime ? `${startWithTime} - ${event.endTime}` : startWithTime;
}

export function buildNativeCalendarDetailSnapshot(
  event: CalEvent | undefined,
  deleting = false,
): NativeCalendarDetailSnapshot {
  if (!event) {
    return { schemaVersion: 1, state: 'error', message: '日程不存在，请返回日历后重新打开。' };
  }
  const repeatLabels: Record<string, string> = {
    daily: '每天重复',
    weekly: '每周重复',
    monthly: '每月重复',
    yearly: '每年重复',
  };
  return {
    schemaVersion: 1,
    state: 'ready',
    deleting,
    event: {
      ...eventRefForEvent(event),
      title: event.title,
      timeLabel: nativeCalendarDetailTimeLabel(event),
      repeatLabel: event.repeat && event.repeat !== 'once' ? repeatLabels[event.repeat] : undefined,
      location: event.location,
      notes: event.description ?? event.detail,
      reminderLabel: event.reminderMinutes == null ? undefined : labelForReminder(event.reminderMinutes),
      recurring: Boolean(event.repeat && event.repeat !== 'once'),
      recurrenceException: Boolean(event.isRecurrenceException),
      editable: true,
    },
  };
}

export function nativeCalendarEditDraft(event: Partial<CalEvent> & Pick<CalEvent, 'startDate'>): NativeCalendarEditDraftSnapshot {
  const allDay = Boolean(event.isAllDay);
  return {
    title: event.title ?? '',
    startDate: event.startDate,
    endDate: event.endDate ?? event.startDate,
    startTime: allDay ? null : event.startTime ?? null,
    endTime: allDay ? null : event.endTime ?? null,
    isAllDay: allDay,
    repeat: event.repeat ?? 'once',
    reminderMinutes: allDay ? null : event.reminderMinutes ?? null,
    location: event.location ?? '',
    notes: event.description ?? event.detail ?? '',
  };
}

export function buildNativeCalendarEditSnapshot(input: {
  draft: NativeCalendarEditDraftSnapshot;
  editing: boolean;
  recurring?: boolean;
  recurrenceException?: boolean;
  saving?: boolean;
  dirty?: boolean;
  state?: NativeCalendarEditSnapshot['state'];
  message?: string;
}): NativeCalendarEditSnapshot {
  return {
    schemaVersion: 1,
    state: input.state ?? 'ready',
    message: input.message,
    draft: input.draft,
    editing: input.editing,
    recurring: Boolean(input.recurring),
    recurrenceException: Boolean(input.recurrenceException),
    saving: Boolean(input.saving),
    dirty: Boolean(input.dirty),
  };
}
