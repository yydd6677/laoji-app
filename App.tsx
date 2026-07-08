import 'react-native-gesture-handler';
import React from 'react';
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

assertProductionApiConfig();

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <EventsProvider>
          <MeetingsProvider>
            <AppDialogProvider>
              <AppLockGate>
                <NavigationContainer>
                  <StatusBar style="dark" />
                  <RootNavigator />
                </NavigationContainer>
              </AppLockGate>
            </AppDialogProvider>
          </MeetingsProvider>
        </EventsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
