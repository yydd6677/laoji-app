import {
  applyGuestTransactionToSeries,
  createEventDeleteTransaction,
  eventIsInRecurrenceScope,
  hideTransactionScope,
  restoreTransactionScope,
} from '../src/services/eventDeleteTransactions';
import type { CalEvent } from '../src/types';

const SERIES: CalEvent = {
  id: 'series',
  sourceEventId: 'series',
  occurrenceDate: '2026-07-05',
  title: '周会',
  startDate: '2026-07-05',
  startTime: '10:00',
  endTime: '11:00',
  repeat: 'weekly',
  color: '#1456F0',
  revision: 3,
};

function occurrence(anchor: string, actualDate = anchor): CalEvent {
  return {
    ...SERIES,
    id: `series@${anchor}`,
    occurrenceDate: anchor,
    occurrenceId: `series@${anchor}`,
    isExpandedOccurrence: true,
    startDate: actualDate,
  };
}

describe('event deletion transaction primitives', () => {
  it('uses the immutable anchor when selecting following occurrences', () => {
    const moved = occurrence('2026-07-12', '2026-07-20');
    expect(eventIsInRecurrenceScope(
      moved,
      { sourceEventId: 'series', occurrenceDate: '2026-07-19' },
      'following',
    )).toBe(false);
  });

  it('hides and restores only the selected occurrence without changing ids', () => {
    const first = occurrence('2026-07-05');
    const second = occurrence('2026-07-12');
    const tx = createEventDeleteTransaction({
      scopeKey: 'user:7',
      target: second,
      recurrenceScope: 'occurrence',
      relatedEvents: [first, second],
      catalogEvent: SERIES,
      now: 1_000,
    });
    expect(tx.deleteRequestId).not.toBe(tx.restoreRequestId);
    expect(tx.undoUntil).toBe(6_000);
    expect(hideTransactionScope([first, second], tx).map(event => event.id)).toEqual([first.id]);
    expect(restoreTransactionScope([first], tx).map(event => event.id)).toEqual([first.id, second.id]);
  });

  it('persists guest occurrence exclusions and following cutoffs reversibly', () => {
    const occurrenceTx = createEventDeleteTransaction({
      scopeKey: 'guest',
      target: occurrence('2026-07-12'),
      recurrenceScope: 'occurrence',
      relatedEvents: [],
      catalogEvent: SERIES,
    });
    const excluded = applyGuestTransactionToSeries(SERIES, occurrenceTx, 'absent');
    expect(excluded.excludedOccurrenceDates).toEqual(['2026-07-12']);
    expect(applyGuestTransactionToSeries(excluded, occurrenceTx, 'present').excludedOccurrenceDates).toEqual([]);

    const followingTx = { ...occurrenceTx, recurrenceScope: 'following' as const };
    expect(applyGuestTransactionToSeries(SERIES, followingTx, 'absent').excludedAfterDate)
      .toBe('2026-07-12');
    expect(applyGuestTransactionToSeries(SERIES, followingTx, 'present').excludedAfterDate)
      .toBeUndefined();
  });
});
