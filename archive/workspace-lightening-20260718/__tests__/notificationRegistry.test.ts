import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { CalEvent } from '../src/types';
import {
  cancelEventNotificationsForScope,
  cancelEventNotificationsForMutation,
  reconcileEventNotificationHorizon,
  reconcileEventNotifications,
  switchEventNotificationScope,
} from '../src/services/notifications';
import { eventRefKey } from '../src/utils/eventIdentity';

const REGISTRY_PREFIX = '@laoji:eventNotificationRegistry:v1:';

function timedEvent(id: string, patch: Partial<CalEvent> = {}): CalEvent {
  return {
    id,
    title: `日程 ${id}`,
    startDate: '2099-07-20',
    startTime: '10:00',
    color: '#5B8CFF',
    reminderMinutes: 15,
    ...patch,
  };
}

function registryEventKey(event: CalEvent): string {
  return eventRefKey({ sourceEventId: event.sourceEventId ?? event.id, occurrenceDate: event.startDate });
}

describe('scoped event notification registry', () => {
  const storage = new Map<string, string>();
  const scheduledNotifications = new Map<string, any>();
  let nextNotificationId = 1;

  beforeEach(async () => {
    jest.useRealTimers();
    jest.clearAllMocks();
    storage.clear();
    scheduledNotifications.clear();
    nextNotificationId = 1;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (Notifications.scheduleNotificationAsync as jest.Mock).mockReset().mockImplementation(async request => {
      const identifier = `notification-${nextNotificationId++}`;
      scheduledNotifications.set(identifier, { identifier, ...request });
      return identifier;
    });
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockReset().mockImplementation(async identifier => {
      scheduledNotifications.delete(identifier);
    });
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockReset().mockImplementation(async () => (
      [...scheduledNotifications.values()]
    ));
    (Notifications.dismissNotificationAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
    await switchEventNotificationScope(null, null);
    jest.clearAllMocks();
  });

  it('cancels the previous scope but keeps its snapshot for privacy-safe restoration', async () => {
    const accountAEvent = timedEvent('account-A-event');
    await switchEventNotificationScope(null, 'user:A');
    await reconcileEventNotifications('user:A', [accountAEvent]);

    await switchEventNotificationScope('user:A', 'user:B');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-1');
    const inactiveA = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:A`)!);
    expect(inactiveA[registryEventKey(accountAEvent)]).toEqual(expect.objectContaining({
      notificationId: null,
      event: expect.objectContaining({ title: accountAEvent.title }),
    }));

    const accountBEvent = timedEvent('account-B-event');
    await reconcileEventNotifications('user:B', [accountBEvent]);
    await switchEventNotificationScope('user:B', 'user:A');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-2');
    const inactiveB = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:B`)!);
    expect(inactiveB[registryEventKey(accountBEvent)].notificationId).toBeNull();

    const restored = await reconcileEventNotifications('user:A', [accountAEvent]);
    expect(restored['account-A-event']).toBe('notification-3');
    expect(JSON.parse(storage.get(`${REGISTRY_PREFIX}user:A`)!)[registryEventKey(accountAEvent)].notificationId)
      .toBe('notification-3');
  });

  it('reconciles cloud deletion, rescheduling, and reminder changes without stale notifications', async () => {
    await switchEventNotificationScope(null, 'user:cloud');
    const deleted = timedEvent('deleted');
    const moved = timedEvent('moved');
    const reminderChanged = timedEvent('reminder-changed');
    const initialIds = await reconcileEventNotifications('user:cloud', [deleted, moved, reminderChanged], {
      windowStart: '2099-07-01',
      windowEnd: '2099-07-31',
    });
    jest.clearAllMocks();

    const movedFromCloud = timedEvent('moved', { startDate: '2099-07-22', startTime: '14:30' });
    const newReminderFromCloud = timedEvent('reminder-changed', { reminderMinutes: 60 });
    const nextIds = await reconcileEventNotifications('user:cloud', [movedFromCloud, newReminderFromCloud], {
      windowStart: '2099-07-01',
      windowEnd: '2099-07-31',
      previousEvents: [
        { ...deleted, notificationId: initialIds.deleted },
        { ...moved, notificationId: initialIds.moved },
        { ...reminderChanged, notificationId: initialIds['reminder-changed'] },
      ],
    });

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(initialIds.deleted);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(initialIds.moved);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(initialIds['reminder-changed']);
    expect(nextIds.moved).not.toBe(initialIds.moved);
    expect(nextIds['reminder-changed']).not.toBe(initialIds['reminder-changed']);

    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:cloud`)!);
    expect(registry[registryEventKey(deleted)]).toBeUndefined();
    expect(registry[registryEventKey(movedFromCloud)].event).toEqual(expect.objectContaining({
      startDate: '2099-07-22',
      startTime: '14:30',
    }));
    expect(registry[registryEventKey(newReminderFromCloud)].event.reminderMinutes).toBe(60);
  });

  it('migrates a legacy id-keyed registry without duplicating its notification', async () => {
    const event = timedEvent('series@2099-07-20', {
      sourceEventId: 'series',
      isExpandedOccurrence: true,
    });
    storage.set(`${REGISTRY_PREFIX}user:legacy`, JSON.stringify({
      'series@2099-07-20': {
        event: {
          id: 'series@2099-07-20',
          title: event.title,
          startDate: event.startDate,
          startTime: event.startTime,
          reminderMinutes: event.reminderMinutes,
        },
        notificationId: 'legacy-notification',
      },
    }));
    scheduledNotifications.set('legacy-notification', {
      identifier: 'legacy-notification',
      content: {
        body: event.title,
        data: {
          eventSourceId: 'series',
          eventOccurrenceDate: '2099-07-20',
          notificationScope: 'user:legacy',
        },
      },
      trigger: null,
    });
    await switchEventNotificationScope(null, 'user:legacy');

    const ids = await reconcileEventNotifications('user:legacy', [event]);

    expect(ids[event.id]).toBe('legacy-notification');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:legacy`)!);
    expect(registry[registryEventKey(event)].notificationId).toBe('legacy-notification');
  });

  it('recovers an orphaned OS notification after registry corruption', async () => {
    const event = timedEvent('recoverable');
    storage.set(`${REGISTRY_PREFIX}user:recover`, '{broken');
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValueOnce([{
      identifier: 'orphaned-notification',
      content: {
        body: event.title,
        data: {
          eventSourceId: event.id,
          eventOccurrenceDate: event.startDate,
          notificationScope: 'user:recover',
        },
      },
      trigger: null,
    }]);
    await switchEventNotificationScope(null, 'user:recover');

    const ids = await reconcileEventNotifications('user:recover', [event]);

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('orphaned-notification');
    expect(ids[event.id]).toBe('notification-1');
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:recover`)!);
    expect(registry[registryEventKey(event)].notificationId).toBe('notification-1');
  });

  it('adopts a scheduled notification when the registry write failed after OS scheduling', async () => {
    const event = timedEvent('schedule-write-crash');
    await switchEventNotificationScope(null, 'user:schedule-crash');
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('registry write failed'));

    await expect(reconcileEventNotifications('user:schedule-crash', [event]))
      .rejects.toThrow('registry write failed');
    expect(scheduledNotifications.size).toBe(1);
    expect(storage.has(`${REGISTRY_PREFIX}user:schedule-crash`)).toBe(false);

    const recovered = await reconcileEventNotifications('user:schedule-crash', [event]);

    expect(recovered[event.id]).toBe('notification-1');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:schedule-crash`)!);
    expect(registry[registryEventKey(event)]).toEqual(expect.objectContaining({
      notificationId: 'notification-1',
      pendingCancellationIds: [],
    }));
  });

  it('converges after OS cancellation succeeds but registry removal fails', async () => {
    const event = timedEvent('cancel-write-crash');
    await switchEventNotificationScope(null, 'user:cancel-crash');
    await reconcileEventNotifications('user:cancel-crash', [event]);
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('registry removal failed'));

    await expect(cancelEventNotificationsForScope('user:cancel-crash', [event]))
      .rejects.toThrow('registry removal failed');
    expect(scheduledNotifications.size).toBe(0);
    expect(storage.has(`${REGISTRY_PREFIX}user:cancel-crash`)).toBe(true);

    await expect(cancelEventNotificationsForScope('user:cancel-crash', [event])).resolves.toBeUndefined();

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(storage.has(`${REGISTRY_PREFIX}user:cancel-crash`)).toBe(false);
  });

  it('cancels duplicate OS notifications for the same stable occurrence', async () => {
    const event = timedEvent('duplicate-occurrence');
    await switchEventNotificationScope(null, 'user:duplicates');
    await reconcileEventNotifications('user:duplicates', [event]);
    const original = scheduledNotifications.get('notification-1');
    scheduledNotifications.set('duplicate-notification', {
      ...original,
      identifier: 'duplicate-notification',
    });
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

    await reconcileEventNotifications('user:duplicates', [event]);

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('duplicate-notification');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect([...scheduledNotifications.keys()]).toEqual(['notification-1']);
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:duplicates`)!);
    expect(registry[registryEventKey(event)].pendingCancellationIds).toEqual([]);
  });

  it('does not recreate a late reminder after its scheduled request has fired', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 17, 14, 55, 0));
    await switchEventNotificationScope(null, 'guest');
    const event = timedEvent('late-reminder', {
      startDate: '2026-07-17',
      startTime: '15:00',
    });

    const first = await reconcileEventNotifications('guest', [event]);
    const firstId = first[event.id];
    expect(firstId).toBe('notification-1');
    const scheduled = JSON.parse(storage.get(`${REGISTRY_PREFIX}guest`)!)[registryEventKey(event)];
    expect(scheduled.scheduledFireAt).toBe('2026-07-17T06:55:01.000Z');

    scheduledNotifications.delete(firstId!);
    jest.setSystemTime(new Date(2026, 6, 17, 14, 55, 2));
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

    const restored = await reconcileEventNotifications('guest', [event]);

    expect(restored[event.id]).toBe(firstId);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    const delivered = JSON.parse(storage.get(`${REGISTRY_PREFIX}guest`)!)[registryEventKey(event)];
    expect(delivered).toEqual(expect.objectContaining({
      notificationId: firstId,
      deliveredAt: '2026-07-17T06:55:01.000Z',
    }));
  });

  it('reschedules a changed event after an earlier reminder was delivered', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 17, 14, 55, 0));
    await switchEventNotificationScope(null, 'guest:edited');
    const event = timedEvent('edited-after-delivery', {
      startDate: '2026-07-17',
      startTime: '15:00',
    });
    const first = await reconcileEventNotifications('guest:edited', [event]);
    scheduledNotifications.delete(first[event.id]!);
    jest.setSystemTime(new Date(2026, 6, 17, 14, 55, 2));
    await reconcileEventNotifications('guest:edited', [event]);
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

    const changed = { ...event, startTime: '15:30' };
    const next = await reconcileEventNotifications('guest:edited', [changed]);

    expect(next[event.id]).toBe('notification-2');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('repairs a missing OS request when its persisted fire time is still in the future', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 17, 14, 0, 0));
    await switchEventNotificationScope(null, 'guest:repair');
    const event = timedEvent('missing-before-fire', {
      startDate: '2026-07-17',
      startTime: '15:00',
    });
    const first = await reconcileEventNotifications('guest:repair', [event]);
    scheduledNotifications.delete(first[event.id]!);
    jest.setSystemTime(new Date(2026, 6, 17, 14, 10, 0));
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

    const repaired = await reconcileEventNotifications('guest:repair', [event]);

    expect(repaired[event.id]).toBe('notification-2');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}guest:repair`)!);
    expect(registry[registryEventKey(event)]).toEqual(expect.objectContaining({
      notificationId: 'notification-2',
      deliveredAt: null,
      scheduledFireAt: '2026-07-17T06:45:00.000Z',
    }));
  });

  it('retains a registry entry when OS cancellation fails so cleanup can retry', async () => {
    const event = timedEvent('retry-cancel');
    await switchEventNotificationScope(null, 'user:retry');
    await reconcileEventNotifications('user:retry', [event]);
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('os busy'));

    await expect(cancelEventNotificationsForScope('user:retry', [event]))
      .rejects.toThrow('notification cancellation failed');

    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:retry`)!);
    expect(registry[registryEventKey(event)].notificationId).toBe('notification-1');
  });

  it('cancels unloaded reminders for a complete series or following scope', async () => {
    await switchEventNotificationScope(null, 'user:series');
    const first = timedEvent('series@2099-07-20', {
      sourceEventId: 'series',
      occurrenceDate: '2099-07-20',
      isExpandedOccurrence: true,
    });
    const second = timedEvent('series@2099-07-27', {
      sourceEventId: 'series',
      occurrenceDate: '2099-07-27',
      startDate: '2099-07-27',
      isExpandedOccurrence: true,
    });
    await reconcileEventNotifications('user:series', [first, second]);
    jest.clearAllMocks();

    await cancelEventNotificationsForMutation(
      'user:series',
      { sourceEventId: 'series', occurrenceDate: '2099-07-27' },
      'following',
      [],
    );

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-2');
    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith('notification-1');
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:series`)!);
    expect(registry[registryEventKey(first)]).toBeTruthy();
    expect(registry[registryEventKey(second)]).toBeUndefined();
  });

  it('removes a previously scheduled tail when the rolling horizon is truncated', async () => {
    await switchEventNotificationScope(null, 'user:horizon');
    const series = timedEvent('daily-series', {
      sourceEventId: 'daily-series',
      startDate: '2099-07-20',
      repeat: 'daily',
    });
    const first = timedEvent('daily-series@2099-07-20', {
      sourceEventId: 'daily-series',
      occurrenceDate: '2099-07-20',
      startDate: '2099-07-20',
      isExpandedOccurrence: true,
      title: series.title,
    });
    const staleTail = timedEvent('daily-series@2099-07-21', {
      sourceEventId: 'daily-series',
      occurrenceDate: '2099-07-21',
      startDate: '2099-07-21',
      isExpandedOccurrence: true,
    });
    await reconcileEventNotifications('user:horizon', [first, staleTail]);
    jest.clearAllMocks();

    await reconcileEventNotificationHorizon(
      'user:horizon',
      [series],
      new Date(2099, 6, 20, 8, 0),
      90,
      1,
    );

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-2');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect([...scheduledNotifications.keys()]).toEqual(['notification-1']);
    const registry = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:horizon`)!);
    expect(registry[registryEventKey(first)]).toBeTruthy();
    expect(registry[registryEventKey(staleTail)]).toBeUndefined();
  });
});
