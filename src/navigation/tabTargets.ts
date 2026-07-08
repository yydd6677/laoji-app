import type { NavigationProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types';

type AppNavigation = NavigationProp<RootStackParamList> | any;

export function openScheduleTab(navigation: AppNavigation) {
  navigation.navigate('MainTabs', { screen: 'Schedule' });
}

export function openMeetingsTab(navigation: AppNavigation) {
  navigation.navigate('MainTabs', { screen: 'Meetings' });
}
