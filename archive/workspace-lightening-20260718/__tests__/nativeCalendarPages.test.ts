import type { CalEvent } from '../src/types';
import {
  buildNativeCalendarDetailSnapshot,
  buildNativeCalendarEditSnapshot,
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

describe('native calendar page snapshots [CAL-SEARCH-001/CAL-DETAIL-001/CAL-EDIT-001/CAL-REPEAT-RRULE-001]', () => {
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

  it('preserves a repeat end date in the native editor contract', () => {
    expect(nativeCalendarEditDraft(event({
      repeat: 'weekly',
      recurrenceUntilDate: '2026-09-30',
    }))).toEqual(expect.objectContaining({
      repeat: 'weekly',
      recurrenceUntilDate: '2026-09-30',
    }));
    expect(nativeCalendarEditDraft(event({
      repeat: 'once',
      recurrenceUntilDate: '2026-09-30',
    })).recurrenceUntilDate).toBeNull();
  });

  it.each(['occurrence', 'following', 'series'] as const)(
    'passes the selected recurrence scope %s through the native editor snapshot',
    recurrenceScope => {
      const draft = nativeCalendarEditDraft(event({ repeat: 'weekly' }));
      expect(buildNativeCalendarEditSnapshot({
        draft,
        editing: true,
        recurring: true,
        recurrenceScope,
      })).toEqual(expect.objectContaining({ recurrenceScope }));
    },
  );

  it('represents an unresolved recurring edit scope explicitly as null', () => {
    const draft = nativeCalendarEditDraft(event({ repeat: 'weekly' }));
    expect(buildNativeCalendarEditSnapshot({
      draft,
      editing: true,
      recurring: true,
    }).recurrenceScope).toBeNull();
  });
});
