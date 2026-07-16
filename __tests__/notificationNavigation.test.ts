import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const mockNavigate = jest.fn();
const mockIsReady = jest.fn(() => false);
const mockGetRootState = jest.fn(() => ({ routeNames: ['MainTabs', 'EventDetail'] }));
const mockGetCurrentRoute: jest.Mock = jest.fn(() => ({ name: 'MainTabs', params: undefined }));

jest.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    navigate: mockNavigate,
    isReady: mockIsReady,
    getRootState: mockGetRootState,
    getCurrentRoute: mockGetCurrentRoute,
  }),
}));

import {
  flushPendingNotificationNavigation,
  installNotificationNavigationListener,
  queueNotificationResponse,
  resetNotificationNavigationForTests,
  setNotificationNavigationScope,
  setNotificationEventResolver,
  setNotificationNavigationUnlocked,
} from '../src/navigation/notificationNavigation';

function response(identifier: string, sourceEventId = 'series-7', occurrenceDate = '2099-07-20') {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        identifier,
        content: {
          data: { eventSourceId: sourceEventId, eventOccurrenceDate: occurrenceDate },
        },
      },
    },
  } as unknown as Parameters<typeof queueNotificationResponse>[0];
}

describe('notification occurrence navigation', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    resetNotificationNavigationForTests();
    await AsyncStorage.clear();
    mockIsReady.mockReturnValue(false);
    mockGetRootState.mockReturnValue({ routeNames: ['MainTabs', 'EventDetail'] });
    mockGetCurrentRoute.mockReturnValue({ name: 'MainTabs', params: undefined });
    setNotificationNavigationScope('user:7');
    setNotificationNavigationUnlocked(true);
    (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
  });

  it('queues a cold response until the authenticated navigator is ready', async () => {
    await queueNotificationResponse(response('cold-1'));
    expect(mockNavigate).not.toHaveBeenCalled();

    mockIsReady.mockReturnValue(true);
    await expect(flushPendingNotificationNavigation()).resolves.toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('EventDetail', {
      eventRef: { sourceEventId: 'series-7', occurrenceDate: '2099-07-20' },
    });
  });

  it('does not navigate twice for the same persisted notification response', async () => {
    mockIsReady.mockReturnValue(true);
    const value = response('same-response');
    await queueNotificationResponse(value);
    await queueNotificationResponse(value);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('marks a response handled without stacking an identical detail route', async () => {
    mockIsReady.mockReturnValue(true);
    mockGetCurrentRoute.mockReturnValue({
      name: 'EventDetail',
      params: { eventRef: { sourceEventId: 'series-7', occurrenceDate: '2099-07-20' } },
    });
    await queueNotificationResponse(response('already-open'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('installs both cold-start and live response handlers and removes the listener', async () => {
    const remove = jest.fn();
    (Notifications.addNotificationResponseReceivedListener as jest.Mock)
      .mockReturnValueOnce({ remove });
    const cleanup = installNotificationNavigationListener();
    await new Promise(resolve => setTimeout(resolve, 0));
    cleanup();
    expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('consumes but never opens a notification owned by another account scope', async () => {
    mockIsReady.mockReturnValue(true);
    const value = response('wrong-account') as any;
    value.notification.request.content.data.notificationScope = 'user:A';
    setNotificationNavigationScope('user:B');

    await queueNotificationResponse(value);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps a response pending until the occurrence repository can resolve it', async () => {
    mockIsReady.mockReturnValue(true);
    setNotificationEventResolver(async () => 'retryable');
    await queueNotificationResponse(response('wait-for-store'));
    expect(mockNavigate).not.toHaveBeenCalled();

    setNotificationEventResolver(async () => 'found');
    await flushPendingNotificationNavigation();
    expect(mockNavigate).toHaveBeenCalledWith('EventDetail', {
      eventRef: { sourceEventId: 'series-7', occurrenceDate: '2099-07-20' },
    });
  });

  it('consumes a confirmed deleted occurrence without opening an empty detail page', async () => {
    mockIsReady.mockReturnValue(true);
    setNotificationEventResolver(async () => 'not-found');
    await queueNotificationResponse(response('deleted-occurrence'));
    expect(mockNavigate).not.toHaveBeenCalled();
    await queueNotificationResponse(response('deleted-occurrence'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps a resolved response pending behind the privacy lock', async () => {
    mockIsReady.mockReturnValue(true);
    setNotificationEventResolver(async () => 'found');
    setNotificationNavigationUnlocked(false);
    await queueNotificationResponse(response('locked'));
    expect(mockNavigate).not.toHaveBeenCalled();

    setNotificationNavigationUnlocked(true);
    await flushPendingNotificationNavigation();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });
});
