import type { CalEvent } from '../types';
import { eventEffectiveEndDate } from '../utils/eventDateSemantics';
import { validateEventDraft } from '../utils/eventDraftValidation';
import {
  getAppStorageItem,
  removeAppStorageItem,
  setAppStorageItem,
} from './appStorage';

export const EVENT_CACHE_SCHEMA_VERSION = 2;
export const MAX_CACHED_EVENT_MONTHS = 9;

const MONTH_CACHE_PREFIX = '@laoji:eventsCache:v2';
const LEGACY_MONTH_CACHE_PREFIX = '@laoji:eventsCache:v1';
const CATALOG_CACHE_PREFIX = '@laoji:eventCatalog:v2';
const LEGACY_CATALOG_CACHE_PREFIX = '@laoji:eventCatalog:v1';
const CACHE_RECOVERY_PREFIX = '@laoji:eventCacheRecovery:v1';

export type EventMonthAccess = Record<string, number>;

export type EventCacheRecoveryNotice = {
  detectedAt: number;
  kinds: Array<'months' | 'catalog'>;
};

type MonthCacheEnvelope = {
  schemaVersion: typeof EVENT_CACHE_SCHEMA_VERSION;
  kind: 'event-month-cache';
  savedAt: number;
  months: Array<{ key: string; lastAccessedAt: number }>;
  events: CalEvent[];
};

type CatalogCacheEnvelope = {
  schemaVersion: typeof EVENT_CACHE_SCHEMA_VERSION;
  kind: 'event-catalog-cache';
  savedAt: number;
  events: CalEvent[];
};

export type LoadedEventMonthCache = {
  events: CalEvent[];
  monthAccess: EventMonthAccess;
  migratedFromLegacy: boolean;
  recoveryNotice: EventCacheRecoveryNotice | null;
};

export type LoadedEventCatalogCache = {
  events: CalEvent[];
  migratedFromLegacy: boolean;
  recoveryNotice: EventCacheRecoveryNotice | null;
};

function monthCacheKey(scope: string): string {
  return `${MONTH_CACHE_PREFIX}:${scope}`;
}

function legacyMonthCacheKey(scope: string): string {
  return `${LEGACY_MONTH_CACHE_PREFIX}:${scope}`;
}

function catalogCacheKey(scope: string): string {
  return `${CATALOG_CACHE_PREFIX}:${scope}`;
}

function legacyCatalogCacheKey(scope: string): string {
  return `${LEGACY_CATALOG_CACHE_PREFIX}:${scope}`;
}

function recoveryKey(scope: string): string {
  return `${CACHE_RECOVERY_PREFIX}:${scope}`;
}

function isMonthKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalDate(value: unknown): value is string | undefined {
  return value === undefined || isDateKey(value);
}

function isOptionalDateArray(value: unknown): value is string[] | undefined {
  return value === undefined || (
    Array.isArray(value)
    && value.every(isDateKey)
    && new Set(value).size === value.length
  );
}

function isOptionalIsoWeekdays(value: unknown): value is number[] | undefined {
  return value === undefined || (
    Array.isArray(value)
    && value.length > 0
    && value.every(item => Number.isSafeInteger(item) && item >= 1 && item <= 7)
    && new Set(value).size === value.length
  );
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 1);
}

