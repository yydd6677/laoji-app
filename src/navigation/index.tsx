import React from 'react';
import { StyleSheet, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../store/AuthStore';
import { Colors as C } from '../theme/colors';

import { LoginScreen }       from '../screens/LoginScreen';
import { ScheduleScreen }    from '../screens/ScheduleScreen';
import { MeetingListScreen } from '../screens/MeetingListScreen';
import { EventDetailScreen } from '../screens/EventDetailScreen';
import { MeetingLiveScreen } from '../screens/MeetingLiveScreen';
import { TranscriptionScreen } from '../screens/TranscriptionScreen';
import { MeetingAttachmentsScreen } from '../screens/MeetingAttachmentsScreen';
import { MeetingOrganizationScreen } from '../screens/MeetingOrganizationScreen';
import { SharedActionScreen } from '../screens/SharedActionScreen';
import { ProfileScreen }     from '../screens/ProfileScreen';
import { ProfileFieldScreen, PROFILE_FIELD_SCREEN_OPTIONS } from '../screens/ProfileFieldScreen';
import { AccountScreen }     from '../screens/AccountScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen';
import { AccountDeletionScreen } from '../screens/AccountDeletionScreen';
import { PrivacyScreen }     from '../screens/PrivacyScreen';
import { AddEventScreen }    from '../screens/AddEventScreen';
import { LegalDocumentScreen } from '../screens/LegalDocumentScreen';
import { SpeakerManagerScreen } from '../screens/SpeakerManagerScreen';
import { SpeakerEnrollmentScreen } from '../screens/SpeakerEnrollmentScreen';
import { MainTabsNavigator } from './MainTabs';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { initializing, mode } = useAuth();

  if (initializing) {
    return <View style={s.loading} testID="app-initializing" />;
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
      <Stack.Screen name="EventDetail"   component={EventDetailScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="MeetingLive"   component={MeetingLiveScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="Transcription" component={TranscriptionScreen} />
      <Stack.Screen name="MeetingAttachments" component={MeetingAttachmentsScreen} />
      <Stack.Screen name="MeetingOrganization" component={MeetingOrganizationScreen} />
      <Stack.Screen name="SharedAction" component={SharedActionScreen} />
      <Stack.Screen name="SpeakerManager" component={SpeakerManagerScreen} />
      <Stack.Screen name="SpeakerEnrollment" component={SpeakerEnrollmentScreen} />
      <Stack.Screen name="Profile"       component={ProfileScreen} />
      <Stack.Screen name="ProfileField"  component={ProfileFieldScreen} options={PROFILE_FIELD_SCREEN_OPTIONS} />
      <Stack.Screen name="Account"       component={AccountScreen} />
      <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
      <Stack.Screen name="AccountDeletion" component={AccountDeletionScreen} />
      <Stack.Screen name="Privacy"       component={PrivacyScreen} />
      <Stack.Screen name="Legal"         component={LegalDocumentScreen} />
      <Stack.Screen name="AddEvent"      component={AddEventScreen} options={{ animation: 'slide_from_bottom' }} />
    </Stack.Navigator>
  );
}

const s = StyleSheet.create({
  loading: { flex: 1, backgroundColor: C.body },
});
