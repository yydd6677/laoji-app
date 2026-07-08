import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../store/AuthStore';
import { Colors as C } from '../theme/colors';

import { LoginScreen }       from '../screens/LoginScreen';
import { ScheduleScreen }    from '../screens/ScheduleScreen';
import { MeetingListScreen } from '../screens/MeetingListScreen';
import { EventDetailScreen } from '../screens/EventDetailScreen';
import { CalendarScreen }    from '../screens/CalendarScreen';
import { RecordingScreen }   from '../screens/RecordingScreen';
import { TranscriptionScreen } from '../screens/TranscriptionScreen';
import { ProfileScreen }     from '../screens/ProfileScreen';
import { AccountScreen }     from '../screens/AccountScreen';
import { PrivacyScreen }     from '../screens/PrivacyScreen';
import { AddEventScreen }    from '../screens/AddEventScreen';
import { LegalDocumentScreen } from '../screens/LegalDocumentScreen';
import { MainTabsNavigator } from './MainTabs';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { initializing, mode } = useAuth();

  if (initializing) {
    return (
      <View style={s.loading}>
        <ActivityIndicator size="large" color={C.purple} />
        <Text style={s.loadingText}>正在进入老记…</Text>
      </View>
    );
  }

  if (mode === 'signed_out') {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Legal" component={LegalDocumentScreen} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName="MainTabs"
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="MainTabs"      component={MainTabsNavigator} />
      <Stack.Screen name="EventDetail"   component={EventDetailScreen} />
      <Stack.Screen name="Calendar"      component={CalendarScreen} />
      <Stack.Screen name="Recording"     component={RecordingScreen} />
      <Stack.Screen name="Transcription" component={TranscriptionScreen} />
      <Stack.Screen name="Profile"       component={ProfileScreen} />
      <Stack.Screen name="Account"       component={AccountScreen} />
      <Stack.Screen name="Privacy"       component={PrivacyScreen} />
      <Stack.Screen name="Legal"         component={LegalDocumentScreen} />
      <Stack.Screen name="AddEvent"      component={AddEventScreen} options={{ animation: 'slide_from_bottom' }} />
    </Stack.Navigator>
  );
}

const s = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.appBg, gap: 12 },
  loadingText: { fontSize: 13, color: C.sub },
});
