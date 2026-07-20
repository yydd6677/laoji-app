import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { MainTabsNavigator } from '../src/navigation/MainTabs.android';

let mockScheduleMounts = 0;
let mockScheduleUnmounts = 0;

jest.mock('../src/screens/ScheduleScreen.android', () => ({
  ScheduleScreen: ({ onTabPress, bottomBarSelectionCommand }: any) => {
    React.useEffect(() => {
      mockScheduleMounts += 1;
      return () => {
        mockScheduleUnmounts += 1;
      };
    }, []);
    return (
      <View testID="schedule-screen">
        <Text testID="schedule-selection-command">{String(bottomBarSelectionCommand)}</Text>
        <Pressable
          testID="press-schedule"
          onPress={() => onTabPress({ nativeEvent: { type: 'tabPress', tab: 'schedule' } })}
        />
        <Pressable
          testID="press-meetings"
          onPress={() => onTabPress({ nativeEvent: { type: 'tabPress', tab: 'meetings' } })}
        />
      </View>
    );
  },
}));

jest.mock('../src/screens/MeetingListScreen.android', () => ({
  MeetingListScreen: ({ onTabPress, bottomBarSelectionCommand }: any) => (
    <View testID="meetings-screen">
      <Text testID="meetings-selection-command">{String(bottomBarSelectionCommand)}</Text>
      <Pressable
        testID="press-schedule"
        onPress={() => onTabPress({ nativeEvent: { type: 'tabPress', tab: 'schedule' } })}
      />
      <Pressable
        testID="press-meetings"
        onPress={() => onTabPress({ nativeEvent: { type: 'tabPress', tab: 'meetings' } })}
      />
    </View>
  ),
}));

async function renderTabs(initialScreen: 'Schedule' | 'Meetings' = 'Schedule') {
  return render(
    <MainTabsNavigator
      navigation={{} as any}
      route={{ key: 'main-tabs', name: 'MainTabs', params: { screen: initialScreen } } as any}
    />,
  );
}

describe('Android active-tab routing [UI-SHELL-RESELECT-001] [UI-SHELL-BOTTOM-MAIN-001]', () => {
  beforeEach(() => {
    mockScheduleMounts = 0;
    mockScheduleUnmounts = 0;
  });

  it('leaves routing and destination motion unchanged after the active native Schedule root handles reselect', async () => {
    const view = await renderTabs();

    expect(view.getByTestId('schedule-selection-command').props.children).toBe('0');
    await fireEvent.press(view.getByTestId('press-schedule'));
    await fireEvent.press(view.getByTestId('press-schedule'));
    expect(view.getByTestId('schedule-selection-command').props.children).toBe('0');
    expect(mockScheduleMounts).toBe(1);
    expect(mockScheduleUnmounts).toBe(0);
  });

  it('does not dispatch Schedule reselect while changing tabs or reselecting Meetings', async () => {
    const view = await renderTabs();

    await fireEvent.press(view.getByTestId('press-meetings'));
    expect(view.getByTestId('meetings-screen')).toBeTruthy();
    expect(view.getByTestId('meetings-selection-command').props.children).toBe('1');
    await fireEvent.press(view.getByTestId('press-meetings'));
    expect(view.getByTestId('meetings-selection-command').props.children).toBe('1');
    await fireEvent.press(view.getByTestId('press-schedule'));

    expect(view.getByTestId('schedule-selection-command').props.children).toBe('2');
  });

  it('preserves only the destination-motion sequence across a Schedule remount', async () => {
    const view = await renderTabs();

    await fireEvent.press(view.getByTestId('press-schedule'));
    await fireEvent.press(view.getByTestId('press-meetings'));
    await fireEvent.press(view.getByTestId('press-schedule'));
    expect(view.getByTestId('schedule-selection-command').props.children).toBe('2');

    await fireEvent.press(view.getByTestId('press-schedule'));
    expect(view.getByTestId('schedule-selection-command').props.children).toBe('2');
  });
});
