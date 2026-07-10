import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { CalEvent } from '../types';

export const DEFAULT_REMINDER_MINUTES = 15;
export const SOON_REMINDER_DELAY_MS = 1_000;

export type ReminderMinutes = number | null;

export interface NotificationPrefs {
  defaultReminderMinutes: ReminderMinutes;
}

export const REMINDER_OPTIONS: { label: string; value: ReminderMinutes }[] = [
  { label: '不提醒', value: null },
  { label: '开始时', value: 0 },
  { label: '5分钟前', value: 5 },
  { label: '15分钟前', value: 15 },
  { label: '30分钟前', value: 30 },
  { label: '1小时前', value: 60 },
];

const PREFS_KEY = '@laoji:notificationPrefs:v1';
const EVENT_NOTIFICATION_CHANNEL_ID = 'laoji-events';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function keyForScope(scope: string): string {
  return `${PREFS_KEY}:${scope}`;
}

export function labelForReminder(value: ReminderMinutes): string {
  return REMINDER_OPTIONS.find(item => item.value === value)?.label ?? `${value}分钟前`;
}

export function defaultReminderForEvent(isAllDay?: boolean, startTime?: string, preferred: ReminderMinutes = DEFAULT_REMINDER_MINUTES): ReminderMinutes {
  if (isAllDay || !startTime) return null;
  return preferred;
}

export function parseEventDateTime(dateStr: string, timeStr?: string): Date | null {
  if (!timeStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function reminderFireDate(event: Pick<CalEvent, 'startDate' | 'startTime' | 'isAllDay' | 'reminderMinutes'>, now = new Date()): Date | null {
  if (event.isAllDay || event.reminderMinutes == null) return null;
  const start = parseEventDateTime(event.startDate, event.startTime);
  if (!start) return null;
  const fireAt = new Date(start.getTime() - event.reminderMinutes * 60 * 1000);
  if (fireAt.getTime() > now.getTime()) return fireAt;
  if (start.getTime() <= now.getTime()) return null;
  const soon = new Date(now.getTime() + SOON_REMINDER_DELAY_MS);
  return soon.getTime() < start.getTime() ? soon : start;
}

export function notificationDateTrigger(date: Date): Notifications.DateTriggerInput {
  const base: Notifications.DateTriggerInput = {
    type: 'date' as Notifications.SchedulableTriggerInputTypes.DATE,
    date,
  };
  if (Platform.OS !== 'android') return base;
  return { ...base, channelId: EVENT_NOTIFICATION_CHANNEL_ID };
}

export async function loadNotificationPrefs(scope: string): Promise<NotificationPrefs> {
  try {
    const raw = await AsyncStorage.getItem(keyForScope(scope));
    if (!raw) return { defaultReminderMinutes: DEFAULT_REMINDER_MINUTES };
    const saved = JSON.parse(raw);
    const value = saved.defaultReminderMinutes;
    return {
      defaultReminderMinutes: value === null || Number.isFinite(value) ? value : DEFAULT_REMINDER_MINUTES,
    };
  } catch {
    return { defaultReminderMinutes: DEFAULT_REMINDER_MINUTES };
  }
}

export async function saveNotificationPrefs(scope: string, prefs: NotificationPrefs): Promise<void> {
  await AsyncStorage.setItem(keyForScope(scope), JSON.stringify(prefs));
}

export async function getNotificationPermissionStatus(): Promise<string> {
  const current = await Notifications.getPermissionsAsync();
  return current.status;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.status === 'granted') return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted || requested.status === 'granted';
}

export async function scheduleEventNotification(event: CalEvent): Promise<string | null> {
  const fireAt = reminderFireDate(event);
  if (!fireAt) return null;

  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(EVENT_NOTIFICATION_CHANNEL_ID, {
        name: '日程提醒',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    return await Notifications.scheduleNotificationAsync({
      content: {
        title: '老记日程提醒',
        body: event.title,
        sound: 'default',
        data: { eventId: event.id },
      },
      trigger: notificationDateTrigger(fireAt),
    });
  } catch (err) {
    console.warn('schedule event notification failed', err);
    return null;
  }
}

export async function cancelEventNotification(notificationId?: string | null): Promise<void> {
  if (!notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch {
    // The notification may have already fired or been cleared by the OS.
  }
}

export async function rescheduleEventNotification(previousId: string | null | undefined, event: CalEvent): Promise<string | null> {
  await cancelEventNotification(previousId);
  return scheduleEventNotification(event);
}
