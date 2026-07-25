import type { InitialState } from '@react-navigation/native';
import type { AuthMode } from './auth';
import { EVENT_CATEGORIES } from '../utils/eventColors';
import type { RootStackParamList } from '../types';

export const NAVIGATION_STATE_SCHEMA = 'laoji.navigation-state';
export const NAVIGATION_STATE_VERSION = 1;
export const NAVIGATION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const NAVIGATION_STATE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const ROOT_NAVIGATION_ROUTE_NAMES = [
  'Login',
  'MainTabs',
  'EventDetail',
  'MeetingLive',
  'Transcription',
  'MeetingOrganization',
  'SpeakerManager',
  'SpeakerEnrollment',
  'Profile',
  'ProfileField',
  'Account',
  'ChangePassword',
  'NotificationSettings',
  'AccountDeletion',
  'Privacy',
  'Legal',
  'AddEvent',
] as const satisfies readonly (keyof RootStackParamList)[];

export const MAIN_TAB_ROUTE_NAMES = ['Schedule', 'Meetings'] as const;

export type NavigationAuthScope = 'signed_out' | 'guest' | `user:${string}`;
export type NavigationRestoreFailure =
  | 'missing'
  | 'corrupt'
  | 'schema'
  | 'version'
  | 'scope'
  | 'expired'
  | 'future'
  | 'state';

export interface PersistedNavigationState {
  schema: typeof NAVIGATION_STATE_SCHEMA;
  version: typeof NAVIGATION_STATE_VERSION;
  authScope: NavigationAuthScope;
  updatedAt: number;
  state: InitialState;
}

export type NavigationRestoreResult = {
  state: InitialState;
  restored: boolean;
  failure?: NavigationRestoreFailure;
};

type PlainRecord = Record<string, unknown>;
type MainTabRouteName = typeof MAIN_TAB_ROUTE_NAMES[number];

const ROOT_ROUTE_SET = new Set<string>(ROOT_NAVIGATION_ROUTE_NAMES);
const TAB_ROUTE_SET = new Set<string>(MAIN_TAB_ROUTE_NAMES);
const PROFILE_FIELDS = new Set(['nickname', 'email', 'phone']);
const ACCOUNT_SECTIONS = new Set(['deletion']);
const TRANSCRIPTION_FOCUS = new Set(['notes', 'transcript', 'summary', 'title']);
const LEGAL_KINDS = new Set(['terms', 'privacy', 'help', 'guide', 'version', 'contact']);
const REPEAT_VALUES = new Set(['once', 'daily', 'weekly', 'monthly', 'yearly']);
const RECURRENCE_SCOPE_VALUES = new Set(['occurrence', 'following', 'series']);
const EVENT_CATEGORY_SET = new Set<string>(EVENT_CATEGORIES);
const MAX_STACK_DEPTH = 32;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_FORM_VALUE_LENGTH = 20_000;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isBoundedString(value: unknown, maxLength = MAX_FORM_VALUE_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isTimeKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function optional(value: unknown, validator: (candidate: unknown) => boolean): boolean {
  return value === undefined || validator(value);
}

function sanitizeEventRef(value: unknown): RootStackParamList['EventDetail']['eventRef'] | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['sourceEventId', 'occurrenceDate'])) return null;
  if (!isIdentifier(value.sourceEventId) || !isDateKey(value.occurrenceDate)) return null;
  return { sourceEventId: value.sourceEventId, occurrenceDate: value.occurrenceDate };
}

function sanitizeTabState(value: unknown): MainTabRouteName | null | false {
  if (value === undefined) return null;
  if (!isPlainRecord(value) || !Array.isArray(value.routes) || value.routes.length === 0) return false;
  if (!Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) >= value.routes.length) {
    return false;
  }
  const names = new Set<string>();
  for (const route of value.routes) {
    if (!isPlainRecord(route) || typeof route.name !== 'string' || !TAB_ROUTE_SET.has(route.name)) return false;
    if (route.params !== undefined || names.has(route.name)) return false;
    names.add(route.name);
  }
  const active = value.routes[value.index as number];
  return (active as PlainRecord).name as MainTabRouteName;
}

