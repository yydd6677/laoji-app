import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { useAuth } from '../src/store/AuthStore';
import { AppReadinessGate } from '../src/components/AppReadinessGate';
import {
  NavigationStateProvider,
  RestorableNavigationContainer,
  useNavigationStateRestoration,
} from '../src/navigation/NavigationStateCoordinator';
import {
  NavigationStateWriter,
  type NavigationStateStorage,
} from '../src/services/navigationStatePersistence';
import { createPersistedNavigationState } from '../src/services/navigationState';

jest.mock('@react-navigation/native', () => ({
  NavigationContainer: require('react').forwardRef((props: Record<string, unknown>, _ref: unknown) => (
    require('react').createElement(
      'NavigationContainer',
      { ...props, testID: 'restorable-navigation-container' },
      props.children,
    )
  )),
  createNavigationContainerRef: () => ({
    isReady: jest.fn(() => false),
    getRootState: jest.fn(() => ({ routeNames: [] })),
    getCurrentRoute: jest.fn(() => undefined),
    navigate: jest.fn(),
  }),
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function eventDetailRecord(scope: `user:${string}`, id: string) {
  return JSON.stringify(createPersistedNavigationState(scope, {
    index: 1,
    routes: [
      { name: 'MainTabs', params: { screen: 'Schedule' } },
      {
        name: 'EventDetail',
        params: { eventRef: { sourceEventId: id, occurrenceDate: '2026-07-17' } },
      },
    ],
  }, Date.now()));
}

function Probe() {
  const { ready, initialState } = useNavigationStateRestoration();
  if (!ready || !initialState) return <Text testID="navigation-decision">waiting</Text>;
  const route = initialState.routes[initialState.index ?? initialState.routes.length - 1];
  return <Text testID="navigation-decision">{route.name}</Text>;
}

describe('NavigationStateProvider cold start and auth switching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps business routes and the splash behind the cold-start restore decision', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      initializing: false,
      mode: 'authenticated',
      session: { user: { id: 7 } },
    });
    const read = deferred<string | null>();
    const storage: NavigationStateStorage = {
      getItem: jest.fn(() => read.promise),
      setItem: jest.fn(async () => undefined),
      removeItem: jest.fn(async () => undefined),
    };
    const writer = new NavigationStateWriter({ storage });
    const view = await render(
      <NavigationStateProvider writer={writer}>
        <Probe />
        <AppReadinessGate><Text testID="business-route">business</Text></AppReadinessGate>
      </NavigationStateProvider>,
    );

    expect(view.getByTestId('navigation-decision').props.children).toBe('waiting');
    expect(view.queryByTestId('business-route')).toBeNull();
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(eventDetailRecord('user:7', 'cold-event'));
      await read.promise;
    });

    await waitFor(() => expect(view.getByTestId('navigation-decision').props.children).toBe('EventDetail'));
    expect(view.getByTestId('business-route')).toBeTruthy();
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });

  it('hides user A immediately and clears storage before mounting user B default state', async () => {
    let auth = {
      initializing: false,
      mode: 'authenticated' as const,
      session: { user: { id: 7 } },
    };
    (useAuth as jest.Mock).mockImplementation(() => auth);
    const clearing = deferred<void>();
    const storage: NavigationStateStorage = {
      getItem: jest.fn(async () => eventDetailRecord('user:7', 'user-a-event')),
      setItem: jest.fn(async () => undefined),
      removeItem: jest.fn(() => clearing.promise),
    };
    const writer = new NavigationStateWriter({ storage });
    const content = (key: string) => (
      <NavigationStateProvider key={key === 'same-provider' ? undefined : key} writer={writer}>
        <Probe />
      </NavigationStateProvider>
    );
    const view = await render(content('same-provider'));
    await waitFor(() => expect(view.getByTestId('navigation-decision').props.children).toBe('EventDetail'));

    auth = { ...auth, session: { user: { id: 8 } } };
    await act(async () => {
      view.rerender(content('same-provider'));
    });

    expect(view.getByTestId('navigation-decision').props.children).toBe('waiting');
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    await act(async () => {
      clearing.resolve();
      await clearing.promise;
    });
    await waitFor(() => expect(view.getByTestId('navigation-decision').props.children).toBe('MainTabs'));
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending navigation write when the app leaves the foreground', async () => {
    let appStateListener = (_state: string) => {};
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
    (useAuth as jest.Mock).mockReturnValue({
      initializing: false,
      mode: 'guest',
      session: null,
    });
    const storage: NavigationStateStorage = {
      getItem: jest.fn(async () => null),
      setItem: jest.fn(async () => undefined),
      removeItem: jest.fn(async () => undefined),
    };
    const writer = new NavigationStateWriter({ storage, debounceMs: 60_000 });
    const flush = jest.spyOn(writer, 'flush');
    const view = await render(
      <NavigationStateProvider writer={writer}>
        <Probe />
        <RestorableNavigationContainer><Text>route body</Text></RestorableNavigationContainer>
      </NavigationStateProvider>,
    );
    await waitFor(() => expect(view.getByTestId('navigation-decision').props.children).toBe('MainTabs'));
    flush.mockClear();

    await act(async () => {
      view.getByTestId('restorable-navigation-container').props.onStateChange({
        index: 1,
        routes: [
          { name: 'MainTabs', params: { screen: 'Schedule' } },
          { name: 'Transcription', params: { meetingId: 'background-meeting' } },
        ],
      });
      await Promise.resolve();
    });
    expect(storage.setItem).not.toHaveBeenCalled();

    await act(async () => {
      appStateListener('background');
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    expect(JSON.parse((storage.setItem as jest.Mock).mock.calls[0][1]).state.routes[1])
      .toMatchObject({ name: 'Transcription', params: { meetingId: 'background-meeting' } });
  });
});
