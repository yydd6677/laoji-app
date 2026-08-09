import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';

import { ScheduleScreen }    from '../screens/ScheduleScreen';
import { MeetingListScreen } from '../screens/MeetingListScreen';
import { EventDetailScreen } from '../screens/EventDetailScreen';
import { MeetingLiveScreen } from '../screens/MeetingLiveScreen';
import { TranscriptionScreen } from '../screens/TranscriptionScreen';
import { MeetingAttachmentsScreen } from '../screens/MeetingAttachmentsScreen';
import { MeetingOrganizationScreen } from '../screens/MeetingOrganizationScreen';
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen';
import { PrivacyScreen }     from '../screens/PrivacyScreen';
import { AddEventScreen }    from '../screens/AddEventScreen';
import { LegalDocumentScreen } from '../screens/LegalDocumentScreen';
import { SpeakerManagerScreen } from '../screens/SpeakerManagerScreen';
import { SpeakerEnrollmentScreen } from '../screens/SpeakerEnrollmentScreen';
import { MainTabsNavigator } from './MainTabs';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
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
      <Stack.Screen name="SpeakerManager" component={SpeakerManagerScreen} />
      <Stack.Screen name="SpeakerEnrollment" component={SpeakerEnrollmentScreen} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
      <Stack.Screen name="Privacy"       component={PrivacyScreen} />
      <Stack.Screen name="Legal"         component={LegalDocumentScreen} />
      <Stack.Screen name="AddEvent"      component={AddEventScreen} options={{ animation: 'slide_from_bottom' }} />
    </Stack.Navigator>
  );
}
