import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';
import {
  EventDetailScreen,
  resolveHeaderSnapTarget,
} from '../src/screens/EventDetailScreen';
import { useEvents } from '../src/store/EventsStore';

const mockShowDialog = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/services/notifications', () => ({
  labelForReminder: (value: number) => `提前${value}分钟`,
}));

describe('EventDetailScreen source-aligned structure', () => {
  const navigate = jest.fn();
  const goBack = jest.fn();
  const navigation = { navigate, goBack } as unknown as React.ComponentProps<typeof EventDetailScreen>['navigation'];
  const route = {
    key: 'event-detail',
    name: 'EventDetail' as const,
    params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-20' } },
  } as React.ComponentProps<typeof EventDetailScreen>['route'];

  beforeEach(() => {
    jest.clearAllMocks();
    (useWindowDimensions as jest.Mock).mockReturnValue({ width: 390, height: 844 });
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'event-1',
        title: '项目评审',
        startDate: '2026-07-20',
        endDate: '2026-07-21',
        startTime: '10:00',
        endTime: '11:00',
        repeat: 'weekly',
        reminderMinutes: 15,
        location: '三楼会议室',
        description: '核对风险项',
      }],
      deleteEvent: jest.fn(),
    });
  });

  it('uses icon actions and source detail zones without the legacy page title', async () => {
    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);

    expect(view.queryByText('日程详情')).toBeNull();
    expect(view.getByLabelText('编辑日程')).toBeTruthy();
    expect(view.getByLabelText('删除日程')).toBeTruthy();
    expect(view.getByText('7月20日 周一 10:00 - 7月21日 周二 11:00')).toBeTruthy();
    expect(view.getByText('每周重复')).toBeTruthy();
    expect(view.getByText('提前15分钟')).toBeTruthy();
    expect(view.getByText('三楼会议室')).toBeTruthy();
    expect(view.getByText('核对风险项')).toBeTruthy();

    const body = view.getByTestId('event-detail-body');
    expect(body.children.map(child => typeof child === 'string' ? child : child.props.testID)).toEqual([
      'event-detail-location-row',
      'event-detail-description-row',
      'event-detail-reminder-row',
    ]);

    fireEvent.press(view.getByLabelText('编辑日程'));
    const editDialog = mockShowDialog.mock.calls.at(-1)?.[0];
    expect(editDialog).toEqual(expect.objectContaining({ title: '修改重复日程' }));
    editDialog.actions[0].onPress();
    expect(navigate).toHaveBeenCalledWith('AddEvent', {
      date: '2026-07-20',
      eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-20' },
      recurrenceScope: 'occurrence',
    });
  });

  it('uses source header geometry and the 0-40-70dp cross-fade thresholds', async () => {
    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);

    await act(async () => {
      view.getByTestId('event-detail-header').props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 116 } },
      });
    });

    expect(view.getByTestId('event-detail-color')).toHaveStyle({
      width: 14,
      height: 14,
      borderRadius: 4,
      backgroundColor: '#0442D2',
    });
    expect(view.getByTestId('event-detail-time')).toHaveStyle({
      color: '#0442D2',
      marginLeft: 32,
    });
    expect(view.getByTestId('calendar-detail-collapsed-title')).toHaveStyle({
      left: 44,
      right: 130,
      textAlign: 'left',
      fontWeight: '400',
      color: '#0442D2',
    });
    expect(view.getByTestId('event-detail-header-wash')).toHaveStyle({
      height: 160,
    });

    const summaryOpacity = StyleSheet.flatten(
      view.getByTestId('event-detail-summary-row').props.style,
    ).opacity;
    const metaOpacity = StyleSheet.flatten(view.getByTestId('event-detail-time').props.style).opacity;
    const titleOpacity = StyleSheet.flatten(
      view.getByTestId('calendar-detail-collapsed-title').props.style,
    ).opacity;
    expect(summaryOpacity.config.inputRange).toEqual([0, 40]);
    expect(metaOpacity.config.inputRange).toEqual([0, 116]);
    expect(titleOpacity.config.inputRange).toEqual([40, 70]);
  });

  it('enables Android nested scrolling for the detail content', async () => {
    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);
    expect(view.getByTestId('event-detail-scroll').props.nestedScrollEnabled).toBe(true);
  });

  it.each([
    { viewport: { width: 320, height: 568 }, expectedWidth: '100%', expectedMaxWidth: undefined },
    { viewport: { width: 640, height: 360 }, expectedWidth: 608, expectedMaxWidth: 720 },
  ])('keeps the title bar and reachable detail rows in one frame at $viewport.width x $viewport.height', async ({
    viewport,
    expectedWidth,
    expectedMaxWidth,
  }) => {
    (useWindowDimensions as jest.Mock).mockReturnValue(viewport);
    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);
    const frame = view.getByTestId('event-detail-content-frame');
    const frameStyle = StyleSheet.flatten(frame.props.style);
    const framedContent = within(frame);
    const scroll = framedContent.getByTestId('event-detail-scroll');
    const scrollContent = within(scroll);

    expect(frameStyle).toEqual(expect.objectContaining({
      flex: 1,
      width: expectedWidth,
      alignSelf: 'center',
    }));
    expect(frameStyle.maxWidth).toBe(expectedMaxWidth);
    expect(framedContent.getByLabelText('编辑日程')).toBeTruthy();
    expect(framedContent.getByLabelText('删除日程')).toBeTruthy();
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    expect(scrollContent.getByTestId('event-detail-header')).toBeTruthy();
    expect(scrollContent.getByTestId('event-detail-location-row')).toBeTruthy();
    expect(scrollContent.getByTestId('event-detail-description-row')).toBeTruthy();
    expect(scrollContent.getByTestId('event-detail-reminder-row')).toBeTruthy();
    expect(StyleSheet.flatten(view.getByTestId('event-detail-header-wash').props.style)).toEqual(
      expect.objectContaining({ position: 'absolute', left: 0, right: 0 }),
    );
  });

  it('shows date-only and all-day ranges without inventing a separate time row', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'event-1',
        title: '整理材料',
        startDate: '2026-07-20',
        reminderMinutes: null,
      }],
      deleteEvent: jest.fn(),
    });
    const dateOnly = await render(<EventDetailScreen navigation={navigation} route={route} />);
    expect(dateOnly.getByText('7月20日 周一')).toBeTruthy();
    expect(dateOnly.queryByText('全天')).toBeNull();
    expect(dateOnly.queryByText('不提醒')).toBeNull();
    expect(dateOnly.queryByTestId('event-detail-reminder-row')).toBeNull();

    await dateOnly.unmount();
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'event-1',
        title: '外出培训',
        startDate: '2026-07-20',
        endDate: '2026-07-21',
        isAllDay: true,
        reminderMinutes: null,
      }],
      deleteEvent: jest.fn(),
    });
    const allDay = await render(<EventDetailScreen navigation={navigation} route={route} />);
    expect(allDay.getByText('7月20日 周一 - 7月21日 周二')).toBeTruthy();
    expect(allDay.queryByText('全天')).toBeNull();
  });

  it('keeps deletion behind the custom confirmation dialog', async () => {
    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);
    fireEvent.press(view.getByLabelText('删除日程'));
    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除重复日程',
      tone: 'danger',
    }));
  });

  it('opens a global search result that is outside the loaded month window', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      searchableEvents: [{
        id: 'event-1',
        title: '历史复盘',
        startDate: '2025-03-08',
        startTime: '14:00',
        endTime: '15:00',
      }],
      deleteEvent: jest.fn(),
    });

    const searchRoute = {
      ...route,
      params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2025-03-08' } },
    } as React.ComponentProps<typeof EventDetailScreen>['route'];
    const view = await render(<EventDetailScreen navigation={navigation} route={searchRoute} />);
    expect(view.getAllByText('历史复盘').length).toBeGreaterThan(0);
    expect(view.queryByText('日程不存在')).toBeNull();
    fireEvent.press(view.getByLabelText('编辑日程'));
    expect(navigate).toHaveBeenCalledWith('AddEvent', {
      date: '2025-03-08',
      eventRef: { sourceEventId: 'event-1', occurrenceDate: '2025-03-08' },
      recurrenceScope: 'series',
    });
  });
});

