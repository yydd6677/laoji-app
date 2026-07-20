import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CalEvent } from '../src/types';
import {
  EVENT_CACHE_SCHEMA_VERSION,
  MAX_CACHED_EVENT_MONTHS,
  clearEventCacheRecoveryNotice,
  eventCacheStorageKeys,
  filterEventsToMonthAccess,
  loadEventCatalogCache,
  loadEventMonthCache,
  saveEventCatalogCache,
  saveEventMonthCache,
  touchEventMonth,
} from '../src/services/eventCache';
import { resetAppStorageQueueForTests } from '../src/services/appStorage';

function event(id: string, startDate: string, endDate?: string): CalEvent {
  return { id, title: `日程 ${id}`, startDate, endDate, color: '#1456F0' };
}

describe('versioned event caches', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
    resetAppStorageQueueForTests();
    storage.clear();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key, value) => { storage.set(key, value); });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async key => { storage.delete(key); });
  });

  it('migrates a legacy flat month cache and bounds it around the current month', async () => {
    const scope = 'user:7';
    const legacy = Array.from({ length: 12 }, (_, index) => (
      event(String(index + 1), `2026-${String(index + 1).padStart(2, '0')}-01`)
    ));
    storage.set(eventCacheStorageKeys.legacyMonth(scope), JSON.stringify(legacy));

    const loaded = await loadEventMonthCache(scope, new Date(2026, 6, 15));

    expect(loaded.migratedFromLegacy).toBe(true);
    expect(Object.keys(loaded.monthAccess)).toHaveLength(MAX_CACHED_EVENT_MONTHS);
    expect(loaded.monthAccess['2026-07']).toBeDefined();
    expect(loaded.events).toHaveLength(MAX_CACHED_EVENT_MONTHS);

    await saveEventMonthCache(scope, loaded.events, loaded.monthAccess, 1234);
    const envelope = JSON.parse(storage.get(eventCacheStorageKeys.month(scope))!);
    expect(envelope).toEqual(expect.objectContaining({
      schemaVersion: EVENT_CACHE_SCHEMA_VERSION,
      kind: 'event-month-cache',
      savedAt: 1234,
    }));
    expect(storage.has(eventCacheStorageKeys.legacyMonth(scope))).toBe(false);
  });

  it('isolates a corrupt versioned cache and falls back to a valid legacy cache', async () => {
    const scope = 'user:corrupt';
    storage.set(eventCacheStorageKeys.month(scope), '{broken');
    storage.set(eventCacheStorageKeys.legacyMonth(scope), JSON.stringify([
      event('legacy', '2026-07-10'),
    ]));

    const loaded = await loadEventMonthCache(scope, new Date(2026, 6, 15));

    expect(loaded.events).toEqual([expect.objectContaining({ id: 'legacy' })]);
    expect(loaded.recoveryNotice?.kinds).toEqual(['months']);
    expect(storage.has(eventCacheStorageKeys.month(scope))).toBe(false);
    expect(JSON.parse(storage.get(eventCacheStorageKeys.recovery(scope))!)).toEqual({
      detectedAt: new Date(2026, 6, 15).getTime(),
      kinds: ['months'],
    });
  });

  it.each([
    ['invalid time', { startTime: '25:00', endTime: '26:00' }],
    ['one-sided time', { startTime: '10:00' }],
    ['invalid repeat', { repeat: 'fortnightly' }],
    ['invalid reminder', { reminderMinutes: -1 }],
    ['invalid weekday', { repeat: 'weekly', recurrenceWeekdays: [0, 7] }],
    ['duplicate weekday', { repeat: 'weekly', recurrenceWeekdays: [1, 1] }],
    ['invalid recurrence date', { recurrenceUntilDate: '2026-99-99' }],
    ['wrong boolean type', { isAllDay: 'yes' }],
  ])('isolates an envelope containing a field-level corrupt event: %s', async (_label, patch) => {
    const scope = `user:field-corrupt:${String(_label)}`;
    storage.set(eventCacheStorageKeys.month(scope), JSON.stringify({
      schemaVersion: EVENT_CACHE_SCHEMA_VERSION,
      kind: 'event-month-cache',
      savedAt: 1,
      months: [{ key: '2026-07', lastAccessedAt: 1 }],
      events: [{ ...event('bad', '2026-07-15'), ...patch }],
    }));

    const loaded = await loadEventMonthCache(scope, new Date(2026, 6, 15));

    expect(loaded.events).toEqual([]);
    expect(loaded.recoveryNotice?.kinds).toEqual(['months']);
    expect(storage.has(eventCacheStorageKeys.month(scope))).toBe(false);
  });

  it('keeps cross-month events while either retained month still references them', () => {
    const spanning = event('spanning', '2026-07-31', '2026-08-01');
    expect(filterEventsToMonthAccess([spanning], { '2026-08': 2 })).toEqual([spanning]);
    expect(filterEventsToMonthAccess([spanning], { '2026-09': 3 })).toEqual([]);
  });

  it('does not retain a timed event in a month reached only at its midnight boundary', () => {
    const midnight = {
      ...event('midnight', '2026-07-31', '2026-08-01'),
      startTime: '23:00',
      endTime: '00:00',
      isAllDay: false,
    };
    expect(filterEventsToMonthAccess([midnight], { '2026-08': 1 })).toEqual([]);
  });

  it('evicts the least recently used month deterministically', () => {
    let access: Record<string, number> = {};
    for (let month = 1; month <= MAX_CACHED_EVENT_MONTHS; month += 1) {
      access = touchEventMonth(access, `2026-${String(month).padStart(2, '0')}`, month);
    }
    access = touchEventMonth(access, '2026-10', 100);

    expect(Object.keys(access)).toHaveLength(MAX_CACHED_EVENT_MONTHS);
    expect(access['2026-01']).toBeUndefined();
    expect(access['2026-10']).toBe(100);
  });

  it('versions the catalog separately and preserves a recovery notice until dismissed', async () => {
    const scope = 'guest-cache';
    storage.set(eventCacheStorageKeys.catalog(scope), JSON.stringify({
      schemaVersion: 99,
      kind: 'event-catalog-cache',
      events: [],
    }));

    const corrupt = await loadEventCatalogCache(scope, 99);
    expect(corrupt.recoveryNotice).toEqual({ detectedAt: 99, kinds: ['catalog'] });

    await saveEventCatalogCache(scope, [event('catalog', '2025-01-01')], 100);
    const restored = await loadEventCatalogCache(scope, 101);
    expect(restored.events).toEqual([expect.objectContaining({ id: 'catalog' })]);
    expect(restored.recoveryNotice).toEqual({ detectedAt: 99, kinds: ['catalog'] });

    await clearEventCacheRecoveryNotice(scope);
    expect(storage.has(eventCacheStorageKeys.recovery(scope))).toBe(false);
  });
});
