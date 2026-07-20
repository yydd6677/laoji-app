import { eventDisplaysAsAllDay, sortAllDayEvents } from '../src/utils/eventAllDay';
import type { CalEvent } from '../src/types';

const base: CalEvent = {
  id: 'base',
  title: '日程',
  startDate: '2026-07-15',
  color: '#1456F0',
};

describe('shared all-day presentation contract', () => {
  it.each([
    [{ ...base, isAllDay: true, startTime: '09:00', endTime: '10:00' }, true],
    [{ ...base, isAllDay: false, startTime: undefined, endTime: undefined }, true],
    [{ ...base, isAllDay: false, startTime: '09:00', endTime: '10:00' }, false],
    [{ ...base, isAllDay: false, startTime: '09:00', endTime: undefined }, false],
    [{ ...base, isAllDay: false, startTime: undefined, endTime: '10:00' }, false],
  ])('classifies explicit all-day and date-only events consistently', (event, expected) => {
    expect(eventDisplaysAsAllDay(event)).toBe(expected);
  });

  it('preserves source order after semantic sort keys are equal', () => {
    const first = { ...base, id: 'first', title: '同名' };
    const second = { ...base, id: 'second', title: '同名' };

    expect(sortAllDayEvents([second, first], [first, second]).map(event => event.id))
      .toEqual(['first', 'second']);
  });
});