describe('event detail header snap contract', () => {
  const scrollableMetrics = {
    headerHeight: 116,
    contentHeight: 900,
    viewportHeight: 700,
  };

  it('uses the header midpoint for a low-speed release in either half', () => {
    expect(resolveHeaderSnapTarget({
      ...scrollableMetrics,
      offsetY: 40,
      releaseVelocityY: 0.1,
    })).toBe(0);
    expect(resolveHeaderSnapTarget({
      ...scrollableMetrics,
      offsetY: 70,
      releaseVelocityY: -0.1,
    })).toBe(116);
  });

  it('uses the gesture direction for an obvious vertical fling', () => {
    expect(resolveHeaderSnapTarget({
      ...scrollableMetrics,
      offsetY: 30,
      releaseVelocityY: -0.5,
    })).toBe(116);
    expect(resolveHeaderSnapTarget({
      ...scrollableMetrics,
      offsetY: 90,
      releaseVelocityY: 0.5,
    })).toBe(0);
  });

  it('does not pull back after the collapse region or when content cannot fully collapse', () => {
    expect(resolveHeaderSnapTarget({
      ...scrollableMetrics,
      offsetY: 150,
      releaseVelocityY: 0,
    })).toBeNull();
    expect(resolveHeaderSnapTarget({
      offsetY: 70,
      releaseVelocityY: 0,
      headerHeight: 116,
      contentHeight: 760,
      viewportHeight: 700,
    })).toBeNull();
  });
});
