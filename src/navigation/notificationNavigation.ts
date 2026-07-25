import { createNavigationContainerRef } from '@react-navigation/native';
import type { NotificationResponse } from 'expo-notifications';
import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';
import type { EventRef, RootStackParamList } from '../types';
import type { OccurrenceMeetingOpenTarget } from '../application/meeting';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from '../services/appStorage';
import {
  EVENT_START_OR_RESUME_ACTION_IDENTIFIER,
  MEETING_PLANNED_END_NOTIFICATION_KIND,
  resolveLegacyNotificationEventRef,
} from '../services/notifications';
import {
  eventRefFromNotificationData,
  sameEventRef,
} from '../utils/eventIdentity';
import {
  parseLaojiSemanticLink,
  semanticEventIntent,
  type SemanticEventOrigin,
} from './semanticLinks';

const LAST_HANDLED_RESPONSE_KEY = '@laoji:lastHandledNotificationResponse:v1';
const PENDING_RESPONSE_KEY = '@laoji:pendingNotificationResponse:v2';

export type NotificationResolution = 'found' | 'not-found' | 'retryable' | 'scope-changed';
type EventNotificationIntent = 'open-event' | 'start-or-resume-meeting';

export type OccurrenceMeetingNotificationResolution =
  | { status: 'found'; target: OccurrenceMeetingOpenTarget }
  | { status: Exclude<NotificationResolution, 'found'> };

export type QuickTileMeetingResolution =
  | { status: 'found'; params: NonNullable<RootStackParamList['MeetingLive']> }
  | { status: Exclude<NotificationResolution, 'found'> };

type PendingNotificationTargetBase = {
  source: 'notification' | 'semantic-link';
  notificationId: string | null;
  notificationScope: string | null;
  responseKey: string;
  capturedAt: number;
};

type PendingEventNotificationTarget = PendingNotificationTargetBase & {
  kind: 'event';
  intent: EventNotificationIntent;
  origin: SemanticEventOrigin;
  ref: EventRef | null;
  legacyEventId?: string;
};

type PendingMeetingActionNotificationTarget = PendingNotificationTargetBase & {
  kind: 'meeting-action';
  meetingId: string;
  canonicalMeetingId: string | null;
  actionId: string;
};

type PendingQuickTileTarget = PendingNotificationTargetBase & {
  kind: 'quick-tile';
  origin: 'quick_tile';
};

type PendingSharedActionTarget = PendingNotificationTargetBase & {
  kind: 'shared-action';
  token: string;
};

type PendingNotificationTarget =
  | PendingEventNotificationTarget
  | PendingMeetingActionNotificationTarget
  | PendingQuickTileTarget
  | PendingSharedActionTarget;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let pendingTarget: PendingNotificationTarget | null = null;
let responseQueue: Promise<void> = Promise.resolve();
let lastHandledResponseKey: string | null = null;
let activeScope: string | null = null;
let eventResolver: ((ref: EventRef) => Promise<NotificationResolution>) | null = null;
let meetingResolver: ((meetingId: string) => Promise<NotificationResolution>) | null = null;
let occurrenceMeetingResolver: (
  (ref: EventRef, entryPoint: 'notification' | 'widget') => Promise<OccurrenceMeetingNotificationResolution>
) | null = null;
let quickTileMeetingResolver: (() => Promise<QuickTileMeetingResolution>) | null = null;
let flushInFlight: Promise<boolean> | null = null;
let navigationUnlocked = false;
let semanticLinkSequence = 0;

