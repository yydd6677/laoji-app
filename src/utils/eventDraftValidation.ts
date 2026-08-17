import type { CalEvent } from '../types';

export type EventDraftValidationCode =
  | 'invalid-start-date'
  | 'invalid-end-date'
  | 'end-before-start'
  | 'end-without-start'
  | 'invalid-start-time'
  | 'invalid-end-time'
  | 'end-not-after-start'
  | 'invalid-repeat'
  | 'invalid-recurrence-until-date'
  | 'recurrence-until-before-start'
  | 'all-day-has-time'
  | 'all-day-reminder-unsupported'
  | 'untimed-reminder-unsupported'
  | 'invalid-reminder';

export interface EventDraftValidationIssue {
  code: EventDraftValidationCode;
  message: string;
}

export interface EventDraftValidationResult<T extends EventDraftForValidation = EventDraftForValidation> {
  valid: boolean;
  issues: EventDraftValidationIssue[];
  value: T | null;
}

export type EventDraftForValidation = Pick<
  Omit<CalEvent, 'id'>,
  | 'title'
  | 'startDate'
  | 'endDate'
  | 'startTime'
  | 'endTime'
  | 'isAllDay'
  | 'repeat'
  | 'recurrenceUntilDate'
  | 'reminderMinutes'
  | 'spanning'
>;

export class EventDraftValidationError extends Error {
  constructor(public readonly issues: EventDraftValidationIssue[]) {
    super(issues[0]?.message ?? '日程数据不正确');
    this.name = 'EventDraftValidationError';
  }
}

const REPEAT_VALUES = new Set<CalEvent['repeat']>([
  undefined,
  'once',
  'daily',
  'weekly',
  'monthly',
  'yearly',
]);

export const EVENT_DATE_MIN_YEAR = 1900;
export const EVENT_DATE_MAX_YEAR = 2100;

export function isValidEventDate(value: string | undefined): value is string {
  if (!value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < EVENT_DATE_MIN_YEAR || year > EVENT_DATE_MAX_YEAR) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function isValidEventTime(value: string | undefined): value is string {
  if (!value) return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function eventDateTimeValue(date: string, time: string): number | null {
  if (!isValidEventDate(date) || !isValidEventTime(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// CAL-EDIT-001 / CAL-REPEAT-RRULE-001: one shared validator owns native and JS save boundaries.
export function validateEventDraft<T extends EventDraftForValidation>(draft: T): EventDraftValidationResult<T> {
  const issues: EventDraftValidationIssue[] = [];
  const add = (code: EventDraftValidationCode, message: string) => issues.push({ code, message });

  if (!isValidEventDate(draft.startDate)) add('invalid-start-date', '请选择有效的开始日期');
  if (draft.endDate && !isValidEventDate(draft.endDate)) add('invalid-end-date', '请选择有效的结束日期');
  if (isValidEventDate(draft.startDate) && draft.endDate && isValidEventDate(draft.endDate)
    && draft.endDate < draft.startDate) {
    add('end-before-start', '结束日期不能早于开始日期');
  }

  if (draft.isAllDay) {
    if (draft.startTime || draft.endTime) add('all-day-has-time', '全天日程不能同时设置具体时间');
    if (draft.reminderMinutes != null) {
      add('all-day-reminder-unsupported', '当前版本暂不支持全天日程提醒');
    }
  } else {
    const hasStart = Boolean(draft.startTime);
    const hasEnd = Boolean(draft.endTime);
    if (hasEnd && !hasStart) {
      add('end-without-start', '请先填写开始时间');
    }
    if (hasStart) {
      if (!isValidEventTime(draft.startTime)) add('invalid-start-time', '开始时间格式不正确');
    }
    if (hasEnd) {
      if (!isValidEventTime(draft.endTime)) add('invalid-end-time', '结束时间格式不正确');
    }
    if (hasStart && hasEnd) {
      const endDate = draft.endDate ?? draft.startDate;
      const startValue = eventDateTimeValue(draft.startDate, draft.startTime!);
      const endValue = eventDateTimeValue(endDate, draft.endTime!);
      if (startValue != null && endValue != null && endValue <= startValue) {
        add('end-not-after-start', '结束时间需要晚于开始时间；跨午夜请将结束日期设为次日');
      }
    }
    if (!hasStart && !hasEnd && draft.reminderMinutes != null) {
      add('untimed-reminder-unsupported', '没有具体时间的日程不能设置提前提醒');
    }
  }

  if (!REPEAT_VALUES.has(draft.repeat)) add('invalid-repeat', '重复规则不受支持');
  if (draft.recurrenceUntilDate && !isValidEventDate(draft.recurrenceUntilDate)) {
    add('invalid-recurrence-until-date', '请选择有效的截止时间');
  }
  if (draft.repeat && draft.repeat !== 'once'
    && isValidEventDate(draft.startDate)
    && isValidEventDate(draft.recurrenceUntilDate)
    && draft.recurrenceUntilDate < draft.startDate) {
    add('recurrence-until-before-start', '截止日期需晚于开始日期');
  }
  if (draft.reminderMinutes != null && (
    !Number.isSafeInteger(draft.reminderMinutes) || draft.reminderMinutes < 0
  )) {
    add('invalid-reminder', '提醒时间必须是非负整数分钟');
  }

  const endDate = draft.endDate && draft.endDate !== draft.startDate ? draft.endDate : undefined;
  const value = issues.length === 0 ? {
    ...draft,
    title: draft.title.trim(),
    endDate,
    isAllDay: draft.isAllDay ?? false,
    repeat: draft.repeat ?? 'once',
    recurrenceUntilDate: draft.repeat && draft.repeat !== 'once'
      ? draft.recurrenceUntilDate
      : undefined,
    reminderMinutes: draft.reminderMinutes ?? null,
    spanning: Boolean(endDate),
  } as T : null;
  return { valid: issues.length === 0, issues, value };
}
