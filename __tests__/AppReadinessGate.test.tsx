import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { AppReadinessGate } from '../src/components/AppReadinessGate';
import { useAuth } from '../src/store/AuthStore';
import { useNavigationStateRestoration } from '../src/navigation/NavigationStateCoordinator';

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/navigation/NavigationStateCoordinator', () => ({
  useNavigationStateRestoration: jest.fn(),
}));

describe('AppReadinessGate', () => {
  it('keeps the native launch screen until authentication and navigation restoration finish', async () => {
    let initializing = true;
    let navigationReady = false;
    (useAuth as jest.Mock).mockImplementation(() => ({ initializing }));
    (useNavigationStateRestoration as jest.Mock).mockImplementation(() => ({ ready: navigationReady }));
    const view = await render(
      <AppReadinessGate><Text>业务页</Text></AppReadinessGate>,
    );

    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    expect(view.queryByText('业务页')).toBeNull();

    initializing = false;
    await act(async () => {
      view.rerender(<AppReadinessGate><Text>业务页</Text></AppReadinessGate>);
    });

    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    expect(view.queryByText('业务页')).toBeNull();

    navigationReady = true;
    await act(async () => {
      view.rerender(<AppReadinessGate><Text>业务页</Text></AppReadinessGate>);
    });

    await waitFor(() => expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1));
    expect(view.getByText('业务页')).toBeTruthy();
  });
});
