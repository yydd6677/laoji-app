import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CalEvent } from '../types';
import { ApiEvent, deleteEvent as apiDelete, fetchEvents, saveEvent, updateEvent as apiUpdate } from '../services/api';
import { useAuth } from './AuthStore';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import {
  cancelEventNotification,
  rescheduleEventNotification,
  scheduleEventNotification,
} from '../services/notifications';

export { checkConflict } from '../utils/eventUtils';

type EventMetadata = Partial<Pick<CalEvent, 'color' | 'location' | 'category' | 'detail' | 'reminderMinutes' | 'notificationId'>>;
type EventMetadataMap = Record<string, EventMetadata>;

const EVENT_METADATA_KEY = '@laoji:eventMetadata:v1';
const GUEST_EVENTS_KEY = '@laoji:guestEvents:v1';

function cleanMetadata(meta: EventMetadata): EventMetadata {
  const cleaned: EventMetadata = {};
  for (const [key, value] of Object.entries(meta) as [keyof EventMetadata, EventMetadata[keyof EventMetadata]][]) {
    if (typeof value === 'string') {
      const next = value.trim();
      if (next) cleaned[key] = next as any;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) cleaned[key] = value as any;
      continue;
    }
  }
  return cleaned;
}

function applyEventMetadata(ev: CalEvent, meta?: EventMetadata): CalEvent {
  if (!meta) return { ...ev, category: normalizeEventCategory(ev.category), color: colorForEvent({ category: ev.category }) };
  const category = normalizeEventCategory(meta.category ?? ev.category);
  return { ...ev, ...meta, category, color: colorForEvent({ category }) };
}

function metadataFromEvent(ev: Omit<CalEvent, 'id'>): EventMetadata {
  return cleanMetadata({
    location: ev.location,
    category: ev.category,
    detail: ev.detail,
    reminderMinutes: ev.reminderMinutes,
  });
}

function metadataFromChanges(changes: Partial<CalEvent>): EventMetadata {
  const patch: EventMetadata = {};
  if ('location' in changes) patch.location = changes.location;
  if ('category' in changes) patch.category = changes.category;
  if ('detail' in changes) patch.detail = changes.detail;
  if ('reminderMinutes' in changes) patch.reminderMinutes = changes.reminderMinutes;
  if ('notificationId' in changes) patch.notificationId = changes.notificationId;
  return patch;
}

function mergeMetadata(map: EventMetadataMap, id: string, patch: EventMetadata): EventMetadataMap {
  const nextMeta = cleanMetadata({ ...(map[id] ?? {}), ...patch });
  const next = { ...map };
  if (Object.keys(nextMeta).length > 0) next[id] = nextMeta;
  else delete next[id];
  return next;
}

function serverToLocal(e: ApiEvent & { id: number }, meta?: EventMetadata): CalEvent {
  const endDate = e.end_date ?? undefined;
  const category = normalizeEventCategory(e.category ?? meta?.category);
  const local = {
    id: String(e.id),
    title: e.title,
    startDate: e.start_date,
    endDate,
    startTime: e.start_time ?? undefined,
    endTime: e.end_time ?? undefined,
    isAllDay: e.is_all_day ?? false,
    repeat: (e.event_type !== 'once' ? e.event_type : undefined) as any,
    description: e.description ?? undefined,
    rawText: e.raw_text ?? undefined,
    location: e.location ?? meta?.location,
    category,
    detail: e.detail ?? meta?.detail,
    status: e.status ?? undefined,
    spanning: e.spanning ?? Boolean(endDate && endDate !== e.start_date),
    reminderMinutes: e.reminder_minutes ?? meta?.reminderMinutes ?? null,
    notificationId: meta?.notificationId ?? null,
    color: colorForEvent({ category }),
  };
  return applyEventMetadata(local, meta);
}

function localToServer(ev: Omit<CalEvent, 'id'>): ApiEvent {
  return {
    title: ev.title,
    event_type: (ev.repeat as string) || 'once',
    start_date: ev.startDate,
    end_date: ev.endDate ?? null,
    color: colorForEvent({ category: ev.category }),
    spanning: ev.spanning ?? Boolean(ev.endDate && ev.endDate !== ev.startDate),
    start_time: ev.startTime ?? null,
    end_time: ev.endTime ?? null,
    is_all_day: ev.isAllDay ?? false,
    description: ev.description ?? null,
    raw_text: ev.rawText ?? null,
    location: ev.location ?? null,
    category: normalizeEventCategory(ev.category),
    detail: ev.detail ?? null,
    status: ev.status ?? null,
    reminder_minutes: ev.reminderMinutes ?? null,
  };
}

