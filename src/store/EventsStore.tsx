import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import {
  EventDisplayMetadata,
  applyEventMetadata,
  eventSeriesDraft,
  sourceEventId,
} from '../services/eventMapper';
import {
  cancelEventNotificationsForMutation,
  reconcileEventNotificationHorizon,
  reconcileEventNotifications,
  reminderFireDate,
  scheduleEventNotificationForScope,
  switchEventNotificationScope,
} from '../services/notifications';
import { expandEventsForMonths } from '../utils/eventRecurrence';
import { resolveEventReference } from '../utils/eventRecurrence';
import {
  eventRefForEvent,
  eventRefKey,
  sourceEventId as stableSourceEventId,
} from '../utils/eventIdentity';
import { getAppStorageItem, writeAppStorageJson } from '../services/appStorage';
import { evaluateEventConflicts, type EventConflict } from '../utils/eventUtils';
import { EventDraftValidationError, validateEventDraft } from '../utils/eventDraftValidation';
import { EventDeleteCoordinator } from '../services/eventDeleteCoordinator';
import {
  applyGuestTransactionToSeries,
  createEventDeleteTransaction,
  hideTransactionScope,
  type EventDeleteTransaction,
} from '../services/eventDeleteTransactions';
import { applyGuestRecurrenceEdit } from '../services/guestRecurrenceEdit';
import {
  type EventMonthAccess,
  touchEventMonth,
} from '../services/eventCache';
import { eventEffectiveEndDate, eventOverlapsDateRange } from '../utils/eventDateSemantics';
import { setOccurrenceMeetingLinkState } from '../services/meetingOccurrenceLifecycle';
import { isScopeKey } from '../domain/meeting';
import {
  loadLocalScheduleEvents,
  replaceLocalScheduleEvents,
} from '../data/repositories/localScheduleRepository';

export { checkConflict } from '../utils/eventUtils';

type EventMetadata = EventDisplayMetadata;
type EventMetadataMap = Record<string, EventMetadata>;

const EVENT_METADATA_KEY = '@laoji:eventMetadata:v1';
const GUEST_EVENTS_KEY = '@laoji:guestEvents:v1';
const EVENT_DELETE_TRANSACTIONS_KEY = '@laoji:eventDeleteTransactions:v1';

function cleanMetadata(meta: EventMetadata): EventMetadata {
  const cleaned: EventMetadata = {};
  if (typeof meta.color === 'string' && meta.color.trim()) cleaned.color = meta.color.trim();
  if (typeof meta.location === 'string' && meta.location.trim()) cleaned.location = meta.location.trim();
  if (typeof meta.category === 'string' && meta.category.trim()) cleaned.category = normalizeEventCategory(meta.category);
  if (typeof meta.detail === 'string' && meta.detail.trim()) cleaned.detail = meta.detail.trim();
  if (typeof meta.reminderMinutes === 'number' && Number.isFinite(meta.reminderMinutes)) {
    cleaned.reminderMinutes = meta.reminderMinutes;
  }
  if (typeof meta.notificationId === 'string' && meta.notificationId.trim()) {
    cleaned.notificationId = meta.notificationId.trim();
  }
  return cleaned;
}

function mergeMetadata(map: EventMetadataMap, id: string, patch: EventMetadata): EventMetadataMap {
  const nextMeta = cleanMetadata({ ...(map[id] ?? {}), ...patch });
  const next = { ...map };
  if (Object.keys(nextMeta).length > 0) next[id] = nextMeta;
  else delete next[id];
  return next;
}