function isOptionalReminder(value: unknown): value is number | null | undefined {
  return value === undefined
    || value === null
    || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isCachedEvent(value: unknown): value is CalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<CalEvent>;
  const validId = (typeof event.id === 'string' && event.id.length > 0)
    || (typeof event.id === 'number' && Number.isSafeInteger(event.id));
  if (!validId
    || typeof event.title !== 'string'
    || !isDateKey(event.startDate)
    || typeof event.color !== 'string'
    || event.color.length === 0
    || !isOptionalString(event.sourceEventId)
    || !isOptionalDate(event.occurrenceDate)
    || !isOptionalString(event.occurrenceId)
    || !isOptionalBoolean(event.isExpandedOccurrence)
    || !isOptionalBoolean(event.isRecurrenceException)
    || !isOptionalDate(event.seriesStartDate)
    || !isOptionalDate(event.seriesEndDate)
    || !isOptionalPositiveInteger(event.revision)
    || !(event.recurrenceSegmentId === undefined
      || typeof event.recurrenceSegmentId === 'string'
      || Number.isSafeInteger(event.recurrenceSegmentId))
    || !isOptionalPositiveInteger(event.recurrenceInterval)
    || !isOptionalIsoWeekdays(event.recurrenceWeekdays)
    || !isOptionalDate(event.recurrenceUntilDate)
    || !isOptionalDate(event.recurrenceEffectiveFromDate)
    || !isOptionalDateArray(event.excludedOccurrenceDates)
    || !isOptionalDate(event.excludedAfterDate)
    || !isOptionalDate(event.endDate)
    || !isOptionalString(event.startTime)
    || !isOptionalString(event.endTime)
    || !isOptionalBoolean(event.spanning)
    || !isOptionalString(event.category)
    || !isOptionalString(event.location)
    || !isOptionalString(event.detail)
    || !isOptionalString(event.status)
    || !isOptionalBoolean(event.isAllDay)
    || !isOptionalString(event.description)
    || !isOptionalString(event.rawText)
    || !isOptionalString(event.clientRequestId)
    || !isOptionalReminder(event.reminderMinutes)
    || !(event.notificationId === undefined
      || event.notificationId === null
      || typeof event.notificationId === 'string')
    || !(event.repeat === undefined
      || event.repeat === 'once'
      || event.repeat === 'daily'
      || event.repeat === 'weekly'
      || event.repeat === 'monthly'
      || event.repeat === 'yearly')) return false;
  if (event.recurrenceUntilDate
    && event.recurrenceUntilDate < (event.recurrenceEffectiveFromDate ?? event.seriesStartDate ?? event.startDate)) {
    return false;
  }
  if (event.excludedAfterDate
    && event.excludedAfterDate < (event.recurrenceEffectiveFromDate ?? event.seriesStartDate ?? event.startDate)) {
    return false;
  }
  return validateEventDraft(event as CalEvent).valid;
}

function parseEventArray(value: unknown): CalEvent[] | null {
  if (!Array.isArray(value) || !value.every(isCachedEvent)) return null;
  return value.map(event => ({ ...event, id: String(event.id) }));
}

function parseRecoveryNotice(raw: string | null): EventCacheRecoveryNotice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EventCacheRecoveryNotice>;
    const kinds = Array.isArray(parsed.kinds)
      ? parsed.kinds.filter((kind): kind is 'months' | 'catalog' => kind === 'months' || kind === 'catalog')
      : [];
    if (typeof parsed.detectedAt !== 'number' || kinds.length === 0) return null;
    return { detectedAt: parsed.detectedAt, kinds: [...new Set(kinds)] };
  } catch {
    return null;
  }
}

async function markCorruptCache(
  scope: string,
  kind: 'months' | 'catalog',
  key: string,
  existingNotice: EventCacheRecoveryNotice | null,
  now: number,
): Promise<EventCacheRecoveryNotice> {
  const persistedNotice = await loadRecoveryNotice(scope);
  const notice: EventCacheRecoveryNotice = {
    detectedAt: persistedNotice?.detectedAt ?? existingNotice?.detectedAt ?? now,
    kinds: [...new Set([
      ...(persistedNotice?.kinds ?? []),
      ...(existingNotice?.kinds ?? []),
      kind,
    ])],
  };
  await Promise.allSettled([
    removeAppStorageItem(key),
    setAppStorageItem(recoveryKey(scope), JSON.stringify(notice)),
  ]);
  return notice;
}

function monthOrdinal(key: string): number {
  return Number(key.slice(0, 4)) * 12 + Number(key.slice(5)) - 1;
}