function eventWithoutId(ev: CalEvent): Omit<CalEvent, 'id'> {
  const { id: _id, ...rest } = ev;
  return rest;
}

function createGuestId(): string {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function persistJson(key: string, value: unknown): Promise<void> {
  try {
    if (Array.isArray(value) && value.length === 0) {
      await AsyncStorage.removeItem(key);
      return;
    }
    if (!Array.isArray(value) && value && typeof value === 'object' && Object.keys(value).length === 0) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence must not block the primary UI action.
  }
}

interface EventsContextType {
  events: CalEvent[];
  loading: boolean;
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
  const [loading, setLoading] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<CalEvent | null>(null);
  const eventMetadataRef = React.useRef<EventMetadataMap>({});

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const metadataStorageKey = `${EVENT_METADATA_KEY}:${scope}`;

  const persistMetadata = useCallback((map: EventMetadataMap) => {
    return persistJson(metadataStorageKey, map);
  }, [metadataStorageKey]);

  const saveMetadataPatch = useCallback(async (id: string, patch: EventMetadata) => {
    const nextMap = mergeMetadata(eventMetadataRef.current, id, patch);
    eventMetadataRef.current = nextMap;
    await persistMetadata(nextMap);
    return nextMap[id];
  }, [persistMetadata]);

  const persistGuestEvents = useCallback((next: CalEvent[]) => {
    return persistJson(GUEST_EVENTS_KEY, next);
  }, []);

  const persistNotificationId = useCallback(async (event: CalEvent, notificationId: string | null) => {
    const patched = { ...event, notificationId };
    await saveMetadataPatch(event.id, { reminderMinutes: patched.reminderMinutes, notificationId });
    return patched;
  }, [saveMetadataPatch]);

  const refreshEvents = useCallback(async (year: number, month: number) => {
    if (mode === 'signed_out') {
      setEvents([]);
      return;
    }
    if (mode === 'guest') {
      return;
    }
    if (!accessToken) return;

    setLoading(true);
    try {
      const data = await fetchEvents(year, month, accessToken);
      const local = (data as any[]).map((e: any) => serverToLocal(e, eventMetadataRef.current[String(e.id)]));
      setEvents(prev => {
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const otherMonths = prev.filter(e => !e.startDate.startsWith(monthStr));
        return [...otherMonths, ...local];
      });
      void Promise.all(local.map(async ev => {
        if (ev.notificationId || ev.reminderMinutes == null) return;
        const notificationId = await scheduleEventNotification(ev);
        if (notificationId) await persistNotificationId(ev, notificationId);
      }));
    } catch {
      // Keep existing events on transient network or auth errors.
    } finally {
      setLoading(false);
    }
  }, [accessToken, mode]);

  useEffect(() => {
    let alive = true;
    async function loadForScope() {
      setLastDeleted(null);
      eventMetadataRef.current = {};
      if (mode === 'signed_out') {
        setEvents([]);
        return;
      }
      setLoading(true);
      try {
        const metadata = await loadJson<EventMetadataMap>(metadataStorageKey, {});
        if (!alive) return;
        eventMetadataRef.current = metadata;
        if (mode === 'guest') {
          const guestEvents = await loadJson<CalEvent[]>(GUEST_EVENTS_KEY, []);
          if (!alive) return;
          setEvents(guestEvents.map(ev => applyEventMetadata(ev, metadata[ev.id])));
          return;
        }
        const now = new Date();
        await refreshEvents(now.getFullYear(), now.getMonth() + 1);
      } finally {
        if (alive) setLoading(false);
      }
    }
    loadForScope();
    return () => { alive = false; };
  }, [metadataStorageKey, mode, refreshEvents]);

  useEffect(() => {
    if (!lastDeleted) return;
    const t = setTimeout(() => setLastDeleted(null), 5000);
    return () => clearTimeout(t);
  }, [lastDeleted]);

  const addEvent = useCallback(async (ev: Omit<CalEvent, 'id'>) => {
    if (mode === 'guest') {
      const category = normalizeEventCategory(ev.category);
      let localEv: CalEvent = {
        ...ev,
        category,
        id: createGuestId(),
        color: colorForEvent({ category }),
      };
      localEv = { ...localEv, notificationId: await scheduleEventNotification(localEv) };
      setEvents(prev => {
        const next = [...prev, localEv];
        void persistGuestEvents(next);
        return next;
      });
      return;
    }
    if (!accessToken) throw new Error('not authenticated');

    const saved = await saveEvent(localToServer(ev), accessToken);
    const savedId = String((saved as ApiEvent & { id: number }).id);
    const localMeta = await saveMetadataPatch(savedId, metadataFromEvent(ev));
    let localEv = serverToLocal(saved as any, localMeta);
    const notificationId = await scheduleEventNotification(localEv);
    if (notificationId) {
      localEv = await persistNotificationId(localEv, notificationId);
    }
    setEvents(prev => [...prev, localEv]);
  }, [accessToken, mode, persistGuestEvents, persistNotificationId, saveMetadataPatch]);

  const deleteEvent = useCallback(async (id: string) => {
    const target = events.find(e => e.id === id) ?? null;
    setEvents(prev => {
      const next = prev.filter(e => e.id !== id);
      if (mode === 'guest') void persistGuestEvents(next);
      return next;
    });
    if (target) setLastDeleted(target);
    void cancelEventNotification(target?.notificationId);
    const previousMap = eventMetadataRef.current;
    const nextMap = { ...eventMetadataRef.current };
    delete nextMap[id];
    eventMetadataRef.current = nextMap;
    void persistMetadata(nextMap);

    if (mode === 'guest') return;
    if (!accessToken) throw new Error('not authenticated');

    try {
      await apiDelete(Number(id), accessToken);
    } catch (err) {
      if (target) {
        const notificationId = await scheduleEventNotification(target);
        const restored = { ...target, notificationId };
        setEvents(prev => prev.some(e => e.id === id) ? prev : [...prev, restored]);
      }
      eventMetadataRef.current = previousMap;
      void persistMetadata(previousMap);
      setLastDeleted(null);
      throw err;
    }
  }, [accessToken, events, mode, persistGuestEvents, persistMetadata]);

  const updateEvent = useCallback(async (id: string, changes: Partial<CalEvent>) => {
    const previous = events.find(e => e.id === id) ?? null;
    if (mode === 'guest') {
      const nextEvent = previous ? { ...previous, ...changes } : null;
      const notificationId = nextEvent
        ? await rescheduleEventNotification(previous?.notificationId, { ...nextEvent, notificationId: null })
        : null;
      setEvents(prev => {
        const next = prev.map(e => e.id === id ? { ...e, ...changes, notificationId } : e);
        void persistGuestEvents(next);
        return next;
      });
      await saveMetadataPatch(id, { ...metadataFromChanges(changes), notificationId });
      return;
    }
    if (!accessToken) throw new Error('not authenticated');

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

    const updated = await apiUpdate(Number(id), payload, accessToken);
    const localMeta = await saveMetadataPatch(id, metadataFromChanges(changes));
    let localEv = serverToLocal(updated as any, localMeta);
    const notificationId = await rescheduleEventNotification(previous?.notificationId, { ...localEv, notificationId: null });
    localEv = await persistNotificationId(localEv, notificationId);
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...localEv } : e));
  }, [accessToken, events, mode, persistGuestEvents, persistNotificationId, saveMetadataPatch]);

  const undoDelete = useCallback(async () => {
    if (!lastDeleted) return;
    const deleted = lastDeleted;
    setLastDeleted(null);
    if (mode === 'guest') {
      const notificationId = await scheduleEventNotification(deleted);
      const restored = { ...deleted, notificationId };
      setEvents(prev => {
        const next = prev.some(e => e.id === deleted.id) ? prev : [...prev, restored];
        void persistGuestEvents(next);
        return next;
      });
      return;
    }
    await addEvent(eventWithoutId(deleted));
  }, [addEvent, lastDeleted, mode, persistGuestEvents]);

  return (
    <EventsContext.Provider value={{ events, loading, addEvent, deleteEvent, updateEvent, refreshEvents, undoDelete, lastDeleted }}>
      {children}
    </EventsContext.Provider>
  );
}

export function useEvents() {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside EventsProvider');
  return ctx;
}