function createGuestId(): string {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventWithClientRequestId(events: readonly CalEvent[], clientRequestId?: string): CalEvent | null {
  const normalized = clientRequestId?.trim();
  if (!normalized) return null;
  return events.find(event => event.clientRequestId?.trim() === normalized) ?? null;
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getAppStorageItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function persistJson(key: string, value: unknown): Promise<void> {
  await writeAppStorageJson(key, value, { removeIfEmpty: true, bestEffort: true });
}

function sourceCatalog(events: CalEvent[]): CalEvent[] {
  const bySource = new Map<string, CalEvent>();
  for (const event of events) {
    const sourceId = sourceEventId(event);
    const catalogKey = event.isRecurrenceException
      ? `${sourceId}:exception:${event.occurrenceDate ?? event.startDate}`
      : event.recurrenceSegmentId != null
        ? `${sourceId}:segment:${event.recurrenceSegmentId}`
        : sourceId;
    if (bySource.has(catalogKey) && event.isExpandedOccurrence) continue;
    const catalogDraft = event.isRecurrenceException ? event : eventSeriesDraft(event);
    bySource.set(catalogKey, {
      ...catalogDraft,
      id: catalogKey,
      sourceEventId: sourceId,
      occurrenceDate: event.isRecurrenceException
        ? event.occurrenceDate ?? event.startDate
        : event.recurrenceEffectiveFromDate
          ?? event.seriesStartDate
          ?? event.occurrenceDate
          ?? event.startDate,
      occurrenceId: undefined,
      isExpandedOccurrence: false,
    });
  }
  return [...bySource.values()];
}

function monthWindow(year: number, month: number): { start: string; end: string } {
  const monthText = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${monthText}-01`,
    end: `${year}-${monthText}-${String(lastDay).padStart(2, '0')}`,
  };
}

function uniqueEvents(events: CalEvent[]): CalEvent[] {
  return [...new Map(events.map(event => [event.id, event])).values()];
}

function metadataKeyForEvent(event: CalEvent): string {
  return eventRefKey(eventRefForEvent(event));
}

function metadataForEvent(map: EventMetadataMap, event: CalEvent): EventMetadata | undefined {
  return map[metadataKeyForEvent(event)] ?? map[event.id] ?? map[stableSourceEventId(event)];
}

/**
 * Keep the display classification beside the stable occurrence identity.
 *
 * A calendar refresh can legitimately return a different client occurrence
 * id (for example after expanding a recurrence or while a delete command is
 * being acknowledged).  The old refresh path only persisted reminder fields
 * for incoming events and removed metadata for every event missing from that
 * response.  When the id changed, the next projection therefore lost the
 * category and fell back to "其他" (the grey-purple bucket).  Display metadata
 * is durable user-facing state, not a refresh bookkeeping detail, so every
 * successful projection refreshes it under the stable source/occurrence key.
 */
function mergeEventDisplayMetadata(
  map: EventMetadataMap,
  event: CalEvent,
): EventMetadataMap {
  return mergeMetadata(map, metadataKeyForEvent(event), {
    color: event.color,
    location: event.location,
    category: event.category,
    detail: event.detail,
    reminderMinutes: event.reminderMinutes,
    notificationId: event.notificationId,
  });
}

/**
 * Guest/device-primary schedule rows may predate the category field.  Their
 * inferred category is kept in the metadata map, while the SQLite row itself
 * can still be the older shape.  Any local projection (including the one
 * performed immediately after a delete) must apply that metadata before it
 * reaches the calendar surface; otherwise every unaffected row falls back to
 * the grey "其他" bucket.
 */
function projectGuestEvents(
  events: CalEvent[],
  metadata: EventMetadataMap,
): CalEvent[] {
  return events.map(event => applyEventMetadata(event, metadataForEvent(metadata, event)));
}

function removeEventMetadata(map: EventMetadataMap, event: CalEvent): void {
  delete map[metadataKeyForEvent(event)];
  delete map[event.id];
}

function removeTransactionMetadata(map: EventMetadataMap, transaction: EventDeleteTransaction): void {
  for (const event of transaction.affectedEvents) removeEventMetadata(map, event);
  if (transaction.catalogEvent) removeEventMetadata(map, transaction.catalogEvent);
  for (const key of Object.keys(map)) {
    try {
      const [sourceId, occurrenceDate] = JSON.parse(key) as [string, string];
      const selected = sourceId === transaction.ref.sourceEventId && (
        transaction.recurrenceScope === 'series'
        || (transaction.recurrenceScope === 'occurrence' && occurrenceDate === transaction.ref.occurrenceDate)
        || (transaction.recurrenceScope === 'following' && occurrenceDate >= transaction.ref.occurrenceDate)
      );
      if (selected) delete map[key];
    } catch {
      // Legacy metadata keys are removed through the snapshots above.
    }
  }
  if (transaction.recurrenceScope === 'series') delete map[transaction.ref.sourceEventId];
}

function removeMutationMetadata(
  map: EventMetadataMap,
  ref: EventRef,
  recurrenceScope: EventRecurrenceScope,
  snapshots: CalEvent[],
): void {
  for (const event of snapshots) removeEventMetadata(map, event);
  for (const key of Object.keys(map)) {
    try {
      const [sourceId, occurrenceDate] = JSON.parse(key) as [string, string];
      const selected = sourceId === ref.sourceEventId && (
        recurrenceScope === 'series'
        || (recurrenceScope === 'occurrence' && occurrenceDate === ref.occurrenceDate)
        || (recurrenceScope === 'following' && occurrenceDate >= ref.occurrenceDate)
      );
      if (selected) delete map[key];
    } catch {
      // Legacy keys are removed from the concrete snapshots above.
    }
  }
  if (recurrenceScope === 'series') delete map[ref.sourceEventId];
}

function monthKeysForRange(startDate: string, endDate: string): string[] {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  if (![startYear, startMonth, endYear, endMonth].every(Number.isFinite)) return [];
  const cursor = new Date(startYear, startMonth - 1, 1);
  const end = new Date(endYear, endMonth - 1, 1);
  const keys: string[] = [];
  while (cursor <= end && keys.length < 120) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

function eventsForDateRange(catalog: CalEvent[], startDate: string, endDate: string): CalEvent[] {
  return uniqueEvents(expandEventsForMonths(sourceCatalog(catalog), monthKeysForRange(startDate, endDate)))
    .filter(event => eventOverlapsDateRange(event, startDate, endDate));
}

function projectDeletionTransactions(
  events: CalEvent[],
  transactions: EventDeleteTransaction[],
): CalEvent[] {
  return transactions.reduce(
    (projected, transaction) => hideTransactionScope(projected, transaction),
    events,
  );
}

interface EventsContextType {
  events: CalEvent[];
  searchableEvents: CalEvent[];
  loading: boolean;
  error: string | null;
  monthStates: Record<string, EventMonthLoadState>;
  cacheRecoveryNotice: null;
  hydratedScope: string | null;
  addEvent: (ev: Omit<CalEvent, 'id'>) => Promise<EventCreateResult>;
  deleteEvent: (ref: EventRef, scope?: EventRecurrenceScope) => Promise<void>;
  updateEvent: (
    ref: EventRef,
    changes: Partial<CalEvent>,
    scope?: EventRecurrenceScope,
  ) => Promise<EventMutationResult>;
  refreshEvents: (year: number, month: number) => Promise<EventRefreshResult>;
  findConflicts: (
    draft: Omit<CalEvent, 'id'>,
    excludeRef?: EventRef,
    excludeScope?: EventRecurrenceScope,
  ) => Promise<EventConflictQueryResult>;
  resolveEventRef: (ref: EventRef) => Promise<EventResolutionResult>;
  undoDelete: () => Promise<void>;
  dismissCacheRecoveryNotice: () => Promise<void>;
  lastDeleted: CalEvent | null;
}

export interface EventMonthLoadState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
  updatedAt?: number;
}

export type EventReminderDelivery = 'not-required' | 'scheduled' | 'unavailable' | 'unconfirmed';

export interface EventMutationResult {
  reminderDelivery: EventReminderDelivery;
}

export interface EventCreateResult extends EventMutationResult {
  eventRef: EventRef;
}

export interface EventRefreshResult {
  dataLoaded: boolean;
  reminderSyncConfirmed: boolean;
}

export interface EventConflictQueryResult {
  hasConflict: boolean;
  conflicts: EventConflict[];
  complete: boolean;
  coverage: {
    status: 'complete' | 'partial' | 'unavailable';
    fromDate: string;
    throughDate: string;
    completeForSeries: boolean;
  };
  invalidCandidateCount: number;
}

export type EventResolutionResult =
  | { status: 'found'; event: CalEvent }
  | { status: 'not-found' | 'retryable' | 'scope-changed'; event: null };

function reminderDeliveryForEvent(
  event: CalEvent,
  notificationId: string | null | undefined,
  unconfirmed = false,
): EventReminderDelivery {
  if (!reminderFireDate(event)) return 'not-required';
  if (unconfirmed) return 'unconfirmed';
  return notificationId ? 'scheduled' : 'unavailable';
}

function reminderDeliveryForUpdatedEvents(
  events: CalEvent[],
  fallback: CalEvent,
  unconfirmed: boolean,
): EventReminderDelivery {
  if (unconfirmed) return 'unconfirmed';
  const expected = events.filter(event => reminderFireDate(event));
  if (expected.length === 0) {
    return reminderDeliveryForEvent(fallback, fallback.notificationId);
  }
  return expected.every(event => event.notificationId) ? 'scheduled' : 'unavailable';
}

const EventsContext = createContext<EventsContextType | null>(null);

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [searchableEvents, setSearchableEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monthStates, setMonthStates] = useState<Record<string, EventMonthLoadState>>({});
  const cacheRecoveryNotice = null;
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<CalEvent | null>(null);
  const lastDeletedTransactionIdRef = useRef<string | null>(null);
  const deleteCoordinatorRef = useRef<EventDeleteCoordinator | null>(null);
  const eventMetadataRef = useRef<EventMetadataMap>({});
  const guestBaseEventsRef = useRef<CalEvent[]>([]);
  const loadedGuestMonthsRef = useRef<Set<string>>(new Set());
  const monthAccessRef = useRef<EventMonthAccess>({});
  const monthStatesRef = useRef<Record<string, EventMonthLoadState>>({});
  const monthRequestSequenceRef = useRef<Map<string, number>>(new Map());
  const activeLoadCountRef = useRef(0);
  const foregroundRefreshRef = useRef<Promise<void> | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const eventsRef = useRef<CalEvent[]>([]);
  const searchableEventsRef = useRef<CalEvent[]>([]);
  const generationRef = useRef(0);
  const activeScopeRef = useRef<string | null>(null);
  const guestMutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const scope = 'guest';

  const metadataStorageKey = `${EVENT_METADATA_KEY}:${scope}`;
  const eventDeleteTransactionsKey = `${EVENT_DELETE_TRANSACTIONS_KEY}:${scope}`;

  const beginLoading = useCallback(() => {
    const generation = generationRef.current;
    activeLoadCountRef.current += 1;
    setLoading(true);
    return generation;
  }, []);

  const endLoading = useCallback((generation: number) => {
    if (generationRef.current !== generation) return;
    activeLoadCountRef.current = Math.max(0, activeLoadCountRef.current - 1);
    if (activeLoadCountRef.current === 0) setLoading(false);
  }, []);

  const updateMonthState = useCallback((key: string, nextState: EventMonthLoadState) => {
    const next = { ...monthStatesRef.current, [key]: nextState };
    monthStatesRef.current = next;
    setMonthStates(next);
    const rangeError = Object.values(next).find(state => state.status === 'error')?.error ?? null;
    setError(rangeError);
  }, []);

  useLayoutEffect(() => {
    const previousScope = activeScopeRef.current;
    const previousEvents = uniqueEvents([
      ...eventsRef.current,
      ...searchableEventsRef.current,
      ...guestBaseEventsRef.current,
    ]);

    generationRef.current += 1;
    deleteCoordinatorRef.current?.dispose();
    deleteCoordinatorRef.current = null;
    lastDeletedTransactionIdRef.current = null;
    activeScopeRef.current = scope;
    eventsRef.current = [];
    searchableEventsRef.current = [];
    eventMetadataRef.current = {};
    guestBaseEventsRef.current = [];
    loadedGuestMonthsRef.current = new Set();
    monthAccessRef.current = {};
    monthStatesRef.current = {};
    monthRequestSequenceRef.current = new Map();
    activeLoadCountRef.current = 0;
    foregroundRefreshRef.current = null;
    appStateRef.current = AppState.currentState;
    setEvents([]);
    setSearchableEvents([]);
    setLastDeleted(null);
    setError(null);
    setMonthStates({});
    setHydratedScope(null);
    setLoading(false);

    void switchEventNotificationScope(
      previousScope,
      scope,
      previousEvents,
    ).catch(() => undefined);
  }, [scope]);

  const persistMetadata = useCallback((map: EventMetadataMap) => {
    return persistJson(metadataStorageKey, map);
  }, [metadataStorageKey]);

  const dismissCacheRecoveryNotice = useCallback(async () => {
    // Account cache recovery no longer exists; kept as a stable context action.
  }, []);

  const persistGuestEvents = useCallback((next: CalEvent[]) => {
    // Calendar CRUD is device-primary.  AsyncStorage is read only once below
    // as a compatibility migration for older installs; all subsequent writes
    // go through the WAL-backed SQLite store.
    return replaceLocalScheduleEvents(next);
  }, []);

  const enqueueGuestMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = guestMutationQueueRef.current.then(operation, operation);
    guestMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const refreshEventCatalog = useCallback(async () => {
    if (activeScopeRef.current !== scope) return;
    searchableEventsRef.current = guestBaseEventsRef.current;
    setSearchableEvents(guestBaseEventsRef.current);
    try {
      await reconcileEventNotificationHorizon(scope, guestBaseEventsRef.current);
    } catch {
      // Local calendar stays available when reminder scheduling is unavailable.
    }
  }, [scope]);

  const refreshEvents = useCallback(async (year: number, month: number): Promise<EventRefreshResult> => {
    const requestGeneration = generationRef.current;
    const emptyResult: EventRefreshResult = { dataLoaded: false, reminderSyncConfirmed: false };
    if (activeScopeRef.current !== scope) {
      return emptyResult;
    }
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return emptyResult;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const requestSequence = (monthRequestSequenceRef.current.get(monthKey) ?? 0) + 1;
    monthRequestSequenceRef.current.set(monthKey, requestSequence);
    const isCurrentRequest = () => generationRef.current === requestGeneration
      && activeScopeRef.current === scope
      && monthRequestSequenceRef.current.get(monthKey) === requestSequence;
    updateMonthState(monthKey, { status: 'loading', error: null });
    const loadGeneration = beginLoading();
    let result = emptyResult;

    try {
      monthAccessRef.current = touchEventMonth(monthAccessRef.current, monthKey);
      loadedGuestMonthsRef.current = new Set(Object.keys(monthAccessRef.current));
      const expanded = projectDeletionTransactions(
        expandEventsForMonths(guestBaseEventsRef.current, loadedGuestMonthsRef.current)
          .map(event => applyEventMetadata(event, metadataForEvent(eventMetadataRef.current, event))),
        deleteCoordinatorRef.current?.list() ?? [],
      );
      const previous = eventsRef.current;
      eventsRef.current = expanded;
      setEvents(expanded);
      const window = monthWindow(year, month);
      let notificationIds: Record<string, string | null> = {};
      let reminderSyncConfirmed = true;
      try {
        notificationIds = await reconcileEventNotifications(scope, expanded, {
          windowStart: window.start,
          windowEnd: window.end,
          previousEvents: previous,
        });
      } catch {
        // Notification persistence must not block the local calendar.
        reminderSyncConfirmed = false;
      }
      if (!isCurrentRequest()) return emptyResult;

      const withNotifications = expanded.map(event => ({
        ...event,
        notificationId: Object.prototype.hasOwnProperty.call(notificationIds, event.id)
          ? notificationIds[event.id]
          : event.notificationId,
      }));
      eventsRef.current = withNotifications;
      setEvents(withNotifications);

      let nextMetadata = { ...eventMetadataRef.current };
      for (const event of withNotifications) {
        nextMetadata = mergeEventDisplayMetadata(nextMetadata, event);
      }
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
      result = { dataLoaded: true, reminderSyncConfirmed };
      if (isCurrentRequest()) updateMonthState(monthKey, { status: 'loaded', error: null, updatedAt: Date.now() });
      return result;
    } catch (err) {
      if (!isCurrentRequest()) return result;
      updateMonthState(monthKey, {
        status: 'error',
        error: err instanceof Error ? err.message : '日程服务暂时不可用',
      });
    } finally {
      endLoading(loadGeneration);
    }
    return result;
  }, [beginLoading, endLoading, persistMetadata, scope, updateMonthState]);

  useEffect(() => {
    let alive = true;
    const loadGeneration = generationRef.current;
    const isCurrent = () => alive
      && generationRef.current === loadGeneration
      && activeScopeRef.current === scope;
    async function loadForScope() {
      const hydrationLoadGeneration = beginLoading();
      try {
        const metadata = await loadJson<EventMetadataMap>(metadataStorageKey, {});
        if (!isCurrent()) return;
        eventMetadataRef.current = metadata;
        let guestEvents = await loadLocalScheduleEvents().catch(() => []);
        if (guestEvents.length === 0) {
          const legacyGuestEvents = await loadJson<CalEvent[]>(GUEST_EVENTS_KEY, []);
          if (legacyGuestEvents.length > 0) {
            guestEvents = legacyGuestEvents;
            await replaceLocalScheduleEvents(legacyGuestEvents).catch(() => undefined);
          }
        }
        if (!isCurrent()) return;
        guestBaseEventsRef.current = guestEvents;
        searchableEventsRef.current = guestEvents;
        setSearchableEvents(guestEvents);
        const now = new Date();
        monthAccessRef.current = touchEventMonth(
          {},
          `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        );
        loadedGuestMonthsRef.current = new Set(Object.keys(monthAccessRef.current));
        await refreshEvents(now.getFullYear(), now.getMonth() + 1);
      } finally {
        if (isCurrent()) {
          setHydratedScope(scope);
        }
        endLoading(hydrationLoadGeneration);
      }
    }
    loadForScope();
    return () => { alive = false; };
  }, [
    beginLoading,
    endLoading,
    metadataStorageKey,
    refreshEvents,
    scope,
  ]);

  useEffect(() => {
    if (hydratedScope !== scope) return undefined;
    let active = true;
    const refreshForegroundRanges = () => {
      if (foregroundRefreshRef.current) return;
      const now = new Date();
      const months = [-1, 0, 1].map(offset => new Date(now.getFullYear(), now.getMonth() + offset, 1));
      const operation = Promise.allSettled([
        ...months.map(value => refreshEvents(value.getFullYear(), value.getMonth() + 1)),
        refreshEventCatalog(),
      ]).then(() => undefined);
      foregroundRefreshRef.current = operation;
      void operation.finally(() => {
        if (active && foregroundRefreshRef.current === operation) foregroundRefreshRef.current = null;
      });
    };
    const subscription = AppState.addEventListener('change', nextState => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === 'active' && previous !== 'active') refreshForegroundRanges();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [hydratedScope, refreshEventCatalog, refreshEvents, scope]);

  const addEvent = useCallback(async (input: Omit<CalEvent, 'id'>): Promise<EventCreateResult> => {
    const validation = validateEventDraft(input);
    if (!validation.valid || !validation.value) throw new EventDraftValidationError(validation.issues);
    const ev = validation.value;
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('event scope changed');
    return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          throw new Error('event scope changed');
        }
        const replay = eventWithClientRequestId(guestBaseEventsRef.current, ev.clientRequestId);
        if (replay) {
          return {
            eventRef: eventRefForEvent(replay),
            reminderDelivery: reminderDeliveryForEvent(replay, replay.notificationId),
          };
        }
        const category = normalizeEventCategory(ev.category);
        const baseId = createGuestId();
        const baseEvent: CalEvent = {
          ...ev,
          category,
          id: baseId,
          sourceEventId: baseId,
          occurrenceDate: ev.startDate,
          seriesStartDate: ev.startDate,
          seriesEndDate: ev.endDate,
          color: colorForEvent({ category }),
          eventRevision: Math.max(1, ev.eventRevision ?? 1),
          draftSourceSha256: ev.draftSourceSha256 ?? null,
          producerRevision: ev.producerRevision ?? 'legacy-v1',
          graphSchemaRevision: ev.graphSchemaRevision ?? 'mention-graph-v1',
        };
        const nextGuestEvents = [...guestBaseEventsRef.current, baseEvent];
        await persistGuestEvents(nextGuestEvents);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          return {
            eventRef: eventRefForEvent(baseEvent),
            reminderDelivery: reminderDeliveryForEvent(baseEvent, null, true),
          };
        }
        guestBaseEventsRef.current = nextGuestEvents;
        searchableEventsRef.current = nextGuestEvents;
        setSearchableEvents(nextGuestEvents);
        const date = new Date(`${ev.startDate}T00:00:00`);
        const refreshResult = await refreshEvents(date.getFullYear(), date.getMonth() + 1);
        let horizonConfirmed = true;
        try {
          await reconcileEventNotificationHorizon(scope, nextGuestEvents);
        } catch {
          horizonConfirmed = false;
        }
        const persisted = eventsRef.current.find(event => sourceEventId(event) === baseId) ?? baseEvent;
        return {
          eventRef: eventRefForEvent(persisted),
          reminderDelivery: reminderDeliveryForEvent(
            persisted,
            persisted.notificationId,
            !refreshResult.dataLoaded || !refreshResult.reminderSyncConfirmed || !horizonConfirmed,
          ),
        };
    });
  }, [enqueueGuestMutation, persistGuestEvents, refreshEvents, scope]);

  const findConflicts = useCallback(async (
    draft: Omit<CalEvent, 'id'>,
    excludeRef?: EventRef,
    excludeScope: EventRecurrenceScope = 'series',
  ): Promise<EventConflictQueryResult> => {
    const endDate = eventEffectiveEndDate(draft);
    const evaluate = (
      catalog: CalEvent[],
      status: EventConflictQueryResult['coverage']['status'],
    ): EventConflictQueryResult => {
      const result = evaluateEventConflicts(
        eventsForDateRange(catalog, draft.startDate, endDate),
        draft,
        excludeRef,
        excludeScope,
      );
      return {
        ...result,
        complete: status === 'complete',
        coverage: {
          status,
          fromDate: draft.startDate,
          throughDate: endDate,
          completeForSeries: !draft.repeat || draft.repeat === 'once',
        },
        invalidCandidateCount: 0,
      };
    };

    return evaluate(guestBaseEventsRef.current, 'complete');
  }, []);

  const resolveEventRef = useCallback(async (ref: EventRef): Promise<EventResolutionResult> => {
    const resolveCurrent = () => resolveEventReference(
      [...eventsRef.current, ...searchableEventsRef.current, ...guestBaseEventsRef.current],
      ref,
    );
    const current = resolveCurrent();
    if (current) return { status: 'found', event: current };
    if (activeScopeRef.current !== scope) return { status: 'scope-changed', event: null };
    if (hydratedScope !== scope) return { status: 'retryable', event: null };
    return { status: 'not-found', event: null };
  }, [hydratedScope, scope]);

  const persistDeleteTransactions = useCallback((transactions: EventDeleteTransaction[]) => {
    return writeAppStorageJson(eventDeleteTransactionsKey, transactions, { removeIfEmpty: true });
  }, [eventDeleteTransactionsKey]);

  const applyDeleteAbsent = useCallback(async (transaction: EventDeleteTransaction) => {
    if (activeScopeRef.current !== transaction.scopeKey) return;
    const base = guestBaseEventsRef.current.find(event => (
        stableSourceEventId(event) === transaction.ref.sourceEventId
      )) ?? transaction.catalogEvent;
      if (!base) throw new Error('event series not found');
      const nextGuestEvents = transaction.recurrenceScope === 'series'
        ? guestBaseEventsRef.current.filter(event => stableSourceEventId(event) !== transaction.ref.sourceEventId)
        : guestBaseEventsRef.current.map(event => stableSourceEventId(event) === transaction.ref.sourceEventId
          ? applyGuestTransactionToSeries(event, transaction, 'absent')
          : event);
      await persistGuestEvents(nextGuestEvents);
      if (activeScopeRef.current !== transaction.scopeKey) return;
      guestBaseEventsRef.current = nextGuestEvents;
      searchableEventsRef.current = nextGuestEvents;
      const expanded = projectGuestEvents(
        expandEventsForMonths(nextGuestEvents, loadedGuestMonthsRef.current),
        eventMetadataRef.current,
      );
      eventsRef.current = expanded;
      setSearchableEvents(nextGuestEvents);
      setEvents(expanded);
  }, [persistGuestEvents]);

  const applyDeletePresent = useCallback(async (transaction: EventDeleteTransaction) => {
    if (activeScopeRef.current !== transaction.scopeKey) return;
    let nextGuestEvents = guestBaseEventsRef.current;
      if (transaction.recurrenceScope === 'series') {
        if (transaction.catalogEvent && !nextGuestEvents.some(event => (
          stableSourceEventId(event) === transaction.ref.sourceEventId
        ))) nextGuestEvents = [...nextGuestEvents, transaction.catalogEvent];
      } else {
        nextGuestEvents = nextGuestEvents.map(event => stableSourceEventId(event) === transaction.ref.sourceEventId
          ? applyGuestTransactionToSeries(event, transaction, 'present')
          : event);
      }
      await persistGuestEvents(nextGuestEvents);
      if (activeScopeRef.current !== transaction.scopeKey) return;
      guestBaseEventsRef.current = nextGuestEvents;
      searchableEventsRef.current = nextGuestEvents;
      const expanded = projectGuestEvents(
        expandEventsForMonths(nextGuestEvents, loadedGuestMonthsRef.current),
        eventMetadataRef.current,
      );
      eventsRef.current = expanded;
      setSearchableEvents(nextGuestEvents);
      setEvents(expanded);
  }, [persistGuestEvents]);

  const deleteCoordinator = useMemo(() => new EventDeleteCoordinator({
    persist: persistDeleteTransactions,
    applyAbsent: applyDeleteAbsent,
    applyPresent: applyDeletePresent,
    cancelReminders: transaction => cancelEventNotificationsForMutation(
      transaction.scopeKey,
      transaction.ref,
      transaction.recurrenceScope,
      transaction.affectedEvents,
    ),
    restoreReminders: async transaction => {
      for (const event of transaction.affectedEvents) {
        await scheduleEventNotificationForScope(transaction.scopeKey, event);
      }
    },
    finalizeAbsent: async transaction => {
      const nextMetadata = { ...eventMetadataRef.current };
      removeTransactionMetadata(nextMetadata, transaction);
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
      if (!isScopeKey(transaction.scopeKey)) throw new Error('event scope changed');
      await setOccurrenceMeetingLinkState({
        scopeKey: transaction.scopeKey,
        occurrence: transaction.ref,
        selection: transaction.recurrenceScope,
        state: 'orphaned',
      });
    },
    executeDelete: async transaction => ({ observedState: 'absent', revision: transaction.revision }),
    executeRestore: async transaction => ({ observedState: 'present', revision: transaction.revision }),
    isKnownFailure: () => false,
    onUndoTarget: transaction => {
      if (transaction) {
        lastDeletedTransactionIdRef.current = transaction.id;
        setLastDeleted(transaction.snapshot);
        return;
      }
      const latest = deleteCoordinatorRef.current?.list()
        .filter(item => item.desiredState === 'absent' && item.undoUntil > Date.now())
        .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
      lastDeletedTransactionIdRef.current = latest?.id ?? null;
      setLastDeleted(latest?.snapshot ?? null);
    },
  }), [applyDeleteAbsent, applyDeletePresent, persistDeleteTransactions, persistMetadata]);

  useEffect(() => {
    let active = true;
    deleteCoordinatorRef.current = deleteCoordinator;
    void loadJson<EventDeleteTransaction[]>(eventDeleteTransactionsKey, []).then(async transactions => {
      if (!active || activeScopeRef.current !== scope) return;
      await deleteCoordinator.hydrate(transactions.filter(transaction => transaction.scopeKey === scope));
      for (const transaction of deleteCoordinator.list()) {
        if (transaction.desiredState === 'absent') await applyDeleteAbsent(transaction);
      }
      await deleteCoordinator.expire();
      void deleteCoordinator.resumeAll().catch(() => undefined);
    });
    return () => {
      active = false;
      deleteCoordinator.dispose();
      if (deleteCoordinatorRef.current === deleteCoordinator) deleteCoordinatorRef.current = null;
    };
  }, [applyDeleteAbsent, deleteCoordinator, eventDeleteTransactionsKey, scope]);

  useEffect(() => {
    const transactionId = lastDeletedTransactionIdRef.current;
    if (!lastDeleted || !transactionId) return;
    const transaction = deleteCoordinator.list().find(item => item.id === transactionId);
    if (!transaction) return;
    const timer = setTimeout(() => {
      void deleteCoordinator.expire().catch(() => undefined);
    }, Math.max(0, transaction.undoUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [deleteCoordinator, lastDeleted]);

  const deleteEvent = useCallback(async (
    ref: EventRef,
    recurrenceScope: EventRecurrenceScope = 'series',
  ) => {
    if (activeScopeRef.current !== scope) throw new Error('event scope changed');
    const target = resolveEventReference(
      [...eventsRef.current, ...searchableEventsRef.current, ...guestBaseEventsRef.current],
      ref,
    );
    if (!target) throw new Error('event occurrence not found');
    const effectiveScope = !target.repeat || target.repeat === 'once' ? 'series' : recurrenceScope;
    const catalogEvent = searchableEventsRef.current.find(event => (
      stableSourceEventId(event) === ref.sourceEventId
    )) ?? guestBaseEventsRef.current.find(event => stableSourceEventId(event) === ref.sourceEventId) ?? null;
    const transaction = createEventDeleteTransaction({
      scopeKey: scope,
      target,
      recurrenceScope: effectiveScope,
      relatedEvents: eventsRef.current,
      catalogEvent,
    });
    await deleteCoordinator.begin(transaction);
  }, [deleteCoordinator, scope]);

  const updateEvent = useCallback(async (
    ref: EventRef,
    changes: Partial<CalEvent>,
    recurrenceScope: EventRecurrenceScope = 'series',
  ): Promise<EventMutationResult> => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('event scope changed');
    const currentEvents = eventsRef.current;
    const previous = resolveEventReference(
      [...currentEvents, ...searchableEventsRef.current],
      ref,
    );
    if (!previous) throw new Error('event occurrence not found');
    const { id: _ignoredId, ...candidate } = {
      ...previous,
      ...changes,
    } as CalEvent;
    const validation = validateEventDraft(candidate);
    if (!validation.valid || !validation.value) throw new EventDraftValidationError(validation.issues);
    const validated = validation.value;
    return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          throw new Error('event scope changed');
        }
        const guestCurrentEvents = eventsRef.current;
        const guestPrevious = resolveEventReference(
          [...guestCurrentEvents, ...guestBaseEventsRef.current],
          ref,
        );
        if (!guestPrevious) throw new Error('event occurrence not found');
        const targetSourceId = ref.sourceEventId;
        const relatedEvents = guestCurrentEvents.filter(event => sourceEventId(event) === targetSourceId);
        const effectiveScope = !guestPrevious.repeat || guestPrevious.repeat === 'once'
          ? 'series'
          : guestPrevious.isRecurrenceException && recurrenceScope === 'following'
            ? 'occurrence'
            : recurrenceScope;
        const nextGuestEvents = applyGuestRecurrenceEdit({
          events: guestBaseEventsRef.current,
          target: guestPrevious,
          ref,
          scope: effectiveScope,
          validated: {
            ...validated,
            eventRevision: Math.max(
              guestPrevious.eventRevision ?? guestPrevious.revision ?? 1,
              validated.eventRevision ?? 1,
            ) + 1,
            draftSourceSha256: validated.draftSourceSha256 ?? guestPrevious.draftSourceSha256 ?? null,
            producerRevision: validated.producerRevision ?? guestPrevious.producerRevision ?? 'legacy-v1',
            graphSchemaRevision: validated.graphSchemaRevision
              ?? guestPrevious.graphSchemaRevision
              ?? 'mention-graph-v1',
          },
          segmentId: createGuestId(),
        });
        await persistGuestEvents(nextGuestEvents);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          return { reminderDelivery: 'unconfirmed' };
        }
        guestBaseEventsRef.current = nextGuestEvents;
        searchableEventsRef.current = nextGuestEvents;
        setSearchableEvents(nextGuestEvents);
        let reminderUnconfirmed = false;
        try {
          await cancelEventNotificationsForMutation(
            scope,
            ref,
            effectiveScope,
            relatedEvents,
          );
        } catch {
          // Startup reconciliation will retry cleanup if the notification service is unavailable.
          reminderUnconfirmed = true;
        }
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          return { reminderDelivery: 'unconfirmed' };
        }
        const nextMetadata = { ...eventMetadataRef.current };
        removeMutationMetadata(nextMetadata, ref, effectiveScope, relatedEvents);
        eventMetadataRef.current = nextMetadata;
        await persistMetadata(nextMetadata);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          return { reminderDelivery: 'unconfirmed' };
        }
        const months = new Set(loadedGuestMonthsRef.current);
        for (const key of monthKeysForRange(
          guestPrevious.startDate,
          eventEffectiveEndDate(guestPrevious),
        )) months.add(key);
        for (const event of nextGuestEvents.filter(event => sourceEventId(event) === targetSourceId)) {
          for (const key of monthKeysForRange(event.startDate, eventEffectiveEndDate(event))) months.add(key);
        }
        const refreshResults = await Promise.all([...months].map(key => {
          const [year, month] = key.split('-').map(Number);
          return Number.isFinite(year) && Number.isFinite(month)
            ? refreshEvents(year, month)
            : Promise.resolve({ dataLoaded: false, reminderSyncConfirmed: false });
        }));
        const updatedEvents = eventsRef.current.filter(event => sourceEventId(event) === targetSourceId);
        const fallback = resolveEventReference(nextGuestEvents, ref)
          ?? nextGuestEvents.find(event => sourceEventId(event) === targetSourceId)
          ?? guestPrevious;
        return {
          reminderDelivery: reminderDeliveryForUpdatedEvents(
            updatedEvents,
            fallback,
            reminderUnconfirmed || refreshResults.some(result => (
              !result.dataLoaded || !result.reminderSyncConfirmed
            )),
          ),
        };
    });
  }, [enqueueGuestMutation, persistGuestEvents, persistMetadata, refreshEvents, scope]);

  const undoDelete = useCallback(async () => {
    const transactionId = lastDeletedTransactionIdRef.current;
    if (!transactionId) return;
    await deleteCoordinator.undo(transactionId);
  }, [deleteCoordinator]);

  return (
    <EventsContext.Provider value={{
      events,
      searchableEvents,
      loading,
      error,
      monthStates,
      cacheRecoveryNotice,
      hydratedScope,
      addEvent,
      deleteEvent,
      updateEvent,
      refreshEvents,
      findConflicts,
      resolveEventRef,
      undoDelete,
      dismissCacheRecoveryNotice,
      lastDeleted,
    }}>
      {children}
    </EventsContext.Provider>
  );
}

export function useEvents() {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside EventsProvider');
  return ctx;
}
