import {
  eventMatchesRef,
  eventRefForEvent,
  eventRefFromNotificationData,
  eventRefKey,
  eventRefNotificationData,
  sourceEventId,
} from '../src/utils/eventIdentity';
import { materializeEventOccurrence, resolveEventReference } from '../src/utils/eventRecurrence';
import type { CalEvent } from '../src/types';

const SERIES: CalEvent = {
  id: 'series@with-at',
  sourceEventId: 'series@with-at',
  title: '周会',
  startDate: '2026-07-05',
  startTime: '10:00',
  endTime: '11:00',
  repeat: 'weekly',
  color: '#1456F0',
};

describe('stable event occurrence identity', () => {
  it('does not parse a current source id that contains @', () => {
    expect(sourceEventId(SERIES)).toBe('series@with-at');
    expect(eventRefKey(eventRefForEvent(SERIES))).toBe('["series@with-at","2026-07-05"]');
  });

  it('keeps the legacy occurrence-id fallback limited to a date suffix', () => {
    expect(sourceEventId({ id: 'legacy@series@2026-07-12' })).toBe('legacy@series');
    expect(sourceEventId({ id: 'ordinary@identifier' })).toBe('ordinary@identifier');
  });

  it('materializes and resolves a far future occurrence from the series catalog', () => {
    const ref = { sourceEventId: 'series@with-at', occurrenceDate: '2027-07-04' };
    const occurrence = materializeEventOccurrence(SERIES, ref.occurrenceDate);

    expect(occurrence).toMatchObject({
      id: 'series@with-at@2027-07-04',
      sourceEventId: 'series@with-at',
      startDate: '2027-07-04',
      isExpandedOccurrence: true,
    });
    expect(resolveEventReference([SERIES], ref)).toEqual(occurrence);
    expect(eventMatchesRef(occurrence!, ref)).toBe(true);
  });

  it('rejects dates that are not occurrences of the recurrence rule', () => {
    expect(materializeEventOccurrence(SERIES, '2027-07-05')).toBeNull();
    expect(materializeEventOccurrence(SERIES, '2026-02-30')).toBeNull();
  });

  it('round-trips the stable ref through notification scalar data', () => {
    const ref = { sourceEventId: 'series@with-at', occurrenceDate: '2027-07-04' };
    expect(eventRefFromNotificationData(eventRefNotificationData(ref))).toEqual(ref);
    expect(eventRefFromNotificationData({ eventSourceId: 'series@with-at' })).toBeNull();
  });

  it('keeps the original recurrence anchor after an occurrence is moved', () => {
    const moved = {
      ...SERIES,
      id: 'series@with-at@2026-07-12',
      occurrenceDate: '2026-07-12',
      startDate: '2026-07-13',
      isExpandedOccurrence: true,
    };
    expect(eventRefForEvent(moved)).toEqual({
      sourceEventId: 'series@with-at',
      occurrenceDate: '2026-07-12',
    });
  });
});
