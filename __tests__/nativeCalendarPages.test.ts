import type { CalEvent } from '../src/types';
import {
  buildNativeCalendarDetailSnapshot,
  buildNativeCalendarSearchSnapshot,
  nativeCalendarEditDraft,
} from '../src/native/nativeCalendarPages';

function event(overrides: Partial<CalEvent> = {}): CalEvent {
  return {
    id: 'event-1',
    title: '项目评审',
    startDate: '2026-07-16',
    startTime: '10:00',
    endTime: '10:30',
    color: '#1456F0',
    repeat: 'once',
    ...overrides,
  };
}

describe('native calendar page snapshots [CAL-SEARCH-001/CAL-DETAIL-001/CAL-EDIT-001]', () => {
  it('keeps today, future, and past search ordering from the shared domain rule', () => {
    const snapshot = buildNativeCalendarSearchSnapshot([
      event({ id: 'past', startDate: '2026-07-14' }),
      event({ id: 'future', startDate: '2026-07-17' }),
      event({ id: 'today', startDate: '2026-07-16' }),
    ], '评审', new Date(2026, 6, 16, 8));
    expect(snapshot.results.map(row => row.sourceEventId)).toEqual(['today', 'future', 'past']);
  });

  it('exposes real detail fields without service-gap placeholders', () => {
    const snapshot = buildNativeCalendarDetailSnapshot(event({
      location: 'A301',
      description: '确认发布范围',
      reminderMinutes: 15,
    }));
    expect(snapshot.event).toEqual(expect.objectContaining({
      location: 'A301',
      notes: '确认发布范围',
      reminderLabel: '15分钟前',
    }));
  });

  it('allows a dated event with no concrete time', () => {
    expect(nativeCalendarEditDraft(event({ startTime: undefined, endTime: undefined }))).toEqual(
      expect.objectContaining({ startDate: '2026-07-16', startTime: null, endTime: null }),
    );
  });
});
