import { createNavigationContainerRef } from '@react-navigation/native';
import type { NotificationResponse } from 'expo-notifications';
import * as Notifications from 'expo-notifications';
import type { EventRef, RootStackParamList } from '../types';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from '../services/appStorage';
import { resolveLegacyNotificationEventRef } from '../services/notifications';
import {
  eventRefFromNotificationData,
  sameEventRef,
} from '../utils/eventIdentity';

const LAST_HANDLED_RESPONSE_KEY = '@laoji:lastHandledNotificationResponse:v1';
const PENDING_RESPONSE_KEY = '@laoji:pendingNotificationResponse:v2';

type PendingNotificationTarget = {
  ref: EventRef | null;
  legacyEventId?: string;
  notificationScope: string | null;
  responseKey: string;
  capturedAt: number;
};

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let pendingTarget: PendingNotificationTarget | null = null;
let responseQueue: Promise<void> = Promise.resolve();
let lastHandledResponseKey: string | null = null;
let activeScope: string | null = null;
let eventResolver: ((ref: EventRef) => Promise<'found' | 'not-found' | 'retryable' | 'scope-changed'>) | null = null;
let flushInFlight: Promise<boolean> | null = null;
let navigationUnlocked = false;

function notificationResponseKey(response: NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

function canNavigateToEventDetail(): boolean {
  if (!navigationRef.isReady()) return false;
  return navigationRef.getRootState().routeNames.includes('EventDetail');
}

async function markHandled(target: PendingNotificationTarget): Promise<void> {
  lastHandledResponseKey = target.responseKey;
  await setAppStorageItem(LAST_HANDLED_RESPONSE_KEY, target.responseKey);
  if (pendingTarget?.responseKey === target.responseKey) pendingTarget = null;
  await removeAppStorageItem(PENDING_RESPONSE_KEY);
  await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
}

async function flushPendingNotificationNavigationNow(): Promise<boolean> {
  const target = pendingTarget;
  if (!target || !activeScope || !navigationUnlocked) return false;
  if (target.notificationScope && target.notificationScope !== activeScope) {
    await markHandled(target);
    return true;
  }
  const ref = target.ref ?? (target.legacyEventId
    ? await resolveLegacyNotificationEventRef(activeScope, target.legacyEventId)
    : null);
  if (!ref || !canNavigateToEventDetail()) return false;
  if (eventResolver) {
    const resolution = await eventResolver(ref);
    if (pendingTarget?.responseKey !== target.responseKey) return false;
    if (resolution === 'retryable' || resolution === 'scope-changed') return false;
    if (resolution === 'not-found') {
      await markHandled(target);
      return true;
    }
  }

  const current = navigationRef.getCurrentRoute();
  const currentRef = current?.name === 'EventDetail'
    ? (current.params as RootStackParamList['EventDetail'] | undefined)?.eventRef
    : undefined;
  if (!currentRef || !sameEventRef(currentRef, ref)) {
    navigationRef.navigate('EventDetail', { eventRef: ref });
  }
  await markHandled(target);
  return true;
}

export function flushPendingNotificationNavigation(): Promise<boolean> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushPendingNotificationNavigationNow().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

export async function queueNotificationResponse(response: NotificationResponse): Promise<void> {
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const data = response.notification.request.content.data;
  const ref = eventRefFromNotificationData(data);
  const legacyEventId = typeof data?.eventId === 'string' || typeof data?.eventId === 'number'
    ? String(data.eventId)
    : undefined;
  if (!ref && !legacyEventId) return;
  const responseKey = notificationResponseKey(response);
  if (lastHandledResponseKey === responseKey) return;
  const lastHandled = await getAppStorageItem(LAST_HANDLED_RESPONSE_KEY).catch(() => null);
  if (lastHandled === responseKey) {
    lastHandledResponseKey = responseKey;
    return;
  }
  const target: PendingNotificationTarget = {
    ref,
    legacyEventId,
    notificationScope: typeof data?.notificationScope === 'string' ? data.notificationScope : null,
    responseKey,
    capturedAt: Date.now(),
  };
  await setAppStorageItem(PENDING_RESPONSE_KEY, JSON.stringify(target));
  pendingTarget = target;
  await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  await flushPendingNotificationNavigation();
}

function enqueueResponse(response: NotificationResponse): void {
  responseQueue = responseQueue
    .then(() => queueNotificationResponse(response))
    .catch(() => undefined);
}

export function installNotificationNavigationListener(): () => void {
  let active = true;
  const subscription = Notifications.addNotificationResponseReceivedListener(enqueueResponse);
  void getAppStorageItem(PENDING_RESPONSE_KEY)
    .then(async raw => {
      if (!active) return;
      if (raw) {
        try {
          const saved = JSON.parse(raw) as PendingNotificationTarget;
          if (saved && typeof saved.responseKey === 'string') {
            const handled = await getAppStorageItem(LAST_HANDLED_RESPONSE_KEY).catch(() => null);
            if (handled === saved.responseKey) await removeAppStorageItem(PENDING_RESPONSE_KEY);
            else pendingTarget = saved;
          }
        } catch {
          await removeAppStorageItem(PENDING_RESPONSE_KEY);
        }
      }
      await flushPendingNotificationNavigation();
      const response = await Notifications.getLastNotificationResponseAsync();
      if (active && response) enqueueResponse(response);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    subscription.remove();
  };
}

export function setNotificationNavigationScope(scope: string | null): void {
  activeScope = scope;
  if (scope) void flushPendingNotificationNavigation();
}

export function setNotificationEventResolver(
  resolver: typeof eventResolver,
): void {
  eventResolver = resolver;
  if (resolver && activeScope) void flushPendingNotificationNavigation();
}

export function setNotificationNavigationUnlocked(unlocked: boolean): void {
  navigationUnlocked = unlocked;
  if (unlocked && activeScope) void flushPendingNotificationNavigation();
}

export function resetNotificationNavigationForTests(): void {
  pendingTarget = null;
  responseQueue = Promise.resolve();
  lastHandledResponseKey = null;
  activeScope = null;
  eventResolver = null;
  flushInFlight = null;
  navigationUnlocked = false;
}
