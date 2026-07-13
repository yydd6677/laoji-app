import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { CalEvent } from '../src/types';
import {
  reconcileEventNotifications,
  switchEventNotificationScope,
} from '../src/services/notifications';

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

describe('scoped event notification registry', () => {
  const storage = new Map<string, string>();
  let nextNotificationId = 1;

  beforeEach(async () => {
    jest.clearAllMocks();
    storage.clear();
    nextNotificationId = 1;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    (Notifications.scheduleNotificationAsync as jest.Mock).mockImplementation(async () => (
      `notification-${nextNotificationId++}`
    ));
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
    expect(inactiveA['account-A-event']).toEqual(expect.objectContaining({
      notificationId: null,
      event: expect.objectContaining({ title: accountAEvent.title }),
    }));

    const accountBEvent = timedEvent('account-B-event');
    await reconcileEventNotifications('user:B', [accountBEvent]);
    await switchEventNotificationScope('user:B', 'user:A');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notification-2');
    const inactiveB = JSON.parse(storage.get(`${REGISTRY_PREFIX}user:B`)!);
    expect(inactiveB['account-B-event'].notificationId).toBeNull();

    const restored = await reconcileEventNotifications('user:A', [accountAEvent]);
    expect(restored['account-A-event']).toBe('notification-3');
    expect(JSON.parse(storage.get(`${REGISTRY_PREFIX}user:A`)!)['account-A-event'].notificationId)
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
    expect(registry.deleted).toBeUndefined();
    expect(registry.moved.event).toEqual(expect.objectContaining({
      startDate: '2099-07-22',
      startTime: '14:30',
    }));
    expect(registry['reminder-changed'].event.reminderMinutes).toBe(60);
  });
});
