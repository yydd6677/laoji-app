import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import { fetchEvents } from '../src/services/api';
import { reconcileEventNotifications } from '../src/services/notifications';
import { EventsProvider, useEvents } from '../src/store/EventsStore';
import { useAuth } from '../src/store/AuthStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/services/api', () => ({
  fetchEvents: jest.fn(),
  saveEvent: jest.fn(),
  deleteEvent: jest.fn(),
  updateEvent: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  cancelEventNotificationsForScope: jest.fn().mockResolvedValue(undefined),
  reconcileEventNotifications: jest.fn().mockResolvedValue({}),
  scheduleEventNotificationForScope: jest.fn().mockResolvedValue(null),
  switchEventNotificationScope: jest.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('EventsProvider authenticated cache', () => {
  let current: ReturnType<typeof useEvents> | null = null;

  function Probe() {
    current = useEvents();
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    current = null;
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 7 } },
      accessToken: 'token-7',
    });
  });

  it('keeps a user-scoped cached calendar visible when startup sync is offline', async () => {
    const cached = [{
      id: 'cached-1',
      title: '离线日程',
      startDate: '2026-07-10',
      color: '#5B8CFF',
      category: '工作',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key.includes('eventsCache') ? JSON.stringify(cached) : null
    ));
    (fetchEvents as jest.Mock).mockRejectedValue(new Error('Network request failed'));

    await act(async () => {
      render(<EventsProvider><Probe /></EventsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.loading).toBe(false));
    expect(current?.events.map(event => event.title)).toContain('离线日程');
    expect(current?.error).toBe('Network request failed');
  });

  it('replaces the synced month and persists the fresh user cache', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([{
      id: 4,
      title: '云端日程',
      event_type: 'once',
      start_date: '2026-07-10',
      end_date: null,
      category: '工作',
      reminder_minutes: null,
    }]);

    await act(async () => {
      render(<EventsProvider><Probe /></EventsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(current?.events.some(event => event.title === '云端日程')).toBe(true));

    expect(current?.error).toBeNull();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@laoji:eventsCache:v1:user:7',
      expect.stringContaining('云端日程'),
    );

    await act(async () => {
      await current?.refreshEvents(2026, 7);
    });
    expect(fetchEvents).toHaveBeenLastCalledWith(2026, 7, 'token-7');
  });

  it('keeps a separate all-time catalog for search', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockImplementation(async (year?: number, month?: number) => (
      year != null && month != null
        ? [{ id: 4, title: '本月日程', event_type: 'once', start_date: '2026-07-10' }]
        : [{ id: 2, title: '历史证书续期', event_type: 'once', start_date: '2025-03-02' }]
    ));

    await act(async () => {
      render(<EventsProvider><Probe /></EventsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(current?.searchableEvents.map(event => event.title)).toContain('历史证书续期'));
    expect(current?.events.map(event => event.title)).toContain('本月日程');
    expect(fetchEvents).toHaveBeenCalledWith(undefined, undefined, 'token-7');
  });

  it('uses the cloud reminder value during notification reconciliation', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key.includes('eventMetadata')
        ? JSON.stringify({ '4': { reminderMinutes: 15, notificationId: 'old-notification' } })
        : null
    ));
    (fetchEvents as jest.Mock).mockResolvedValue([{
      id: 4,
      title: '云端改过提醒的日程',
      event_type: 'once',
      start_date: '2026-07-20',
      start_time: '10:00',
      reminder_minutes: 60,
    }]);

    await act(async () => {
      render(<EventsProvider><Probe /></EventsProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(reconcileEventNotifications).toHaveBeenCalledWith(
      'user:7',
      [expect.objectContaining({ id: '4', reminderMinutes: 60 })],
      expect.objectContaining({ previousEvents: expect.any(Array) }),
    ));
    expect(current?.events[0]).toEqual(expect.objectContaining({ reminderMinutes: 60 }));
  });

  it('does not expose an unsaved guest event when local persistence fails', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@laoji:guestEvents:v1') throw new Error('storage full');
    });

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));

    await act(async () => {
      await expect(current?.addEvent({
        title: '不能持久化的日程',
        startDate: '2026-07-12',
        color: '#7B5CB8',
        category: '生活',
      })).rejects.toThrow('storage full');
    });

    expect(current?.events).toEqual([]);
    expect(current?.searchableEvents).toEqual([]);
  });

  it('serializes concurrent guest event creation without losing either event', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const firstWrite = deferred<void>();
    let guestWriteCount = 0;
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string) => {
      if (key !== '@laoji:guestEvents:v1') return Promise.resolve();
      guestWriteCount += 1;
      return guestWriteCount === 1 ? firstWrite.promise : Promise.resolve();
    });

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));

    let firstCreate!: Promise<void>;
    let secondCreate!: Promise<void>;
    await act(async () => {
      firstCreate = current!.addEvent({ title: '并发日程 A', startDate: '2026-07-12', color: '#7B5CB8' });
      secondCreate = current!.addEvent({ title: '并发日程 B', startDate: '2026-07-12', color: '#7B5CB8' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(guestWriteCount).toBe(1);

    await act(async () => {
      firstWrite.resolve();
      await Promise.all([firstCreate, secondCreate]);
    });

    expect(current?.searchableEvents.map(event => event.title)).toEqual(['并发日程 A', '并发日程 B']);
    const guestWrites = (AsyncStorage.setItem as jest.Mock).mock.calls
      .filter(([key]) => key === '@laoji:guestEvents:v1');
    expect(JSON.parse(guestWrites.at(-1)![1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '并发日程 A' }),
      expect.objectContaining({ title: '并发日程 B' }),
    ]));
  });

  it('clears the old scope immediately and discards a delayed refresh after switching accounts', async () => {
    let auth = {
      mode: 'authenticated',
      session: { user: { id: 'A' } },
      accessToken: 'token-A',
    };
    (useAuth as jest.Mock).mockImplementation(() => auth);
    const cachedAEvent = [{
      id: 'cached-A',
      title: 'A 的缓存日程',
      startDate: '2026-07-11',
      color: '#5B8CFF',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key.includes('user:A') && (key.includes('eventsCache') || key.includes('eventCatalog'))
        ? JSON.stringify(cachedAEvent)
        : null
    ));
    const accountA = deferred<unknown[]>();
    const accountB = deferred<unknown[]>();
    (fetchEvents as jest.Mock).mockImplementation((_year?: number, _month?: number, token?: string) => {
      if (token === 'token-A') return accountA.promise;
      if (token === 'token-B') return accountB.promise;
      return Promise.resolve([]);
    });

    const view = await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      'token-A',
    ));
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('A 的缓存日程'));

    auth = {
      mode: 'authenticated',
      session: { user: { id: 'B' } },
      accessToken: 'token-B',
    };
    await act(async () => {
      await view.rerender(<EventsProvider><Probe /></EventsProvider>);
    });
    expect(current?.events).toEqual([]);
    expect(current?.searchableEvents).toEqual([]);
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      'token-B',
    ));

    await act(async () => {
      accountB.resolve([{
        id: 22,
        title: 'B 的日程',
        event_type: 'once',
        start_date: '2026-07-11',
        reminder_minutes: null,
      }]);
      await accountB.promise;
    });
    await waitFor(() => expect(current?.events.map(event => event.title)).toEqual(['B 的日程']));

    await act(async () => {
      accountA.resolve([{
        id: 11,
        title: 'A 的迟到日程',
        event_type: 'once',
        start_date: '2026-07-11',
        reminder_minutes: null,
      }]);
      await accountA.promise;
      await Promise.resolve();
    });

    expect(current?.events.map(event => event.title)).toEqual(['B 的日程']);
    expect(current?.searchableEvents.map(event => event.title)).not.toContain('A 的迟到日程');
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      '@laoji:eventsCache:v1:user:B',
      expect.stringContaining('A 的迟到日程'),
    );
  });
});
