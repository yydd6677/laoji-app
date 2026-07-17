import * as Notifications from 'expo-notifications';
import { diagnosticWarn } from './diagnostics';
import { Linking, Platform } from 'react-native';
import { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';
import {
  eventRefForEvent,
  eventRefFromNotificationData,
  eventRefKey,
  eventRefNotificationData,
} from '../utils/eventIdentity';
import { expandEventsForMonths } from '../utils/eventRecurrence';

export const DEFAULT_REMINDER_MINUTES = 15;
export const SOON_REMINDER_DELAY_MS = 1_000;
export const TEST_NOTIFICATION_DELAY_MS = 3_000;
export const EVENT_REMINDER_HORIZON_DAYS = 90;
export const ANDROID_EVENT_REMINDER_LIMIT = 128;
export const IOS_EVENT_REMINDER_LIMIT = 48;

export type ReminderMinutes = number | null;

export interface NotificationPrefs {
  defaultReminderMinutes: ReminderMinutes;
}

export interface NotificationPermissionState {
  status: string;
  granted: boolean;
  canAskAgain: boolean;
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
  'title' | 'startDate' | 'endDate' | 'startTime' | 'isAllDay' | 'reminderMinutes'
> & EventRef & { legacyEventId?: string };

interface EventNotificationRegistration {
  event: NotificationEventSnapshot;
  notificationId: string | null;
  fingerprint: string;
  pendingCancellationIds: string[];
  scheduledFireAt: string | null;
  deliveredAt: string | null;
}

type EventNotificationRegistry = Record<string, EventNotificationRegistration>;

export interface EventNotificationReconcileOptions {
  windowStart?: string;
  windowEnd?: string;
  previousEvents?: CalEvent[];
}

export interface EventNotificationHorizonPlan {
  events: CalEvent[];
  windowStart: string;
  windowEnd: string;
  truncated: boolean;
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
  const ref = eventRefForEvent(event);
  return {
    ...ref,
    legacyEventId: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    startTime: event.startTime,
    isAllDay: event.isAllDay,
    reminderMinutes: event.reminderMinutes,
  };
}

function notificationFingerprint(event: NotificationEventSnapshot): string {
  return JSON.stringify([
    event.sourceEventId,
    event.occurrenceDate,
    event.legacyEventId ?? null,
    event.title,
    event.startDate,
    event.endDate ?? null,
    event.startTime ?? null,
    event.isAllDay ?? false,
    event.reminderMinutes ?? null,
  ]);
}

function registrationFingerprint(registration: Partial<EventNotificationRegistration>): string {
  return typeof registration.fingerprint === 'string' && registration.fingerprint
    ? registration.fingerprint
    : registration.event ? notificationFingerprint(registration.event) : '';
}

function uniqueNotificationIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function snapshotFromScheduledNotification(
  request: Awaited<ReturnType<typeof Notifications.getAllScheduledNotificationsAsync>>[number],
  ref: EventRef,
): NotificationEventSnapshot {
  const data = request.content.data;
  const rawSnapshot = data?.eventSnapshot;
  if (rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)) {
    const saved = rawSnapshot as Partial<NotificationEventSnapshot>;
    if (typeof saved.title === 'string' && typeof saved.startDate === 'string') {
      return {
        ...ref,
        title: saved.title,
        startDate: saved.startDate,
        endDate: typeof saved.endDate === 'string' ? saved.endDate : undefined,
        startTime: typeof saved.startTime === 'string' ? saved.startTime : undefined,
        isAllDay: typeof saved.isAllDay === 'boolean' ? saved.isAllDay : undefined,
        reminderMinutes: saved.reminderMinutes === null || typeof saved.reminderMinutes === 'number'
          ? saved.reminderMinutes
          : undefined,
        legacyEventId: typeof saved.legacyEventId === 'string' ? saved.legacyEventId : undefined,
      };
    }
  }
  return {
    ...ref,
    title: typeof request.content.body === 'string' ? request.content.body : '',
    startDate: ref.occurrenceDate,
    reminderMinutes: null,
  };
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
  let parsed: unknown = null;
  try {
    const raw = await getAppStorageItem(registryKeyForScope(scope));
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const normalized: EventNotificationRegistry = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const registration = value as Partial<EventNotificationRegistration>;
      const event = registration.event as (Partial<NotificationEventSnapshot> & { id?: string }) | undefined;
      if (!event || typeof event.title !== 'string' || typeof event.startDate !== 'string') continue;
      const ref = typeof event.sourceEventId === 'string' && typeof event.occurrenceDate === 'string'
        ? { sourceEventId: event.sourceEventId, occurrenceDate: event.occurrenceDate }
        : {
          sourceEventId: typeof event.id === 'string' ? event.id.replace(/@(\d{4}-\d{2}-\d{2})$/, '') : '',
          occurrenceDate: event.startDate,
        };
      if (!ref.sourceEventId) continue;
      const snapshot: NotificationEventSnapshot = {
        sourceEventId: ref.sourceEventId,
        occurrenceDate: ref.occurrenceDate,
        title: event.title,
        startDate: event.startDate,
        endDate: event.endDate,
        startTime: event.startTime,
        isAllDay: event.isAllDay,
        reminderMinutes: event.reminderMinutes,
        legacyEventId: typeof event.legacyEventId === 'string'
          ? event.legacyEventId
          : typeof event.id === 'string' ? event.id : undefined,
      };
      normalized[eventRefKey(ref)] = {
        event: snapshot,
        notificationId: typeof registration.notificationId === 'string'
          ? registration.notificationId
          : null,
        fingerprint: typeof registration.fingerprint === 'string'
          ? registration.fingerprint
          : notificationFingerprint(snapshot),
        pendingCancellationIds: Array.isArray(registration.pendingCancellationIds)
          ? uniqueNotificationIds(registration.pendingCancellationIds)
          : [],
        scheduledFireAt: typeof registration.scheduledFireAt === 'string'
          ? registration.scheduledFireAt
          : null,
        deliveredAt: typeof registration.deliveredAt === 'string'
          ? registration.deliveredAt
          : null,
      };
    }
  }

  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const scheduledByRef = new Map<string, typeof scheduled>();
    for (const request of scheduled) {
      const data = request.content.data;
      if (data?.notificationScope !== scope) continue;
      const ref = eventRefFromNotificationData(data);
      if (!ref) continue;
      const key = eventRefKey(ref);
      scheduledByRef.set(key, [...(scheduledByRef.get(key) ?? []), request]);
    }

    for (const [key, registration] of Object.entries(normalized)) {
      const requests = scheduledByRef.get(key) ?? [];
      const persistedFingerprint = registrationFingerprint(registration);
      const canonical = requests.find(request => request.identifier === registration.notificationId)
        ?? requests.find(request => request.content.data?.fingerprint === persistedFingerprint)
        ?? requests[0];
      if (!canonical) {
        const fireAtMs = registration.scheduledFireAt
          ? Date.parse(registration.scheduledFireAt)
          : Number.NaN;
        // DEVICE-NOTIFICATION-001: a fired request disappears from the OS
        // scheduled list. Keep its durable id and mark it delivered so a late
        // reminder is not recreated every time the app returns to foreground.
        if (registration.notificationId && Number.isFinite(fireAtMs) && fireAtMs <= Date.now()) {
          registration.deliveredAt = registration.deliveredAt ?? registration.scheduledFireAt;
          registration.pendingCancellationIds = [];
          continue;
        }
        registration.notificationId = null;
        registration.scheduledFireAt = null;
        registration.deliveredAt = null;
        registration.pendingCancellationIds = [];
        continue;
      }

      const recoveredFingerprint = typeof canonical.content.data?.fingerprint === 'string'
        ? canonical.content.data.fingerprint
        : persistedFingerprint;
      if (recoveredFingerprint && recoveredFingerprint !== persistedFingerprint) {
        registration.event = snapshotFromScheduledNotification(canonical, {
          sourceEventId: registration.event.sourceEventId,
          occurrenceDate: registration.event.occurrenceDate,
        });
      }
      registration.notificationId = canonical.identifier;
      registration.fingerprint = recoveredFingerprint || notificationFingerprint(registration.event);
      registration.scheduledFireAt = typeof canonical.content.data?.fireAt === 'string'
        ? canonical.content.data.fireAt
        : registration.scheduledFireAt;
      registration.deliveredAt = null;
      registration.pendingCancellationIds = uniqueNotificationIds([
        ...registration.pendingCancellationIds,
        ...requests
          .filter(request => request.identifier !== canonical.identifier)
          .map(request => request.identifier),
      ]).filter(id => requests.some(request => request.identifier === id));
      scheduledByRef.delete(key);
    }

    for (const [key, requests] of scheduledByRef) {
      const canonical = requests[0];
      const ref = eventRefFromNotificationData(canonical.content.data);
      if (!ref) continue;
      const event = snapshotFromScheduledNotification(canonical, ref);
      normalized[key] = {
        event,
        notificationId: canonical.identifier,
        fingerprint: typeof canonical.content.data?.fingerprint === 'string'
          ? canonical.content.data.fingerprint
          : notificationFingerprint(event),
        pendingCancellationIds: requests.slice(1).map(request => request.identifier),
        scheduledFireAt: typeof canonical.content.data?.fireAt === 'string'
          ? canonical.content.data.fireAt
          : null,
        deliveredAt: null,
      };
    }
  } catch {
    // Registry data remains usable when the OS cannot enumerate notifications.
  }
  return normalized;
}

