import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation';
import { AuthProvider } from './src/store/AuthStore';
import { EventsProvider } from './src/store/EventsStore';
import { MeetingsProvider } from './src/store/MeetingsStore';
import { AppDialogProvider } from './src/components/AppDialog';
import { AppLockGate } from './src/components/AppLockGate';
import { assertProductionApiConfig } from './src/services/config';
import { EventUndoBanner } from './src/components/EventUndoBanner';
import { cleanupStaleMeetingShareCache } from './src/services/meetingShare';
import { NotificationPermissionPrimer } from './src/components/NotificationPermissionPrimer';
import { AppReadinessGate } from './src/components/AppReadinessGate';

assertProductionApiConfig();

export default function App() {
  useEffect(() => {
    void cleanupStaleMeetingShareCache().catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AppReadinessGate>
          <EventsProvider>
            <MeetingsProvider>
              <AppDialogProvider>
                <NotificationPermissionPrimer />
                <AppLockGate>
                  <View style={{ flex: 1 }}>
                    <NavigationContainer>
                      <StatusBar style="dark" backgroundColor="#FFFFFF" />
                      <RootNavigator />
                    </NavigationContainer>
                    <EventUndoBanner />
                  </View>
                </AppLockGate>
              </AppDialogProvider>
            </MeetingsProvider>
          </EventsProvider>
        </AppReadinessGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
