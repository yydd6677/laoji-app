import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';
import {
  DEFAULT_REMINDER_MINUTES,
  ANDROID_EVENT_REMINDER_LIMIT,
  EVENT_REMINDER_HORIZON_DAYS,
  SOON_REMINDER_DELAY_MS,
  TEST_NOTIFICATION_DELAY_MS,
  defaultReminderForEvent,
  ensureNotificationPermission,
  labelForReminder,
  notificationDateTrigger,
  openNotificationSettings,
  parseEventDateTime,
  planEventNotificationHorizon,
  prepareNotificationChannel,
  reminderFireDate,
  reminderUnavailableMessage,
  scheduleTestNotification,
  scheduleEventNotification,
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

  it('plans a bounded rolling horizon for future recurrence reminders', () => {
    const plan = planEventNotificationHorizon([{
      id: 'daily-series',
      sourceEventId: 'daily-series',
      title: '每日复盘',
      startDate: '2026-07-15',
      startTime: '10:00',
      repeat: 'daily',
      reminderMinutes: 15,
      color: '#1456F0',
    }], new Date(2026, 6, 15, 8, 0), EVENT_REMINDER_HORIZON_DAYS, 3);

    expect(plan.events.map(event => event.startDate)).toEqual([
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
    ]);
    expect(plan.truncated).toBe(true);
    expect(plan.windowEnd).toBe('2026-10-13');
    expect(ANDROID_EVENT_REMINDER_LIMIT).toBeGreaterThan(3);
  });

  it('keeps all-day and untimed events out of the reminder horizon', () => {
    const now = new Date(2026, 6, 15, 8, 0);
    const plan = planEventNotificationHorizon([{
      id: 'all-day',
      title: '全天事项',
      startDate: '2026-07-16',
      isAllDay: true,
      reminderMinutes: 15,
      color: '#1456F0',
    }, {
      id: 'untimed',
      title: '无时间事项',
      startDate: '2026-07-16',
      reminderMinutes: 15,
      color: '#1456F0',
    }], now);

    expect(plan.events).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it('builds an explicit date notification trigger', () => {
    const date = new Date(2026, 6, 8, 14, 45, 0);
    expect(notificationDateTrigger(date)).toEqual(expect.objectContaining({
      type: 'date',
      date,
    }));
  });
});

describe('notification permission setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the Android reminder channel before requesting permission', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });

    await expect(ensureNotificationPermission()).resolves.toBe(true);
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'laoji-events',
      expect.objectContaining({ name: '日程提醒', importance: 'high' }),
    );
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a system request after the OS disallows asking again', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    });

    await expect(ensureNotificationPermission()).resolves.toBe(false);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('prepares a visible reminder channel and opens its Android notification settings', async () => {
    await prepareNotificationChannel();
    await openNotificationSettings();

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'laoji-events',
      expect.objectContaining({ sound: 'default' }),
    );
    expect(Linking.sendIntent).toHaveBeenCalledWith(
      'android.settings.APP_NOTIFICATION_SETTINGS',
      [{ key: 'android.provider.extra.APP_PACKAGE', value: 'com.laoji.app' }],
    );
    expect(Linking.openSettings).not.toHaveBeenCalled();
  });

  it('falls back to the app settings when dedicated notification settings are unavailable', async () => {
    (Linking.sendIntent as jest.Mock).mockRejectedValueOnce(new Error('unsupported intent'));

    await openNotificationSettings();

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a granted scheduling failure from a permission denial', async () => {
    (Notifications.getPermissionsAsync as jest.Mock)
      .mockResolvedValueOnce({ status: 'granted', granted: true, canAskAgain: true })
      .mockResolvedValueOnce({ status: 'denied', granted: false, canAskAgain: true });

    await expect(reminderUnavailableMessage()).resolves.toContain('系统通知已开启');
    await expect(reminderUnavailableMessage()).resolves.toContain('检查并开启系统通知');
  });

  it('schedules the settings test through the same Android date-trigger path', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValueOnce('test-id');

    await expect(scheduleTestNotification()).resolves.toBe('test-id');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ title: '老记测试提醒' }),
      trigger: expect.objectContaining({
        type: 'date',
        date: new Date(1_800_000_000_000 + TEST_NOTIFICATION_DELAY_MS),
      }),
    }));
    now.mockRestore();
  });

  it('embeds a stable occurrence ref instead of a client event id', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    await scheduleEventNotification({
      id: 'temporary-row-id',
      sourceEventId: 'series@source',
      title: '项目评审',
      startDate: '2099-07-20',
      startTime: '10:00',
      reminderMinutes: 15,
      color: '#1456F0',
    }, 'user:7');

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        data: expect.objectContaining({
          kind: 'event',
          version: 2,
          eventSourceId: 'series@source',
          eventOccurrenceDate: '2099-07-20',
          notificationScope: 'user:7',
          fingerprint: expect.any(String),
          fireAt: expect.any(String),
        }),
      }),
    }));
  });
});
