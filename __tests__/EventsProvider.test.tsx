import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  deleteEvent as apiDeleteEvent,
  fetchEvents,
  saveEvent,
  updateEvent as apiUpdateEvent,
} from '../src/services/api';
import {
  cancelEventNotificationsForScope,
  reconcileEventNotifications,
  scheduleEventNotificationForScope,
} from '../src/services/notifications';
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
  reminderFireDate: jest.fn((event: { startTime?: string; reminderMinutes?: number | null }) => (
    event.startTime && event.reminderMinutes != null ? new Date('2099-01-01T00:00:00Z') : null
  )),
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

  it('keeps a cloud-saved event and reports when its local reminder is unavailable', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([]);
    (saveEvent as jest.Mock).mockResolvedValue({
      id: 44,
      title: '不会重复创建的日程',
      event_type: 'once',
      start_date: '2099-01-10',
      start_time: '10:00',
      reminder_minutes: 15,
    });
    (scheduleEventNotificationForScope as jest.Mock).mockResolvedValue(null);

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));
    (fetchEvents as jest.Mock).mockClear();

    let result: Awaited<ReturnType<NonNullable<typeof current>['addEvent']>> | undefined;
    await act(async () => {
      result = await current!.addEvent({
        title: '不会重复创建的日程',
        startDate: '2099-01-10',
        startTime: '10:00',
        reminderMinutes: 15,
        color: '#5B8CFF',
      });
    });

    expect(result).toEqual({ reminderDelivery: 'unavailable' });
    expect(saveEvent).toHaveBeenCalledTimes(1);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '44', title: '不会重复创建的日程' }),
    ]);
  });

  it('does not turn a notification registry failure into a failed cloud save', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([]);
    (saveEvent as jest.Mock).mockResolvedValue({
      id: 45,
      title: '提醒状态待确认',
      event_type: 'once',
      start_date: '2099-01-11',
      start_time: '11:00',
      reminder_minutes: 15,
    });
    (scheduleEventNotificationForScope as jest.Mock).mockRejectedValue(new Error('registry full'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));

    let result: Awaited<ReturnType<NonNullable<typeof current>['addEvent']>> | undefined;
    await act(async () => {
      result = await current!.addEvent({
        title: '提醒状态待确认',
        startDate: '2099-01-11',
        startTime: '11:00',
        reminderMinutes: 15,
        color: '#5B8CFF',
      });
    });

    expect(result).toEqual({ reminderDelivery: 'unconfirmed' });
    expect(current?.events.map(event => event.title)).toContain('提醒状态待确认');
  });

  it('does not remove a cached cloud event when no access token is available', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 7 } },
      accessToken: null,
    });
    const cached = [{
      id: 'tokenless-event',
      title: '不能本机误删的日程',
      startDate: '2026-07-13',
      color: '#5B8CFF',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:eventsCache:v1:user:7' ? JSON.stringify(cached) : null
    ));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events).toHaveLength(1));

    await act(async () => {
      await expect(current!.deleteEvent('tokenless-event')).rejects.toThrow('not authenticated');
    });

    expect(apiDeleteEvent).not.toHaveBeenCalled();
    expect(current?.events).toEqual([expect.objectContaining({ title: '不能本机误删的日程' })]);
  });

  it('restores a cloud event when deletion and reminder rebuilding both fail', async () => {
    const cached = [{
      id: '99',
      title: '云端仍然存在的日程',
      startDate: '2099-01-12',
      startTime: '12:00',
      reminderMinutes: 15,
      color: '#5B8CFF',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:eventsCache:v1:user:7' ? JSON.stringify(cached) : null
    ));
    (fetchEvents as jest.Mock).mockRejectedValue(new Error('offline'));
    (apiDeleteEvent as jest.Mock).mockRejectedValue(new Error('delete failed'));
    (scheduleEventNotificationForScope as jest.Mock).mockRejectedValue(new Error('registry full'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events).toHaveLength(1));

    await act(async () => {
      await expect(current!.deleteEvent('99')).rejects.toThrow('delete failed');
    });

    expect(apiDeleteEvent).toHaveBeenCalledWith(99, 'token-7');
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '99', title: '云端仍然存在的日程', notificationId: null }),
    ]);
    expect(current?.lastDeleted).toBeNull();
  });

  it('keeps the undo action available when restoring a deleted cloud event fails', async () => {
    const initial = {
      id: 101,
      title: '需要撤销的日程',
      event_type: 'once',
      start_date: '2099-01-12',
      start_time: '12:00',
      reminder_minutes: null,
    };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);
    (apiDeleteEvent as jest.Mock).mockResolvedValue(undefined);
    (saveEvent as jest.Mock).mockRejectedValueOnce(new Error('offline'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.some(event => event.id === '101')).toBe(true));

    await act(async () => { await current!.deleteEvent('101'); });
    expect(current?.lastDeleted).toEqual(expect.objectContaining({ title: '需要撤销的日程' }));

    await act(async () => {
      await expect(current!.undoDelete()).rejects.toThrow('offline');
    });
    expect(current?.lastDeleted).toEqual(expect.objectContaining({ title: '需要撤销的日程' }));

    (saveEvent as jest.Mock).mockResolvedValueOnce(initial);
    await act(async () => { await current!.undoDelete(); });
    expect(current?.lastDeleted).toBeNull();
    expect(saveEvent).toHaveBeenCalledTimes(2);
  });

  it('reports an unavailable reminder after a cloud event edit without repeating the month refresh', async () => {
    const initial = {
      id: 77,
      title: '编辑前日程',
      event_type: 'once',
      start_date: '2099-01-12',
      start_time: '12:00',
      reminder_minutes: 15,
    };
    const updated = { ...initial, title: '编辑后日程' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('编辑前日程'));

    (fetchEvents as jest.Mock).mockClear();
    (fetchEvents as jest.Mock).mockResolvedValue([updated]);
    (apiUpdateEvent as jest.Mock).mockResolvedValue(updated);
    (cancelEventNotificationsForScope as jest.Mock).mockResolvedValueOnce(undefined);
    (reconcileEventNotifications as jest.Mock).mockResolvedValueOnce({ '77': null });

    let result: Awaited<ReturnType<NonNullable<typeof current>['updateEvent']>> | undefined;
    await act(async () => {
      result = await current!.updateEvent('77', { title: '编辑后日程' });
    });

    expect(result).toEqual({ reminderDelivery: 'unavailable' });
    expect(apiUpdateEvent).toHaveBeenCalledWith(77, { title: '编辑后日程' }, 'token-7');
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchEvents).toHaveBeenCalledWith(2099, 1, 'token-7');
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '77', title: '编辑后日程', notificationId: null }),
    ]);
  });

  it('keeps reminder removal unconfirmed when an old notification cannot be cancelled', async () => {
    const initial = {
      id: 78,
      title: '关闭提醒',
      event_type: 'once',
      start_date: '2099-01-13',
      start_time: '13:00',
      reminder_minutes: 15,
    };
    const updated = { ...initial, reminder_minutes: null };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('关闭提醒'));

    (fetchEvents as jest.Mock).mockResolvedValue([updated]);
    (apiUpdateEvent as jest.Mock).mockResolvedValue(updated);
    (cancelEventNotificationsForScope as jest.Mock).mockRejectedValueOnce(new Error('registry unavailable'));
    (reconcileEventNotifications as jest.Mock).mockResolvedValueOnce({});

    let result: Awaited<ReturnType<NonNullable<typeof current>['updateEvent']>> | undefined;
    await act(async () => {
      result = await current!.updateEvent('78', { reminderMinutes: null });
    });

    expect(result).toEqual({ reminderDelivery: 'unconfirmed' });
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '78', reminderMinutes: null }),
    ]);
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

    let firstCreate!: ReturnType<NonNullable<typeof current>['addEvent']>;
    let secondCreate!: ReturnType<NonNullable<typeof current>['addEvent']>;
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
