import 'react-native-gesture-handler';
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation';
import { LocalProfileProvider } from './src/store/LocalProfileStore';
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
import {
  AppStartupBoundary,
  AppStartupError,
} from './src/components/AppStartupBoundary';
import { MeetingMediaImportProvider } from './src/components/MeetingMediaImportProvider';
import { UpcomingEventsProjectionCoordinator } from './src/components/UpcomingEventsProjectionCoordinator';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { DeviceServiceCoordinator } from './src/components/DeviceServiceCoordinator';
import { DeviceMeetingCompletionProvider } from './src/components/DeviceMeetingCompletionProvider';
import { startAutomaticAppUpdateChecks } from './src/services/appUpdate';

function AppUpdateCoordinator() {
  useEffect(() => startAutomaticAppUpdateChecks(), []);
  return null;
}

function RuntimeProviders({ onRestart }: {
  onRestart: () => void;
}) {
  const { colors, themeId } = useTheme();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.appBg).catch(() => undefined);
  }, [colors.appBg]);

  useEffect(() => {
    void cleanupStaleMeetingShareCache().catch(() => {});
  }, []);

  return (
    <LocalProfileProvider>
      <NavigationStateProvider>
      <DeviceServiceCoordinator />
        <AppUpdateCoordinator />
        <NativePlatformCoordinator />
        <AppReadinessGate onRetry={onRestart}>
          <EventsProvider>
            <MeetingsProvider>
              <DeviceMeetingCompletionProvider />
              <UpcomingEventsProjectionCoordinator />
              <AppLockGate>
                <AppDialogProvider>
                  <MeetingMediaImportProvider>
                    <NotificationPermissionPrimer />
                    <View style={{ flex: 1 }}>
                      <RestorableNavigationContainer>
                        <StatusBar
                          style={themeId === 'midnight' ? 'light' : 'dark'}
                          backgroundColor={colors.appBg}
                        />
                        <RootNavigator />
                        <NotificationNavigationHandler />
                      </RestorableNavigationContainer>
                      <EventUndoBanner />
                    </View>
                  </MeetingMediaImportProvider>
                </AppDialogProvider>
              </AppLockGate>
            </MeetingsProvider>
          </EventsProvider>
        </AppReadinessGate>
      </NavigationStateProvider>
    </LocalProfileProvider>
  );
}

function ValidatedRuntime({ onRestart }: {
  onRestart: () => void;
}) {
  // UI-BOOT-READINESS-001 routes configuration failure into the recovery surface.
  try {
    assertProductionApiConfig();
  } catch (error) {
    throw new AppStartupError('configuration', 'LaoJi runtime configuration is invalid', error);
  }
  return (
    <RuntimeProviders onRestart={onRestart} />
  );
}

export default function App() {
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const restart = useCallback(() => {
    setRuntimeGeneration(value => value + 1);
  }, []);

  return (
    <ThemeProvider>
      <AppStartupBoundary
        resetKey={runtimeGeneration}
        onRetry={restart}
      >
        <SafeAreaProvider key={`runtime:${runtimeGeneration}`}>
          <ValidatedRuntime onRestart={restart} />
        </SafeAreaProvider>
      </AppStartupBoundary>
    </ThemeProvider>
  );
}
