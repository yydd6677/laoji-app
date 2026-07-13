import * as Notifications from 'expo-notifications';
import { diagnosticWarn } from './diagnostics';
import { Platform } from 'react-native';
import { CalEvent } from '../types';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';

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
const EVENT_NOTIFICATION_REGISTRY_KEY = '@laoji:eventNotificationRegistry:v1';
const ACTIVE_NOTIFICATION_SCOPE_KEY = '@laoji:activeNotificationScope:v1';
const EVENT_NOTIFICATION_CHANNEL_ID = 'laoji-events';

type NotificationEventSnapshot = Pick<
  CalEvent,
  'id' | 'title' | 'startDate' | 'endDate' | 'startTime' | 'isAllDay' | 'reminderMinutes'
>;

interface EventNotificationRegistration {
  event: NotificationEventSnapshot;
  notificationId: string | null;
}

type EventNotificationRegistry = Record<string, EventNotificationRegistration>;

export interface EventNotificationReconcileOptions {
  windowStart?: string;
  windowEnd?: string;
  previousEvents?: CalEvent[];
}

let desiredActiveScope: string | null | undefined;
let notificationOperationQueue: Promise<void> = Promise.resolve();

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

function registryKeyForScope(scope: string): string {
  return `${EVENT_NOTIFICATION_REGISTRY_KEY}:${scope}`;
}

function enqueueNotificationOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = notificationOperationQueue.then(operation, operation);
  notificationOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function notificationSnapshot(event: CalEvent): NotificationEventSnapshot {
  return {
    id: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    startTime: event.startTime,
    isAllDay: event.isAllDay,
    reminderMinutes: event.reminderMinutes,
  };
}

function notificationFingerprint(event: NotificationEventSnapshot): string {
  return JSON.stringify(event);
}

function overlapsWindow(
  event: Pick<NotificationEventSnapshot, 'startDate' | 'endDate'>,
  windowStart?: string,
  windowEnd?: string,
): boolean {
  if (!windowStart || !windowEnd) return true;
  return event.startDate <= windowEnd && (event.endDate ?? event.startDate) >= windowStart;
}

function isDesiredScope(scope: string): boolean {
  return desiredActiveScope === undefined || desiredActiveScope === scope;
}