function monthKeysForEvent(event: Pick<CalEvent, 'startDate' | 'endDate'>): string[] {
  const startKey = event.startDate.slice(0, 7);
  const endKey = eventEffectiveEndDate(event).slice(0, 7);
  if (!isMonthKey(startKey) || !isMonthKey(endKey)) return [];
  const start = monthOrdinal(startKey);
  const end = monthOrdinal(endKey);
  if (end < start) return [startKey];
  const keys: string[] = [];
  for (let ordinal = start; ordinal <= end && keys.length < 120; ordinal += 1) {
    const year = Math.floor(ordinal / 12);
    const month = ordinal % 12 + 1;
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return keys;
}

export function pruneEventMonthAccess(
  monthAccess: EventMonthAccess,
  limit = MAX_CACHED_EVENT_MONTHS,
): EventMonthAccess {
  return Object.fromEntries(
    Object.entries(monthAccess)
      .filter(([key, lastAccessedAt]) => isMonthKey(key) && Number.isFinite(lastAccessedAt))
      .sort(([, left], [, right]) => right - left)
      .slice(0, Math.max(0, limit)),
  );
}

export function touchEventMonth(
  monthAccess: EventMonthAccess,
  key: string,
  now = Date.now(),
): EventMonthAccess {
  if (!isMonthKey(key)) return pruneEventMonthAccess(monthAccess);
  return pruneEventMonthAccess({ ...monthAccess, [key]: now });
}

export function deriveEventMonthAccess(
  events: CalEvent[],
  now = new Date(),
): EventMonthAccess {
  const currentOrdinal = now.getFullYear() * 12 + now.getMonth();
  const keys = [...new Set(events.flatMap(monthKeysForEvent))]
    .sort((left, right) => {
      const distance = Math.abs(monthOrdinal(left) - currentOrdinal)
        - Math.abs(monthOrdinal(right) - currentOrdinal);
      return distance || monthOrdinal(right) - monthOrdinal(left);
    })
    .slice(0, MAX_CACHED_EVENT_MONTHS);
  const base = now.getTime();
  return Object.fromEntries(keys.map((key, index) => [key, base - index]));
}

export function filterEventsToMonthAccess(events: CalEvent[], monthAccess: EventMonthAccess): CalEvent[] {
  const retained = new Set(Object.keys(monthAccess));
  if (retained.size === 0) return [];
  return events.filter(event => monthKeysForEvent(event).some(key => retained.has(key)));
}

function parseMonthEnvelope(raw: string): { events: CalEvent[]; monthAccess: EventMonthAccess } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MonthCacheEnvelope>;
    if (parsed.schemaVersion !== EVENT_CACHE_SCHEMA_VERSION || parsed.kind !== 'event-month-cache') return null;
    const events = parseEventArray(parsed.events);
    if (!events || !Array.isArray(parsed.months)) return null;
    const monthAccess: EventMonthAccess = {};
    for (const month of parsed.months) {
      if (!month || !isMonthKey(month.key) || !Number.isFinite(month.lastAccessedAt)) return null;
      monthAccess[month.key] = month.lastAccessedAt;
    }
    const boundedAccess = pruneEventMonthAccess(monthAccess);
    return { events: filterEventsToMonthAccess(events, boundedAccess), monthAccess: boundedAccess };
  } catch {
    return null;
  }
}

function parseCatalogEnvelope(raw: string): CalEvent[] | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CatalogCacheEnvelope>;
    if (parsed.schemaVersion !== EVENT_CACHE_SCHEMA_VERSION || parsed.kind !== 'event-catalog-cache') return null;
    return parseEventArray(parsed.events);
  } catch {
    return null;
  }
}

async function loadRecoveryNotice(scope: string): Promise<EventCacheRecoveryNotice | null> {
  return parseRecoveryNotice(await getAppStorageItem(recoveryKey(scope)).catch(() => null));
}

