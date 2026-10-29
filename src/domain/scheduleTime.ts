/** A period is an honest precision, never an inferred hour or an all-day flag. */
export const SCHEDULE_PERIODS = [
  'early_morning', 'morning', 'noon', 'afternoon', 'evening', 'night',
] as const;
export type SchedulePeriod = typeof SCHEDULE_PERIODS[number];
export type ScheduleTimePrecision = 'unspecified' | 'period' | 'exact';
export type ScheduleTimeValue =
  | { precision: 'unspecified'; period: null; startTime: null; endTime: null }
  | { precision: 'period'; period: SchedulePeriod; startTime: null; endTime: null }
  | { precision: 'exact'; period: null; startTime: string; endTime: string | null };

const PERIOD_LABELS: Record<SchedulePeriod, string> = {
  early_morning: '凌晨', morning: '上午', noon: '中午',
  afternoon: '下午', evening: '傍晚', night: '晚上',
};

export function isSchedulePeriod(value: unknown): value is SchedulePeriod {
  return typeof value === 'string' && (SCHEDULE_PERIODS as readonly string[]).includes(value);
}

export function isScheduleClock(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isScheduleTimeValue(value: unknown): value is ScheduleTimeValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const time = value as Partial<ScheduleTimeValue>;
  switch (time.precision) {
    case 'unspecified': return time.period === null && time.startTime === null && time.endTime === null;
    case 'period': return isSchedulePeriod(time.period) && time.startTime === null && time.endTime === null;
    case 'exact': return time.period === null && isScheduleClock(time.startTime)
      && (time.endTime === null || isScheduleClock(time.endTime));
    default: return false;
  }
}

export function unspecifiedScheduleTime(): ScheduleTimeValue {
  return { precision: 'unspecified', period: null, startTime: null, endTime: null };
}

export function schedulePeriodLabel(period: SchedulePeriod | null | undefined): string | null {
  return period ? PERIOD_LABELS[period] : null;
}

export function scheduleTimeLabel(time: ScheduleTimeValue): string {
  if (time.precision === 'period') return PERIOD_LABELS[time.period];
  if (time.precision === 'unspecified') return '未设置';
  return time.endTime ? `${time.startTime} - ${time.endTime}` : time.startTime;
}
