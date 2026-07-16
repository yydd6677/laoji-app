import { validateEventDraft } from '../src/utils/eventDraftValidation';

const BASE = {
  title: '项目评审',
  startDate: '2026-07-20',
  startTime: '10:00',
  endTime: '11:00',
  isAllDay: false,
  repeat: 'once' as const,
  reminderMinutes: 15,
};

describe('shared event draft validation', () => {
  it.each([
    ['invalid-start-date', { startDate: '2026-02-30' }],
    ['invalid-start-time', { startTime: '24:00' }],
    ['invalid-end-time', { endTime: '11:60' }],
    ['single-sided-time', { endTime: undefined, reminderMinutes: null }],
    ['end-not-after-start', { endTime: '10:00' }],
    ['end-not-after-start', { endTime: '09:00' }],
    ['invalid-reminder', { reminderMinutes: -1 }],
    ['invalid-reminder', { reminderMinutes: 1.5 }],
  ])('rejects %s', (code, patch) => {
    const result = validateEventDraft({ ...BASE, ...patch });
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain(code);
  });

  it('accepts an explicit cross-midnight interval', () => {
    const result = validateEventDraft({
      ...BASE,
      startTime: '23:30',
      endDate: '2026-07-21',
      endTime: '00:00',
    });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(expect.objectContaining({
      endDate: '2026-07-21',
      spanning: true,
    }));
  });

  it('allows an untimed date-only item without a reminder', () => {
    const result = validateEventDraft({
      ...BASE,
      startTime: undefined,
      endTime: undefined,
      reminderMinutes: null,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects time and reminder fields on all-day items', () => {
    const result = validateEventDraft({ ...BASE, isAllDay: true });
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'all-day-has-time',
      'all-day-reminder-unsupported',
    ]));
  });

  it.each(['once', 'daily', 'weekly', 'monthly', 'yearly'] as const)(
    'accepts the %s recurrence enum',
    repeat => expect(validateEventDraft({ ...BASE, repeat }).valid).toBe(true),
  );
});
