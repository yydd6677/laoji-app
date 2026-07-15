import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { AppReadinessGate } from '../src/components/AppReadinessGate';
import { useAuth } from '../src/store/AuthStore';

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));

describe('AppReadinessGate', () => {
  it('keeps the native launch screen until authentication restoration finishes', async () => {
    let initializing = true;
    (useAuth as jest.Mock).mockImplementation(() => ({ initializing }));
    const view = await render(
      <AppReadinessGate><Text>业务页</Text></AppReadinessGate>,
    );

    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    initializing = false;
    await act(async () => {
      view.rerender(<AppReadinessGate><Text>业务页</Text></AppReadinessGate>);
    });

    await waitFor(() => expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1));
  });
});
