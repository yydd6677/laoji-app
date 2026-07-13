import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalEvent } from '../types';
import { ApiEvent, deleteEvent as apiDelete, fetchEvents, saveEvent, updateEvent as apiUpdate } from '../services/api';
import { useAuth } from './AuthStore';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import {
  EventDisplayMetadata,
  apiEventClientId,
  apiEventToCalEvent,
  applyEventMetadata,
  calEventToApiEvent,
  eventSeriesDraft,
  sourceEventId,
} from '../services/eventMapper';
import {
  cancelEventNotificationsForScope,
  reconcileEventNotifications,
  scheduleEventNotificationForScope,
  switchEventNotificationScope,
} from '../services/notifications';
import { expandEventsForMonths } from '../utils/eventRecurrence';
import { getAppStorageItem, writeAppStorageJson } from '../services/appStorage';

export { checkConflict } from '../utils/eventUtils';

type EventMetadata = EventDisplayMetadata;
type EventMetadataMap = Record<string, EventMetadata>;

const EVENT_METADATA_KEY = '@laoji:eventMetadata:v1';
const GUEST_EVENTS_KEY = '@laoji:guestEvents:v1';
const EVENTS_CACHE_KEY = '@laoji:eventsCache:v1';
const EVENT_CATALOG_CACHE_KEY = '@laoji:eventCatalog:v1';

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
    if (bySource.has(sourceId) && event.isExpandedOccurrence) continue;
    bySource.set(sourceId, {
      ...eventSeriesDraft(event),
      id: sourceId,
      sourceEventId: sourceId,
      occurrenceId: undefined,
      isExpandedOccurrence: false,
    });
  }
  return [...bySource.values()];
}

