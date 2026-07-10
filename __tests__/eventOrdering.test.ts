import { CalEvent } from '../src/types';
import { sortEventsForSearch } from '../src/utils/eventOrdering';

const base: CalEvent = {
  id: 'base',
  title: '基础日程',
  startDate: '2026-07-09',
  color: '#7B5CB8',
};

const today = new Date(2026, 6, 9);

describe('sortEventsForSearch', () => {
  it('shows today first, then future nearest first, then past nearest first', () => {
    const result = sortEventsForSearch([
      { ...base, id: 'past-far', title: '很久以前', startDate: '2026-07-01', startTime: '09:00' },
      { ...base, id: 'future-near', title: '明天', startDate: '2026-07-10', startTime: '15:00' },
      { ...base, id: 'today-late', title: '今天晚些', startDate: '2026-07-09', startTime: '17:00' },
      { ...base, id: 'future-far', title: '以后', startDate: '2026-07-15', startTime: '08:00' },
      { ...base, id: 'past-near', title: '昨天', startDate: '2026-07-08', startTime: '18:00' },
      { ...base, id: 'today-early', title: '今天早些', startDate: '2026-07-09', startTime: '08:00' },
    ], today);

    expect(result.map(event => event.id)).toEqual([
      'today-early',
      'today-late',
      'future-near',
      'future-far',
      'past-near',
      'past-far',
    ]);
  });

  it('sorts events on the same day by start time, end time, title, then original order', () => {
    const result = sortEventsForSearch([
      { ...base, id: 'late', title: '晚些', startTime: '16:00' },
      { ...base, id: 'same-b', title: '乙事项', startTime: '09:00', endTime: '10:00' },
      { ...base, id: 'same-a', title: '甲事项', startTime: '09:00', endTime: '10:00' },
      { ...base, id: 'early-end', title: '先结束', startTime: '09:00', endTime: '09:30' },
      { ...base, id: 'no-time', title: '全天事项', startTime: undefined },
      { ...base, id: 'first', title: '最早', startTime: '08:30' },
    ], today);

    expect(result.map(event => event.id)).toEqual([
      'first',
      'early-end',
      'same-a',
      'same-b',
      'late',
      'no-time',
    ]);
  });

  it('treats spanning events that cover today as today events', () => {
    const result = sortEventsForSearch([
      { ...base, id: 'future-single', title: '明天单日', startDate: '2026-07-10', startTime: '09:00' },
      {
        ...base,
        id: 'cover-today',
        title: '本周完成',
        startDate: '2026-07-07',
        endDate: '2026-07-12',
        spanning: true,
      },
      {
        ...base,
        id: 'past-span',
        title: '上周任务',
        startDate: '2026-07-01',
        endDate: '2026-07-08',
        spanning: true,
      },
    ], today);

    expect(result.map(event => event.id)).toEqual([
      'cover-today',
      'future-single',
      'past-span',
    ]);
  });
});