export async function resolveLegacyNotificationEventRef(
  scope: string,
  legacyEventId: string,
): Promise<EventRef | null> {
  const registry = await loadEventNotificationRegistry(scope);
  for (const registration of Object.values(registry)) {
    if (registration.event.legacyEventId === legacyEventId) {
      return {
        sourceEventId: registration.event.sourceEventId,
        occurrenceDate: registration.event.occurrenceDate,
      };
    }
  }
  const suffix = /^(.*)@(\d{4}-\d{2}-\d{2})$/.exec(legacyEventId);
  return suffix ? { sourceEventId: suffix[1], occurrenceDate: suffix[2] } : null;
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
  const uniqueIds = uniqueNotificationIds(ids);
  const results = await Promise.all(uniqueIds.map(cancelEventNotification));
  if (results.some(cancelled => !cancelled)) throw new Error('notification cancellation failed');
}

async function scheduleForScope(
  scope: string,
  event: CalEvent,
): Promise<{ notificationId: string | null; fireAt: Date | null }> {
  if (!isDesiredScope(scope)) return { notificationId: null, fireAt: null };
  const fireAt = reminderFireDate(event);
  if (!fireAt) return { notificationId: null, fireAt: null };
  const notificationId = await scheduleEventNotification(event, scope, fireAt);
  if (!notificationId || isDesiredScope(scope)) return { notificationId, fireAt };
  await cancelNotificationIds([notificationId]);
  return { notificationId: null, fireAt: null };
}