function sanitizeMainTabsRoute(route: PlainRecord): { name: 'MainTabs'; params: { screen: MainTabRouteName }; state: InitialState } | null {
  let paramsTab: MainTabRouteName | null = null;
  if (route.params !== undefined) {
    if (!isPlainRecord(route.params) || !hasOnlyKeys(route.params, ['screen', 'params', 'initial'])) return null;
    if (typeof route.params.screen !== 'string' || !TAB_ROUTE_SET.has(route.params.screen)) return null;
    if (route.params.params !== undefined) return null;
    if (route.params.initial !== undefined && typeof route.params.initial !== 'boolean') return null;
    paramsTab = route.params.screen as MainTabRouteName;
  }

  const stateTab = sanitizeTabState(route.state);
  if (stateTab === false) return null;
  const activeTab = stateTab ?? paramsTab ?? 'Schedule';
  return {
    name: 'MainTabs',
    params: { screen: activeTab },
    state: {
      index: activeTab === 'Schedule' ? 0 : 1,
      routes: MAIN_TAB_ROUTE_NAMES.map(name => ({ name })),
    },
  };
}

function validDraftInput(value: unknown): value is PlainRecord {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'title',
    'startDate',
    'endDate',
    'startTime',
    'endTime',
    'isAllDay',
    'repeat',
    'recurrenceUntilDate',
    'description',
    'rawText',
    'location',
    'category',
    'detail',
    'status',
    'reminderMinutes',
  ])) return false;
  return isBoundedString(value.title)
    && isDateKey(value.startDate)
    && optional(value.endDate, isDateKey)
    && optional(value.startTime, isTimeKey)
    && optional(value.endTime, isTimeKey)
    && typeof value.isAllDay === 'boolean'
    && optional(value.repeat, candidate => typeof candidate === 'string' && REPEAT_VALUES.has(candidate))
    && optional(value.recurrenceUntilDate, isDateKey)
    && optional(value.description, isBoundedString)
    && optional(value.rawText, isBoundedString)
    && optional(value.location, isBoundedString)
    && optional(value.category, candidate => typeof candidate === 'string' && EVENT_CATEGORY_SET.has(candidate))
    && optional(value.detail, isBoundedString)
    && optional(value.status, isBoundedString)
    && (value.reminderMinutes === undefined
      || value.reminderMinutes === null
      || (Number.isSafeInteger(value.reminderMinutes) && (value.reminderMinutes as number) >= 0));
}

function sanitizeActionFollowup(value: unknown): NonNullable<RootStackParamList['AddEvent']['followup']> | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'meetingId',
    'canonicalMeetingId',
    'actionId',
    'clientRequestId',
  ])) return null;
  if (!isIdentifier(value.meetingId)
    || !isIdentifier(value.canonicalMeetingId)
    || !isIdentifier(value.actionId)
    || !isIdentifier(value.clientRequestId)) return null;
  return {
    meetingId: value.meetingId,
    canonicalMeetingId: value.canonicalMeetingId,
    actionId: value.actionId,
    clientRequestId: value.clientRequestId,
  };
}

function sanitizeAddEventParams(value: unknown): RootStackParamList['AddEvent'] | null {
  if (value === undefined) return {};
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'date',
    'endDate',
    'startTime',
    'endTime',
    'eventRef',
    'recurrenceScope',
    'draft',
    'followup',
  ])) return null;
  if (!optional(value.date, isDateKey)
    || !optional(value.endDate, isDateKey)
    || !optional(value.startTime, isTimeKey)
    || !optional(value.endTime, isTimeKey)) return null;
  if (!optional(
    value.recurrenceScope,
    candidate => typeof candidate === 'string' && RECURRENCE_SCOPE_VALUES.has(candidate),
  )) return null;

  const eventRef = value.eventRef === undefined ? undefined : sanitizeEventRef(value.eventRef);
  if (value.eventRef !== undefined && !eventRef) return null;
  if (value.draft !== undefined && !validDraftInput(value.draft)) return null;
  const followup = value.followup === undefined ? undefined : sanitizeActionFollowup(value.followup);
  if (value.followup !== undefined && !followup) return null;
  if (eventRef) return followup ? null : {
    eventRef,
    ...(value.recurrenceScope !== undefined
      ? { recurrenceScope: value.recurrenceScope as NonNullable<RootStackParamList['AddEvent']['recurrenceScope']> }
      : {}),
  };

  const draft = value.draft as PlainRecord | undefined;
  const date = value.date ?? draft?.startDate;
  const endDate = value.endDate ?? draft?.endDate;
  const startTime = value.startTime ?? draft?.startTime;
  const endTime = value.endTime ?? draft?.endTime;
  return {
    ...(date !== undefined ? { date: date as string } : {}),
    ...(endDate !== undefined ? { endDate: endDate as string } : {}),
    ...(startTime !== undefined ? { startTime: startTime as string } : {}),
    ...(endTime !== undefined ? { endTime: endTime as string } : {}),
    ...(draft !== undefined
      ? { draft: { ...draft } as unknown as RootStackParamList['AddEvent']['draft'] }
      : {}),
    ...(followup ? { followup } : {}),
  };
}

