import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ScheduleScreen } from '../screens/ScheduleScreen';
import { MeetingListScreen } from '../screens/MeetingListScreen';
import { MainTabsParamList } from '../types';

// We use a custom BottomTabBar inside each screen, so hide the default one
const Tab = createBottomTabNavigator<MainTabsParamList>();

export function MainTabsNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false, tabBarStyle: { display: 'none' } }}
      initialRouteName="Schedule"
    >
      <Tab.Screen name="Schedule" component={ScheduleScreen} />
      <Tab.Screen name="Meetings" component={MeetingListScreen} />
    </Tab.Navigator>
  );
}
