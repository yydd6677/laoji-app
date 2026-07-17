import React, { useEffect, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NativeTabPressEvent } from 'laoji-native-platform';
import { ScheduleScreen } from '../screens/ScheduleScreen.android';
import { MeetingListScreen } from '../screens/MeetingListScreen.android';
import type { MainTabsParamList, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'MainTabs'>;
type MainTab = keyof MainTabsParamList;

function requestedTab(params: RootStackParamList['MainTabs']): MainTab | null {
  if (!params || !('screen' in params)) return null;
  return params.screen === 'Meetings' ? 'Meetings' : params.screen === 'Schedule' ? 'Schedule' : null;
}

// UI-ANDROID-COMPOSITION-001: each tab mounts one exported native root that owns its bar.
export function MainTabsNavigator({ navigation, route }: Props) {
  const [selectedTab, setSelectedTab] = useState<MainTab>(() => requestedTab(route.params) ?? 'Schedule');

  useEffect(() => {
    const next = requestedTab(route.params);
    if (next) setSelectedTab(next);
  }, [route.params]);

  const handleTabPress = (event: { nativeEvent: NativeTabPressEvent }) => {
    setSelectedTab(event.nativeEvent.tab === 'meetings' ? 'Meetings' : 'Schedule');
  };

  return selectedTab === 'Schedule' ? (
    <ScheduleScreen navigation={navigation} onTabPress={handleTabPress} />
  ) : (
    <MeetingListScreen navigation={navigation} onTabPress={handleTabPress} />
  );
}
