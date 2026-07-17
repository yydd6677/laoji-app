import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
import { NotificationNavigationHandler } from './src/components/NotificationNavigationHandler';
import {
  NavigationStateProvider,
  RestorableNavigationContainer,
} from './src/navigation/NavigationStateCoordinator';
import { NativePlatformCoordinator } from './src/components/NativePlatformCoordinator';

assertProductionApiConfig();

export default function App() {
  useEffect(() => {
    void cleanupStaleMeetingShareCache().catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationStateProvider>
          <NativePlatformCoordinator />
          <AppReadinessGate>
            <EventsProvider>
              <MeetingsProvider>
                <AppLockGate>
                  <AppDialogProvider>
                    <NotificationPermissionPrimer />
                    <View style={{ flex: 1 }}>
                      <RestorableNavigationContainer>
                        <StatusBar style="dark" backgroundColor="#FFFFFF" />
                        <RootNavigator />
                        <NotificationNavigationHandler />
                      </RestorableNavigationContainer>
                      <EventUndoBanner />
                    </View>
                  </AppDialogProvider>
                </AppLockGate>
              </MeetingsProvider>
            </EventsProvider>
          </AppReadinessGate>
        </NavigationStateProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