async function loadEventNotificationRegistry(scope: string): Promise<EventNotificationRegistry> {
  try {
    const raw = await getAppStorageItem(registryKeyForScope(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as EventNotificationRegistry;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveEventNotificationRegistry(scope: string, registry: EventNotificationRegistry): Promise<void> {
  const key = registryKeyForScope(scope);
  if (Object.keys(registry).length === 0) {
    await removeAppStorageItem(key);
    return;
  }
  await setAppStorageItem(key, JSON.stringify(registry));
}

async function cancelNotificationIds(ids: Array<string | null | undefined>): Promise<void> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  await Promise.all(uniqueIds.map(cancelEventNotification));
}

async function scheduleForScope(scope: string, event: CalEvent): Promise<string | null> {
  if (!isDesiredScope(scope)) return null;
  const notificationId = await scheduleEventNotification(event);
  if (!notificationId || isDesiredScope(scope)) return notificationId;
  await cancelEventNotification(notificationId);
  return null;
}

async function syncRegistryEvent(
  scope: string,
  registry: EventNotificationRegistry,
  event: CalEvent,
): Promise<string | null> {
  const nextSnapshot = notificationSnapshot(event);
  const existing = registry[event.id];
  const unchanged = existing
    && notificationFingerprint(existing.event) === notificationFingerprint(nextSnapshot);

  if (unchanged && existing.notificationId) {
    if (event.notificationId && event.notificationId !== existing.notificationId) {
      await cancelEventNotification(event.notificationId);
    }
    return existing.notificationId;
  }

  await cancelNotificationIds([existing?.notificationId, event.notificationId]);
  const notificationId = await scheduleForScope(scope, event);
  registry[event.id] = { event: nextSnapshot, notificationId };
  return notificationId;
}

async function deactivateNotificationScope(scope: string): Promise<void> {
  const registry = await loadEventNotificationRegistry(scope);
  await cancelNotificationIds(Object.values(registry).map(entry => entry.notificationId));
  const inactive = Object.fromEntries(Object.entries(registry).map(([eventId, entry]) => [
    eventId,
    { ...entry, notificationId: null },
  ]));
  await saveEventNotificationRegistry(scope, inactive);
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
    const raw = await getAppStorageItem(keyForScope(scope));
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
  await setAppStorageItem(keyForScope(scope), JSON.stringify(prefs));
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
    diagnosticWarn('schedule event notification failed', err);
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

export function switchEventNotificationScope(
  previousScope: string | null,
  nextScope: string | null,
  previousEvents: CalEvent[] = [],
): Promise<void> {
  desiredActiveScope = nextScope;
  return enqueueNotificationOperation(async () => {
    if (desiredActiveScope !== nextScope) return;

    const storedScope = await getAppStorageItem(ACTIVE_NOTIFICATION_SCOPE_KEY);
    const scopesToDeactivate = new Set(
      [storedScope, previousScope].filter((scope): scope is string => Boolean(scope) && scope !== nextScope),
    );
    for (const scope of scopesToDeactivate) {
      await deactivateNotificationScope(scope);
    }
    if (previousScope && scopesToDeactivate.has(previousScope)) {
      await cancelNotificationIds(previousEvents.map(event => event.notificationId));
    }

    if (desiredActiveScope !== nextScope) return;
    if (nextScope) await setAppStorageItem(ACTIVE_NOTIFICATION_SCOPE_KEY, nextScope);
    else await removeAppStorageItem(ACTIVE_NOTIFICATION_SCOPE_KEY);
  });
}

export function reconcileEventNotifications(
  scope: string,
  events: CalEvent[],
  options: EventNotificationReconcileOptions = {},
): Promise<Record<string, string | null>> {
  return enqueueNotificationOperation(async () => {
    if (!isDesiredScope(scope)) return {};

    const registry = await loadEventNotificationRegistry(scope);
    const incomingById = new Map(events.map(event => [event.id, event]));
    const notificationIds: Record<string, string | null> = {};

    for (const [eventId, registration] of Object.entries(registry)) {
      if (incomingById.has(eventId)) continue;
      if (!overlapsWindow(registration.event, options.windowStart, options.windowEnd)) continue;
      await cancelEventNotification(registration.notificationId);
      delete registry[eventId];
    }

    for (const previous of options.previousEvents ?? []) {
      if (incomingById.has(previous.id)) continue;
      if (!overlapsWindow(previous, options.windowStart, options.windowEnd)) continue;
      await cancelEventNotification(previous.notificationId);
    }

    for (const event of events) {
      notificationIds[event.id] = await syncRegistryEvent(scope, registry, event);
    }
    await saveEventNotificationRegistry(scope, registry);
    return notificationIds;
  });
}

export function scheduleEventNotificationForScope(scope: string, event: CalEvent): Promise<string | null> {
  return enqueueNotificationOperation(async () => {
    if (!isDesiredScope(scope)) return null;
    const registry = await loadEventNotificationRegistry(scope);
    const notificationId = await syncRegistryEvent(scope, registry, event);
    await saveEventNotificationRegistry(scope, registry);
    return notificationId;
  });
}

export function cancelEventNotificationsForScope(scope: string, events: CalEvent[]): Promise<void> {
  return enqueueNotificationOperation(async () => {
    const registry = await loadEventNotificationRegistry(scope);
    const ids: Array<string | null | undefined> = [];
    for (const event of events) {
      ids.push(event.notificationId, registry[event.id]?.notificationId);
      delete registry[event.id];
    }
    await cancelNotificationIds(ids);
    await saveEventNotificationRegistry(scope, registry);
  });
}

export async function rescheduleEventNotification(previousId: string | null | undefined, event: CalEvent): Promise<string | null> {
  await cancelEventNotification(previousId);
  return scheduleEventNotification(event);
}
