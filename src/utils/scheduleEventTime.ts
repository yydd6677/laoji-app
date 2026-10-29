import type { CalEvent } from '../types';
import {
  isScheduleTimeValue, scheduleTimeLabel, unspecifiedScheduleTime,
  type ScheduleTimeValue,
} from '../domain/scheduleTime';
import { scheduleTimePeriodFromText } from '../services/localScheduleParser';

export type EventTimeFields = Pick<CalEvent,
  'timePrecision' | 'timePeriod' | 'startTime' | 'endTime' | 'isAllDay' | 'rawText'>;

/** Explicit persisted precision always wins over the original dictation. */
export function scheduleTimeForEvent(event: EventTimeFields): ScheduleTimeValue {
  if (event.timePrecision !== undefined) {
    const time = {
      precision: event.timePrecision, period: event.timePeriod ?? null,
      startTime: event.startTime ?? null, endTime: event.endTime ?? null,
    };
    if (!isScheduleTimeValue(time)) throw new Error('日程时间精度与内容不一致');
    return time;
  }
  // Narrow legacy read boundary only. New events must not reconstruct edited
  // fields from old rawText, or a cleared evening comes back on reopening.
  if (!event.isAllDay && event.startTime) {
    const time = { precision: 'exact', period: null, startTime: event.startTime,
      endTime: event.endTime ?? null };
    if (isScheduleTimeValue(time)) return time;
  }
  if (!event.isAllDay) {
    const period = scheduleTimePeriodFromText(event.rawText ?? '');
    const time = { precision: 'period', period, startTime: null, endTime: null };
    if (isScheduleTimeValue(time)) return time;
  }
  return unspecifiedScheduleTime();
}

export function eventTimeLabel(event: EventTimeFields): string {
  return scheduleTimeLabel(scheduleTimeForEvent(event));
}