function sanitizeRoute(route: unknown): InitialState['routes'][number] | null {
  if (!isPlainRecord(route) || typeof route.name !== 'string' || !ROOT_ROUTE_SET.has(route.name)) return null;
  switch (route.name as keyof RootStackParamList) {
    case 'Login':
    case 'MeetingOrganization':
    case 'SpeakerManager':
    case 'Profile':
    case 'ChangePassword':
    case 'NotificationSettings':
    case 'AccountDeletion':
    case 'Privacy':
      return route.params === undefined ? { name: route.name } : null;
    case 'MainTabs':
      return sanitizeMainTabsRoute(route);
    case 'EventDetail': {
      if (!isPlainRecord(route.params) || !hasOnlyKeys(route.params, ['eventRef'])) return null;
      const eventRef = sanitizeEventRef(route.params.eventRef);
      return eventRef ? { name: 'EventDetail', params: { eventRef } } : null;
    }
    case 'MeetingLive':
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['meetingId'])
        && isIdentifier(route.params.meetingId)
        ? { name: 'MeetingLive', params: { meetingId: route.params.meetingId } }
        : null;
    case 'Transcription':
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['meetingId', 'focus', 'actionId', 'actionFocusRequestId'])
        && isIdentifier(route.params.meetingId)
        && optional(route.params.focus, candidate => typeof candidate === 'string' && TRANSCRIPTION_FOCUS.has(candidate))
        && optional(route.params.actionId, isIdentifier)
        && optional(route.params.actionFocusRequestId, candidate => Number.isSafeInteger(candidate) && (candidate as number) >= 0)
        ? {
            name: 'Transcription',
            params: {
              meetingId: route.params.meetingId,
              ...(route.params.focus !== undefined ? { focus: route.params.focus as 'notes' | 'transcript' | 'summary' | 'title' } : {}),
              ...(route.params.actionId !== undefined ? { actionId: route.params.actionId } : {}),
              ...(route.params.actionFocusRequestId !== undefined
                ? { actionFocusRequestId: route.params.actionFocusRequestId as number }
                : {}),
            },
          }
        : null;
    case 'SpeakerEnrollment':
      if (route.params === undefined) return { name: 'SpeakerEnrollment' };
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['speakerId'])
        && optional(route.params.speakerId, isIdentifier)
        ? {
            name: 'SpeakerEnrollment',
            ...(route.params.speakerId !== undefined ? { params: { speakerId: route.params.speakerId } } : {}),
          }
        : null;
    case 'ProfileField':
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['field'])
        && typeof route.params.field === 'string'
        && PROFILE_FIELDS.has(route.params.field)
        ? { name: 'ProfileField', params: { field: route.params.field as 'nickname' | 'email' | 'phone' } }
        : null;
    case 'Account':
      if (route.params === undefined) return { name: 'Account' };
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['section'])
        && optional(route.params.section, candidate => typeof candidate === 'string' && ACCOUNT_SECTIONS.has(candidate))
        ? {
            name: 'Account',
            ...(route.params.section !== undefined ? { params: { section: 'deletion' as const } } : {}),
          }
        : null;
    case 'Legal':
      return isPlainRecord(route.params)
        && hasOnlyKeys(route.params, ['kind'])
        && typeof route.params.kind === 'string'
        && LEGAL_KINDS.has(route.params.kind)
        ? {
            name: 'Legal',
            params: { kind: route.params.kind as RootStackParamList['Legal']['kind'] },
          }
        : null;
    case 'AddEvent': {
      const params = sanitizeAddEventParams(route.params);
      return params ? { name: 'AddEvent', params } : null;
    }
    default:
      return null;
  }
}

