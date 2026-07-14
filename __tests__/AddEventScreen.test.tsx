import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AddEventScreen } from '../src/screens/AddEventScreen';
import { useAuth } from '../src/store/AuthStore';
import { useEvents } from '../src/store/EventsStore';

const mockShowDialog = jest.fn();

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/store/EventsStore', () => ({
  checkConflict: jest.fn(() => ({ hasConflict: false, conflicts: [] })),
  useEvents: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  DEFAULT_REMINDER_MINUTES: 15,
  REMINDER_OPTIONS: [
    { value: null, label: '不提醒' },
    { value: 15, label: '提前15分钟' },
  ],
  defaultReminderForEvent: jest.fn(() => 15),
  loadNotificationPrefs: jest.fn(async () => ({ defaultReminderMinutes: 15 })),
  reminderUnavailableMessage: jest.fn(async () => '系统通知已开启，但本机提醒创建失败。请重新打开日程并保存提醒。'),
}));

describe('AddEventScreen save reliability', () => {
  const addEvent = jest.fn();
  const updateEvent = jest.fn();
  const refreshEvents = jest.fn();
  const navigation = {
    goBack: jest.fn(),
  } as unknown as React.ComponentProps<typeof AddEventScreen>['navigation'];
  const route = {
    key: 'edit-event',
    name: 'AddEvent' as const,
    params: { eventId: 'event-1' },
  } as React.ComponentProps<typeof AddEventScreen>['route'];

  beforeEach(() => {
    jest.clearAllMocks();
    addEvent.mockResolvedValue({ reminderDelivery: 'not-required' });
    updateEvent.mockResolvedValue({ reminderDelivery: 'unconfirmed' });
    refreshEvents.mockResolvedValue({ dataLoaded: true, reminderSyncConfirmed: true });
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 7 } },
    });
    (useEvents as jest.Mock).mockReturnValue({
      events: [{
        id: 'event-1',
        title: '项目评审',
        startDate: '2026-07-20',
        startTime: '10:00',
        endTime: '11:00',
        category: '工作',
        reminderMinutes: 15,
        color: '#5B8CFF',
      }],
      addEvent,
      updateEvent,
      refreshEvents,
    });
  });

  it('uses the store edit result without issuing a duplicate screen refresh', async () => {
    const view = await render(<AddEventScreen navigation={navigation} route={route} />);

    expect(view.getByTestId('event-save').props.accessibilityLabel).toBe('保存日程修改');
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({ title: '项目评审', startDate: '2026-07-20' }),
    ));
    expect(refreshEvents).not.toHaveBeenCalled();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenCalledWith({
      title: '日程已保存',
      message: '本机提醒状态未能确认，可重新打开日程并保存提醒。',
      tone: 'warning',
    });
  });

  it('uses the store create result without issuing a duplicate screen refresh', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
    });
    const createRoute = {
      key: 'create-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.changeText(view.getByPlaceholderText('添加标题'), '新的日程');
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '新的日程',
      startDate: '2026-07-20',
      clientRequestId: expect.any(String),
    })));
    expect(refreshEvents).not.toHaveBeenCalled();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('saves a manually created all-day event without requiring clock times', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
    });
    const createRoute = {
      key: 'create-all-day-event',
      name: 'AddEvent' as const,
      params: { date: '2026-07-20' },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={createRoute} />);

    await fireEvent.changeText(view.getByPlaceholderText('添加标题'), '提交材料');
    expect(view.getByTestId('event-all-day-toggle').props.accessibilityState.checked).toBe(false);
    await fireEvent.press(view.getByTestId('event-all-day-toggle'));
    expect(view.getByTestId('event-all-day-toggle').props.accessibilityState.checked).toBe(true);
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '提交材料',
      startDate: '2026-07-20',
      startTime: undefined,
      endTime: undefined,
      isAllDay: true,
    })));
  });

  it('prefills the full form from a parsed voice draft and preserves parser metadata', async () => {
    (useEvents as jest.Mock).mockReturnValue({
      events: [],
      addEvent,
      updateEvent,
      refreshEvents,
    });
    const draftRoute = {
      key: 'create-from-voice-draft',
      name: 'AddEvent' as const,
      params: {
        draft: {
          title: '跨部门评审',
          startDate: '2026-07-20',
          endDate: '2026-07-21',
          startTime: '15:00',
          endTime: '16:30',
          isAllDay: false,
          repeat: 'weekly' as const,
          description: '核对风险',
          rawText: '下周一到周二下午开跨部门评审',
          location: '三楼会议室',
          category: '工作' as const,
          detail: '携带材料',
          status: '待确认',
          reminderMinutes: 15,
        },
      },
    } as React.ComponentProps<typeof AddEventScreen>['route'];
    const view = await render(<AddEventScreen navigation={navigation} route={draftRoute} />);

    expect(view.getByPlaceholderText('添加标题').props.value).toBe('跨部门评审');
    expect(view.getByPlaceholderText('添加地点').props.value).toBe('三楼会议室');
    expect(view.getByPlaceholderText('添加备注').props.value).toBe('核对风险');
    expect(view.getByText('2026-07-20')).toBeTruthy();
    expect(view.getByText('2026-07-21')).toBeTruthy();
    await fireEvent.press(view.getByTestId('event-save'));

    await waitFor(() => expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '跨部门评审',
      startDate: '2026-07-20',
      endDate: '2026-07-21',
      startTime: '15:00',
      endTime: '16:30',
      repeat: 'weekly',
      description: '核对风险',
      rawText: '下周一到周二下午开跨部门评审',
      location: '三楼会议室',
      category: '工作',
      detail: '携带材料',
      status: '待确认',
      reminderMinutes: 15,
    })));
  });
});
