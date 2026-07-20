import { CalEvent } from '../src/types';
import {
  expandEventForMonth,
  expandEventsForMonths,
  materializeEventsForSearch,
  resolveEventReference,
} from '../src/utils/eventRecurrence';

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

  it('does not carry a one-off event into a month it reaches only at midnight', () => {
    const event: CalEvent = {
      ...BASE,
      startDate: '2026-07-31',
      endDate: '2026-08-01',
      startTime: '23:00',
      endTime: '00:00',
      repeat: 'once',
      spanning: true,
    };
    expect(expandEventForMonth(event, 2026, 7)).toHaveLength(1);
    expect(expandEventForMonth(event, 2026, 8)).toEqual([]);
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

  it('honors recurrence interval, selected weekdays, and an inclusive end date', () => {
    const events = expandEventForMonth({
      ...BASE,
      startDate: '2026-07-06',
      seriesStartDate: '2026-07-06',
      repeat: 'weekly',
      recurrenceInterval: 2,
      recurrenceWeekdays: [1, 3],
      recurrenceUntilDate: '2026-07-22',
    }, 2026, 7);

    expect(events.map(event => event.startDate)).toEqual([
      '2026-07-06',
      '2026-07-08',
      '2026-07-20',
      '2026-07-22',
    ]);
  });

  it('uses ISO weekday 7 for Sunday', () => {
    const events = expandEventForMonth({
      ...BASE,
      startDate: '2026-07-05',
      seriesStartDate: '2026-07-05',
      repeat: 'weekly',
      recurrenceWeekdays: [7],
      recurrenceUntilDate: '2026-07-19',
    }, 2026, 7);

    expect(events.map(event => event.startDate)).toEqual([
      '2026-07-05',
      '2026-07-12',
      '2026-07-19',
    ]);
  });

  it('preserves a stable Sunday anchor when a following segment displays on Monday', () => {
    const events = expandEventForMonth({
      ...BASE,
      id: 'guest-series-1:segment:2',
      occurrenceDate: '2026-07-19',
      recurrenceSegmentId: 2,
      recurrenceEffectiveFromDate: '2026-07-19',
      seriesStartDate: '2026-07-05',
      startDate: '2026-07-20',
      repeat: 'weekly',
    }, 2026, 7);

    expect(events.map(event => ({ anchor: event.occurrenceDate, display: event.startDate }))).toEqual([
      { anchor: '2026-07-19', display: '2026-07-20' },
      { anchor: '2026-07-26', display: '2026-07-27' },
    ]);
  });

  it('keeps a moved exception addressable by its original occurrence anchor', () => {
    const exception: CalEvent = {
      ...BASE,
      id: 'guest-series-1@2026-07-16:exception',
      occurrenceDate: '2026-07-16',
      startDate: '2026-07-18',
      repeat: 'weekly',
      isRecurrenceException: true,
    };

    expect(expandEventForMonth(exception, 2026, 7)).toEqual([exception]);
    expect(resolveEventReference([exception], {
      sourceEventId: 'guest-series-1',
      occurrenceDate: '2026-07-16',
    })).toBe(exception);
  });

  it('selects the segment whose recurrence range contains the requested anchor', () => {
    const first: CalEvent = {
      ...BASE,
      repeat: 'weekly',
      excludedAfterDate: '2026-07-23',
    };
    const following: CalEvent = {
      ...BASE,
      id: 'guest-series-1:segment:2',
      recurrenceSegmentId: 2,
      startDate: '2026-07-23',
      seriesStartDate: '2026-07-23',
      startTime: '14:00',
      endTime: '15:00',
      repeat: 'weekly',
    };

    expect(resolveEventReference([first, following], {
      sourceEventId: 'guest-series-1',
      occurrenceDate: '2026-07-30',
    })).toMatchObject({ startDate: '2026-07-30', startTime: '14:00' });
  });

  it('expands a root, shifted following segment, and moved exception catalog without duplicates', () => {
    const root: CalEvent = {
      ...BASE,
      id: 'guest-series-1',
      occurrenceDate: '2026-07-05',
      recurrenceEffectiveFromDate: '2026-07-05',
      startDate: '2026-07-05',
      endDate: '2026-07-07',
      repeat: 'weekly',
      excludedAfterDate: '2026-07-19',
      excludedOccurrenceDates: ['2026-07-12'],
    };
    const segment: CalEvent = {
      ...root,
      id: 'catalog:guest-series-1:segment:3',
      recurrenceSegmentId: 3,
      occurrenceDate: '2026-07-19',
      recurrenceEffectiveFromDate: '2026-07-19',
      startDate: '2026-07-20',
      endDate: '2026-07-22',
      excludedAfterDate: undefined,
      excludedOccurrenceDates: ['2026-07-26'],
      title: '后段',
    };
    const exception: CalEvent = {
      ...root,
      id: 'guest-series-1@2026-07-12',
      occurrenceDate: '2026-07-12',
      startDate: '2026-07-14',
      endDate: '2026-07-16',
      repeat: 'once',
      isRecurrenceException: true,
      excludedAfterDate: undefined,
      excludedOccurrenceDates: [],
      title: '移动实例',
    };

    const july = expandEventsForMonths([root, segment, exception], ['2026-07'])
      .sort((left, right) => (left.occurrenceDate ?? '').localeCompare(right.occurrenceDate ?? ''));
    expect(july.map(event => ({
      anchor: event.occurrenceDate,
      display: event.startDate,
      title: event.title,
    }))).toEqual([
      { anchor: '2026-07-05', display: '2026-07-05', title: '复盘' },
      { anchor: '2026-07-12', display: '2026-07-14', title: '移动实例' },
      { anchor: '2026-07-19', display: '2026-07-20', title: '后段' },
    ]);
    expect(new Set(july.map(event => event.occurrenceDate)).size).toBe(july.length);
    expect(resolveEventReference([root, segment, exception], {
      sourceEventId: 'guest-series-1',
      occurrenceDate: '2026-08-02',
    })).toMatchObject({
      occurrenceDate: '2026-08-02',
      startDate: '2026-08-03',
      title: '后段',
    });
  });
});
