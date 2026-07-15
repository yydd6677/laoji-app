import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import {
  BOTTOM_TAB_BAR_GEOMETRY,
  BottomTabBar,
  getBottomTabBarFloatingTopInset,
} from '../src/components/BottomTabBar';
import { EventUndoBanner } from '../src/components/EventUndoBanner';
import { useEvents } from '../src/store/EventsStore';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));

describe('bottom tab geometry', () => {
  beforeEach(() => {
    (useEvents as jest.Mock).mockReturnValue({
      lastDeleted: { title: '项目评审' },
      undoDelete: jest.fn(),
    });
  });

  it('derives content and overlay clearance from the compact action button', () => {
    expect(BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance)
      .toBe(
        BOTTOM_TAB_BAR_GEOMETRY.barHeight
          + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap
          + BOTTOM_TAB_BAR_GEOMETRY.micRadius,
      );
    expect(getBottomTabBarFloatingTopInset(0)).toBe(
      BOTTOM_TAB_BAR_GEOMETRY.barHeight
        + BOTTOM_TAB_BAR_GEOMETRY.minimumBottomFill
        + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap,
    );
    expect(getBottomTabBarFloatingTopInset(34)).toBe(
      BOTTOM_TAB_BAR_GEOMETRY.barHeight + 34 + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap,
    );
  });

  it('positions the undo banner above the full microphone footprint', async () => {
    await render(<EventUndoBanner />);

    const style = StyleSheet.flatten(screen.getByTestId('event-undo-banner').props.style);
    expect(style.bottom).toBe(
      getBottomTabBarFloatingTopInset(0) + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap,
    );
  });

  it('exposes tab selection and page-specific action purpose to accessibility services', async () => {
    await render(
      <BottomTabBar
        active="schedule"
        onSchedule={jest.fn()}
        onMeetings={jest.fn()}
        onMic={jest.fn()}
      />,
    );

    expect(screen.getByLabelText('日程').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByLabelText('会议').props.accessibilityState).toEqual({ selected: false });
    expect(screen.getByLabelText('新建日程')).toBeTruthy();
  });

  it('keeps a flat tab row with a compact right-side action', async () => {
    await render(
      <BottomTabBar
        active="schedule"
        onSchedule={jest.fn()}
        onMeetings={jest.fn()}
        onMic={jest.fn()}
      />,
    );

    const tabRow = StyleSheet.flatten(screen.getByTestId('bottom-tab-row').props.style);
    const action = StyleSheet.flatten(screen.getByTestId('bottom-microphone-schedule').props.style);
    const iconBox = StyleSheet.flatten(screen.getByTestId('bottom-tab-schedule-icon-box').props.style);
    const label = StyleSheet.flatten(screen.getByTestId('bottom-tab-schedule-label').props.style);
    expect(tabRow.height).toBe(BOTTOM_TAB_BAR_GEOMETRY.barHeight);
    expect(BOTTOM_TAB_BAR_GEOMETRY.barHeight).toBe(65);
    expect(iconBox).toEqual(expect.objectContaining({
      width: BOTTOM_TAB_BAR_GEOMETRY.tabIconContainerWidth,
      height: BOTTOM_TAB_BAR_GEOMETRY.tabIconContainerHeight,
      marginTop: BOTTOM_TAB_BAR_GEOMETRY.tabIconTop,
    }));
    expect(label).toEqual(expect.objectContaining({
      marginTop: BOTTOM_TAB_BAR_GEOMETRY.tabLabelGap,
      fontSize: BOTTOM_TAB_BAR_GEOMETRY.tabLabelSize,
      lineHeight: BOTTOM_TAB_BAR_GEOMETRY.tabLabelLineHeight,
      fontWeight: '400',
    }));
    expect(action.width).toBe(BOTTOM_TAB_BAR_GEOMETRY.micDiameter);
    expect(action.height).toBe(BOTTOM_TAB_BAR_GEOMETRY.micDiameter);
    expect(action.right).toBe(16);
  });

  it('uses the source tab icon press-and-return animation on every tab press', async () => {
    const onSchedule = jest.fn();
    await render(
      <BottomTabBar
        active="schedule"
        onSchedule={onSchedule}
        onMeetings={jest.fn()}
      />,
    );

    (Animated.timing as jest.Mock).mockClear();
    fireEvent.press(screen.getByTestId('bottom-tab-schedule'));

    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(Animated.timing).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      toValue: BOTTOM_TAB_BAR_GEOMETRY.tabPressScale,
      duration: BOTTOM_TAB_BAR_GEOMETRY.tabPressHalfDuration,
      useNativeDriver: true,
    }));
    expect(Animated.timing).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      toValue: 1,
      duration: BOTTOM_TAB_BAR_GEOMETRY.tabPressHalfDuration,
      useNativeDriver: true,
    }));
  });

  it('omits the floating action when the page supplies its own command', async () => {
    await render(
      <BottomTabBar
        active="meetings"
        onSchedule={jest.fn()}
        onMeetings={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('bottom-microphone-meeting')).toBeNull();
  });
});
