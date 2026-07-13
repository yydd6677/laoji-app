import { CalEvent } from '../src/types';
import { expandEventForMonth, expandEventsForMonths, materializeEventsForSearch } from '../src/utils/eventRecurrence';

const BASE: CalEvent = {
  id: 'guest-series-1',
  sourceEventId: 'guest-series-1',
  title: '复盘',
  startDate: '2026-07-09',
  startTime: '10:00',
  endTime: '11:00',
  color: '#5B8CFF',
};

describe('eventRecurrence', () => {
  it('expands monthly events on the original day, not the month number', () => {
    const august = expandEventForMonth({ ...BASE, repeat: 'monthly' }, 2026, 8);
    expect(august).toHaveLength(1);
    expect(august[0]).toMatchObject({
      id: 'guest-series-1@2026-08-09',
      startDate: '2026-08-09',
      seriesStartDate: '2026-07-09',
      isExpandedOccurrence: true,
    });
  });

  it('does not create daily occurrences before the series starts', () => {
    const july = expandEventForMonth({ ...BASE, startDate: '2026-07-29', repeat: 'daily' }, 2026, 7);
    expect(july.map(event => event.startDate)).toEqual([
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
  });

  it('carries a spanning recurring occurrence into the next month', () => {
    const event: CalEvent = {
      ...BASE,
      startDate: '2026-07-31',
      endDate: '2026-08-02',
      repeat: 'weekly',
      spanning: true,
    };
    const august = expandEventForMonth(event, 2026, 8);
    expect(august[0]).toMatchObject({ startDate: '2026-07-31', endDate: '2026-08-02' });
  });

  it('deduplicates occurrences when rebuilding multiple loaded months', () => {
    const events = expandEventsForMonths([{ ...BASE, repeat: 'monthly' }], ['2026-07', '2026-08']);
    expect(events.map(event => event.id)).toEqual([
      'guest-series-1@2026-07-09',
      'guest-series-1@2026-08-09',
    ]);
  });

  it('uses the nearest upcoming occurrence for global recurring-event search', () => {
    const [result] = materializeEventsForSearch(
      [{ ...BASE, repeat: 'monthly' }],
      new Date(2026, 6, 10, 12),
    );
    expect(result).toMatchObject({
      id: 'guest-series-1@2026-08-09',
      startDate: '2026-08-09',
      isExpandedOccurrence: true,
    });
  });
});
