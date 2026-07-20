import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { AppReadinessGate } from '../src/components/AppReadinessGate';
import { useAuth } from '../src/store/AuthStore';
import { useNavigationStateRestoration } from '../src/navigation/NavigationStateCoordinator';

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/navigation/NavigationStateCoordinator', () => ({
  useNavigationStateRestoration: jest.fn(),
}));

describe('UI-BOOT-READINESS-001 AppReadinessGate', () => {
  let initializing = true;
  let navigationReady = false;

  beforeEach(() => {
    jest.clearAllMocks();
    initializing = true;
    navigationReady = false;
    (useAuth as jest.Mock).mockImplementation(() => ({ initializing }));
    (useNavigationStateRestoration as jest.Mock).mockImplementation(() => ({
      ready: navigationReady,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases the native splash into a visible loading surface before readiness completes', async () => {
    const view = await render(
      <AppReadinessGate onRetry={jest.fn()}>
        <Text>业务页</Text>
      </AppReadinessGate>,
    );

    expect(view.getByTestId('app-startup-loading')).toBeTruthy();
    expect(view.getByText('正在打开老记')).toBeTruthy();
    expect(view.queryByText('业务页')).toBeNull();
    await waitFor(() => expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1));

    initializing = false;
    navigationReady = true;
    await view.rerender(
      <AppReadinessGate onRetry={jest.fn()}>
        <Text>业务页</Text>
      </AppReadinessGate>,
    );

    expect(view.getByText('业务页')).toBeTruthy();
    expect(view.queryByTestId('app-startup-loading')).toBeNull();
  });

  it('bounds authentication restoration and retries the whole runtime tree', async () => {
    jest.useFakeTimers();
    const onRetry = jest.fn();
    const view = await render(
      <AppReadinessGate onRetry={onRetry} timeoutMs={50}>
        <Text>业务页</Text>
      </AppReadinessGate>,
    );

    await act(async () => {
      jest.advanceTimersByTime(50);
    });

    expect(view.getByTestId('app-startup-error')).toBeTruthy();
    expect(view.getByText('启动未完成')).toBeTruthy();
    expect(view.getByText('错误代码：LAOJI-START-AUTH')).toBeTruthy();
    fireEvent.press(view.getByLabelText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('identifies navigation restoration separately and recovers when it eventually finishes', async () => {
    jest.useFakeTimers();
    initializing = false;
    const view = await render(
      <AppReadinessGate onRetry={jest.fn()} timeoutMs={50}>
        <Text>业务页</Text>
      </AppReadinessGate>,
    );

    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(view.getByText('错误代码：LAOJI-START-NAV')).toBeTruthy();

    navigationReady = true;
    await view.rerender(
      <AppReadinessGate onRetry={jest.fn()} timeoutMs={50}>
        <Text>业务页</Text>
      </AppReadinessGate>,
    );
    expect(view.getByText('业务页')).toBeTruthy();
  });
});