export async function loadEventMonthCache(scope: string, now = new Date()): Promise<LoadedEventMonthCache> {
  let notice = await loadRecoveryNotice(scope);
  const key = monthCacheKey(scope);
  const raw = await getAppStorageItem(key).catch(() => null);
  if (raw) {
    const parsed = parseMonthEnvelope(raw);
    if (parsed) return { ...parsed, migratedFromLegacy: false, recoveryNotice: notice };
    notice = await markCorruptCache(scope, 'months', key, notice, now.getTime());
  }

  const legacyRaw = await getAppStorageItem(legacyMonthCacheKey(scope)).catch(() => null);
  if (!legacyRaw) return { events: [], monthAccess: {}, migratedFromLegacy: false, recoveryNotice: notice };
  try {
    const events = parseEventArray(JSON.parse(legacyRaw));
    if (!events) throw new Error('invalid legacy month cache');
    const monthAccess = deriveEventMonthAccess(events, now);
    return {
      events: filterEventsToMonthAccess(events, monthAccess),
      monthAccess,
      migratedFromLegacy: true,
      recoveryNotice: notice,
    };
  } catch {
    notice = await markCorruptCache(
      scope,
      'months',
      legacyMonthCacheKey(scope),
      notice,
      now.getTime(),
    );
    return { events: [], monthAccess: {}, migratedFromLegacy: false, recoveryNotice: notice };
  }
}

export async function saveEventMonthCache(
  scope: string,
  events: CalEvent[],
  monthAccess: EventMonthAccess,
  now = Date.now(),
): Promise<void> {
  const boundedAccess = pruneEventMonthAccess(monthAccess);
  const envelope: MonthCacheEnvelope = {
    schemaVersion: EVENT_CACHE_SCHEMA_VERSION,
    kind: 'event-month-cache',
    savedAt: now,
    months: Object.entries(boundedAccess).map(([key, lastAccessedAt]) => ({ key, lastAccessedAt })),
    events: filterEventsToMonthAccess(events, boundedAccess),
  };
  await setAppStorageItem(monthCacheKey(scope), JSON.stringify(envelope));
  await removeAppStorageItem(legacyMonthCacheKey(scope)).catch(() => undefined);
}

export async function loadEventCatalogCache(scope: string, now = Date.now()): Promise<LoadedEventCatalogCache> {
  let notice = await loadRecoveryNotice(scope);
  const key = catalogCacheKey(scope);
  const raw = await getAppStorageItem(key).catch(() => null);
  if (raw) {
    const events = parseCatalogEnvelope(raw);
    if (events) return { events, migratedFromLegacy: false, recoveryNotice: notice };
    notice = await markCorruptCache(scope, 'catalog', key, notice, now);
  }

  const legacyRaw = await getAppStorageItem(legacyCatalogCacheKey(scope)).catch(() => null);
  if (!legacyRaw) return { events: [], migratedFromLegacy: false, recoveryNotice: notice };
  try {
    const events = parseEventArray(JSON.parse(legacyRaw));
    if (!events) throw new Error('invalid legacy catalog cache');
    return { events, migratedFromLegacy: true, recoveryNotice: notice };
  } catch {
    notice = await markCorruptCache(
      scope,
      'catalog',
      legacyCatalogCacheKey(scope),
      notice,
      now,
    );
    return { events: [], migratedFromLegacy: false, recoveryNotice: notice };
  }
}

export async function saveEventCatalogCache(
  scope: string,
  events: CalEvent[],
  now = Date.now(),
): Promise<void> {
  const envelope: CatalogCacheEnvelope = {
    schemaVersion: EVENT_CACHE_SCHEMA_VERSION,
    kind: 'event-catalog-cache',
    savedAt: now,
    events,
  };
  await setAppStorageItem(catalogCacheKey(scope), JSON.stringify(envelope));
  await removeAppStorageItem(legacyCatalogCacheKey(scope)).catch(() => undefined);
}

export function clearEventCacheRecoveryNotice(scope: string): Promise<void> {
  return removeAppStorageItem(recoveryKey(scope));
}

export const eventCacheStorageKeys = {
  month: monthCacheKey,
  legacyMonth: legacyMonthCacheKey,
  catalog: catalogCacheKey,
  legacyCatalog: legacyCatalogCacheKey,
  recovery: recoveryKey,
};
