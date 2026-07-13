import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  BOTTOM_TAB_BAR_GEOMETRY,
  BottomTabBar,
  getBottomTabBarFloatingTopInset,
} from '../src/components/BottomTabBar';
import { EventUndoBanner } from '../src/components/EventUndoBanner';
import { useEvents } from '../src/store/EventsStore';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Path: 'Path',
  Rect: 'Rect',
}));
jest.mock('../src/components/VoiceInputModal', () => ({ VoiceInputModal: 'VoiceInputModal' }));
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

  it('derives scroll and overlay clearance from the floating microphone', () => {
    expect(BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance)
      .toBe(BOTTOM_TAB_BAR_GEOMETRY.micRadius + 16);
    expect(getBottomTabBarFloatingTopInset(0)).toBe(
      BOTTOM_TAB_BAR_GEOMETRY.barHeight
        + BOTTOM_TAB_BAR_GEOMETRY.minimumBottomFill
        + BOTTOM_TAB_BAR_GEOMETRY.micRadius,
    );
    expect(getBottomTabBarFloatingTopInset(34)).toBe(
      BOTTOM_TAB_BAR_GEOMETRY.barHeight + 34 + BOTTOM_TAB_BAR_GEOMETRY.micRadius,
    );
  });

  it('positions the undo banner above the full microphone footprint', async () => {
    await render(<EventUndoBanner />);

    const style = StyleSheet.flatten(screen.getByTestId('event-undo-banner').props.style);
    expect(style.bottom).toBe(
      getBottomTabBarFloatingTopInset(0) + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap,
    );
  });

  it('exposes tab selection and microphone purpose to accessibility services', async () => {
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
    expect(screen.getByLabelText('说出日程')).toBeTruthy();
  });

  it('reserves the floating microphone footprint outside screen content', async () => {
    await render(
      <BottomTabBar
        active="schedule"
        onSchedule={jest.fn()}
        onMeetings={jest.fn()}
        onMic={jest.fn()}
      />,
    );

    const outer = StyleSheet.flatten(screen.getByTestId('bottom-tab-bar').props.style);
    const tabRow = StyleSheet.flatten(screen.getByTestId('bottom-tab-row').props.style);
    const microphone = StyleSheet.flatten(screen.getByTestId('bottom-microphone-wrap').props.style);

    expect(outer.paddingTop).toBe(BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance);
    expect(tabRow.top).toBe(BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance);
    expect(microphone.top).toBe(
      BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance - BOTTOM_TAB_BAR_GEOMETRY.micRadius,
    );
  });
});