function metadataForApiEvent(event: ApiEvent & { id: number }, map: EventMetadataMap): EventMetadata | undefined {
  const clientId = apiEventClientId(event);
  const saved = map[clientId] ?? map[String(event.id)];
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

interface EventsContextType {
  events: CalEvent[];
  searchableEvents: CalEvent[];
  loading: boolean;
  error: string | null;
  addEvent: (ev: Omit<CalEvent, 'id'>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  updateEvent: (id: string, changes: Partial<CalEvent>) => Promise<void>;
  refreshEvents: (year: number, month: number) => Promise<void>;
  undoDelete: () => Promise<void>;
  lastDeleted: CalEvent | null;
}

const EventsContext = createContext<EventsContextType | null>(null);

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [searchableEvents, setSearchableEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<CalEvent | null>(null);
  const eventMetadataRef = useRef<EventMetadataMap>({});
  const guestBaseEventsRef = useRef<CalEvent[]>([]);
  const loadedGuestMonthsRef = useRef<Set<string>>(new Set());
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
  const eventsCacheKey = `${EVENTS_CACHE_KEY}:${scope}`;
  const eventCatalogCacheKey = `${EVENT_CATALOG_CACHE_KEY}:${scope}`;

  useLayoutEffect(() => {
    const previousScope = activeScopeRef.current;
    const previousEvents = uniqueEvents([
      ...eventsRef.current,
      ...searchableEventsRef.current,
      ...guestBaseEventsRef.current,
    ]);

    generationRef.current += 1;
    activeScopeRef.current = scope;
    eventsRef.current = [];
    searchableEventsRef.current = [];
    eventMetadataRef.current = {};
    guestBaseEventsRef.current = [];
    loadedGuestMonthsRef.current = new Set();
    setEvents([]);
    setSearchableEvents([]);
    setLastDeleted(null);
    setError(null);
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
    return persistJson(eventsCacheKey, next);
  }, [eventsCacheKey, mode]);

  const persistEventCatalog = useCallback((next: CalEvent[]) => {
    if (mode !== 'authenticated') return Promise.resolve();
    return persistJson(eventCatalogCacheKey, next);
  }, [eventCatalogCacheKey, mode]);

  const saveMetadataPatch = useCallback(async (id: string, patch: EventMetadata) => {
    const nextMap = mergeMetadata(eventMetadataRef.current, id, patch);
    eventMetadataRef.current = nextMap;
    await persistMetadata(nextMap);
    return nextMap[id];
  }, [persistMetadata]);

  const persistGuestEvents = useCallback((next: CalEvent[]) => {
    return writeAppStorageJson(GUEST_EVENTS_KEY, next, { removeIfEmpty: true });
  }, []);

  const enqueueGuestMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = guestMutationQueueRef.current.then(operation, operation);
    guestMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const persistNotificationId = useCallback(async (event: CalEvent, notificationId: string | null) => {
    const patched = { ...event, notificationId };
    await saveMetadataPatch(event.id, { reminderMinutes: patched.reminderMinutes, notificationId });
    return patched;
  }, [saveMetadataPatch]);

  const refreshEventCatalog = useCallback(async () => {
    const requestGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      searchableEventsRef.current = [];
      setSearchableEvents([]);
      return;
    }
    if (mode === 'guest') {
      searchableEventsRef.current = guestBaseEventsRef.current;
      setSearchableEvents(guestBaseEventsRef.current);
      return;
    }
    if (!accessToken) return;
    const data = await fetchEvents(undefined, undefined, accessToken);
    if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
    const catalog = (data as (ApiEvent & { id: number })[]).map(event => {
      return apiEventToCalEvent(event, metadataForApiEvent(event, eventMetadataRef.current));
    });
    searchableEventsRef.current = catalog;
    setSearchableEvents(catalog);
    if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
    await persistEventCatalog(catalog);
  }, [accessToken, mode, persistEventCatalog, scope]);

  const refreshEvents = useCallback(async (year: number, month: number) => {
    const requestGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      eventsRef.current = [];
      setEvents([]);
      setError(null);
      return;
    }
    if (mode === 'guest') {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      loadedGuestMonthsRef.current.add(monthKey);
      const expanded = expandEventsForMonths(guestBaseEventsRef.current, loadedGuestMonthsRef.current)
        .map(event => applyEventMetadata(event, eventMetadataRef.current[event.id]));
      const previous = eventsRef.current;
      eventsRef.current = expanded;
      setEvents(expanded);
      setError(null);
      const window = monthWindow(year, month);
      let notificationIds: Record<string, string | null> = {};
      try {
        notificationIds = await reconcileEventNotifications(scope, expanded, {
          windowStart: window.start,
          windowEnd: window.end,
          previousEvents: previous,
        });
      } catch {
        // Notification persistence must not block the guest calendar.
      }
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;

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
        if (event.startDate <= window.end && (event.endDate ?? event.startDate) >= window.start && !incomingIds.has(event.id)) {
          delete nextMetadata[event.id];
        }
      }
      for (const event of withNotifications) {
        nextMetadata = mergeMetadata(nextMetadata, event.id, {
          reminderMinutes: event.reminderMinutes,
          notificationId: event.notificationId,
        });
      }
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
      return;
    }
    if (!accessToken) return;

    setLoading(true);
    try {
      const data = await fetchEvents(year, month, accessToken);
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      const local = (data as (ApiEvent & { id: number })[]).map(e => {
        return apiEventToCalEvent(e, metadataForApiEvent(e, eventMetadataRef.current));
      });
      const window = monthWindow(year, month);
      const previous = eventsRef.current;
      const incomingIds = new Set(local.map(event => event.id));
      const retained = previous.filter(event => {
        if (incomingIds.has(event.id)) return false;
        const eventEnd = event.endDate ?? event.startDate;
        return !(event.startDate <= window.end && eventEnd >= window.start);
      });
      const next = [...retained, ...local];
      eventsRef.current = next;
      setEvents(next);
      await persistEvents(next);
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(null);

      let notificationIds: Record<string, string | null> = {};
      try {
        notificationIds = await reconcileEventNotifications(scope, local, {
          windowStart: window.start,
          windowEnd: window.end,
          previousEvents: previous,
        });
      } catch {
        // The cloud calendar remains usable when local notification storage fails.
      }
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;

      const withNotifications = eventsRef.current.map(event => (
        incomingIds.has(event.id) && Object.prototype.hasOwnProperty.call(notificationIds, event.id)
          ? { ...event, notificationId: notificationIds[event.id] }
          : event
      ));
      eventsRef.current = withNotifications;
      setEvents(withNotifications);
      await persistEvents(withNotifications);
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;

      let nextMetadata = { ...eventMetadataRef.current };
      for (const event of previous) {
        if (event.startDate <= window.end && (event.endDate ?? event.startDate) >= window.start && !incomingIds.has(event.id)) {
          delete nextMetadata[event.id];
        }
      }
      for (const event of withNotifications.filter(event => incomingIds.has(event.id))) {
        nextMetadata = mergeMetadata(nextMetadata, event.id, {
          reminderMinutes: event.reminderMinutes,
          notificationId: event.notificationId,
        });
      }
      eventMetadataRef.current = nextMetadata;
      await persistMetadata(nextMetadata);
    } catch (err) {
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(err instanceof Error ? err.message : '日程服务暂时不可用');
    } finally {
      if (generationRef.current === requestGeneration && activeScopeRef.current === scope) {
        setLoading(false);
      }
    }
  }, [accessToken, mode, persistEvents, persistMetadata, scope]);

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
      setLoading(true);
      try {
        const metadata = await loadJson<EventMetadataMap>(metadataStorageKey, {});
        if (!isCurrent()) return;
        eventMetadataRef.current = metadata;
        if (mode === 'guest') {
          const guestEvents = await loadJson<CalEvent[]>(GUEST_EVENTS_KEY, []);
          if (!isCurrent()) return;
          guestBaseEventsRef.current = guestEvents;
          searchableEventsRef.current = guestEvents;
          setSearchableEvents(guestEvents);
          const now = new Date();
          loadedGuestMonthsRef.current = new Set([
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
          ]);
          await refreshEvents(now.getFullYear(), now.getMonth() + 1);
          return;
        }
        const [cachedEvents, cachedCatalog] = await Promise.all([
          loadJson<CalEvent[]>(eventsCacheKey, []),
          loadJson<CalEvent[]>(eventCatalogCacheKey, []),
        ]);
        if (!isCurrent()) return;
        const hydratedEvents = cachedEvents.map(event => applyEventMetadata(event, metadata[event.id]));
        const hydratedCatalog = (cachedCatalog.length > 0 ? cachedCatalog : sourceCatalog(hydratedEvents))
          .map(event => applyEventMetadata(event, metadata[event.id]));
        eventsRef.current = hydratedEvents;
        searchableEventsRef.current = hydratedCatalog;
        setEvents(hydratedEvents);
        setSearchableEvents(hydratedCatalog);
        const now = new Date();
        await refreshEvents(now.getFullYear(), now.getMonth() + 1);
        if (!isCurrent()) return;
        try {
          await refreshEventCatalog();
        } catch {
          // The cached global catalog remains searchable while offline.
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }
    loadForScope();
    return () => { alive = false; };
  }, [eventCatalogCacheKey, eventsCacheKey, metadataStorageKey, mode, refreshEventCatalog, refreshEvents, scope]);

  useEffect(() => {
    if (!lastDeleted) return;
    const t = setTimeout(() => setLastDeleted(null), 5000);
    return () => clearTimeout(t);
  }, [lastDeleted]);

  const addEvent = useCallback(async (ev: Omit<CalEvent, 'id'>) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const category = normalizeEventCategory(ev.category);
        const baseId = createGuestId();
        const baseEvent: CalEvent = {
          ...ev,
          category,
          id: baseId,
          sourceEventId: baseId,
          seriesStartDate: ev.startDate,
          seriesEndDate: ev.endDate,
          color: colorForEvent({ category }),
        };
        const nextGuestEvents = [...guestBaseEventsRef.current, baseEvent];
        await persistGuestEvents(nextGuestEvents);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        guestBaseEventsRef.current = nextGuestEvents;
        searchableEventsRef.current = nextGuestEvents;
        setSearchableEvents(nextGuestEvents);
        const date = new Date(`${ev.startDate}T00:00:00`);
        await refreshEvents(date.getFullYear(), date.getMonth() + 1);
      });
    }
    if (!accessToken) throw new Error('not authenticated');

    const saved = await saveEvent(calEventToApiEvent(ev), accessToken);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const savedId = String((saved as ApiEvent & { id: number }).id);
    const localMeta = await saveMetadataPatch(savedId, metadataFromEvent(ev));
    let localEv = apiEventToCalEvent(saved as ApiEvent & { id: number }, localMeta);
    const notificationId = await scheduleEventNotificationForScope(scope, localEv);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    if (notificationId) {
      localEv = await persistNotificationId(localEv, notificationId);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    }
    setEvents(prev => {
      const next = [...prev, localEv];
      eventsRef.current = next;
      void persistEvents(next);
      return next;
    });
    setSearchableEvents(prev => {
      const next = [...prev.filter(event => sourceEventId(event) !== savedId), localEv];
      searchableEventsRef.current = next;
      void persistEventCatalog(next);
      return next;
    });
  }, [accessToken, enqueueGuestMutation, mode, persistEventCatalog, persistEvents, persistGuestEvents, persistNotificationId, refreshEvents, saveMetadataPatch, scope]);

  const deleteEvent = useCallback(async (id: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const currentEvents = eventsRef.current;
    const target = currentEvents.find(e => e.id === id) ?? null;
    const targetSourceId = target ? sourceEventId(target) : id.split('@', 1)[0];
    const removedEvents = target
      ? currentEvents.filter(event => sourceEventId(event) === targetSourceId)
      : [];
    const previousCatalog = searchableEventsRef.current;
    const nextCatalog = previousCatalog.filter(event => sourceEventId(event) !== targetSourceId);
    const nextEvents = currentEvents.filter(event => sourceEventId(event) !== targetSourceId);

    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const guestCurrentEvents = eventsRef.current;
        const guestTarget = guestCurrentEvents.find(event => event.id === id) ?? null;
        const guestTargetSourceId = guestTarget ? sourceEventId(guestTarget) : id.split('@', 1)[0];
        const guestRemovedEvents = guestTarget
          ? guestCurrentEvents.filter(event => sourceEventId(event) === guestTargetSourceId)
          : [];
        const guestNextEvents = guestCurrentEvents.filter(event => sourceEventId(event) !== guestTargetSourceId);
        const nextGuestEvents = guestBaseEventsRef.current.filter(event => sourceEventId(event) !== guestTargetSourceId);
        await persistGuestEvents(nextGuestEvents);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;

        guestBaseEventsRef.current = nextGuestEvents;
        searchableEventsRef.current = nextGuestEvents;
        eventsRef.current = guestNextEvents;
        setSearchableEvents(nextGuestEvents);
        setEvents(guestNextEvents);
        if (guestTarget) setLastDeleted(guestTarget);

        const nextMap = { ...eventMetadataRef.current };
        for (const event of guestRemovedEvents) delete nextMap[event.id];
        delete nextMap[guestTargetSourceId];
        eventMetadataRef.current = nextMap;
        await persistMetadata(nextMap);
        try {
          await cancelEventNotificationsForScope(scope, guestRemovedEvents);
        } catch {
          // Startup reconciliation will retry cleanup if the notification service is unavailable.
        }
      });
    }

    searchableEventsRef.current = nextCatalog;
    eventsRef.current = nextEvents;
    setSearchableEvents(nextCatalog);
    setEvents(nextEvents);
    void persistEventCatalog(nextCatalog);
    void persistEvents(nextEvents);
    if (target) setLastDeleted(target);
    const previousMap = eventMetadataRef.current;
    const nextMap = { ...eventMetadataRef.current };
    for (const event of removedEvents) delete nextMap[event.id];
    delete nextMap[targetSourceId];
    eventMetadataRef.current = nextMap;
    void persistMetadata(nextMap);

    try {
      await cancelEventNotificationsForScope(scope, removedEvents);
    } catch {
      // A failed registry write must not block deletion from the source of truth.
    }

    if (!accessToken) throw new Error('not authenticated');

    try {
      await apiDelete(Number(targetSourceId), accessToken);
    } catch (err) {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) throw err;
      if (removedEvents.length > 0) {
        const restored = await Promise.all(removedEvents.map(async event => ({
          ...event,
          notificationId: await scheduleEventNotificationForScope(scope, event),
        })));
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) throw err;
        const restoredEvents = eventsRef.current.some(e => e.id === id)
          ? eventsRef.current
          : [...eventsRef.current, ...restored];
        eventsRef.current = restoredEvents;
        setEvents(restoredEvents);
        void persistEvents(restoredEvents);
        let restoredMap = { ...previousMap };
        for (const event of restored) {
          restoredMap = mergeMetadata(restoredMap, event.id, {
            reminderMinutes: event.reminderMinutes,
            notificationId: event.notificationId,
          });
        }
        eventMetadataRef.current = restoredMap;
        void persistMetadata(restoredMap);
      } else {
        eventMetadataRef.current = previousMap;
        void persistMetadata(previousMap);
      }
      setLastDeleted(null);
      searchableEventsRef.current = previousCatalog;
      setSearchableEvents(previousCatalog);
      void persistEventCatalog(previousCatalog);
      throw err;
    }
  }, [accessToken, enqueueGuestMutation, mode, persistEventCatalog, persistEvents, persistGuestEvents, persistMetadata, scope]);

  const updateEvent = useCallback(async (id: string, changes: Partial<CalEvent>) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const currentEvents = eventsRef.current;
    const previous = currentEvents.find(e => e.id === id) ?? null;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const guestCurrentEvents = eventsRef.current;
        const guestPrevious = guestCurrentEvents.find(event => event.id === id) ?? null;
        const targetSourceId = guestPrevious ? sourceEventId(guestPrevious) : id.split('@', 1)[0];
        const base = guestBaseEventsRef.current.find(event => sourceEventId(event) === targetSourceId);
        if (!base) throw new Error('event not found');
        const relatedEvents = guestCurrentEvents.filter(event => sourceEventId(event) === targetSourceId);
        const updatedBase: CalEvent = {
          ...base,
          ...changes,
          id: base.id,
          sourceEventId: targetSourceId,
          occurrenceId: undefined,
          isExpandedOccurrence: false,
          seriesStartDate: changes.startDate ?? base.seriesStartDate ?? base.startDate,
          seriesEndDate: 'endDate' in changes ? changes.endDate : base.seriesEndDate ?? base.endDate,
          notificationId: null,
        };
        const nextGuestEvents = guestBaseEventsRef.current.map(event => (
          sourceEventId(event) === targetSourceId ? updatedBase : event
        ));
        await persistGuestEvents(nextGuestEvents);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        guestBaseEventsRef.current = nextGuestEvents;
        searchableEventsRef.current = nextGuestEvents;
        setSearchableEvents(nextGuestEvents);
        try {
          await cancelEventNotificationsForScope(scope, relatedEvents);
        } catch {
          // Startup reconciliation will retry cleanup if the notification service is unavailable.
        }
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const nextMetadata = { ...eventMetadataRef.current };
        for (const event of relatedEvents) delete nextMetadata[event.id];
        eventMetadataRef.current = nextMetadata;
        await persistMetadata(nextMetadata);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const date = new Date(`${updatedBase.startDate}T00:00:00`);
        await refreshEvents(date.getFullYear(), date.getMonth() + 1);
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    const targetSourceId = previous ? sourceEventId(previous) : id.split('@', 1)[0];
    const relatedEvents = currentEvents.filter(event => sourceEventId(event) === targetSourceId);

    const payload: Partial<ApiEvent> = {};
    if ('title' in changes) payload.title = changes.title;
    if ('repeat' in changes) payload.event_type = (changes.repeat as string) || 'once';
    if ('startDate' in changes) payload.start_date = changes.startDate;
    if ('endDate' in changes) payload.end_date = changes.endDate ?? null;
    if ('color' in changes) payload.color = changes.color ?? null;
    if ('spanning' in changes) payload.spanning = changes.spanning ?? null;
    if ('startTime' in changes) payload.start_time = changes.startTime ?? null;
    if ('endTime' in changes) payload.end_time = changes.endTime ?? null;
    if ('isAllDay' in changes) payload.is_all_day = changes.isAllDay;
    if ('description' in changes) payload.description = changes.description ?? null;
    if ('rawText' in changes) payload.raw_text = changes.rawText ?? null;
    if ('location' in changes) payload.location = changes.location ?? null;
    if ('category' in changes) payload.category = changes.category ?? null;
    if ('detail' in changes) payload.detail = changes.detail ?? null;
    if ('status' in changes) payload.status = changes.status ?? null;
    if ('reminderMinutes' in changes) payload.reminder_minutes = changes.reminderMinutes ?? null;

    const updated = await apiUpdate(Number(targetSourceId), payload, accessToken) as ApiEvent & { id: number };
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    try {
      await cancelEventNotificationsForScope(scope, relatedEvents);
    } catch {
      // The following refresh will retry notification reconciliation.
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const nextMetadata = { ...eventMetadataRef.current };
    for (const event of relatedEvents) delete nextMetadata[event.id];
    eventMetadataRef.current = nextMetadata;
    await persistMetadata(nextMetadata);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const updatedCatalogEvent = apiEventToCalEvent(updated, metadataForApiEvent(updated, nextMetadata));
    setSearchableEvents(prev => {
      const next = [
        ...prev.filter(event => sourceEventId(event) !== targetSourceId),
        updatedCatalogEvent,
      ];
      searchableEventsRef.current = next;
      void persistEventCatalog(next);
      return next;
    });

    const months = new Set<string>();
    for (const event of relatedEvents) months.add(event.startDate.slice(0, 7));
    months.add(updated.start_date.slice(0, 7));
    if (updated.end_date) months.add(updated.end_date.slice(0, 7));
    for (const key of months) {
      const [year, month] = key.split('-').map(Number);
      if (Number.isFinite(year) && Number.isFinite(month)) await refreshEvents(year, month);
    }
  }, [accessToken, enqueueGuestMutation, mode, persistEventCatalog, persistGuestEvents, persistMetadata, refreshEvents, scope]);

  const undoDelete = useCallback(async () => {
    if (!lastDeleted) return;
    const deleted = lastDeleted;
    setLastDeleted(null);
    await addEvent(eventSeriesDraft(deleted));
  }, [addEvent, lastDeleted]);

  return (
    <EventsContext.Provider value={{ events, searchableEvents, loading, error, addEvent, deleteEvent, updateEvent, refreshEvents, undoDelete, lastDeleted }}>
      {children}
    </EventsContext.Provider>
  );
}

export function useEvents() {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside EventsProvider');
  return ctx;
}