function notificationResponseKey(response: NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

function canNavigateTo(routeName: keyof RootStackParamList): boolean {
  if (!navigationRef.isReady()) return false;
  return navigationRef.getRootState().routeNames.includes(routeName);
}

function navigateToOccurrenceMeeting(target: OccurrenceMeetingOpenTarget): void {
  const current = navigationRef.getCurrentRoute();
  if (target.route === 'Transcription') {
    const currentParams = current?.name === 'Transcription'
      ? current.params as RootStackParamList['Transcription'] | undefined
      : undefined;
    if (current?.name !== 'Transcription' || currentParams?.meetingId !== target.params.meetingId) {
      navigationRef.navigate('Transcription', target.params);
    }
    return;
  }
  const currentParams = current?.name === 'MeetingLive'
    ? current.params as RootStackParamList['MeetingLive']
    : undefined;
  if (
    current?.name !== 'MeetingLive'
    || currentParams?.meetingId !== target.params.meetingId
    || currentParams?.startRequested !== target.params.startRequested
  ) {
    navigationRef.navigate('MeetingLive', target.params);
  }
}

async function markHandled(target: PendingNotificationTarget): Promise<void> {
  if (target.source === 'notification') {
    lastHandledResponseKey = target.responseKey;
    await setAppStorageItem(LAST_HANDLED_RESPONSE_KEY, target.responseKey);
  }
  if (pendingTarget?.responseKey === target.responseKey) pendingTarget = null;
  await removeAppStorageItem(PENDING_RESPONSE_KEY);
  if (target.notificationId) {
    await Notifications.dismissNotificationAsync(target.notificationId).catch(() => undefined);
  }
  if (target.source === 'notification') {
    await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }
}

async function flushPendingNotificationNavigationNow(): Promise<boolean> {
  const target = pendingTarget;
  if (!target || !activeScope || !navigationUnlocked) return false;
  if (target.notificationScope && target.notificationScope !== activeScope) {
    await markHandled(target);
    return true;
  }
  if (target.kind === 'quick-tile') {
    if (!quickTileMeetingResolver || !canNavigateTo('MeetingLive')) return false;
    const resolution = await quickTileMeetingResolver();
    if (pendingTarget?.responseKey !== target.responseKey) return false;
    if (resolution.status !== 'found') {
      if (resolution.status === 'not-found') {
        await markHandled(target);
        return true;
      }
      return false;
    }
    const current = navigationRef.getCurrentRoute();
    const currentParams = current?.name === 'MeetingLive'
      ? current.params as RootStackParamList['MeetingLive']
      : undefined;
    if (
      current?.name !== 'MeetingLive'
      || currentParams?.meetingId !== resolution.params.meetingId
      || currentParams?.startRequested !== resolution.params.startRequested
      || currentParams?.entryPoint !== resolution.params.entryPoint
    ) {
      navigationRef.navigate('MeetingLive', resolution.params);
    }
    await markHandled(target);
    return true;
  }
  if (target.kind === 'meeting-action') {
    if (!canNavigateTo('Transcription')) return false;
    if (meetingResolver) {
      const resolution = await meetingResolver(target.meetingId);
      if (pendingTarget?.responseKey !== target.responseKey) return false;
      if (resolution === 'retryable' || resolution === 'scope-changed') return false;
      if (resolution === 'not-found') {
        await markHandled(target);
        return true;
      }
    }
    const params: RootStackParamList['Transcription'] = {
      meetingId: target.meetingId,
      focus: 'summary',
      actionId: target.actionId,
      actionFocusRequestId: target.capturedAt,
    };
    const current = navigationRef.getCurrentRoute();
    const currentParams = current?.name === 'Transcription'
      ? current.params as RootStackParamList['Transcription'] | undefined
      : undefined;
    if (
      current?.name !== 'Transcription'
      || currentParams?.meetingId !== target.meetingId
      || currentParams.actionId !== target.actionId
      || currentParams.actionFocusRequestId !== target.capturedAt
    ) {
      navigationRef.navigate('Transcription', params);
    }
    await markHandled(target);
    return true;
  }
  if (target.kind === 'shared-action') {
    if (!canNavigateTo('SharedAction')) return false;
    const current = navigationRef.getCurrentRoute();
    const params = current?.name === 'SharedAction'
      ? current.params as RootStackParamList['SharedAction'] | undefined
      : undefined;
    if (current?.name !== 'SharedAction' || params?.token !== target.token) {
      navigationRef.navigate('SharedAction', { token: target.token });
    }
    await markHandled(target);
    return true;
  }
  const ref = target.ref ?? (target.legacyEventId
    ? await resolveLegacyNotificationEventRef(activeScope, target.legacyEventId)
    : null);
  if (!ref) return false;
  if (target.intent === 'start-or-resume-meeting') {
    if (
      !occurrenceMeetingResolver
      || !canNavigateTo('MeetingLive')
      || !canNavigateTo('Transcription')
    ) return false;
    const resolution = await occurrenceMeetingResolver(
      ref,
      target.origin === 'widget' ? 'widget' : 'notification',
    );
    if (pendingTarget?.responseKey !== target.responseKey) return false;
    if (target.notificationScope && target.notificationScope !== activeScope) {
      await markHandled(target);
      return true;
    }
    if (resolution.status !== 'found') {
      if (resolution.status === 'not-found') {
        await markHandled(target);
        return true;
      }
      return false;
    }
    navigateToOccurrenceMeeting(resolution.target);
    await markHandled(target);
    return true;
  }
  if (!canNavigateTo('EventDetail')) return false;
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
  const data = response.notification.request.content.data;
  const defaultAction = response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;
  const occurrenceMeetingAction = response.actionIdentifier === EVENT_START_OR_RESUME_ACTION_IDENTIFIER
    && data?.kind === 'event';
  if (!defaultAction && !occurrenceMeetingAction) return;
  const responseKey = notificationResponseKey(response);
  if (lastHandledResponseKey === responseKey) return;
  const lastHandled = await getAppStorageItem(LAST_HANDLED_RESPONSE_KEY).catch(() => null);
  if (lastHandled === responseKey) {
    lastHandledResponseKey = responseKey;
    return;
  }
  if (defaultAction && data?.kind === MEETING_PLANNED_END_NOTIFICATION_KIND) {
    const notificationId = response.notification.request.identifier || null;
    if (notificationId) {
      await Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    }
    await setAppStorageItem(LAST_HANDLED_RESPONSE_KEY, responseKey).catch(() => undefined);
    lastHandledResponseKey = responseKey;
    await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    return;
  }
  const notificationScope = typeof data?.notificationScope === 'string' ? data.notificationScope : null;
  const notificationId = response.notification.request.identifier || null;
  const capturedAt = Date.now();
  let target: PendingNotificationTarget;
  if (data?.kind === 'meeting-action') {
    const meetingId = typeof data.meetingId === 'string' ? data.meetingId.trim() : '';
    const actionId = typeof data.actionId === 'string' ? data.actionId.trim() : '';
    if (!meetingId || !actionId) return;
    target = {
      source: 'notification',
      kind: 'meeting-action',
      meetingId,
      canonicalMeetingId: typeof data.canonicalMeetingId === 'string'
        ? data.canonicalMeetingId.trim() || null
        : null,
      actionId,
      notificationId,
      notificationScope,
      responseKey,
      capturedAt,
    };
  } else {
    const ref = eventRefFromNotificationData(data);
    const legacyEventId = typeof data?.eventId === 'string' || typeof data?.eventId === 'number'
      ? String(data.eventId)
      : undefined;
    const semanticIntent = ref
      ? semanticEventIntent(
          ref,
          occurrenceMeetingAction ? 'start-or-resume-meeting' : 'open-event',
          'notification',
        )
      : null;
    if (ref && !semanticIntent) return;
    if (!semanticIntent && !legacyEventId) return;
    target = {
      source: 'notification',
      kind: 'event',
      intent: semanticIntent?.action
        ?? (occurrenceMeetingAction ? 'start-or-resume-meeting' : 'open-event'),
      origin: 'notification',
      ref: semanticIntent?.ref ?? null,
      legacyEventId,
      notificationId,
      notificationScope,
      responseKey,
      capturedAt,
    };
  }
  await setAppStorageItem(PENDING_RESPONSE_KEY, JSON.stringify(target));
  pendingTarget = target;
  await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  await flushPendingNotificationNavigation();
}

export async function queueSemanticLink(rawUrl: string): Promise<void> {
  const intent = parseLaojiSemanticLink(rawUrl);
  if (!intent) return;
  const capturedAt = Date.now();
  semanticLinkSequence += 1;
  const base: PendingNotificationTargetBase = {
    source: 'semantic-link',
    notificationId: null,
    notificationScope: null,
    responseKey: `semantic-link:${capturedAt}:${semanticLinkSequence}`,
    capturedAt,
  };
  const target: PendingNotificationTarget = intent.kind === 'new-meeting'
    ? { ...base, kind: 'quick-tile', origin: 'quick_tile' }
    : intent.kind === 'shared-action'
      ? { ...base, kind: 'shared-action', token: intent.token }
      : {
        ...base,
        kind: 'event',
        intent: intent.action,
        origin: intent.origin,
        ref: intent.ref,
      };
  await setAppStorageItem(PENDING_RESPONSE_KEY, JSON.stringify(target));
  pendingTarget = target;
  await flushPendingNotificationNavigation();
}

function enqueueResponse(response: NotificationResponse): void {
  responseQueue = responseQueue
    .then(() => queueNotificationResponse(response))
    .catch(() => undefined);
}

function restoredPendingTarget(value: unknown): PendingNotificationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  if (typeof saved.responseKey !== 'string' || !saved.responseKey) return null;
  const base: PendingNotificationTargetBase = {
    source: saved.source === 'semantic-link' ? 'semantic-link' : 'notification',
    notificationId: typeof saved.notificationId === 'string' ? saved.notificationId.trim() || null : null,
    notificationScope: typeof saved.notificationScope === 'string' ? saved.notificationScope : null,
    responseKey: saved.responseKey,
    capturedAt: Number.isSafeInteger(saved.capturedAt) && (saved.capturedAt as number) >= 0
      ? saved.capturedAt as number
      : Date.now(),
  };
  if (saved.kind === 'quick-tile') {
    if (base.source !== 'semantic-link' || saved.origin !== 'quick_tile') return null;
    return { ...base, kind: 'quick-tile', origin: 'quick_tile' };
  }
  if (saved.kind === 'meeting-action') {
    const meetingId = typeof saved.meetingId === 'string' ? saved.meetingId.trim() : '';
    const actionId = typeof saved.actionId === 'string' ? saved.actionId.trim() : '';
    if (!meetingId || !actionId) return null;
    return {
      ...base,
      kind: 'meeting-action',
      meetingId,
      canonicalMeetingId: typeof saved.canonicalMeetingId === 'string'
        ? saved.canonicalMeetingId.trim() || null
        : null,
      actionId,
    };
  }
  if (saved.kind === 'shared-action') {
    const token = typeof saved.token === 'string' ? saved.token.trim() : '';
    if (base.source !== 'semantic-link' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
    return { ...base, kind: 'shared-action', token };
  }
  const rawRef = saved.ref;
  const ref = rawRef && typeof rawRef === 'object' && !Array.isArray(rawRef)
    && typeof (rawRef as Record<string, unknown>).sourceEventId === 'string'
    && typeof (rawRef as Record<string, unknown>).occurrenceDate === 'string'
    ? {
        sourceEventId: (rawRef as Record<string, string>).sourceEventId,
        occurrenceDate: (rawRef as Record<string, string>).occurrenceDate,
      }
    : null;
  const legacyEventId = typeof saved.legacyEventId === 'string' ? saved.legacyEventId : undefined;
  if (!ref && !legacyEventId) return null;
  const intent: EventNotificationIntent = saved.intent === 'start-or-resume-meeting'
    ? 'start-or-resume-meeting'
    : 'open-event';
  const origin: SemanticEventOrigin = saved.origin === 'widget' ? 'widget' : 'notification';
  if (origin === 'widget' && base.source !== 'semantic-link') return null;
  return { ...base, kind: 'event', intent, origin, ref, legacyEventId };
}

export function installNotificationNavigationListener(): () => void {
  let active = true;
  const subscription = Notifications.addNotificationResponseReceivedListener(enqueueResponse);
  void getAppStorageItem(PENDING_RESPONSE_KEY)
    .then(async raw => {
      if (!active) return;
      if (raw) {
        try {
          const saved = restoredPendingTarget(JSON.parse(raw));
          if (saved) {
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

export function installSemanticLinkNavigationListener(): () => void {
  let active = true;
  const subscription = Linking.addEventListener('url', event => {
    if (active) void queueSemanticLink(event.url).catch(() => undefined);
  });
  void Linking.getInitialURL()
    .then(url => {
      if (active && url) return queueSemanticLink(url);
      return undefined;
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

export function setNotificationMeetingResolver(
  resolver: typeof meetingResolver,
): void {
  meetingResolver = resolver;
  if (resolver && activeScope) void flushPendingNotificationNavigation();
}

export function setNotificationOccurrenceMeetingResolver(
  resolver: typeof occurrenceMeetingResolver,
): void {
  occurrenceMeetingResolver = resolver;
  if (resolver && activeScope) void flushPendingNotificationNavigation();
}

export function setQuickTileMeetingResolver(
  resolver: typeof quickTileMeetingResolver,
): void {
  quickTileMeetingResolver = resolver;
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
  meetingResolver = null;
  occurrenceMeetingResolver = null;
  quickTileMeetingResolver = null;
  flushInFlight = null;
  navigationUnlocked = false;
  semanticLinkSequence = 0;
}
