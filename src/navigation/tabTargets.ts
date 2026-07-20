import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
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

type RootNavigation = Pick<NativeStackNavigationProp<RootStackParamList>, 'popTo'>;

export function openScheduleTab(navigation: RootNavigation) {
  navigation.popTo('MainTabs', { screen: 'Schedule' });
}

export function openMeetingsTab(navigation: RootNavigation) {
  navigation.popTo('MainTabs', { screen: 'Meetings' });
}
