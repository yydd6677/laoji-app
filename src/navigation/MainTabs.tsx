import React from 'react';
import {
  createBottomTabNavigator,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { BottomTabBar } from '../components/BottomTabBar';
import { ScheduleScreen } from '../screens/ScheduleScreen';
import { MeetingListScreen } from '../screens/MeetingListScreen';
import { MainTabsParamList } from '../types';
import { openMeetingRecorder, pressMainTab } from './tabTargets';

const Tab = createBottomTabNavigator<MainTabsParamList>();

function MainTabBar({ state, navigation }: BottomTabBarProps) {
  const active = state.routes[state.index]?.name === 'Meetings' ? 'meetings' : 'schedule';

  return (
    <BottomTabBar
      active={active}
      onSchedule={() => pressMainTab(navigation, state, 'Schedule')}
      onMeetings={() => pressMainTab(navigation, state, 'Meetings')}
      onMic={active === 'meetings' ? () => openMeetingRecorder(navigation) : undefined}
    />
  );
}

export function MainTabsNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={props => <MainTabBar {...props} />}
      initialRouteName="Schedule"
    >
      <Tab.Screen name="Schedule" component={ScheduleScreen} />
      <Tab.Screen name="Meetings" component={MeetingListScreen} />
    </Tab.Navigator>
  );
}
