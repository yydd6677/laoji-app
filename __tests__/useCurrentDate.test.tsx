import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  millisecondsUntilNextLocalDate,
  useCurrentDate,
} from '../src/hooks/useCurrentDate';

describe('useCurrentDate', () => {
  let appStateListener: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    appStateListener = null;
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('computes the next local midnight instead of a fixed 24-hour delay', () => {
    expect(millisecondsUntilNextLocalDate(new Date(2026, 6, 15, 23, 59, 59, 900))).toBe(150);
  });

  it('refreshes the displayed date on foreground transition', async () => {
    let now = new Date(2026, 6, 15, 23, 0);
    const clock = () => new Date(now);
    function Probe() {
      const date = useCurrentDate(clock);
      return <Text>{`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`}</Text>;
    }
    const view = await render(<Probe />);
    expect(view.getByText('2026-07-15')).toBeTruthy();

    now = new Date(2026, 6, 16, 8, 0);
    await act(async () => { appStateListener?.('active'); });

    await waitFor(() => expect(view.getByText('2026-07-16')).toBeTruthy());
  });

  it('refreshes after the local midnight timer fires', async () => {
    let now = new Date(2026, 6, 15, 23, 59, 59, 900);
    const clock = () => new Date(now);
    function Probe() {
      const date = useCurrentDate(clock);
      return <Text>{`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`}</Text>;
    }
    const view = await render(<Probe />);
    now = new Date(2026, 6, 16, 0, 0, 0, 100);

    await act(async () => { jest.advanceTimersByTime(150); });

    await waitFor(() => expect(view.getByText('2026-07-16')).toBeTruthy());
  });
});
