import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { NavigationProp } from '@react-navigation/native';
import type { MainTabsParamList, RootStackParamList } from '../types';

type MainTabName = keyof MainTabsParamList;
type MainTabBarNavigation = BottomTabBarProps['navigation'];
type MainTabBarState = BottomTabBarProps['state'];

export function pressMainTab(
  navigation: MainTabBarNavigation,
  state: MainTabBarState,
  targetName: MainTabName,
) {
  const target = state.routes.find(route => route.name === targetName);
  if (!target) return;

  const event = navigation.emit({
    type: 'tabPress',
    target: target.key,
    canPreventDefault: true,
  });
  const current = state.routes[state.index];
  if (!event.defaultPrevented && current?.key !== target.key) {
    navigation.navigate(target.name, target.params);
  }
}

export function openMeetingRecorder(navigation: MainTabBarNavigation) {
  navigation.navigate('MeetingLive');
}

type RootNavigation = Pick<NavigationProp<RootStackParamList>, 'navigate'>;

export function openScheduleTab(navigation: RootNavigation) {
  navigation.navigate('MainTabs', { screen: 'Schedule' });
}

export function openMeetingsTab(navigation: RootNavigation) {
  navigation.navigate('MainTabs', { screen: 'Meetings' });
}
