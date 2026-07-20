import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MainTabsNavigator } from '../src/navigation/MainTabs';

const mockEmit = jest.fn();
const mockNavigate = jest.fn();
const mockTabNavigation = {
  emit: mockEmit,
  navigate: mockNavigate,
};
let mockTabIndex = 0;
let mockNavigatorProps: Record<string, unknown> | undefined;

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/screens/ScheduleScreen', () => ({ ScheduleScreen: 'ScheduleScreen' }));
jest.mock('../src/screens/MeetingListScreen', () => ({ MeetingListScreen: 'MeetingListScreen' }));
jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: () => {
    const ReactModule = require('react');
    const ReactNative = require('react-native');
    return {
      Navigator: (props: Record<string, any>) => {
        mockNavigatorProps = props;
        const routes = [
          { key: 'schedule-key', name: 'Schedule' },
          { key: 'meetings-key', name: 'Meetings' },
        ];
        return ReactModule.createElement(
          ReactNative.View,
          { testID: 'mock-main-tabs' },
          props.children,
          props.tabBar({
            state: {
              stale: false,
              type: 'tab',
              key: 'main-tabs-key',
              index: mockTabIndex,
              routeNames: routes.map(route => route.name),
              history: [],
              routes,
            },
            descriptors: {},
            navigation: mockTabNavigation,
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          }),
        );
      },
      Screen: ({ name }: { name: string }) => ReactModule.createElement(
        ReactNative.Text,
        { testID: `mock-screen-${name}` },
        name,
      ),
    };
  },
}));

describe('MainTabsNavigator bottom-tab ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTabIndex = 0;
    mockNavigatorProps = undefined;
    mockEmit.mockReturnValue({ defaultPrevented: false });
  });

  it('renders one navigator-owned bar and emits a tab press when Schedule is reselected', async () => {
    await render(<MainTabsNavigator />);

    expect(screen.getAllByTestId('bottom-tab-bar')).toHaveLength(1);
    expect(mockNavigatorProps?.screenOptions).toEqual({ headerShown: false });
    expect(mockNavigatorProps?.tabBar).toEqual(expect.any(Function));
    expect(screen.queryByTestId('bottom-microphone-schedule')).toBeNull();
    expect(screen.getByLabelText('日程').props.accessibilityState).toEqual({ selected: true });

    await fireEvent.press(screen.getByTestId('bottom-tab-schedule'));

    expect(mockEmit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'schedule-key',
      canPreventDefault: true,
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('switches tabs and exposes the meeting recorder only on the meeting route', async () => {
    const view = await render(<MainTabsNavigator />);

    await fireEvent.press(screen.getByTestId('bottom-tab-meetings'));
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'meetings-key',
      canPreventDefault: true,
    });
    expect(mockNavigate).toHaveBeenCalledWith('Meetings', undefined);

    mockEmit.mockClear();
    mockNavigate.mockClear();
    mockTabIndex = 1;
    await view.rerender(<MainTabsNavigator />);

    expect(screen.getAllByTestId('bottom-tab-bar')).toHaveLength(1);
    expect(screen.getByLabelText('会议').props.accessibilityState).toEqual({ selected: true });
    await fireEvent.press(screen.getByTestId('bottom-microphone-meeting'));
    expect(mockNavigate).toHaveBeenCalledWith('MeetingLive');

    mockNavigate.mockClear();
    await fireEvent.press(screen.getByTestId('bottom-tab-schedule'));
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'schedule-key',
      canPreventDefault: true,
    });
    expect(mockNavigate).toHaveBeenCalledWith('Schedule', undefined);
  });
});