function routeAllowedForScope(name: string, scope: NavigationAuthScope): boolean {
  if (scope === 'signed_out') return name === 'Login' || name === 'Legal';
  return name !== 'Login';
}

export function navigationScopeForAuth(
  mode: AuthMode,
  userId?: string | number | null,
): NavigationAuthScope {
  if (mode === 'guest') return 'guest';
  if (mode === 'authenticated' && userId !== undefined && userId !== null && String(userId).length > 0) {
    return `user:${String(userId)}`;
  }
  return 'signed_out';
}

export function defaultNavigationState(scope: NavigationAuthScope): InitialState {
  if (scope === 'signed_out') return { index: 0, routes: [{ name: 'Login' }] };
  const mainTabs = sanitizeMainTabsRoute({ name: 'MainTabs' });
  if (!mainTabs) throw new Error('MainTabs default state is invalid');
  return { index: 0, routes: [mainTabs] };
}

export function sanitizeNavigationState(value: unknown, scope: NavigationAuthScope): InitialState | null {
  if (!isPlainRecord(value)
    || !Array.isArray(value.routes)
    || value.routes.length === 0
    || value.routes.length > MAX_STACK_DEPTH
    || !Number.isInteger(value.index)
    || (value.index as number) < 0
    || (value.index as number) >= value.routes.length) return null;

  const sanitizedRoutes: InitialState['routes'] = [];
  for (const route of value.routes) {
    const sanitized = sanitizeRoute(route);
    if (!sanitized || !routeAllowedForScope(sanitized.name, scope)) return null;
    sanitizedRoutes.push(sanitized);
  }

  const expectedRoot = scope === 'signed_out' ? 'Login' : 'MainTabs';
  if (sanitizedRoutes[0]?.name !== expectedRoot) return null;
  if (sanitizedRoutes.slice(1).some(route => route.name === expectedRoot)) return null;

  const currentRoutes = sanitizedRoutes.slice(0, (value.index as number) + 1);
  return { index: currentRoutes.length - 1, routes: currentRoutes };
}

export function createPersistedNavigationState(
  scope: NavigationAuthScope,
  state: unknown,
  updatedAt = Date.now(),
): PersistedNavigationState {
  return {
    schema: NAVIGATION_STATE_SCHEMA,
    version: NAVIGATION_STATE_VERSION,
    authScope: scope,
    updatedAt,
    state: sanitizeNavigationState(state, scope) ?? defaultNavigationState(scope),
  };
}

export function parsePersistedNavigationState(
  raw: string | null,
  scope: NavigationAuthScope,
  now = Date.now(),
): NavigationRestoreResult {
  const fallback = defaultNavigationState(scope);
  if (raw === null) return { state: fallback, restored: false, failure: 'missing' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: fallback, restored: false, failure: 'corrupt' };
  }
  if (!isPlainRecord(value)) return { state: fallback, restored: false, failure: 'corrupt' };
  if (value.schema !== NAVIGATION_STATE_SCHEMA) return { state: fallback, restored: false, failure: 'schema' };
  if (value.version !== NAVIGATION_STATE_VERSION) return { state: fallback, restored: false, failure: 'version' };
  if (value.authScope !== scope) return { state: fallback, restored: false, failure: 'scope' };
  if (!Number.isFinite(value.updatedAt)) return { state: fallback, restored: false, failure: 'corrupt' };
  if ((value.updatedAt as number) > now + NAVIGATION_STATE_FUTURE_TOLERANCE_MS) {
    return { state: fallback, restored: false, failure: 'future' };
  }
  if (now - (value.updatedAt as number) > NAVIGATION_STATE_MAX_AGE_MS) {
    return { state: fallback, restored: false, failure: 'expired' };
  }
  const state = sanitizeNavigationState(value.state, scope);
  return state
    ? { state, restored: true }
    : { state: fallback, restored: false, failure: 'state' };
}