async function syncRegistryEvent(
  scope: string,
  registry: EventNotificationRegistry,
  event: CalEvent,
): Promise<string | null> {
  const nextSnapshot = notificationSnapshot(event);
  const nextFingerprint = notificationFingerprint(nextSnapshot);
  const key = eventRefKey(eventRefForEvent(event));
  const existing = registry[key];
  const unchanged = existing
    && registrationFingerprint(existing) === nextFingerprint;

  if (unchanged && existing.deliveredAt) {
    await cancelNotificationIds([
      ...existing.pendingCancellationIds,
      event.notificationId !== existing.notificationId ? event.notificationId : null,
    ]);
    registry[key] = {
      event: nextSnapshot,
      notificationId: existing.notificationId,
      fingerprint: nextFingerprint,
      pendingCancellationIds: [],
      scheduledFireAt: existing.scheduledFireAt,
      deliveredAt: existing.deliveredAt,
    };
    return existing.notificationId;
  }

  if (unchanged && existing.notificationId) {
    await cancelNotificationIds([
      ...existing.pendingCancellationIds,
      event.notificationId !== existing.notificationId ? event.notificationId : null,
    ]);
    registry[key] = {
      event: nextSnapshot,
      notificationId: existing.notificationId,
      fingerprint: nextFingerprint,
      pendingCancellationIds: [],
      scheduledFireAt: existing.scheduledFireAt,
      deliveredAt: null,
    };
    return existing.notificationId;
  }

  await cancelNotificationIds([
    existing?.notificationId,
    ...(existing?.pendingCancellationIds ?? []),
    event.notificationId,
  ]);
  const { notificationId, fireAt } = await scheduleForScope(scope, event);
  registry[key] = {
    event: nextSnapshot,
    notificationId,
    fingerprint: nextFingerprint,
    pendingCancellationIds: [],
    scheduledFireAt: fireAt?.toISOString() ?? null,
    deliveredAt: null,
  };
  return notificationId;
}

