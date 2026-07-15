import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ScheduleScreen } from '../src/screens/ScheduleScreen';
import { useEvents } from '../src/store/EventsStore';
import { useAuth } from '../src/store/AuthStore';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ Avatar: 'Avatar' }));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  getBottomTabBarFloatingTopInset: () => 85,
}));
jest.mock('../src/components/VoiceInputModal', () => ({ VoiceInputModal: 'VoiceInputModal' }));
jest.mock('../src/components/AppActionSheet', () => {
  const ReactModule = require('react');
  return {
    AppActionSheet: (props: Record<string, unknown>) => ReactModule.createElement(
      'AppActionSheet',
      { ...props, testID: 'schedule-create-sheet' },
    ),
  };
});
jest.mock('../src/components/MonthCalendarView', () => ({ MonthCalendarView: 'MonthCalendarView' }));
jest.mock('../src/components/DayTimelineView', () => ({ DayTimelineView: 'DayTimelineView' }));
jest.mock('../src/components/QuickDatePanel', () => {
  const ReactModule = require('react');
  return {
    QuickDatePanel: (props: Record<string, unknown>) => ReactModule.createElement(
      'QuickDatePanel',
      { ...props, testID: 'schedule-quick-date-panel' },
    ),
  };
});
jest.mock('../src/components/CalendarSearchPage', () => ({ CalendarSearchPage: 'CalendarSearchPage' }));

describe('Feishu-style schedule shell', () => {
  const refreshEvents = jest.fn(async () => ({ dataLoaded: true, reminderSyncConfirmed: true }));
  const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof ScheduleScreen>['navigation'];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 15, 9, 0));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ profile: {} });
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: null,
      refreshEvents,
    });
  });

  it('matches the source title and single-calendar tab geometry', async () => {
    await render(<ScheduleScreen navigation={navigation} />);

    expect(screen.getByText('2026年7月')).toBeTruthy();
    const title = StyleSheet.flatten(screen.getByText('2026年7月').props.style);
    expect(title).toEqual(expect.objectContaining({ fontSize: 24, lineHeight: 34, fontWeight: '700' }));

    expect(screen.getByTestId('schedule-search-icon').props.size).toBe(24);
    expect(screen.getByLabelText('搜索日程').props.hitSlop).toEqual({
      top: 10,
      bottom: 10,
      left: 10,
      right: 10,
    });
    expect(StyleSheet.flatten(screen.getByTestId('schedule-header-actions').props.style))
      .toEqual(expect.objectContaining({ width: 34, height: 48, alignItems: 'flex-end' }));

    expect(StyleSheet.flatten(screen.getByTestId('calendar-view-indicator').props.style))
      .toEqual(expect.objectContaining({ height: 50, paddingBottom: 10 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-view-tab').props.style))
      .toEqual(expect.objectContaining({ width: 60, height: 40 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-view-tab-label').props.style))
      .toEqual(expect.objectContaining({ fontSize: 14, lineHeight: 20, fontWeight: '400', color: '#1456F0' }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-view-tab-indicator').props.style))
      .toEqual(expect.objectContaining({ left: 0, right: 0, height: 2 }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-toggle-view').props.style))
      .toEqual(expect.objectContaining({ width: 32, height: 32, marginRight: 10 }));
  });

  it('toggles month and day views directly without opening a chooser', async () => {
    await render(<ScheduleScreen navigation={navigation} />);

    const toggle = screen.getByLabelText('切换到单日视图');
    expect(screen.getByTestId('calendar-toggle-view-icon').props.name).toBe('list-outline');
    await fireEvent.press(toggle);

    expect(screen.getByLabelText('切换到月视图')).toBeTruthy();
    expect(screen.getByTestId('calendar-toggle-view-icon').props.name).toBe('calendar-outline');
  });

  it('opens the top-left month title directly into the month-only picker', async () => {
    await render(<ScheduleScreen navigation={navigation} />);

    const panel = screen.getByTestId('schedule-quick-date-panel');
    expect(panel.props.mode).toBe('yearMonthOnly');
    expect(panel.props.top).toBe(100);
    expect(panel.props.visible).toBe(false);

    await fireEvent.press(screen.getByLabelText('选择年月'));
    expect(screen.getByTestId('schedule-quick-date-panel').props.visible).toBe(true);
    expect(screen.getByLabelText('收起年月选择')).toBeTruthy();
  });

  it('keeps a short create-button tap on the discoverable choice sheet', async () => {
    await render(<ScheduleScreen navigation={navigation} />);

    expect(screen.getByTestId('schedule-create-sheet').props.visible).toBe(false);
    await fireEvent.press(screen.getByLabelText('新建日程'));
    expect(screen.getByTestId('schedule-create-sheet').props.visible).toBe(true);
    expect(screen.getByTestId('schedule-create-sheet').props.items.map(
      (item: { label: string }) => item.label,
    )).toEqual(['语音输入', '手动新建']);
  });

  it('keeps search fixed and moves sync recovery into a non-layout-shifting toast', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: 'network unavailable',
      refreshEvents,
    });
    await render(<ScheduleScreen navigation={navigation} />);

    const headerActions = screen.getByTestId('schedule-header-actions');
    expect(within(headerActions).getByLabelText('搜索日程')).toBeTruthy();
    expect(within(headerActions).queryByLabelText('日程同步失败，点击重试')).toBeNull();

    const syncError = screen.getByTestId('calendar-sync-error');
    expect(StyleSheet.flatten(syncError.props.style)).toEqual(expect.objectContaining({
      minHeight: 40,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 20,
    }));
    await fireEvent.press(screen.getByLabelText('日程同步失败，点击重试'));
    expect(refreshEvents).toHaveBeenCalledWith(2026, 7);
  });
});
