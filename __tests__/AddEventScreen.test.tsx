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
}));

describe('AddEventScreen edit reliability', () => {
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
      addEvent: jest.fn(),
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
});
