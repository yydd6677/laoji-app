import React from 'react';
import { Animated, Text } from 'react-native';
import { render } from '@testing-library/react-native';
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
});
