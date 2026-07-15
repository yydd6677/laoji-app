import { layoutMonthWeekEvents } from '../src/utils/monthEventLayout';
import type { CalEvent } from '../src/types';

const week = [
  '2026-07-12',
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
];

function event(overrides: Partial<CalEvent> & Pick<CalEvent, 'id' | 'title' | 'startDate'>): CalEvent {
  return { color: '#1456F0', ...overrides };
}

describe('Feishu-style month event matrix', () => {
  it('uses one fixed-slot segment for a multi-day event in the same week', () => {
    const layout = layoutMonthWeekEvents([
      event({ id: 'span', title: '连续课程', startDate: '2026-07-13', endDate: '2026-07-15' }),
    ], week, 3);

    expect(layout.segments).toEqual([
      expect.objectContaining({ column: 1, span: 3, slot: 0, visible: true }),
    ]);
    expect(layout.eventCounts).toEqual([0, 1, 1, 1, 0, 0, 0]);
  });

  it('keeps long and all-day events ahead, then counts hidden occupancy per day', () => {
    const layout = layoutMonthWeekEvents([
      event({ id: 'timed', title: '晨会', startDate: '2026-07-13', startTime: '09:00', endTime: '10:00' }),
      event({ id: 'all-day', title: '全天事项', startDate: '2026-07-13', isAllDay: true }),
      event({ id: 'span', title: '跨日事项', startDate: '2026-07-13', endDate: '2026-07-15' }),
    ], week, 2);

    expect(layout.segments.map(item => [item.event.id, item.slot, item.visible])).toEqual([
      ['span', 0, true],
      ['all-day', 1, true],
      ['timed', 2, false],
    ]);
    expect(layout.hiddenCounts).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it('splits only at week boundaries and not at a month boundary', () => {
    const crossWeek = event({
      id: 'cross-week',
      title: '周末出行',
      startDate: '2026-07-18',
      endDate: '2026-07-20',
      spanning: false,
    });
    const first = layoutMonthWeekEvents([crossWeek], week, 2).segments[0];
    const second = layoutMonthWeekEvents([crossWeek], [
      '2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22',
      '2026-07-23', '2026-07-24', '2026-07-25',
    ], 2).segments[0];
    expect(first).toEqual(expect.objectContaining({ column: 6, span: 1 }));
    expect(second).toEqual(expect.objectContaining({ column: 0, span: 2 }));

    const crossMonth = event({
      id: 'cross-month',
      title: '跨月项目',
      startDate: '2026-07-30',
      endDate: '2026-08-01',
    });
    const monthSegment = layoutMonthWeekEvents([crossMonth], [
      '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29',
      '2026-07-30', '2026-07-31', '2026-08-01',
    ], 2).segments[0];
    expect(monthSegment).toEqual(expect.objectContaining({ column: 4, span: 3 }));
  });
});
