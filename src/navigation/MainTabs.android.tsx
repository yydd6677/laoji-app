import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NativeTabPressEvent } from 'laoji-native-platform';
import { ScheduleScreen } from '../screens/ScheduleScreen.android';
import { MeetingListScreen } from '../screens/MeetingListScreen.android';
import type { MainTabsParamList, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'MainTabs'>;
type MainTab = keyof MainTabsParamList;
type MainTabsState = {
  selectedTab: MainTab;
  // UI-SHELL-BOTTOM-MAIN-001: restarts source selection motion after active-root replacement.
  bottomBarSelectionCommand: number;
};

function requestedTab(params: RootStackParamList['MainTabs']): MainTab | null {
  if (!params || !('screen' in params)) return null;
  return params.screen === 'Meetings' ? 'Meetings' : params.screen === 'Schedule' ? 'Schedule' : null;
}

// UI-ANDROID-COMPOSITION-001: each tab mounts one exported native root that owns its bar.
export function MainTabsNavigator({ navigation, route }: Props) {
  const [state, setState] = useState<MainTabsState>(() => ({
    selectedTab: requestedTab(route.params) ?? 'Schedule',
    bottomBarSelectionCommand: 0,
  }));

  useEffect(() => {
    const next = requestedTab(route.params);
    if (next) {
      setState(current => current.selectedTab === next ? current : {
        ...current,
        selectedTab: next,
        bottomBarSelectionCommand: current.bottomBarSelectionCommand + 1,
      });
    }
  }, [route.params]);

  const handleTabPress = (event: { nativeEvent: NativeTabPressEvent }) => {
    const next = event.nativeEvent.tab === 'meetings' ? 'Meetings' : 'Schedule';
    setState(current => {
      if (current.selectedTab !== next) {
        return {
          ...current,
          selectedTab: next,
          bottomBarSelectionCommand: current.bottomBarSelectionCommand + 1,
        };
      }
      // UI-SHELL-RESELECT-001: the active Calendar native root already handled
      // its synchronous onSingleClick-equivalent before dispatching this event.
      return current;
    });
  };

  return (
    <View style={styles.root}>
      <View
        style={[styles.page, state.selectedTab === 'Schedule' ? styles.visible : styles.hidden]}
        pointerEvents={state.selectedTab === 'Schedule' ? 'auto' : 'none'}
        accessibilityElementsHidden={state.selectedTab !== 'Schedule'}
        importantForAccessibility={state.selectedTab === 'Schedule' ? 'auto' : 'no-hide-descendants'}
      >
        <ScheduleScreen
          navigation={navigation}
          onTabPress={handleTabPress}
          bottomBarSelectionCommand={state.bottomBarSelectionCommand}
        />
      </View>
      <View
        style={[styles.page, state.selectedTab === 'Meetings' ? styles.visible : styles.hidden]}
        pointerEvents={state.selectedTab === 'Meetings' ? 'auto' : 'none'}
        accessibilityElementsHidden={state.selectedTab !== 'Meetings'}
        importantForAccessibility={state.selectedTab === 'Meetings' ? 'auto' : 'no-hide-descendants'}
      >
        <MeetingListScreen
          navigation={navigation}
          onTabPress={handleTabPress}
          bottomBarSelectionCommand={state.bottomBarSelectionCommand}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: StyleSheet.absoluteFillObject,
  visible: { opacity: 1, zIndex: 1 },
  hidden: { opacity: 0, zIndex: 0 },
});
