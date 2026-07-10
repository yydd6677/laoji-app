import { CalEvent } from '../src/types';
import { selectTasksForDate } from '../src/utils/taskOrdering';

const base: CalEvent = {
  id: 'base',
  title: '基础日程',
  startDate: '2026-07-08',
  startTime: '10:00',
  color: '#7B5CB8',
};

describe('selectTasksForDate', () => {
  it('keeps timed events on the selected date and excludes single-day all-day items', () => {
    const result = selectTasksForDate([
      base,
      { ...base, id: 'no-time', title: '全天事项', startTime: undefined, isAllDay: true },
      { ...base, id: 'other-date', title: '其他日期', startDate: '2026-07-09', startTime: '09:00' },
    ], '2026-07-08');

    expect(result.map(event => event.id)).toEqual(['base']);
  });

  it('includes spanning events that cover the selected date', () => {
    const result = selectTasksForDate([
      { ...base, id: 'span', title: '跨日任务', startDate: '2026-07-07', endDate: '2026-07-10', spanning: true, startTime: '09:00' },
      { ...base, id: 'span-all-day', title: '跨日全天', startDate: '2026-07-07', endDate: '2026-07-10', spanning: true, startTime: undefined, isAllDay: true },
      { ...base, id: 'ended', title: '已结束', startDate: '2026-07-01', endDate: '2026-07-07', spanning: true, startTime: '08:00' },
    ], '2026-07-08');

    expect(result.map(event => event.id)).toEqual(['span', 'span-all-day']);
  });

  it('sorts tasks by start time, end time, title, then original order', () => {
    const result = selectTasksForDate([
      { ...base, id: 'late', title: '晚些', startTime: '16:00' },
      { ...base, id: 'same-b', title: '乙事项', startTime: '09:00', endTime: '10:00' },
      { ...base, id: 'same-a', title: '甲事项', startTime: '09:00', endTime: '10:00' },
      { ...base, id: 'early-end', title: '先结束', startTime: '09:00', endTime: '09:30' },
      { ...base, id: 'first', title: '最早', startTime: '08:30' },
    ], '2026-07-08');

    expect(result.map(event => event.id)).toEqual([
      'first',
      'early-end',
      'same-a',
      'same-b',
      'late',
    ]);
  });
});
