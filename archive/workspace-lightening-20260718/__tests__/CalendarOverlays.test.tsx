import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, BackHandler, PanResponder, StyleSheet } from 'react-native';
import { QuickDatePanel } from '../src/components/QuickDatePanel';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const noEvents: never[] = [];

describe('Feishu-style calendar overlays', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the quick date panel in 200ms and preserves its source geometry', async () => {
    const props = {
      top: 60,
      month: new Date(2026, 6, 1),
      selectedDate: new Date(2026, 6, 13),
      events: noEvents,
      onSelectDate: jest.fn(),
      onMonthChange: jest.fn(),
      onClose: jest.fn(),
    };
    const view = await render(<QuickDatePanel {...props} visible={false} />);
    await view.rerender(<QuickDatePanel {...props} visible />);

    const panel = await screen.findByTestId('quick-date-panel');
    const geometry = panel.props.style[1];
    expect(geometry).toEqual(expect.objectContaining({ top: 60, height: 313 }));
    const surfaceStyle = StyleSheet.flatten(screen.getByTestId('quick-date-panel-surface').props.style);
    const contentStyle = StyleSheet.flatten(screen.getByTestId('quick-date-panel-content-shell').props.style);
    const dividerStyle = StyleSheet.flatten(screen.getByTestId('quick-date-panel-top-divider').props.style);
    expect(surfaceStyle.bottom).toBe(15);
    expect(surfaceStyle.opacity).toBeDefined();
    expect(surfaceStyle.transform?.[0]).toHaveProperty('translateY');
    expect(contentStyle.opacity).toBeUndefined();
    expect(contentStyle.transform?.[0]).toHaveProperty('translateY');
    expect(dividerStyle.opacity).toBeDefined();
    expect(dividerStyle.transform).toBeUndefined();
    expect(screen.getByLabelText('收起日期选择').props.style.bottom).toBe(15);
    expect(screen.getByLabelText('上一个月').props.style[1]).toEqual({ width: 61 });
    expect(screen.getByLabelText('下一个月').props.style[1]).toEqual({ width: 37 });
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 200 && config.toValue === 1
    ))).toBe(true);
    const openingConfig = (Animated.timing as jest.Mock).mock.calls.find(([, config]) => (
      config.duration === 200 && config.toValue === 1
    ))?.[1];
    expect(openingConfig.easing(0.25)).toBeCloseTo(0.1464466, 6);

    await fireEvent.press(screen.getByLabelText('7月13日'));
    expect(props.onSelectDate).toHaveBeenCalledWith(new Date(2026, 6, 13));
  });

  it('pages the quick date grid horizontally like the source ViewPager2', async () => {
    const onMonthChange = jest.fn();
    await render(
      <QuickDatePanel
        visible
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={onMonthChange}
        onClose={jest.fn()}
      />,
    );

    const pager = screen.getByTestId('quick-date-month-pager');
    expect(pager.props.horizontal).toBe(true);
    expect(pager.props.pagingEnabled).toBe(true);
    expect(pager.props.accessibilityActions).toEqual([
      { name: 'decrement', label: '上一个月' },
      { name: 'increment', label: '下一个月' },
    ]);

    await fireEvent(pager, 'scrollBeginDrag');
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 780, y: 0 } },
    });
    await fireEvent(pager, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 780, y: 0 } },
    });
    expect(onMonthChange).toHaveBeenCalledTimes(1);
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2026, 7, 1));
  });

  it('closes the quick date panel when an upward drag is released', async () => {
    const onClose = jest.fn();
    await render(
      <QuickDatePanel
        visible
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={jest.fn()}
        onClose={onClose}
      />,
    );

    const config = (PanResponder.create as jest.Mock).mock.calls.at(-1)[0];
    expect(config.onMoveShouldSetPanResponder(null, { dx: 2, dy: -12 })).toBe(true);
    config.onPanResponderGrant();
    config.onPanResponderMove(null, { dx: 0, dy: -80 });
    config.onPanResponderRelease(null, { dx: 0, dy: -80 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches to the source-style year/month wheels in 150ms', async () => {
    const onMonthChange = jest.fn();
    await render(
      <QuickDatePanel
        visible
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={onMonthChange}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByTestId('quick-date-picker-toggle'));
    expect(screen.getByTestId('quick-date-picker-toggle').props.accessibilityState.expanded).toBe(true);
    expect(screen.getByTestId('quick-date-year-month-picker')).toBeTruthy();
    expect(screen.getByTestId('quick-date-year-wheel').props.accessibilityValue.text).toBe('2026年');
    expect(screen.getByTestId('quick-date-month-wheel').props.accessibilityValue.text).toBe('7月');
    expect((Animated.timing as jest.Mock).mock.calls.some(([, config]) => (
      config.duration === 150 && config.toValue === 1
    ))).toBe(true);

    expect(screen.getAllByLabelText('8月')).toHaveLength(1);
    await fireEvent.press(screen.getByLabelText('8月'));
    expect(onMonthChange).toHaveBeenCalledWith(new Date(2026, 7, 1));

    onMonthChange.mockClear();
    const monthWheel = screen.getByTestId('quick-date-month-wheel-scroll');
    await fireEvent(monthWheel, 'scrollBeginDrag');
    await fireEvent(monthWheel, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 0, y: 384 } },
    });
    await fireEvent(monthWheel, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 0, y: 384 } },
    });
    expect(onMonthChange).toHaveBeenCalledTimes(1);
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2026, 8, 1));
  });

  it('settles and commits both wheels when a slow drag ends without momentum', async () => {
    const onMonthChange = jest.fn();
    await render(
      <QuickDatePanel
        visible
        mode="yearMonthOnly"
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={onMonthChange}
        onClose={jest.fn()}
      />,
    );

    const yearWheel = screen.getByTestId('quick-date-year-wheel-scroll');
    await fireEvent(yearWheel, 'scrollBeginDrag');
    await fireEvent(yearWheel, 'scrollEndDrag', {
      nativeEvent: { contentOffset: { x: 0, y: 127 * 48 }, velocity: { x: 0, y: 0 } },
    });
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2027, 6, 1));

    onMonthChange.mockClear();
    const monthWheel = screen.getByTestId('quick-date-month-wheel-scroll');
    await fireEvent(monthWheel, 'scrollBeginDrag');
    await fireEvent(monthWheel, 'scrollEndDrag', {
      nativeEvent: { contentOffset: { x: 0, y: 31 * 48 }, velocity: { x: 0, y: 0 } },
    });
    expect(onMonthChange).toHaveBeenCalledTimes(1);
    expect(onMonthChange).toHaveBeenLastCalledWith(new Date(2026, 7, 1));
  });

  it('uses a full-screen dismiss layer, owns system back, and hides inactive picker pages', async () => {
    const onClose = jest.fn();
    const removeBackHandler = jest.fn();
    (BackHandler.addEventListener as jest.Mock).mockReturnValue({ remove: removeBackHandler });
    const view = await render(
      <QuickDatePanel
        visible
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={jest.fn()}
        onClose={onClose}
      />,
    );

    const overlay = screen.getByTestId('quick-date-overlay');
    expect(StyleSheet.flatten(overlay.props.style)).toEqual(expect.objectContaining({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }));
    expect(overlay.props.pointerEvents).toBe('auto');
    expect(overlay.props.accessibilityViewIsModal).toBe(true);
    expect(overlay.props.accessibilityElementsHidden).toBe(false);

    const dismissLayer = screen.getByTestId('quick-date-dismiss-layer');
    expect(StyleSheet.flatten(dismissLayer.props.style)).toEqual(expect.objectContaining({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }));
    await fireEvent.press(dismissLayer);
    expect(onClose).toHaveBeenCalledTimes(1);

    const backHandler = (BackHandler.addEventListener as jest.Mock).mock.calls.at(-1)[1];
    expect(backHandler()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);

    expect(screen.getByTestId('quick-date-date-content').props.accessibilityElementsHidden).toBe(false);
    expect(screen.getByTestId(
      'quick-date-year-month-content',
      { includeHiddenElements: true },
    ).props.accessibilityElementsHidden).toBe(true);
    await fireEvent.press(screen.getByTestId('quick-date-picker-toggle'));
    expect(screen.getByTestId(
      'quick-date-date-content',
      { includeHiddenElements: true },
    ).props.accessibilityElementsHidden).toBe(true);
    expect(screen.getByTestId('quick-date-year-month-content').props.accessibilityElementsHidden).toBe(false);

    await view.rerender(
      <QuickDatePanel
        visible={false}
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={jest.fn()}
        onClose={onClose}
      />,
    );
    expect(removeBackHandler).toHaveBeenCalledTimes(1);
  });

  it('opens the month-view title entry directly as the source month-only picker', async () => {
    const onMonthChange = jest.fn();
    await render(
      <QuickDatePanel
        visible
        mode="yearMonthOnly"
        top={60}
        month={new Date(2026, 6, 1)}
        selectedDate={new Date(2026, 6, 13)}
        events={noEvents}
        onSelectDate={jest.fn()}
        onMonthChange={onMonthChange}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('quick-date-panel').props.style[1]).toEqual({
      top: 60,
      height: 309,
    });
    expect(screen.queryByTestId('quick-date-picker-toggle')).toBeNull();
    expect(screen.queryByTestId('quick-date-month-pager')).toBeNull();
    expect(screen.getByTestId('quick-date-year-month-picker')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('quick-date-year-wheel').props.style))
      .toEqual(expect.objectContaining({ height: 240 }));
    expect(screen.getAllByLabelText('8月')).toHaveLength(1);

    await fireEvent.press(screen.getByLabelText('8月'));
    expect(onMonthChange).toHaveBeenCalledWith(new Date(2026, 7, 1));
  });
});
