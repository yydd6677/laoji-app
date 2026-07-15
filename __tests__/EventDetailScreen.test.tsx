import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { EventDetailScreen } from '../src/screens/EventDetailScreen';
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
    params: { eventId: 'event-1' },
  } as React.ComponentProps<typeof EventDetailScreen>['route'];

  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(navigate).toHaveBeenCalledWith('AddEvent', { date: '2026-07-20', eventId: 'event-1' });
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
      title: '删除日程',
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

    const view = await render(<EventDetailScreen navigation={navigation} route={route} />);
    expect(view.getAllByText('历史复盘').length).toBeGreaterThan(0);
    expect(view.queryByText('日程不存在')).toBeNull();
    fireEvent.press(view.getByLabelText('编辑日程'));
    expect(navigate).toHaveBeenCalledWith('AddEvent', { date: '2025-03-08', eventId: 'event-1' });
  });
});
