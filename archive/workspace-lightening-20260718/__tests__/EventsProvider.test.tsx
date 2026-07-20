import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  commandEventEdit,
  commandEventState,
  fetchEventEditCommand,
  fetchEvents,
  saveEvent,
} from '../src/services/api';
import {
  cancelEventNotificationsForScope,
  cancelEventNotificationsForMutation,
  reconcileEventNotificationHorizon,
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
  commandEventEdit: jest.fn(),
  commandEventState: jest.fn(),
  fetchEventEditCommand: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  cancelEventNotificationsForScope: jest.fn().mockResolvedValue(undefined),
  cancelEventNotificationsForMutation: jest.fn().mockResolvedValue(undefined),
  reconcileEventNotificationHorizon: jest.fn().mockResolvedValue({}),
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
  let appStateListener: ((state: string) => void) | null = null;

  function Probe() {
    current = useEvents();
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    current = null;
    appStateListener = null;
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 7 } },
      accessToken: 'token-7',
    });
    (commandEventState as jest.Mock).mockImplementation(async (_id, command) => ({
      client_request_id: command.client_request_id,
      source_event_id: _id,
      desired_state: command.desired_state,
      observed_state: command.desired_state,
      scope: command.scope,
      occurrence_date: command.occurrence_date,
      revision: command.desired_state === 'absent' ? 2 : 3,
      changed: true,
    }));
    (fetchEventEditCommand as jest.Mock).mockRejectedValue(new Error('unexpected recovery'));
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
      '@laoji:eventsCache:v2:user:7',
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
      end_time: '11:00',
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
        endTime: '11:00',
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
      end_time: '12:00',
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
        endTime: '12:00',
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
      await expect(current!.deleteEvent({
        sourceEventId: 'tokenless-event',
        occurrenceDate: '2026-07-13',
      })).rejects.toThrow('not authenticated');
    });

    expect(commandEventState).not.toHaveBeenCalled();
    expect(current?.events).toEqual([expect.objectContaining({ title: '不能本机误删的日程' })]);
  });

  it('keeps an unknown cloud deletion hidden and durable instead of restoring a phantom', async () => {
    const cached = [{
      id: '99',
      title: '云端仍然存在的日程',
      startDate: '2026-07-12',
      startTime: '12:00',
      endTime: '13:00',
      reminderMinutes: 15,
      color: '#5B8CFF',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:eventsCache:v1:user:7' ? JSON.stringify(cached) : null
    ));
    (fetchEvents as jest.Mock).mockRejectedValue(new Error('offline'));
    (commandEventState as jest.Mock).mockRejectedValue(new Error('request timed out'));
    (cancelEventNotificationsForMutation as jest.Mock).mockRejectedValue(new Error('registry full'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events).toHaveLength(1));

    await act(async () => {
      await current!.deleteEvent({
        sourceEventId: '99',
        occurrenceDate: '2026-07-12',
      });
    });

    expect(commandEventState).toHaveBeenCalledWith(99, expect.objectContaining({
      desired_state: 'absent',
      scope: 'series',
      client_request_id: expect.stringMatching(/^event-delete:/),
    }), 'token-7');
    expect(current?.events).toEqual([]);
    expect(current?.lastDeleted).toEqual(expect.objectContaining({ id: '99' }));
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@laoji:eventDeleteTransactions:v1:user:7',
      expect.stringContaining('"observedState":"unknown"'),
    );
  });

  it('settles deletion before retrying restore with the original source id', async () => {
    const initial = {
      id: 101,
      title: '需要撤销的日程',
      event_type: 'once',
      start_date: '2026-07-12',
      start_time: '12:00',
      end_time: '13:00',
      reminder_minutes: null,
    };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);
    (commandEventState as jest.Mock).mockImplementation(async (_id, command) => {
      if (command.desired_state === 'present') throw new Error('offline');
      return {
        observed_state: 'absent',
        revision: 2,
      };
    });

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.some(event => event.id === '101')).toBe(true));

    await act(async () => {
      await current!.deleteEvent({ sourceEventId: '101', occurrenceDate: '2026-07-12' });
    });
    expect(current?.lastDeleted).toEqual(expect.objectContaining({ title: '需要撤销的日程' }));

    await act(async () => {
      await expect(current!.undoDelete()).rejects.toThrow('offline');
    });
    expect(current?.lastDeleted).toEqual(expect.objectContaining({ title: '需要撤销的日程' }));

    (commandEventState as jest.Mock).mockImplementation(async (_id, command) => ({
      observed_state: command.desired_state,
      revision: command.desired_state === 'present' ? 3 : 2,
    }));
    await act(async () => { await current!.undoDelete(); });
    expect(current?.lastDeleted).toBeNull();
    const commands = (commandEventState as jest.Mock).mock.calls;
    expect(commands.map(([, command]) => command.desired_state)).toEqual([
      'absent',
      'present',
      'present',
    ]);
    expect(commands.every(([id]) => id === 101)).toBe(true);
    expect(saveEvent).not.toHaveBeenCalled();
  });

  it('reports an unavailable reminder after a cloud event edit without repeating the month refresh', async () => {
    const initial = {
      id: 77,
      title: '编辑前日程',
      event_type: 'once',
      start_date: '2026-07-12',
      start_time: '12:00',
      end_time: '13:00',
      reminder_minutes: 15,
    };
    const updated = { ...initial, title: '编辑后日程' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('编辑前日程'));

    (fetchEvents as jest.Mock).mockClear();
    (fetchEvents as jest.Mock).mockResolvedValue([updated]);
    (commandEventEdit as jest.Mock).mockImplementation(async (id, command) => ({
      client_request_id: command.client_request_id,
      source_event_id: id,
      canonical_ref: { source_event_id: id, occurrence_date: command.occurrence_date },
      scope: command.scope,
      previous_revision: 1,
      revision: 2,
      changed: true,
      event: { ...updated, revision: 2 },
      affected_range: {
        from_occurrence_date: command.occurrence_date,
        through_occurrence_date: command.occurrence_date,
      },
    }));
    (cancelEventNotificationsForMutation as jest.Mock).mockResolvedValueOnce(undefined);
    (reconcileEventNotifications as jest.Mock).mockResolvedValueOnce({ '77': null });

    let result: Awaited<ReturnType<NonNullable<typeof current>['updateEvent']>> | undefined;
    await act(async () => {
      result = await current!.updateEvent(
        { sourceEventId: '77', occurrenceDate: '2026-07-12' },
        { title: '编辑后日程' },
      );
    });

    expect(result).toEqual({ reminderDelivery: 'unavailable' });
    expect(commandEventEdit).toHaveBeenCalledWith(77, expect.objectContaining({
      client_request_id: expect.stringMatching(/^event-edit:/),
      scope: 'series',
      occurrence_date: '2026-07-12',
      patch: { title: '编辑后日程' },
    }), 'token-7');
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect((fetchEvents as jest.Mock).mock.calls.filter(
      ([year, month]) => year === 2026 && month === 7,
    )).toHaveLength(1);
    expect(fetchEvents).toHaveBeenCalledWith(undefined, undefined, 'token-7');
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '77', title: '编辑后日程', notificationId: null }),
    ]);
  });

  it('keeps reminder removal unconfirmed when an old notification cannot be cancelled', async () => {
    const initial = {
      id: 78,
      title: '关闭提醒',
      event_type: 'once',
      start_date: '2026-07-13',
      start_time: '13:00',
      end_time: '14:00',
      reminder_minutes: 15,
    };
    const updated = { ...initial, reminder_minutes: null };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('关闭提醒'));

    (fetchEvents as jest.Mock).mockResolvedValue([updated]);
    (commandEventEdit as jest.Mock).mockImplementation(async (id, command) => ({
      client_request_id: command.client_request_id,
      source_event_id: id,
      canonical_ref: { source_event_id: id, occurrence_date: command.occurrence_date },
      scope: command.scope,
      previous_revision: 1,
      revision: 2,
      changed: true,
      event: { ...updated, revision: 2 },
      affected_range: {
        from_occurrence_date: command.occurrence_date,
        through_occurrence_date: command.occurrence_date,
      },
    }));
    (cancelEventNotificationsForMutation as jest.Mock).mockRejectedValueOnce(new Error('registry unavailable'));
    (reconcileEventNotifications as jest.Mock).mockResolvedValueOnce({});

    let result: Awaited<ReturnType<NonNullable<typeof current>['updateEvent']>> | undefined;
    await act(async () => {
      result = await current!.updateEvent(
        { sourceEventId: '78', occurrenceDate: '2026-07-13' },
        { reminderMinutes: null },
      );
    });

    expect(result).toEqual({ reminderDelivery: 'unconfirmed' });
    expect(current?.events).toEqual([
      expect.objectContaining({ id: '78', reminderMinutes: null }),
    ]);
  });

  it('journals an edit with an unknown network outcome instead of inviting a duplicate write', async () => {
    const initial = {
      id: 79,
      title: '待确认编辑',
      event_type: 'once',
      start_date: '2026-07-14',
      start_time: '09:00',
      end_time: '10:00',
      revision: 3,
    };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([initial]);
    (commandEventEdit as jest.Mock).mockRejectedValue(new Error('request timed out'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('待确认编辑'));

    let result: Awaited<ReturnType<NonNullable<typeof current>['updateEvent']>> | undefined;
    await act(async () => {
      result = await current!.updateEvent(
        { sourceEventId: '79', occurrenceDate: '2026-07-14' },
        { title: '网络恢复后确认' },
      );
    });

    expect(result).toEqual({ reminderDelivery: 'unconfirmed', syncStatus: 'pending' });
    expect(commandEventEdit).toHaveBeenCalledTimes(1);
    expect(commandEventEdit).toHaveBeenCalledWith(79, expect.objectContaining({
      client_request_id: expect.stringMatching(/^event-edit:/),
      expected_revision: 3,
      patch: { title: '网络恢复后确认' },
    }), 'token-7');
    const journalWrites = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
      ([key]) => key === '@laoji:eventEditTransactions:v1:user:7',
    );
    expect(journalWrites).not.toHaveLength(0);
    expect(JSON.parse(journalWrites.at(-1)![1])).toEqual(expect.objectContaining({
      version: 1,
      transactions: [expect.objectContaining({
        phase: 'retryable',
        ref: { sourceEventId: '79', occurrenceDate: '2026-07-14' },
      })],
    }));
  });

  it('recovers a committed edit journal on startup without posting the command again', async () => {
    const initial = {
      id: 80,
      title: '恢复前标题',
      event_type: 'once',
      start_date: '2026-07-15',
      start_time: '09:00',
      end_time: '10:00',
      revision: 4,
    };
    const recovered = { ...initial, title: '已恢复标题', revision: 5 };
    const transaction = {
      id: 'event-edit:recovery-1',
      scopeKey: 'user:7',
      ref: { sourceEventId: '80', occurrenceDate: '2026-07-15' },
      recurrenceScope: 'series',
      patch: { title: '已恢复标题' },
      expectedRevision: 4,
      phase: 'retryable',
      createdAt: 1,
    };
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:eventEditTransactions:v1:user:7'
        ? JSON.stringify({ version: 1, transactions: [transaction] })
        : null
    ));
    (fetchEvents as jest.Mock).mockResolvedValue([recovered]);
    (fetchEventEditCommand as jest.Mock).mockResolvedValue({
      client_request_id: transaction.id,
      source_event_id: 80,
      canonical_ref: { source_event_id: 80, occurrence_date: '2026-07-15' },
      scope: 'series',
      previous_revision: 4,
      revision: 5,
      changed: true,
      event: recovered,
      affected_range: {
        from_occurrence_date: '2026-07-15',
        through_occurrence_date: '2026-07-15',
      },
    });

    await render(<EventsProvider><Probe /></EventsProvider>);

    await waitFor(() => expect(fetchEventEditCommand).toHaveBeenCalledWith(
      transaction.id,
      'token-7',
    ));
    await waitFor(() => expect(current?.events.map(event => event.title)).toContain('已恢复标题'));
    expect(commandEventEdit).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(
      '@laoji:eventEditTransactions:v1:user:7',
    );
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

  it('persists a guest occurrence edit as an exception and cleans only that reminder scope', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    const series = [{
      id: 'guest-weekly-edit',
      sourceEventId: 'guest-weekly-edit',
      occurrenceDate: '2026-07-06',
      title: '游客周会',
      startDate: '2026-07-06',
      seriesStartDate: '2026-07-06',
      startTime: '10:00',
      endTime: '11:00',
      repeat: 'weekly',
      reminderMinutes: 15,
      color: '#1456F0',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:guestEvents:v1' ? JSON.stringify(series) : null
    ));
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.events.some(event => (
      event.occurrenceDate === '2026-07-20'
    ))).toBe(true));

    await act(async () => {
      await current!.updateEvent(
        { sourceEventId: 'guest-weekly-edit', occurrenceDate: '2026-07-20' },
        { title: '游客产品周会', startDate: '2026-07-21' },
        'occurrence',
      );
    });

    expect(cancelEventNotificationsForMutation).toHaveBeenCalledWith(
      'guest',
      { sourceEventId: 'guest-weekly-edit', occurrenceDate: '2026-07-20' },
      'occurrence',
      expect.any(Array),
    );
    const guestWrites = (AsyncStorage.setItem as jest.Mock).mock.calls
      .filter(([key]) => key === '@laoji:guestEvents:v1');
    const saved = JSON.parse(guestWrites.at(-1)![1]);
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ excludedOccurrenceDates: ['2026-07-20'] }),
      expect.objectContaining({
        occurrenceDate: '2026-07-20',
        startDate: '2026-07-21',
        isRecurrenceException: true,
      }),
    ]));
    expect(current?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        occurrenceDate: '2026-07-20',
        startDate: '2026-07-21',
        title: '游客产品周会',
      }),
    ]));
  });

  it('finds a far guest recurrence without depending on loaded display months', async () => {
    (useAuth as jest.Mock).mockReturnValue({ mode: 'guest', session: null, accessToken: null });
    const series = [{
      id: 'guest-weekly',
      sourceEventId: 'guest-weekly',
      occurrenceDate: '2026-07-05',
      title: '周日复盘',
      startDate: '2026-07-05',
      startTime: '10:00',
      endTime: '11:00',
      repeat: 'weekly',
      color: '#1456F0',
    }];
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:guestEvents:v1' ? JSON.stringify(series) : null
    ));
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.searchableEvents).toHaveLength(1));

    const result = await current!.findConflicts({
      title: '临时安排',
      startDate: '2026-09-06',
      startTime: '10:30',
      endTime: '11:30',
      isAllDay: false,
      repeat: 'once',
      reminderMinutes: null,
      color: '#1456F0',
    });

    expect(result.coverage.status).toBe('complete');
    expect(result.conflicts[0]).toMatchObject({
      ref: { sourceEventId: 'guest-weekly', occurrenceDate: '2026-09-06' },
      event: { title: '周日复盘', startDate: '2026-09-06' },
      kind: 'timed-overlap',
    });
  });

  it('loads every target cloud month and reports partial coverage explicitly', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockImplementation(async (year?: number, month?: number) => {
      if (year === 2027 && month === 12) return [{
        id: 501,
        title: '跨年值班',
        event_type: 'once',
        start_date: '2027-12-31',
        end_date: '2028-01-01',
        start_time: '23:00',
        end_time: '01:00',
      }];
      if (year === 2028 && month === 1) throw new Error('month unavailable');
      return [];
    });
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.loading).toBe(false));
    (fetchEvents as jest.Mock).mockClear();

    const result = await current!.findConflicts({
      title: '跨年发布',
      startDate: '2027-12-31',
      endDate: '2028-01-01',
      startTime: '23:30',
      endTime: '00:30',
      isAllDay: false,
      repeat: 'once',
      reminderMinutes: null,
      color: '#1456F0',
    });

    expect(fetchEvents).toHaveBeenCalledWith(2027, 12, 'token-7');
    expect(fetchEvents).toHaveBeenCalledWith(2028, 1, 'token-7');
    expect(result.coverage.status).toBe('partial');
    expect(result.complete).toBe(false);
    expect(result.conflicts.map(conflict => conflict.event.title)).toContain('跨年值班');
  });

  it('prevents an older response for the same month from overwriting a newer response', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([]);
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.hydratedScope).toBe('user:7'));
    (fetchEvents as jest.Mock).mockClear();

    const older = deferred<unknown[]>();
    const newer = deferred<unknown[]>();
    (fetchEvents as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    let olderRequest!: Promise<unknown>;
    let newerRequest!: Promise<unknown>;
    await act(async () => {
      olderRequest = current!.refreshEvents(2026, 9);
      newerRequest = current!.refreshEvents(2026, 9);
      await Promise.resolve();
    });

    await act(async () => {
      newer.resolve([{
        id: 902,
        title: '较新的九月结果',
        event_type: 'once',
        start_date: '2026-09-02',
      }]);
      await newerRequest;
    });
    await act(async () => {
      older.resolve([{
        id: 901,
        title: '迟到的旧结果',
        event_type: 'once',
        start_date: '2026-09-01',
      }]);
      await olderRequest;
    });

    expect(current?.events.map(event => event.title)).toContain('较新的九月结果');
    expect(current?.events.map(event => event.title)).not.toContain('迟到的旧结果');
    expect(current?.monthStates['2026-09']).toEqual(expect.objectContaining({
      status: 'loaded',
      error: null,
    }));
  });

  it('isolates loading and errors by month range', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([]);
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.hydratedScope).toBe('user:7'));
    (fetchEvents as jest.Mock).mockImplementation(async (year?: number, month?: number) => {
      if (year === 2026 && month === 8) throw new Error('八月暂不可用');
      return year === 2026 && month === 7 ? [{
        id: 701,
        title: '七月仍可用',
        event_type: 'once',
        start_date: '2026-07-20',
      }] : [];
    });

    await act(async () => {
      await Promise.all([
        current!.refreshEvents(2026, 7),
        current!.refreshEvents(2026, 8),
      ]);
    });

    expect(current?.monthStates['2026-07'].status).toBe('loaded');
    expect(current?.monthStates['2026-08']).toEqual({ status: 'error', error: '八月暂不可用' });
    expect(current?.events.map(event => event.title)).toContain('七月仍可用');
    expect(current?.error).toBe('八月暂不可用');
  });

  it('deduplicates repeated foreground transitions into one adjacent-month and catalog refresh', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (fetchEvents as jest.Mock).mockResolvedValue([]);
    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.hydratedScope).toBe('user:7'));
    await waitFor(() => expect(appStateListener).not.toBeNull());
    (fetchEvents as jest.Mock).mockClear();
    const gate = deferred<unknown[]>();
    (fetchEvents as jest.Mock).mockImplementation(() => gate.promise);

    await act(async () => {
      appStateListener?.('background');
      appStateListener?.('active');
      appStateListener?.('background');
      appStateListener?.('active');
      await Promise.resolve();
    });

    expect(fetchEvents).toHaveBeenCalledTimes(4);
    expect(fetchEvents).toHaveBeenCalledWith(2026, 6, 'token-7');
    expect(fetchEvents).toHaveBeenCalledWith(2026, 7, 'token-7');
    expect(fetchEvents).toHaveBeenCalledWith(2026, 8, 'token-7');
    expect(fetchEvents).toHaveBeenCalledWith(undefined, undefined, 'token-7');

    await act(async () => {
      gate.resolve([]);
      await gate.promise;
    });
    await waitFor(() => expect(current?.loading).toBe(false));
  });

  it('exposes an isolated cache recovery notice and lets the user dismiss it', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => (
      key === '@laoji:eventsCache:v2:user:7' ? '{broken' : null
    ));
    (fetchEvents as jest.Mock).mockRejectedValue(new Error('offline'));

    await render(<EventsProvider><Probe /></EventsProvider>);
    await waitFor(() => expect(current?.hydratedScope).toBe('user:7'));

    expect(current?.cacheRecoveryNotice).toEqual(expect.objectContaining({ kinds: ['months'] }));
    await act(async () => { await current!.dismissCacheRecoveryNotice(); });
    expect(current?.cacheRecoveryNotice).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('@laoji:eventCacheRecovery:v1:user:7');
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
