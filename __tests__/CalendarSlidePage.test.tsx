import React from 'react';
import { Animated, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { CalendarSlidePage } from '../src/components/CalendarSlidePage';

describe('CalendarSlidePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the source 800ms entrance and 300ms exit for vertical editor pages', async () => {
    const view = await render(
      <CalendarSlidePage visible direction="vertical" onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      duration: 800,
      toValue: 1,
      useNativeDriver: true,
    }));

    await view.rerender(
      <CalendarSlidePage visible={false} direction="vertical" onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    expect(Animated.timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      duration: 300,
      toValue: 0,
      useNativeDriver: true,
    }));
  });

  it('preserves an explicit shared transition duration', async () => {
    await render(
      <CalendarSlidePage visible duration={300} onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      duration: 300,
      toValue: 1,
      useNativeDriver: true,
    }));
  });

  it('supports the bottom-up transition used by repeat selection', async () => {
    const view = await render(
      <CalendarSlidePage visible direction="vertical" testID="vertical-page" onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    const transform = view.getByTestId('vertical-page').props.style[1].transform;
    expect(transform[0]).toHaveProperty('translateY');
    expect(transform[0]).not.toHaveProperty('translateX');
  });

  it('stops intercepting touch and accessibility as soon as exit begins', async () => {
    const view = await render(
      <CalendarSlidePage visible testID="sliding-page" onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    let finishExit: ((result: { finished: boolean }) => void) | undefined;
    (Animated.timing as jest.Mock).mockImplementationOnce(() => ({
      start: (callback?: (result: { finished: boolean }) => void) => { finishExit = callback; },
      stop: jest.fn(),
    }));

    await view.rerender(
      <CalendarSlidePage visible={false} testID="sliding-page" onRequestClose={jest.fn()}>
        <Text>内容</Text>
      </CalendarSlidePage>,
    );

    const exitingPage = view.getByTestId('sliding-page', { includeHiddenElements: true });
    expect(exitingPage.props.pointerEvents).toBe('none');
    expect(exitingPage.props.accessibilityViewIsModal).toBe(false);
    expect(exitingPage.props.accessibilityElementsHidden).toBe(true);
    expect(exitingPage.props.importantForAccessibility).toBe('no-hide-descendants');

    await act(() => finishExit?.({ finished: true }));
  });
});
