import {
  DEFAULT_REMINDER_MINUTES,
  defaultReminderForEvent,
  labelForReminder,
  parseEventDateTime,
  reminderFireDate,
} from '../src/services/notifications';

describe('notification reminder rules', () => {
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

  it('does not schedule past reminders', () => {
    const fireAt = reminderFireDate(
      { startDate: '2026-07-08', startTime: '15:00', isAllDay: false, reminderMinutes: 15 },
      new Date(2026, 6, 8, 14, 50, 0),
    );
    expect(fireAt).toBeNull();
  });

  it('labels explicit start-time reminders', () => {
    expect(labelForReminder(0)).toBe('开始时');
  });
});