async function deactivateNotificationScope(scope: string): Promise<void> {
  const registry = await loadEventNotificationRegistry(scope);
  await cancelNotificationIds(Object.values(registry).flatMap(entry => [
    entry.notificationId,
    ...entry.pendingCancellationIds,
  ]));
  const inactive = Object.fromEntries(Object.entries(registry).map(([eventId, entry]) => [
    eventId,
    {
      ...entry,
      notificationId: null,
      pendingCancellationIds: [],
      scheduledFireAt: null,
      deliveredAt: null,
    },
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

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function reminderHorizonMonthKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  for (
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    cursor <= end;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  ) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

export function planEventNotificationHorizon(
  catalog: CalEvent[],
  now = new Date(),
  horizonDays = EVENT_REMINDER_HORIZON_DAYS,
  limit = Platform.OS === 'ios' ? IOS_EVENT_REMINDER_LIMIT : ANDROID_EVENT_REMINDER_LIMIT,
): EventNotificationHorizonPlan {
  const windowStart = formatLocalDate(now);
  const horizonEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + horizonDays);
  const fullWindowEnd = formatLocalDate(horizonEnd);
  const byRef = new Map<string, { event: CalEvent; fireAt: Date }>();
  for (const event of expandEventsForMonths(
    catalog,
    reminderHorizonMonthKeys(now, horizonEnd),
  )) {
    if (event.startDate < windowStart || event.startDate > fullWindowEnd) continue;
    const fireAt = reminderFireDate(event, now);
    if (!fireAt) continue;
    byRef.set(eventRefKey(eventRefForEvent(event)), { event, fireAt });
  }
  const candidates = [...byRef.values()].sort((left, right) => (
    left.fireAt.getTime() - right.fireAt.getTime()
    || left.event.title.localeCompare(right.event.title, 'zh-Hans-CN')
  ));
  const safeLimit = Math.max(0, Math.trunc(limit));
  const selected = candidates.slice(0, safeLimit);
  const truncated = candidates.length > selected.length;
  return {
    events: selected.map(item => item.event),
    windowStart,
    windowEnd: fullWindowEnd,
    truncated,
  };
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
  return (await getNotificationPermissionState()).status;
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const current = await Notifications.getPermissionsAsync();
  return {
    status: current.status,
    granted: current.granted || current.status === 'granted',
    canAskAgain: current.canAskAgain !== false,
  };
}

export async function prepareNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(EVENT_NOTIFICATION_CHANNEL_ID, {
    name: '日程提醒',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });
}

export async function ensureNotificationPermission(): Promise<boolean> {
  await prepareNotificationChannel();
  const current = await getNotificationPermissionState();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted || requested.status === 'granted';
}

export async function openNotificationSettings(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
        { key: 'android.provider.extra.APP_PACKAGE', value: 'com.laoji.app' },
      ]);
      return;
    } catch {
      // Older Android builds may not expose the dedicated notification settings intent.
    }
  }
  await Linking.openSettings();
}

export async function reminderUnavailableMessage(): Promise<string> {
  const permission = await getNotificationPermissionState().catch(() => null);
  if (permission?.granted) {
    return '系统通知已开启，但本机提醒创建失败。请重新打开日程并保存提醒。';
  }
  return '本机未创建系统提醒，请在“通知与提醒”中检查并开启系统通知。';
}

export async function scheduleTestNotification(): Promise<string> {
  const granted = await ensureNotificationPermission();
  if (!granted) throw new Error('notification permission denied');
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '老记测试提醒',
      body: '通知功能运行正常',
      sound: 'default',
      data: { source: 'notification-settings-test' },
    },
    trigger: notificationDateTrigger(new Date(Date.now() + TEST_NOTIFICATION_DELAY_MS)),
  });
}

