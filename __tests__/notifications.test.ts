import {
  DEFAULT_REMINDER_MINUTES,
  SOON_REMINDER_DELAY_MS,
  defaultReminderForEvent,
  labelForReminder,
  notificationDateTrigger,
  parseEventDateTime,
  reminderFireDate,
} from '../src/services/notifications';

describe('notification reminder rules', () => {
  it('uses a one-second fallback delay for imminent events', () => {
    expect(SOON_REMINDER_DELAY_MS).toBe(1_000);
  });

  it('defaults timed events to 15 minutes before', () => {
    expect(defaultReminderForEvent(false, '15:00')).toBe(DEFAULT_REMINDER_MINUTES);
  });

  it('does not default all-day or untimed events to notifications', () => {
    expect(defaultReminderForEvent(true, '15:00')).toBeNull();
    expect(defaultReminderForEvent(false, undefined)).toBeNull();
  });

  it('parses local event date and time', () => {
    const parsed = parseEventDateTime('2026-07-08', '15:30');
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(6);
    expect(parsed?.getDate()).toBe(8);
    expect(parsed?.getHours()).toBe(15);
    expect(parsed?.getMinutes()).toBe(30);
  });

  it('computes future reminder fire dates', () => {
    const fireAt = reminderFireDate(
      { startDate: '2026-07-08', startTime: '15:00', isAllDay: false, reminderMinutes: 15 },
      new Date(2026, 6, 8, 14, 0, 0),
    );
    expect(fireAt?.getHours()).toBe(14);
    expect(fireAt?.getMinutes()).toBe(45);
  });

  it('uses a near-term reminder when the default lead time has already passed', () => {
    const fireAt = reminderFireDate(
      { startDate: '2026-07-08', startTime: '15:00', isAllDay: false, reminderMinutes: 15 },
      new Date(2026, 6, 8, 14, 50, 0),
    );
    expect(fireAt?.getTime()).toBe(new Date(2026, 6, 8, 14, 50, 0).getTime() + SOON_REMINDER_DELAY_MS);
  });

  it('does not schedule reminders for events that already started', () => {
    const fireAt = reminderFireDate(
      { startDate: '2026-07-08', startTime: '15:00', isAllDay: false, reminderMinutes: 15 },
      new Date(2026, 6, 8, 15, 1, 0),
    );
    expect(fireAt).toBeNull();
  });

  it('labels explicit start-time reminders', () => {
    expect(labelForReminder(0)).toBe('开始时');
  });

  it('builds an explicit date notification trigger', () => {
    const date = new Date(2026, 6, 8, 14, 45, 0);
    expect(notificationDateTrigger(date)).toEqual(expect.objectContaining({
      type: 'date',
      date,
    }));
  });
});
