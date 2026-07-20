import { validateEventDraft } from '../src/utils/eventDraftValidation';

// CAL-REPEAT-RRULE-001: recurrence end validation remains shared with native save.

const BASE = {
  title: '项目评审',
  startDate: '2026-07-20',
  startTime: '10:00',
  endTime: '11:00',
  isAllDay: false,
  repeat: 'once' as const,
  recurrenceUntilDate: undefined,
  reminderMinutes: 15,
};

describe('shared event draft validation', () => {
  it.each([
    ['invalid-start-date', { startDate: '2026-02-30' }],
    ['invalid-start-date', { startDate: '1899-12-31' }],
    ['invalid-start-date', { startDate: '2101-01-01' }],
    ['invalid-end-date', { endDate: '2200-01-01' }],
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

  it('keeps a valid repeat end date and clears it when repetition is disabled', () => {
    const repeated = validateEventDraft({
      ...BASE,
      repeat: 'weekly' as const,
      recurrenceUntilDate: '2026-09-30',
    });
    expect(repeated.valid).toBe(true);
    expect(repeated.value?.recurrenceUntilDate).toBe('2026-09-30');

    const once = validateEventDraft({ ...BASE, recurrenceUntilDate: '2026-09-30' });
    expect(once.valid).toBe(true);
    expect(once.value?.recurrenceUntilDate).toBeUndefined();
  });

  it('accepts both supported calendar boundary years', () => {
    expect(validateEventDraft({
      ...BASE,
      startDate: '1900-01-01',
      endDate: '1900-01-01',
    }).valid).toBe(true);
    expect(validateEventDraft({
      ...BASE,
      startDate: '2100-12-31',
      endDate: '2100-12-31',
    }).valid).toBe(true);
  });

  it.each(['1800-06-01', '2200-06-01'])(
    'rejects an out-of-range repeat end date %s',
    recurrenceUntilDate => {
      const result = validateEventDraft({
        ...BASE,
        repeat: 'yearly' as const,
        recurrenceUntilDate,
      });
      expect(result.issues.map(issue => issue.code)).toContain('invalid-recurrence-until-date');
    },
  );

  it('rejects a repeat end date before the event start date', () => {
    const result = validateEventDraft({
      ...BASE,
      repeat: 'daily' as const,
      recurrenceUntilDate: '2026-07-19',
    });
    expect(result.issues.map(issue => issue.code)).toContain('recurrence-until-before-start');
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
