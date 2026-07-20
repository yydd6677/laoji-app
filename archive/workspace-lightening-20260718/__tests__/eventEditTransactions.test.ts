import {
  createEventEditJournal,
  createEventEditTransaction,
  parseEventEditJournal,
} from '../src/services/eventEditTransactions';

const target = {
  id: '42@2026-07-20',
  sourceEventId: '42',
  occurrenceDate: '2026-07-20',
  revision: 7,
  title: '周会',
  startDate: '2026-07-20',
  startTime: '10:00',
  endTime: '11:00',
  repeat: 'weekly' as const,
  color: '#3370FF',
};

describe('event edit transactions', () => {
  it('captures a stable occurrence reference and optimistic revision', () => {
    const transaction = createEventEditTransaction({
      scopeKey: 'user:7',
      target,
      recurrenceScope: 'occurrence',
      patch: { title: '产品周会' },
      now: 123,
    });

    expect(transaction).toEqual(expect.objectContaining({
      scopeKey: 'user:7',
      ref: { sourceEventId: '42', occurrenceDate: '2026-07-20' },
      recurrenceScope: 'occurrence',
      expectedRevision: 7,
      phase: 'pending',
      createdAt: 123,
    }));
  });

  it('loads only valid entries from the versioned journal and legacy arrays', () => {
    const transaction = createEventEditTransaction({
      scopeKey: 'user:7',
      target,
      recurrenceScope: 'series',
      patch: { location: null },
    });
    expect(parseEventEditJournal(createEventEditJournal([transaction, {} as never]))).toEqual([transaction]);
    expect(parseEventEditJournal([transaction, null])).toEqual([transaction]);
    expect(parseEventEditJournal({ version: 2, transactions: [transaction] })).toEqual([]);
  });
});