export async function scheduleEventNotification(
  event: CalEvent,
  scope: string,
  fireAtOverride?: Date,
): Promise<string | null> {
  const fireAt = fireAtOverride ?? reminderFireDate(event);
  if (!fireAt) return null;

  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return null;

    return await Notifications.scheduleNotificationAsync({
      content: {
        title: '老记日程提醒',
        body: event.title,
        sound: 'default',
        data: {
          kind: 'event',
          version: 2,
          ...eventRefNotificationData(eventRefForEvent(event)),
          notificationScope: scope,
          fingerprint: notificationFingerprint(notificationSnapshot(event)),
          eventSnapshot: notificationSnapshot(event),
          fireAt: fireAt.toISOString(),
        },
      },
      trigger: notificationDateTrigger(fireAt),
    });
  } catch (err) {
    diagnosticWarn('schedule event notification failed', err);
    return null;
  }
}

export async function cancelEventNotification(notificationId?: string | null): Promise<boolean> {
  if (!notificationId) return true;
  const [scheduled] = await Promise.allSettled([
    Notifications.cancelScheduledNotificationAsync(notificationId),
    Notifications.dismissNotificationAsync(notificationId),
  ]);
  return scheduled.status === 'fulfilled';
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
    const incomingByRef = new Map(events.map(event => [eventRefKey(eventRefForEvent(event)), event]));
    const notificationIds: Record<string, string | null> = {};

    for (const [key, registration] of Object.entries(registry)) {
      if (incomingByRef.has(key)) continue;
      if (!overlapsWindow(registration.event, options.windowStart, options.windowEnd)) continue;
      await cancelNotificationIds([
        registration.notificationId,
        ...registration.pendingCancellationIds,
      ]);
      delete registry[key];
    }

    for (const previous of options.previousEvents ?? []) {
      if (incomingByRef.has(eventRefKey(eventRefForEvent(previous)))) continue;
      if (!overlapsWindow(previous, options.windowStart, options.windowEnd)) continue;
      await cancelNotificationIds([previous.notificationId]);
    }

    for (const event of events) {
      notificationIds[event.id] = await syncRegistryEvent(scope, registry, event);
    }
    await saveEventNotificationRegistry(scope, registry);
    return notificationIds;
  });
}

export async function reconcileEventNotificationHorizon(
  scope: string,
  catalog: CalEvent[],
  now = new Date(),
  horizonDays = EVENT_REMINDER_HORIZON_DAYS,
  limit = Platform.OS === 'ios' ? IOS_EVENT_REMINDER_LIMIT : ANDROID_EVENT_REMINDER_LIMIT,
): Promise<Record<string, string | null>> {
  const plan = planEventNotificationHorizon(catalog, now, horizonDays, limit);
  return reconcileEventNotifications(scope, plan.events, {
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
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
      const key = eventRefKey(eventRefForEvent(event));
      ids.push(
        event.notificationId,
        registry[key]?.notificationId,
        ...(registry[key]?.pendingCancellationIds ?? []),
      );
      delete registry[key];
    }
    await cancelNotificationIds(ids);
    await saveEventNotificationRegistry(scope, registry);
  });
}

export function cancelEventNotificationsForMutation(
  scope: string,
  ref: EventRef,
  recurrenceScope: EventRecurrenceScope,
  events: CalEvent[] = [],
): Promise<void> {
  return enqueueNotificationOperation(async () => {
    const registry = await loadEventNotificationRegistry(scope);
    const ids: Array<string | null | undefined> = events.map(event => event.notificationId);
    for (const [key, registration] of Object.entries(registry)) {
      const sameSource = registration.event.sourceEventId === ref.sourceEventId;
      const selected = sameSource && (
        recurrenceScope === 'series'
        || (recurrenceScope === 'occurrence' && registration.event.occurrenceDate === ref.occurrenceDate)
        || (recurrenceScope === 'following' && registration.event.occurrenceDate >= ref.occurrenceDate)
      );
      if (!selected) continue;
      ids.push(registration.notificationId, ...registration.pendingCancellationIds);
      delete registry[key];
    }
    await cancelNotificationIds(ids);
    await saveEventNotificationRegistry(scope, registry);
  });
}
