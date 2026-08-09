import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import {
  ApiEvent,
  ApiEventEditCommandResponse,
  commandEventEdit,
  commandEventState,
  fetchEventEditCommand,
  fetchEvents,
  saveEvent,
} from '../services/api';
import { useAuth } from './AuthStore';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import {
  EventDisplayMetadata,
  apiEventClientId,
  apiEventToCalEvent,
  applyEventMetadata,
  calEventChangesToApiEditPatch,
  calEventToApiEvent,
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
import { HttpResponseError } from '../services/errors';
import { EventDeleteCoordinator } from '../services/eventDeleteCoordinator';
import {
  applyGuestTransactionToSeries,
  createEventDeleteTransaction,
  eventIsInRecurrenceScope,
  hideTransactionScope,
  restoreTransactionScope,
  type EventDeleteTransaction,
} from '../services/eventDeleteTransactions';
import {
  EventEditCoordinator,
  type EventEditFailureKind,
} from '../services/eventEditCoordinator';
import {
  createEventEditJournal,
  createEventEditTransaction,
  parseEventEditJournal,
  type EventEditTransaction,
} from '../services/eventEditTransactions';
import { applyGuestRecurrenceEdit } from '../services/guestRecurrenceEdit';
import {
  type EventCacheRecoveryNotice,
  type EventMonthAccess,
  clearEventCacheRecoveryNotice,
  filterEventsToMonthAccess,
  loadEventCatalogCache,
  loadEventMonthCache,
  saveEventCatalogCache,
  saveEventMonthCache,
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
const EVENT_EDIT_TRANSACTIONS_KEY = '@laoji:eventEditTransactions:v1';

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

function metadataFromEvent(ev: Omit<CalEvent, 'id'>): EventMetadata {
  return cleanMetadata({
    location: ev.location,
    category: ev.category,
    detail: ev.detail,
    reminderMinutes: ev.reminderMinutes,
  });
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

function metadataForApiEvent(event: ApiEvent & { id: number }, map: EventMetadataMap): EventMetadata | undefined {
  const clientId = apiEventClientId(event);
  const stableKey = eventRefKey({
    sourceEventId: String(event.source_event_id ?? event.id),
    occurrenceDate: event.occurrence_date ?? event.start_date,
  });
  const saved = map[stableKey] ?? map[clientId] ?? map[String(event.id)];
  if (!Object.prototype.hasOwnProperty.call(event, 'reminder_minutes')) return saved;
  return { ...saved, reminderMinutes: event.reminder_minutes ?? null };
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

function normalizeEditResponseEvent(
  transaction: EventEditTransaction,
  response: ApiEventEditCommandResponse,
  metadata?: EventMetadata,
): CalEvent {
  const event = apiEventToCalEvent(response.event, metadata);
  const sourceId = transaction.ref.sourceEventId;
  if (transaction.recurrenceScope === 'occurrence') {
    return {
      ...event,
      id: event.id === sourceId
        ? `${sourceId}@${transaction.ref.occurrenceDate}:exception`
        : event.id,
      sourceEventId: sourceId,
      occurrenceDate: transaction.ref.occurrenceDate,
      isRecurrenceException: true,
      isExpandedOccurrence: false,
    };
  }
  if (transaction.recurrenceScope === 'following') {
    const segmentId = response.segment_id ?? event.recurrenceSegmentId ?? transaction.id;
    return {
      ...event,
      id: event.id === sourceId ? `${sourceId}:segment:${segmentId}` : event.id,
      sourceEventId: sourceId,
      occurrenceDate: transaction.ref.occurrenceDate,
      recurrenceSegmentId: segmentId,
      recurrenceEffectiveFromDate: transaction.ref.occurrenceDate,
      isExpandedOccurrence: false,
      seriesStartDate: event.seriesStartDate ?? event.startDate,
    };
  }
  return {
    ...event,
    sourceEventId: sourceId,
    occurrenceDate: event.occurrenceDate ?? event.seriesStartDate ?? event.startDate,
    isExpandedOccurrence: false,
  };
}

function projectEditResponse(
  events: CalEvent[],
  catalog: CalEvent[],
  transaction: EventEditTransaction,
  responseEvent: CalEvent,
  loadedMonths: string[],
): { events: CalEvent[]; catalog: CalEvent[] } {
  const sourceId = transaction.ref.sourceEventId;
  const retainedEvents = events.filter(event => !eventIsInRecurrenceScope(
    event,
    transaction.ref,
    transaction.recurrenceScope,
  ));
  const projectedResponse = responseEvent.isRecurrenceException
    || !responseEvent.repeat
    || responseEvent.repeat === 'once'
    ? [responseEvent]
    : expandEventsForMonths([responseEvent], loadedMonths);

  let nextCatalog: CalEvent[];
  if (transaction.recurrenceScope === 'series') {
    nextCatalog = [...catalog.filter(event => stableSourceEventId(event) !== sourceId), responseEvent];
  } else if (transaction.recurrenceScope === 'occurrence') {
    nextCatalog = catalog
      .filter(event => !(
        event.isRecurrenceException
        && eventIsInRecurrenceScope(event, transaction.ref, 'occurrence')
      ))
      .map(event => stableSourceEventId(event) === sourceId && !event.isRecurrenceException
        ? {
          ...event,
          excludedOccurrenceDates: [...new Set([
            ...(event.excludedOccurrenceDates ?? []),
            transaction.ref.occurrenceDate,
          ])].sort(),
        }
        : event);
    nextCatalog.push(responseEvent);
  } else {
    nextCatalog = catalog
      .filter(event => !(
        stableSourceEventId(event) === sourceId
        && event.recurrenceSegmentId != null
        && (event.seriesStartDate ?? event.startDate) >= transaction.ref.occurrenceDate
      ))
      .map(event => stableSourceEventId(event) === sourceId
        && (event.seriesStartDate ?? event.startDate) < transaction.ref.occurrenceDate
        ? { ...event, excludedAfterDate: transaction.ref.occurrenceDate }
        : event);
    nextCatalog.push(responseEvent);
  }
  return {
    events: uniqueEvents([...retainedEvents, ...projectedResponse]),
    catalog: uniqueEvents(nextCatalog),
  };
}

function classifyEventEditFailure(
  error: unknown,
  operation: 'execute' | 'recover',
): EventEditFailureKind {
  if (operation === 'recover' && error instanceof HttpResponseError && error.status === 404) {
    return 'command-missing';
  }
  if (error instanceof HttpResponseError
    && [400, 403, 404, 409, 422].includes(error.status)) return 'permanent';
  return 'retryable';
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

function projectCatalogTransactions(
  catalog: CalEvent[],
  transactions: EventDeleteTransaction[],
): CalEvent[] {
  return transactions.reduce((projected, transaction) => {
    if (transaction.recurrenceScope === 'series') {
      return projected.filter(event => stableSourceEventId(event) !== transaction.ref.sourceEventId);
    }
    return projected.map(event => stableSourceEventId(event) === transaction.ref.sourceEventId
      ? applyGuestTransactionToSeries(event, transaction, 'absent')
      : event);
  }, catalog);
}

interface EventsContextType {
  events: CalEvent[];
  searchableEvents: CalEvent[];
  loading: boolean;
  error: string | null;
  monthStates: Record<string, EventMonthLoadState>;
  cacheRecoveryNotice: EventCacheRecoveryNotice | null;
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
  syncStatus?: 'pending';
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
  const { mode, session, accessToken } = useAuth();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [searchableEvents, setSearchableEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monthStates, setMonthStates] = useState<Record<string, EventMonthLoadState>>({});
  const [cacheRecoveryNotice, setCacheRecoveryNotice] = useState<EventCacheRecoveryNotice | null>(null);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [editJournalHydratedScope, setEditJournalHydratedScope] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<CalEvent | null>(null);
  const lastDeletedTransactionIdRef = useRef<string | null>(null);
  const deleteCoordinatorRef = useRef<EventDeleteCoordinator | null>(null);
  const editCoordinatorRef = useRef<EventEditCoordinator<EventMutationResult> | null>(null);
  const eventMetadataRef = useRef<EventMetadataMap>({});
  const guestBaseEventsRef = useRef<CalEvent[]>([]);
  const loadedGuestMonthsRef = useRef<Set<string>>(new Set());
  const monthAccessRef = useRef<EventMonthAccess>({});
  const monthStatesRef = useRef<Record<string, EventMonthLoadState>>({});
  const monthRequestSequenceRef = useRef<Map<string, number>>(new Map());
  const catalogRequestSequenceRef = useRef(0);
  const activeLoadCountRef = useRef(0);
  const foregroundRefreshRef = useRef<Promise<void> | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const eventsRef = useRef<CalEvent[]>([]);
  const searchableEventsRef = useRef<CalEvent[]>([]);
  const generationRef = useRef(0);
  const activeScopeRef = useRef<string | null>(null);
  const guestMutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const metadataStorageKey = `${EVENT_METADATA_KEY}:${scope}`;
  const eventDeleteTransactionsKey = `${EVENT_DELETE_TRANSACTIONS_KEY}:${scope}`;
  const eventEditTransactionsKey = `${EVENT_EDIT_TRANSACTIONS_KEY}:${scope}`;

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
    editCoordinatorRef.current?.dispose();
    editCoordinatorRef.current = null;
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
    catalogRequestSequenceRef.current += 1;
    activeLoadCountRef.current = 0;
    foregroundRefreshRef.current = null;
    appStateRef.current = AppState.currentState;
    setEvents([]);
    setSearchableEvents([]);
    setLastDeleted(null);
    setError(null);
    setMonthStates({});
    setCacheRecoveryNotice(null);
    setHydratedScope(null);
    setEditJournalHydratedScope(null);
    setLoading(false);

    void switchEventNotificationScope(
      previousScope === 'signed_out' ? null : previousScope,
      scope === 'signed_out' ? null : scope,
      previousEvents,
    ).catch(() => undefined);
  }, [scope]);

  const persistMetadata = useCallback((map: EventMetadataMap) => {
    return persistJson(metadataStorageKey, map);
  }, [metadataStorageKey]);

  const persistEvents = useCallback((next: CalEvent[]) => {
    if (mode !== 'authenticated') return Promise.resolve();
    return saveEventMonthCache(scope, next, monthAccessRef.current).catch(() => undefined);
  }, [mode, scope]);

  const persistEventCatalog = useCallback((next: CalEvent[]) => {
    if (mode !== 'authenticated') return Promise.resolve();
    return saveEventCatalogCache(scope, next).catch(() => undefined);
  }, [mode, scope]);

  const dismissCacheRecoveryNotice = useCallback(async () => {
    await clearEventCacheRecoveryNotice(scope);
    if (activeScopeRef.current === scope) setCacheRecoveryNotice(null);
  }, [scope]);

  const saveMetadataPatch = useCallback(async (id: string, patch: EventMetadata) => {
    const nextMap = mergeMetadata(eventMetadataRef.current, id, patch);
    eventMetadataRef.current = nextMap;
    await persistMetadata(nextMap);
    return nextMap[id];
  }, [persistMetadata]);

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

  const persistNotificationId = useCallback(async (event: CalEvent, notificationId: string | null) => {
    const patched = { ...event, notificationId };
    await saveMetadataPatch(metadataKeyForEvent(event), { reminderMinutes: patched.reminderMinutes, notificationId });
    return patched;
  }, [saveMetadataPatch]);

  const refreshEventCatalog = useCallback(async () => {
    const requestGeneration = generationRef.current;
    const requestSequence = catalogRequestSequenceRef.current + 1;
    catalogRequestSequenceRef.current = requestSequence;
    const isCurrentRequest = () => generationRef.current === requestGeneration
      && activeScopeRef.current === scope
      && catalogRequestSequenceRef.current === requestSequence;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      searchableEventsRef.current = [];
      setSearchableEvents([]);
      return;
    }
    if (mode === 'guest') {
      searchableEventsRef.current = guestBaseEventsRef.current;
      setSearchableEvents(guestBaseEventsRef.current);
      try {
        await reconcileEventNotificationHorizon(scope, guestBaseEventsRef.current);
      } catch {
        // The guest catalog remains available when reminder scheduling is unavailable.
      }
      return;
    }
    if (!accessToken) return;
    const data = await fetchEvents(undefined, undefined, accessToken);
    if (!isCurrentRequest()) return;
    const loadedCatalog = (data as (ApiEvent & { id: number })[]).map(event => {
      return apiEventToCalEvent(event, metadataForApiEvent(event, eventMetadataRef.current));
    });
    const catalog = projectCatalogTransactions(
      loadedCatalog,
      deleteCoordinatorRef.current?.list() ?? [],
    );
    searchableEventsRef.current = catalog;
    setSearchableEvents(catalog);
    if (!isCurrentRequest()) return;
    await persistEventCatalog(catalog);
    if (!isCurrentRequest()) return;
    try {
      await reconcileEventNotificationHorizon(scope, catalog);
    } catch {
      // Catalog synchronization is independent from local reminder delivery.
    }
  }, [accessToken, mode, persistEventCatalog, scope]);

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
    if (mode === 'signed_out') {
      eventsRef.current = [];
      setEvents([]);
      result = { dataLoaded: true, reminderSyncConfirmed: true };
      if (isCurrentRequest()) updateMonthState(monthKey, { status: 'loaded', error: null, updatedAt: Date.now() });
      return result;
    }
    if (mode === 'guest') {
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
        // Notification persistence must not block the guest calendar.
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

      const incomingIds = new Set(expanded.map(event => event.id));
      let nextMetadata = { ...eventMetadataRef.current };
      for (const event of previous) {
        if (eventOverlapsDateRange(event, window.start, window.end) && !incomingIds.has(event.id)) {
          removeEventMetadata(nextMetadata, event);
        }
      }
      for (const event of withNotifications) {
        nextMetadata = mergeMetadata(nextMetadata, metadataKeyForEvent(event), {
          reminderMinutes: event.reminderMinutes,
          notificationId: event.notificationId,
        });
      }
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
      result = { dataLoaded: true, reminderSyncConfirmed };
      if (isCurrentRequest()) updateMonthState(monthKey, { status: 'loaded', error: null, updatedAt: Date.now() });
      return result;
    }
    if (!accessToken) throw new Error('登录状态待恢复，当前显示本机缓存');

    const data = await fetchEvents(year, month, accessToken);
      if (!isCurrentRequest()) return result;
      const loadedLocal = (data as (ApiEvent & { id: number })[]).map(e => {
        return apiEventToCalEvent(e, metadataForApiEvent(e, eventMetadataRef.current));
      });
      const local = projectDeletionTransactions(
        loadedLocal,
        deleteCoordinatorRef.current?.list() ?? [],
      );
      const window = monthWindow(year, month);
      const previous = eventsRef.current;
      const incomingIds = new Set(local.map(event => event.id));
      const retained = previous.filter(event => {
        if (incomingIds.has(event.id)) return false;
        return !eventOverlapsDateRange(event, window.start, window.end);
      });
      monthAccessRef.current = touchEventMonth(monthAccessRef.current, monthKey);
      const next = filterEventsToMonthAccess([...retained, ...local], monthAccessRef.current);
      eventsRef.current = next;
      setEvents(next);
      await persistEvents(next);
      if (!isCurrentRequest()) return result;

      let notificationIds: Record<string, string | null> = {};
      let reminderSyncConfirmed = true;
      try {
        notificationIds = await reconcileEventNotifications(scope, local, {
          windowStart: window.start,
          windowEnd: window.end,
          previousEvents: previous,
        });
      } catch {
        // The cloud calendar remains usable when local notification storage fails.
        reminderSyncConfirmed = false;
      }
      if (!isCurrentRequest()) return result;

      const withNotifications = eventsRef.current.map(event => (
        incomingIds.has(event.id) && Object.prototype.hasOwnProperty.call(notificationIds, event.id)
          ? { ...event, notificationId: notificationIds[event.id] }
          : event
      ));
      eventsRef.current = withNotifications;
      setEvents(withNotifications);
      await persistEvents(withNotifications);
      if (!isCurrentRequest()) return result;

      let nextMetadata = { ...eventMetadataRef.current };
      for (const event of previous) {
        if (eventOverlapsDateRange(event, window.start, window.end) && !incomingIds.has(event.id)) {
          removeEventMetadata(nextMetadata, event);
        }
      }
      for (const event of withNotifications.filter(event => incomingIds.has(event.id))) {
        nextMetadata = mergeMetadata(nextMetadata, metadataKeyForEvent(event), {
          reminderMinutes: event.reminderMinutes,
          notificationId: event.notificationId,
        });
      }
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
      result = { dataLoaded: true, reminderSyncConfirmed };
      if (isCurrentRequest()) updateMonthState(monthKey, { status: 'loaded', error: null, updatedAt: Date.now() });
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
  }, [accessToken, beginLoading, endLoading, mode, persistEvents, persistMetadata, scope, updateMonthState]);

  useEffect(() => {
    let alive = true;
    const loadGeneration = generationRef.current;
    const isCurrent = () => alive
      && generationRef.current === loadGeneration
      && activeScopeRef.current === scope;
    async function loadForScope() {
      if (mode === 'signed_out') {
        return;
      }
      const hydrationLoadGeneration = beginLoading();
      try {
        const metadata = await loadJson<EventMetadataMap>(metadataStorageKey, {});
        if (!isCurrent()) return;
        eventMetadataRef.current = metadata;
        if (mode === 'guest') {
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
          return;
        }
        const now = new Date();
        const cachedMonths = await loadEventMonthCache(scope, now);
        const cachedCatalog = await loadEventCatalogCache(scope, now.getTime());
        if (!isCurrent()) return;
        monthAccessRef.current = cachedMonths.monthAccess;
        setCacheRecoveryNotice(cachedCatalog.recoveryNotice ?? cachedMonths.recoveryNotice);
        const hydratedEvents = projectDeletionTransactions(
          cachedMonths.events.map(event => applyEventMetadata(event, metadataForEvent(metadata, event))),
          deleteCoordinatorRef.current?.list() ?? [],
        );
        const hydratedCatalog = projectCatalogTransactions(
          (cachedCatalog.events.length > 0 ? cachedCatalog.events : sourceCatalog(hydratedEvents))
            .map(event => applyEventMetadata(event, metadataForEvent(metadata, event))),
          deleteCoordinatorRef.current?.list() ?? [],
        );
        eventsRef.current = hydratedEvents;
        searchableEventsRef.current = hydratedCatalog;
        setEvents(hydratedEvents);
        setSearchableEvents(hydratedCatalog);
        if (cachedMonths.migratedFromLegacy) await persistEvents(hydratedEvents);
        if (cachedCatalog.migratedFromLegacy) await persistEventCatalog(hydratedCatalog);
        await refreshEvents(now.getFullYear(), now.getMonth() + 1);
        if (!isCurrent()) return;
        try {
          await refreshEventCatalog();
        } catch {
          // The cached global catalog remains searchable while offline.
        }
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
    mode,
    persistEventCatalog,
    persistEvents,
    refreshEventCatalog,
    refreshEvents,
    scope,
  ]);

  useEffect(() => {
    if (mode === 'signed_out' || hydratedScope !== scope) return undefined;
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
  }, [hydratedScope, mode, refreshEventCatalog, refreshEvents, scope]);

  const addEvent = useCallback(async (input: Omit<CalEvent, 'id'>): Promise<EventCreateResult> => {
    const validation = validateEventDraft(input);
    if (!validation.valid || !validation.value) throw new EventDraftValidationError(validation.issues);
    const ev = validation.value;
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('event scope changed');
    if (mode === 'guest') {
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
    }
    if (!accessToken) throw new Error('not authenticated');

    const localReplay = eventWithClientRequestId(searchableEventsRef.current, ev.clientRequestId);
    if (localReplay) {
      return {
        eventRef: eventRefForEvent(localReplay),
        reminderDelivery: reminderDeliveryForEvent(localReplay, localReplay.notificationId),
      };
    }
    let saved: ApiEvent;
    try {
      saved = await saveEvent(calEventToApiEvent(ev), accessToken);
    } catch (reason) {
      if (!(reason instanceof HttpResponseError) || reason.status !== 409 || !ev.clientRequestId?.trim()) {
        throw reason;
      }
      await refreshEventCatalog();
      const replay = eventWithClientRequestId(searchableEventsRef.current, ev.clientRequestId);
      if (!replay) throw reason;
      return {
        eventRef: eventRefForEvent(replay),
        reminderDelivery: reminderDeliveryForEvent(replay, replay.notificationId),
      };
    }
    const savedEvent = saved as ApiEvent & { id: number };
    const savedEventRef: EventRef = {
      sourceEventId: String(savedEvent.id),
      occurrenceDate: savedEvent.occurrence_date ?? savedEvent.start_date,
    };
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
      return { eventRef: savedEventRef, reminderDelivery: 'unconfirmed' };
    }
    const savedId = String(savedEvent.id);
    const savedRefKey = eventRefKey({
      sourceEventId: savedId,
      occurrenceDate: saved.occurrence_date ?? saved.start_date,
    });
    const localMeta = await saveMetadataPatch(savedRefKey, metadataFromEvent(ev));
    let localEv = apiEventToCalEvent(saved as ApiEvent & { id: number }, localMeta);
    let notificationId: string | null = null;
    let reminderUnconfirmed = false;
    try {
      notificationId = await scheduleEventNotificationForScope(scope, localEv);
    } catch {
      // The cloud event is already durable. A local notification registry
      // failure must not invite the user to create the same event again.
      reminderUnconfirmed = true;
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
      return {
        eventRef: savedEventRef,
        reminderDelivery: reminderDeliveryForEvent(localEv, notificationId, true),
      };
    }
    if (notificationId) {
      localEv = await persistNotificationId(localEv, notificationId);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
        return {
          eventRef: savedEventRef,
          reminderDelivery: reminderDeliveryForEvent(localEv, notificationId, true),
        };
      }
    }
    for (const key of monthKeysForRange(localEv.startDate, eventEffectiveEndDate(localEv))) {
      monthAccessRef.current = touchEventMonth(monthAccessRef.current, key);
    }
    setEvents(prev => {
      const next = filterEventsToMonthAccess([...prev, localEv], monthAccessRef.current);
      eventsRef.current = next;
      void persistEvents(next);
      return next;
    });
    const nextCatalog = [
      ...searchableEventsRef.current.filter(event => sourceEventId(event) !== savedId),
      localEv,
    ];
    searchableEventsRef.current = nextCatalog;
    setSearchableEvents(nextCatalog);
    void persistEventCatalog(nextCatalog);
    try {
      await reconcileEventNotificationHorizon(scope, nextCatalog);
    } catch {
      reminderUnconfirmed = true;
    }
    return {
      eventRef: eventRefForEvent(localEv),
      reminderDelivery: reminderDeliveryForEvent(localEv, notificationId, reminderUnconfirmed),
    };
  }, [accessToken, enqueueGuestMutation, mode, persistEventCatalog, persistEvents, persistGuestEvents, persistNotificationId, refreshEventCatalog, refreshEvents, saveMetadataPatch, scope]);

  const findConflicts = useCallback(async (
    draft: Omit<CalEvent, 'id'>,
    excludeRef?: EventRef,
    excludeScope: EventRecurrenceScope = 'series',
  ): Promise<EventConflictQueryResult> => {
    const operationGeneration = generationRef.current;
    const endDate = eventEffectiveEndDate(draft);
    const fallbackCatalog = uniqueEvents([
      ...searchableEventsRef.current,
      ...eventsRef.current,
      ...guestBaseEventsRef.current,
    ]);
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

    if (mode === 'guest') return evaluate(guestBaseEventsRef.current, 'complete');
    if (mode !== 'authenticated' || !accessToken) {
      return evaluate(fallbackCatalog, fallbackCatalog.length > 0 ? 'partial' : 'unavailable');
    }

    const responses = await Promise.allSettled(
      monthKeysForRange(draft.startDate, endDate).map(async key => {
        const [year, month] = key.split('-').map(Number);
        return fetchEvents(year, month, accessToken);
      }),
    );
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
      return evaluate(fallbackCatalog, fallbackCatalog.length > 0 ? 'partial' : 'unavailable');
    }
    const successful = responses.filter(
      (response): response is PromiseFulfilledResult<ApiEvent[]> => response.status === 'fulfilled',
    );
    const loaded = successful.flatMap(response => response.value).map(event => {
        const apiEvent = event as ApiEvent & { id: number };
        return apiEventToCalEvent(apiEvent, metadataForApiEvent(apiEvent, eventMetadataRef.current));
    });
    const byRef = new Map<string, CalEvent>();
    for (const event of [...fallbackCatalog, ...loaded]) {
      byRef.set(eventRefKey({
        sourceEventId: stableSourceEventId(event),
        occurrenceDate: event.occurrenceDate ?? event.startDate,
      }), event);
    }
    const status = successful.length === responses.length
      ? 'complete'
      : byRef.size > 0 ? 'partial' : 'unavailable';
    return evaluate([...byRef.values()], status);
  }, [accessToken, mode, scope]);

  const resolveEventRef = useCallback(async (ref: EventRef): Promise<EventResolutionResult> => {
    const resolveCurrent = () => resolveEventReference(
      [...eventsRef.current, ...searchableEventsRef.current, ...guestBaseEventsRef.current],
      ref,
    );
    const current = resolveCurrent();
    if (current) return { status: 'found', event: current };
    if (activeScopeRef.current !== scope) return { status: 'scope-changed', event: null };
    if (hydratedScope !== scope) return { status: 'retryable', event: null };
    if (mode === 'guest' || mode === 'signed_out') return { status: 'not-found', event: null };
    if (!accessToken) return { status: 'retryable', event: null };

    const [year, month] = ref.occurrenceDate.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return { status: 'not-found', event: null };
    const refresh = await refreshEvents(year, month);
    if (activeScopeRef.current !== scope) return { status: 'scope-changed', event: null };
    let resolved = resolveCurrent();
    if (resolved) return { status: 'found', event: resolved };
    try {
      await refreshEventCatalog();
    } catch {
      // The month result or cached catalog may still be enough below.
    }
    if (activeScopeRef.current !== scope) return { status: 'scope-changed', event: null };
    resolved = resolveCurrent();
    if (resolved) return { status: 'found', event: resolved };
    return refresh.dataLoaded
      ? { status: 'not-found', event: null }
      : { status: 'retryable', event: null };
  }, [accessToken, hydratedScope, mode, refreshEventCatalog, refreshEvents, scope]);

  const persistEditTransactions = useCallback((transactions: EventEditTransaction[]) => {
    return writeAppStorageJson(
      eventEditTransactionsKey,
      transactions.length > 0 ? createEventEditJournal(transactions) : [],
      { removeIfEmpty: true },
    );
  }, [eventEditTransactionsKey]);

  const applyEditCommandResult = useCallback(async (
    transaction: EventEditTransaction,
    response: ApiEventEditCommandResponse,
  ): Promise<EventMutationResult> => {
    if (activeScopeRef.current !== transaction.scopeKey) throw new Error('event scope changed');
    const sourceId = transaction.ref.sourceEventId;
    const relatedEvents = eventsRef.current.filter(event => stableSourceEventId(event) === sourceId);
    let reminderUnconfirmed = false;
    try {
      await cancelEventNotificationsForMutation(
        transaction.scopeKey,
        transaction.ref,
        transaction.recurrenceScope,
        relatedEvents,
      );
    } catch {
      reminderUnconfirmed = true;
    }
    if (activeScopeRef.current !== transaction.scopeKey) throw new Error('event scope changed');

    const nextMetadata = { ...eventMetadataRef.current };
    removeMutationMetadata(nextMetadata, transaction.ref, transaction.recurrenceScope, relatedEvents);
    eventMetadataRef.current = nextMetadata;
    await persistMetadata(nextMetadata);
    if (activeScopeRef.current !== transaction.scopeKey) throw new Error('event scope changed');

    const responseEvent = normalizeEditResponseEvent(
      transaction,
      response,
      metadataForApiEvent(response.event, nextMetadata),
    );
    const loadedMonths = Object.keys(monthAccessRef.current);
    const projected = projectEditResponse(
      eventsRef.current,
      searchableEventsRef.current,
      transaction,
      responseEvent,
      loadedMonths,
    );
    const projectedEvents = filterEventsToMonthAccess(projected.events, monthAccessRef.current);
    eventsRef.current = projectedEvents;
    searchableEventsRef.current = projected.catalog;
    setEvents(projectedEvents);
    setSearchableEvents(projected.catalog);
    await Promise.all([
      persistEvents(projectedEvents),
      persistEventCatalog(projected.catalog),
    ]);

    const months = new Set<string>();
    const anchorMonth = transaction.ref.occurrenceDate.slice(0, 7);
    for (const key of loadedMonths) {
      if (transaction.recurrenceScope === 'series'
        || (transaction.recurrenceScope === 'following' && key >= anchorMonth)) months.add(key);
    }
    for (const event of relatedEvents.filter(event => eventIsInRecurrenceScope(
      event,
      transaction.ref,
      transaction.recurrenceScope,
    ))) {
      for (const key of monthKeysForRange(event.startDate, eventEffectiveEndDate(event))) months.add(key);
    }
    for (const key of monthKeysForRange(
      responseEvent.startDate,
      eventEffectiveEndDate(responseEvent),
    )) months.add(key);
    const affected = response.affected_range;
    if (affected.from_occurrence_date && affected.through_occurrence_date) {
      for (const key of monthKeysForRange(
        affected.from_occurrence_date,
        affected.through_occurrence_date,
      )) months.add(key);
    }

    const refreshResults = await Promise.all([...months].map(key => {
      const [year, month] = key.split('-').map(Number);
      return Number.isFinite(year) && Number.isFinite(month)
        ? refreshEvents(year, month)
        : Promise.resolve({ dataLoaded: false, reminderSyncConfirmed: false });
    }));
    try {
      await refreshEventCatalog();
    } catch {
      // The projected command response remains durable in the local catalog while offline.
    }
    if (activeScopeRef.current !== transaction.scopeKey) throw new Error('event scope changed');
    const updatedEvents = eventsRef.current.filter(event => stableSourceEventId(event) === sourceId);
    return {
      reminderDelivery: reminderDeliveryForUpdatedEvents(
        updatedEvents,
        responseEvent,
        reminderUnconfirmed || refreshResults.some(result => (
          !result.dataLoaded || !result.reminderSyncConfirmed
        )),
      ),
    };
  }, [persistEventCatalog, persistEvents, persistMetadata, refreshEventCatalog, refreshEvents]);

  const editCoordinator = useMemo(() => new EventEditCoordinator<EventMutationResult>({
    persist: persistEditTransactions,
    execute: async transaction => {
      if (!accessToken) throw new HttpResponseError('not authenticated', 401);
      const sourceId = Number(transaction.ref.sourceEventId);
      if (!Number.isSafeInteger(sourceId)) throw new HttpResponseError('invalid event id', 400);
      return commandEventEdit(sourceId, {
        client_request_id: transaction.id,
        scope: transaction.recurrenceScope,
        occurrence_date: transaction.ref.occurrenceDate,
        expected_revision: transaction.expectedRevision,
        patch: transaction.patch,
      }, accessToken);
    },
    recover: async transaction => {
      if (!accessToken) throw new HttpResponseError('not authenticated', 401);
      return fetchEventEditCommand(transaction.id, accessToken);
    },
    apply: applyEditCommandResult,
    classifyFailure: classifyEventEditFailure,
  }), [accessToken, applyEditCommandResult, persistEditTransactions]);

  useEffect(() => {
    let active = true;
    editCoordinatorRef.current = editCoordinator;
    void loadJson<unknown>(eventEditTransactionsKey, null).then(value => {
      if (!active || activeScopeRef.current !== scope) return;
      editCoordinator.hydrate(parseEventEditJournal(value).filter(item => item.scopeKey === scope));
      setEditJournalHydratedScope(scope);
    });
    return () => {
      active = false;
      editCoordinator.dispose();
      if (editCoordinatorRef.current === editCoordinator) editCoordinatorRef.current = null;
    };
  }, [editCoordinator, eventEditTransactionsKey, scope]);

  useEffect(() => {
    if (hydratedScope !== scope || editJournalHydratedScope !== scope) return;
    void editCoordinator.resumeAll();
  }, [editCoordinator, editJournalHydratedScope, hydratedScope, scope]);

  const persistDeleteTransactions = useCallback((transactions: EventDeleteTransaction[]) => {
    return writeAppStorageJson(eventDeleteTransactionsKey, transactions, { removeIfEmpty: true });
  }, [eventDeleteTransactionsKey]);

  const applyDeleteAbsent = useCallback(async (transaction: EventDeleteTransaction) => {
    if (activeScopeRef.current !== transaction.scopeKey) return;
    if (mode === 'guest') {
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
      const expanded = expandEventsForMonths(nextGuestEvents, loadedGuestMonthsRef.current);
      eventsRef.current = expanded;
      setSearchableEvents(nextGuestEvents);
      setEvents(expanded);
      return;
    }

    const nextEvents = hideTransactionScope(eventsRef.current, transaction);
    const nextCatalog = transaction.recurrenceScope === 'series'
      ? searchableEventsRef.current.filter(event => stableSourceEventId(event) !== transaction.ref.sourceEventId)
      : searchableEventsRef.current.map(event => stableSourceEventId(event) === transaction.ref.sourceEventId
        ? applyGuestTransactionToSeries(event, transaction, 'absent')
        : event);
    eventsRef.current = nextEvents;
    searchableEventsRef.current = nextCatalog;
    setEvents(nextEvents);
    setSearchableEvents(nextCatalog);
    await Promise.all([persistEvents(nextEvents), persistEventCatalog(nextCatalog)]);
  }, [mode, persistEventCatalog, persistEvents, persistGuestEvents]);

  const applyDeletePresent = useCallback(async (transaction: EventDeleteTransaction) => {
    if (activeScopeRef.current !== transaction.scopeKey) return;
    if (mode === 'guest') {
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
      const expanded = expandEventsForMonths(nextGuestEvents, loadedGuestMonthsRef.current);
      eventsRef.current = expanded;
      setSearchableEvents(nextGuestEvents);
      setEvents(expanded);
      return;
    }

    let nextCatalog = searchableEventsRef.current;
    if (transaction.recurrenceScope === 'series') {
      if (transaction.catalogEvent && !nextCatalog.some(event => (
        stableSourceEventId(event) === transaction.ref.sourceEventId
      ))) nextCatalog = [...nextCatalog, transaction.catalogEvent];
    } else {
      nextCatalog = nextCatalog.map(event => stableSourceEventId(event) === transaction.ref.sourceEventId
        ? applyGuestTransactionToSeries(event, transaction, 'present')
        : event);
    }
    const nextEvents = restoreTransactionScope(eventsRef.current, transaction);
    eventsRef.current = nextEvents;
    searchableEventsRef.current = nextCatalog;
    setEvents(nextEvents);
    setSearchableEvents(nextCatalog);
    await Promise.all([persistEvents(nextEvents), persistEventCatalog(nextCatalog)]);
  }, [mode, persistEventCatalog, persistEvents, persistGuestEvents]);

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
    executeDelete: async transaction => {
      if (mode === 'guest') return { observedState: 'absent', revision: transaction.revision };
      if (!accessToken) throw new HttpResponseError('not authenticated', 401);
      const sourceId = Number(transaction.ref.sourceEventId);
      if (!Number.isSafeInteger(sourceId)) throw new HttpResponseError('invalid event id', 400);
      const response = await commandEventState(sourceId, {
        client_request_id: transaction.deleteRequestId,
        desired_state: 'absent',
        scope: transaction.recurrenceScope,
        occurrence_date: transaction.ref.occurrenceDate,
        expected_revision: transaction.deleteExpectedRevision,
      }, accessToken);
      return { observedState: response.observed_state, revision: response.revision };
    },
    executeRestore: async transaction => {
      if (mode === 'guest') return { observedState: 'present', revision: transaction.revision };
      if (!accessToken) throw new HttpResponseError('not authenticated', 401);
      const sourceId = Number(transaction.ref.sourceEventId);
      if (!Number.isSafeInteger(sourceId)) throw new HttpResponseError('invalid event id', 400);
      const response = await commandEventState(sourceId, {
        client_request_id: transaction.restoreRequestId,
        desired_state: 'present',
        scope: transaction.recurrenceScope,
        occurrence_date: transaction.ref.occurrenceDate,
        expected_revision: transaction.restoreExpectedRevision,
      }, accessToken);
      return { observedState: response.observed_state, revision: response.revision };
    },
    isKnownFailure: error => error instanceof HttpResponseError && error.status < 500,
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
  }), [accessToken, applyDeleteAbsent, applyDeletePresent, mode, persistDeleteTransactions, persistMetadata]);

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
    if (mode !== 'guest' && !accessToken) throw new Error('not authenticated');
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
  }, [accessToken, deleteCoordinator, mode, scope]);

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
    if (mode === 'guest') {
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
          validated,
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
    }
    if (!accessToken) throw new Error('not authenticated');
    const effectiveScope = !previous.repeat || previous.repeat === 'once'
      ? 'series'
      : previous.isRecurrenceException && recurrenceScope === 'following'
        ? 'occurrence'
        : recurrenceScope;
    const patch = calEventChangesToApiEditPatch(previous, validated);
    if (Object.keys(patch).length === 0) {
      return {
        reminderDelivery: reminderDeliveryForEvent(
          previous,
          previous.notificationId,
        ),
      };
    }
    const transaction = createEventEditTransaction({
      scopeKey: scope,
      target: previous,
      recurrenceScope: effectiveScope,
      patch,
    });
    const result = await editCoordinator.begin(transaction);
    return result.status === 'applied'
      ? result.value
      : { reminderDelivery: 'unconfirmed', syncStatus: 'pending' };
  }, [accessToken, editCoordinator, enqueueGuestMutation, mode, persistGuestEvents, persistMetadata, refreshEvents, scope]);

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
