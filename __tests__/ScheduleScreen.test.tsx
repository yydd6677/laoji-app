import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { ScheduleScreen } from '../src/screens/ScheduleScreen';
import { getAppStorageItem, setAppStorageItem } from '../src/services/appStorage';
import { useEvents } from '../src/store/EventsStore';
import { useAuth } from '../src/store/AuthStore';
import { useAppDialog } from '../src/components/AppDialog';
import { BOTTOM_TAB_BAR_GEOMETRY } from '../src/components/BottomTabBar';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({ useAppDialog: jest.fn() }));
jest.mock('../src/services/appStorage', () => ({
  getAppStorageItem: jest.fn(),
  setAppStorageItem: jest.fn(),
}));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ Avatar: 'Avatar' }));
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
jest.mock('../src/components/MonthCalendarView', () => {
  const ReactModule = require('react');
  return {
    MonthCalendarView: (props: Record<string, unknown>) => ReactModule.createElement(
      'MonthCalendarView',
      { ...props, testID: 'schedule-month-view' },
    ),
  };
});
jest.mock('../src/components/DayTimelineView', () => {
  const ReactModule = require('react');
  return {
    DayTimelineView: (props: Record<string, unknown>) => ReactModule.createElement(
      'DayTimelineView',
      { ...props, testID: 'schedule-day-view' },
    ),
  };
});
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
  const updateEvent = jest.fn(async () => ({ reminderDelivery: 'not-required' }));
  const findConflicts = jest.fn(async () => ({
    hasConflict: false,
    conflicts: [],
    complete: true,
    coverage: {
      status: 'complete',
      fromDate: '2026-07-15',
      throughDate: '2026-07-15',
      completeForSeries: true,
    },
    invalidCandidateCount: 0,
  }));
  const showDialog = jest.fn();
  const dismissCacheRecoveryNotice = jest.fn(async () => undefined);
  const navigate = jest.fn();
  const addListener = jest.fn();
  let tabPressListener: (() => void) | undefined;
  const navigation = { navigate, addListener } as unknown as React.ComponentProps<typeof ScheduleScreen>['navigation'];

  const renderRestoredSchedule = async () => {
    const view = await render(<ScheduleScreen navigation={navigation} />);
    await waitFor(() => expect(screen.queryByTestId('schedule-view-loading')).toBeNull());
    return view;
  };

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 15, 9, 0));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tabPressListener = undefined;
    addListener.mockImplementation((eventName: string, listener: () => void) => {
      if (eventName === 'tabPress') tabPressListener = listener;
      return jest.fn();
    });
    (getAppStorageItem as jest.Mock).mockResolvedValue(null);
    (setAppStorageItem as jest.Mock).mockResolvedValue(undefined);
    (useIsFocused as jest.Mock).mockReturnValue(true);
    (useAppDialog as jest.Mock).mockReturnValue({ showDialog });
    (useAuth as jest.Mock).mockReturnValue({
      initializing: false,
      mode: 'guest',
      session: null,
      profile: {},
    });
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: null,
      monthStates: {},
      cacheRecoveryNotice: null,
      dismissCacheRecoveryNotice,
      updateEvent,
      findConflicts,
      refreshEvents,
    });
  });

  it('saves a timeline gesture through the range conflict and repository contracts', async () => {
    await renderRestoredSchedule();
    await fireEvent.press(screen.getByLabelText('切换到单日视图'));
    const dayView = screen.getByTestId('schedule-day-view');
    const event = {
      id: '42',
      title: '评审',
      startDate: '2026-07-15',
      startTime: '10:00',
      endTime: '11:00',
      color: '#1456F0',
      repeat: 'once' as const,
    };
    const changes = {
      startDate: '2026-07-15',
      endDate: undefined,
      startTime: '10:15',
      endTime: '11:15',
    };

    await expect(dayView.props.onChangeEventTime(event, changes)).resolves.toBe(true);

    expect(findConflicts).toHaveBeenCalledWith(
      expect.objectContaining(changes),
      { sourceEventId: '42', occurrenceDate: '2026-07-15' },
      'series',
    );
    expect(updateEvent).toHaveBeenCalledWith(
      { sourceEventId: '42', occurrenceDate: '2026-07-15' },
      changes,
      'series',
    );
  });

  it('uses the chosen recurrence scope for both gesture conflicts and the edit transaction', async () => {
    await renderRestoredSchedule();
    await fireEvent.press(screen.getByLabelText('切换到单日视图'));
    const dayView = screen.getByTestId('schedule-day-view');
    const event = {
      id: 'series@2026-07-15',
      sourceEventId: 'series',
      occurrenceDate: '2026-07-15',
      title: '周会',
      startDate: '2026-07-15',
      startTime: '10:00',
      endTime: '11:00',
      color: '#1456F0',
      repeat: 'weekly' as const,
    };
    const changes = {
      startDate: '2026-07-15',
      endDate: undefined,
      startTime: '10:30',
      endTime: '11:30',
    };

    const pending = dayView.props.onChangeEventTime(event, changes);
    await waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
    const scopeDialog = showDialog.mock.calls[0][0];
    await scopeDialog.actions.find((action: { text: string }) => action.text === '修改此后日程').onPress();
    await expect(pending).resolves.toBe(true);

    expect(findConflicts).toHaveBeenCalledWith(
      expect.objectContaining(changes),
      { sourceEventId: 'series', occurrenceDate: '2026-07-15' },
      'following',
    );
    expect(updateEvent).toHaveBeenCalledWith(
      { sourceEventId: 'series', occurrenceDate: '2026-07-15' },
      changes,
      'following',
    );
  });

  it('matches the source title and single-calendar tab geometry', async () => {
    await renderRestoredSchedule();

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
    await renderRestoredSchedule();

    const toggle = screen.getByLabelText('切换到单日视图');
    expect(screen.getByTestId('calendar-toggle-view-icon').props.name).toBe('list-outline');
    await fireEvent.press(toggle);

    expect(screen.getByLabelText('切换到月视图')).toBeTruthy();
    expect(screen.getByTestId('calendar-toggle-view-icon').props.name).toBe('calendar-outline');
    expect(setAppStorageItem).toHaveBeenCalledWith(
      '@laoji:scheduleViewMode:v1:guest',
      'day',
    );
  });

  it('opens the top-left month title directly into the month-only picker', async () => {
    await renderRestoredSchedule();

    const panel = screen.getByTestId('schedule-quick-date-panel');
    expect(panel.props.mode).toBe('yearMonthOnly');
    expect(panel.props.top).toBe(100);
    expect(panel.props.visible).toBe(false);

    await fireEvent.press(screen.getByLabelText('选择年月'));
    expect(screen.getByTestId('schedule-quick-date-panel').props.visible).toBe(true);
    expect(screen.getByLabelText(
      '收起年月选择',
      { includeHiddenElements: true },
    )).toBeTruthy();
  });

  it('keeps a short create-button tap on the discoverable choice sheet', async () => {
    await renderRestoredSchedule();

    expect(screen.queryByTestId('bottom-tab-bar')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('calendar-create-cluster').props.style))
      .toEqual(expect.objectContaining({
        bottom: BOTTOM_TAB_BAR_GEOMETRY.sceneActionBottom,
      }));
    expect(screen.getByTestId('schedule-create-sheet').props.visible).toBe(false);
    await fireEvent.press(screen.getByLabelText('新建日程'));
    expect(screen.getByTestId('schedule-create-sheet').props.visible).toBe(true);
    expect(screen.getByTestId('schedule-create-sheet').props.items.map(
      (item: { label: string }) => item.label,
    )).toEqual(['语音输入', '手动新建']);
  });

  it('returns the focused schedule route to today on a repeated tab press', async () => {
    await renderRestoredSchedule();
    const monthView = screen.getByTestId('schedule-month-view');

    await act(() => monthView.props.onSelectDate(new Date(2026, 9, 3)));
    expect(screen.getByText('2026年10月')).toBeTruthy();
    expect(addListener).toHaveBeenCalledWith('tabPress', expect.any(Function));

    await act(() => tabPressListener?.());
    expect(screen.getByText('2026年7月')).toBeTruthy();
  });

  it('keeps search fixed and moves sync recovery into a non-layout-shifting toast', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: 'network unavailable',
      monthStates: {
        '2026-07': { status: 'error', error: 'network unavailable' },
      },
      refreshEvents,
    });
    await renderRestoredSchedule();

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

  it('keeps adjacent-month prefetch state out of the visible month feedback', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: 'adjacent requests failed',
      monthStates: {
        '2026-06': { status: 'error', error: 'June unavailable' },
        '2026-07': { status: 'loaded', error: null },
        '2026-08': { status: 'loading', error: null },
      },
      cacheRecoveryNotice: null,
      dismissCacheRecoveryNotice,
      refreshEvents,
    });

    await renderRestoredSchedule();

    expect(screen.queryByTestId('calendar-sync-error')).toBeNull();
    expect(screen.queryByTestId('calendar-visible-month-loading')).toBeNull();
  });

  it('shows a non-layout-shifting loader only while the empty visible month loads', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: null,
      monthStates: {
        '2026-07': { status: 'loading', error: null },
      },
      cacheRecoveryNotice: null,
      dismissCacheRecoveryNotice,
      refreshEvents,
    });

    await renderRestoredSchedule();

    const loader = screen.getByTestId('calendar-visible-month-loading');
    expect(loader.props.pointerEvents).toBe('none');
    expect(StyleSheet.flatten(loader.props.style)).toEqual(expect.objectContaining({
      position: 'absolute',
      zIndex: 2,
    }));
  });

  it('shows cache recovery in a fixed overlay and dismisses its durable marker explicitly', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [],
      error: null,
      cacheRecoveryNotice: { detectedAt: Date.now(), kinds: ['months'] },
      dismissCacheRecoveryNotice,
      refreshEvents,
    });
    await renderRestoredSchedule();

    const notice = screen.getByTestId('calendar-cache-recovery');
    expect(StyleSheet.flatten(notice.props.style)).toEqual(expect.objectContaining({
      minHeight: 48,
      borderRadius: 4,
    }));
    await fireEvent.press(screen.getByLabelText('关闭缓存恢复提示'));
    expect(dismissCacheRecoveryNotice).toHaveBeenCalledTimes(1);
  });

  it('restores a scoped day view before exposing either calendar mode', async () => {
    let resolveStoredMode: (value: string | null) => void = () => undefined;
    (getAppStorageItem as jest.Mock).mockReturnValue(new Promise<string | null>(resolve => {
      resolveStoredMode = resolve;
    }));

    await render(<ScheduleScreen navigation={navigation} />);

    expect(getAppStorageItem).toHaveBeenCalledWith('@laoji:scheduleViewMode:v1:guest');
    expect(screen.getByTestId('schedule-view-loading')).toBeTruthy();
    expect(screen.queryByTestId('schedule-month-view')).toBeNull();
    expect(screen.queryByTestId('schedule-day-view')).toBeNull();
    expect(screen.queryByTestId('calendar-toggle-view-icon')).toBeNull();

    await act(async () => {
      resolveStoredMode('day');
      await Promise.resolve();
    });

    expect(screen.queryByTestId('schedule-view-loading')).toBeNull();
    expect(screen.getByTestId('schedule-day-view')).toBeTruthy();
    expect(screen.queryByTestId('schedule-month-view')).toBeNull();
  });

  it('reloads view mode per account scope without showing the previous scope mode', async () => {
    let resolveUserMode: (value: string | null) => void = () => undefined;
    (getAppStorageItem as jest.Mock).mockImplementation((key: string) => (
      key.endsWith(':guest')
        ? Promise.resolve('day')
        : new Promise<string | null>(resolve => {
          resolveUserMode = resolve;
        })
    ));
    const view = await renderRestoredSchedule();
    expect(screen.getByTestId('schedule-day-view')).toBeTruthy();

    (useAuth as jest.Mock).mockReturnValue({
      initializing: false,
      mode: 'authenticated',
      session: { user: { id: 7 } },
      profile: {},
    });
    await view.rerender(<ScheduleScreen navigation={navigation} />);

    expect(screen.getByTestId('schedule-view-loading')).toBeTruthy();
    expect(screen.queryByTestId('schedule-day-view')).toBeNull();
    expect(screen.queryByTestId('schedule-month-view')).toBeNull();

    await act(async () => {
      resolveUserMode('month');
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('schedule-month-view')).toBeTruthy());
    expect(getAppStorageItem).toHaveBeenLastCalledWith('@laoji:scheduleViewMode:v1:user:7');
  });

  it('hides and closes calendar overlays when the schedule route loses focus', async () => {
    const view = await renderRestoredSchedule();
    await fireEvent.press(screen.getByLabelText('选择年月'));
    expect(screen.getByTestId('schedule-quick-date-panel').props.visible).toBe(true);

    (useIsFocused as jest.Mock).mockReturnValue(false);
    await view.rerender(<ScheduleScreen navigation={navigation} />);

    expect(screen.getByTestId('schedule-quick-date-panel').props.visible).toBe(false);
    const hiddenContent = screen.getByTestId(
      'schedule-main-content',
      { includeHiddenElements: true },
    );
    expect(hiddenContent.props.accessibilityElementsHidden).toBe(true);
    expect(hiddenContent.props.pointerEvents).toBe('none');
  });
});
