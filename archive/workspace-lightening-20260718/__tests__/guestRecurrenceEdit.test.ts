import { applyGuestRecurrenceEdit } from '../src/services/guestRecurrenceEdit';
import { expandEventsForMonths, resolveEventReference } from '../src/utils/eventRecurrence';
import type { CalEvent } from '../src/types';

const base: CalEvent = {
  id: 'guest-series',
  sourceEventId: 'guest-series',
  occurrenceDate: '2026-07-06',
  title: '周会',
  startDate: '2026-07-06',
  seriesStartDate: '2026-07-06',
  startTime: '10:00',
  endTime: '11:00',
  repeat: 'weekly',
  color: '#3370FF',
};
const target = resolveEventReference([base], {
  sourceEventId: 'guest-series',
  occurrenceDate: '2026-07-20',
})!;
const validated = {
  ...target,
  title: '产品周会',
  startDate: '2026-07-21',
  startTime: '14:00',
  endTime: '15:00',
};
delete (validated as Partial<CalEvent>).id;

describe('guest recurrence edit scopes', () => {
  it('creates one moved exception while preserving the original stable anchor', () => {
    const result = applyGuestRecurrenceEdit({
      events: [base],
      target,
      ref: { sourceEventId: 'guest-series', occurrenceDate: '2026-07-20' },
      scope: 'occurrence',
      validated,
      segmentId: 'unused',
    });

    expect(result[0].excludedOccurrenceDates).toEqual(['2026-07-20']);
    expect(resolveEventReference(result, {
      sourceEventId: 'guest-series',
      occurrenceDate: '2026-07-20',
    })).toMatchObject({
      startDate: '2026-07-21',
      occurrenceDate: '2026-07-20',
      isRecurrenceException: true,
    });
  });

  it('splits following occurrences without duplicating the first edited instance', () => {
    const result = applyGuestRecurrenceEdit({
      events: [base],
      target,
      ref: { sourceEventId: 'guest-series', occurrenceDate: '2026-07-20' },
      scope: 'following',
      validated,
      segmentId: 'next',
    });
    const expanded = expandEventsForMonths(result, ['2026-07', '2026-08']);

    expect(expanded.filter(event => event.startDate === '2026-07-21')).toHaveLength(1);
    expect(expanded.map(event => event.startDate)).toContain('2026-07-28');
    expect(expanded.find(event => event.startDate === '2026-07-28')).toMatchObject({
      title: '产品周会',
      startTime: '14:00',
    });
    expect(expanded.map(event => event.startDate)).not.toContain('2026-07-27');
  });

  it('rebuilds the whole series using the selected occurrence date delta', () => {
    const result = applyGuestRecurrenceEdit({
      events: [base, { ...base, id: 'old-exception', isRecurrenceException: true }],
      target,
      ref: { sourceEventId: 'guest-series', occurrenceDate: '2026-07-20' },
      scope: 'series',
      validated,
      segmentId: 'unused',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      startDate: '2026-07-07',
      seriesStartDate: '2026-07-07',
      title: '产品周会',
      startTime: '14:00',
    });
  });
});
