import {
  eventCoversDate,
  eventEffectiveEndDate,
  eventEndsAtExclusiveMidnight,
  eventOccupiedDateKeys,
  eventOverlapsDateRange,
} from '../src/utils/eventDateSemantics';

describe('event date half-open semantics', () => {
  it('excludes the stored end date when a timed event ends there at midnight', () => {
    const event = {
      startDate: '2026-07-13',
      endDate: '2026-07-14',
      startTime: '23:00',
      endTime: '00:00',
      isAllDay: false,
    };

    expect(eventEndsAtExclusiveMidnight(event)).toBe(true);
    expect(eventEffectiveEndDate(event)).toBe('2026-07-13');
    expect(eventCoversDate(event, '2026-07-13')).toBe(true);
    expect(eventCoversDate(event, '2026-07-14')).toBe(false);
    expect(eventOverlapsDateRange(event, '2026-07-14', '2026-07-31')).toBe(false);
  });

  it('keeps a non-midnight end date occupied', () => {
    const event = {
      startDate: '2026-07-13',
      endDate: '2026-07-14',
      startTime: '23:00',
      endTime: '00:01',
      isAllDay: false,
    };
    expect(eventEffectiveEndDate(event)).toBe('2026-07-14');
    expect(eventCoversDate(event, '2026-07-14')).toBe(true);
  });

  it('keeps stored all-day end dates inclusive even without times', () => {
    const event = {
      startDate: '2026-07-13',
      endDate: '2026-07-14',
      isAllDay: true,
    };
    expect(eventEndsAtExclusiveMidnight(event)).toBe(false);
    expect(eventOccupiedDateKeys(event)).toEqual(['2026-07-13', '2026-07-14']);
  });

  it('handles a multi-day timed event ending at midnight without a ghost final day', () => {
    const event = {
      startDate: '2026-07-13',
      endDate: '2026-07-16',
      startTime: '12:00',
      endTime: '00:00',
      isAllDay: false,
    };
    expect(eventOccupiedDateKeys(event)).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
    ]);
  });
});
