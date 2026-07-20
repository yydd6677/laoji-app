import React, { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import {
  AppStartupBoundary,
  AppStartupError,
} from '../src/components/AppStartupBoundary';
import {
  AppStartupStateView,
  UI_BOOT_READINESS_GEOMETRY,
} from '../src/components/AppStartupStateView';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));

describe('UI-BOOT-READINESS-001 AppStartupBoundary', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('turns a pre-mount configuration failure into a diagnosable recovery surface', async () => {
    function InvalidRuntime(): React.ReactNode {
      throw new AppStartupError('configuration', 'invalid configuration');
    }

    const view = await render(
      <AppStartupBoundary resetKey={0} onRetry={jest.fn()}>
        <InvalidRuntime />
      </AppStartupBoundary>,
    );

    expect(view.getByTestId('app-startup-error')).toBeTruthy();
    expect(view.getByText('错误代码：LAOJI-START-CONFIG')).toBeTruthy();
    await waitFor(() => expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1));
  });

  it('remounts the runtime tree after retry instead of leaving the error boundary latched', async () => {
    function FlakyRuntime({ failing }: { failing: boolean }) {
      if (failing) throw new Error('first render failed');
      return <Text>运行树已恢复</Text>;
    }
    function Harness() {
      const [generation, setGeneration] = useState(0);
      const [failing, setFailing] = useState(true);
      return (
        <AppStartupBoundary
          resetKey={generation}
          onRetry={() => {
            setFailing(false);
            setGeneration(value => value + 1);
          }}
        >
          <FlakyRuntime key={generation} failing={failing} />
        </AppStartupBoundary>
      );
    }

    const view = await render(<Harness />);
    expect(view.getByText('错误代码：LAOJI-START-RUNTIME')).toBeTruthy();
    fireEvent.press(view.getByLabelText('重试'));
    await waitFor(() => expect(view.getByText('运行树已恢复')).toBeTruthy());
  });

  it('keeps the source-derived 125dp state slot and 76x36dp retry action', async () => {
    const view = await render(
      <AppStartupStateView phase="error" failureStage="navigation" onRetry={jest.fn()} />,
    );
    const visual = view.getByTestId('app-startup-visual', { includeHiddenElements: true });
    expect(StyleSheet.flatten(visual.props.style)).toEqual(expect.objectContaining({
      width: UI_BOOT_READINESS_GEOMETRY.visualSize,
      height: UI_BOOT_READINESS_GEOMETRY.visualSize,
    }));
    const retryStyle = view.getByLabelText('重试').props.style;
    expect(StyleSheet.flatten(
      typeof retryStyle === 'function' ? retryStyle({ pressed: false }) : retryStyle,
    )).toEqual(
      expect.objectContaining({
        width: 76,
        height: 36,
      }),
    );
  });
});
