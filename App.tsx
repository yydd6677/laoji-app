import 'react-native-gesture-handler';
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation';
import { AuthProvider } from './src/store/AuthStore';
import { EventsProvider } from './src/store/EventsStore';
import { MeetingsProvider } from './src/store/MeetingsStore';
import { AppDialogProvider } from './src/components/AppDialog';
import { GuestDataMigrationProvider } from './src/components/GuestDataMigrationProvider';
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
import { MeetingActionSyncProvider } from './src/components/MeetingActionSyncProvider';
import { MeetingRootSyncProvider } from './src/components/MeetingRootSyncProvider';
import { MeetingSpeakerCorrectionSyncProvider } from './src/components/MeetingSpeakerCorrectionSyncProvider';
import { MeetingManualNoteSyncProvider } from './src/components/MeetingManualNoteSyncProvider';
import { MeetingOccurrenceSyncProvider } from './src/components/MeetingOccurrenceSyncProvider';
import {
  AppStartupBoundary,
  AppStartupError,
} from './src/components/AppStartupBoundary';
import { MeetingMediaImportProvider } from './src/components/MeetingMediaImportProvider';
import { UpcomingEventsProjectionCoordinator } from './src/components/UpcomingEventsProjectionCoordinator';
import { MeetingTranscriptCompletionProvider } from './src/components/MeetingTranscriptCompletionProvider';
import { MeetingRetentionCleanupProvider } from './src/components/MeetingRetentionCleanupProvider';

function RuntimeProviders({ onRestart }: {
  onRestart: () => void;
  feishuEvidence?: string;
}) {
  useEffect(() => {
    void cleanupStaleMeetingShareCache().catch(() => {});
  }, []);

  return (
    <AuthProvider>
      <NavigationStateProvider>
        <NativePlatformCoordinator />
        <AppReadinessGate
          feishuEvidence="feishu:UI-BOOT-READINESS-001:readiness-gate"
          onRetry={onRestart}
        >
          <MeetingRootSyncProvider>
            <MeetingRetentionCleanupProvider>
              <MeetingOccurrenceSyncProvider>
                <MeetingActionSyncProvider>
                  <MeetingManualNoteSyncProvider>
                    <MeetingSpeakerCorrectionSyncProvider>
                    <EventsProvider>
                    <MeetingsProvider>
                      <MeetingTranscriptCompletionProvider>
                        <UpcomingEventsProjectionCoordinator />
                        <AppLockGate>
                          <AppDialogProvider>
                            <MeetingMediaImportProvider>
                              <GuestDataMigrationProvider>
                                <NotificationPermissionPrimer />
                                <View style={{ flex: 1 }}>
                                  <RestorableNavigationContainer>
                                    <StatusBar style="dark" backgroundColor="#FFFFFF" />
                                    <RootNavigator />
                                    <NotificationNavigationHandler />
                                  </RestorableNavigationContainer>
                                  <EventUndoBanner />
                                </View>
                              </GuestDataMigrationProvider>
                            </MeetingMediaImportProvider>
                          </AppDialogProvider>
                        </AppLockGate>
                      </MeetingTranscriptCompletionProvider>
                    </MeetingsProvider>
                    </EventsProvider>
                    </MeetingSpeakerCorrectionSyncProvider>
                  </MeetingManualNoteSyncProvider>
                </MeetingActionSyncProvider>
              </MeetingOccurrenceSyncProvider>
            </MeetingRetentionCleanupProvider>
          </MeetingRootSyncProvider>
        </AppReadinessGate>
      </NavigationStateProvider>
    </AuthProvider>
  );
}

function ValidatedRuntime({ onRestart }: {
  onRestart: () => void;
  feishuEvidence?: string;
}) {
  // UI-BOOT-READINESS-001 routes configuration failure into the recovery surface.
  try {
    assertProductionApiConfig();
  } catch (error) {
    throw new AppStartupError('configuration', 'LaoJi runtime configuration is invalid', error);
  }
  return (
    <RuntimeProviders
      feishuEvidence="feishu:UI-BOOT-READINESS-001:runtime-providers"
      onRestart={onRestart}
    />
  );
}

export default function App() {
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const restart = useCallback(() => {
    setRuntimeGeneration(value => value + 1);
  }, []);

  return (
    <AppStartupBoundary
      feishuEvidence="feishu:UI-BOOT-READINESS-001:startup-boundary"
      resetKey={runtimeGeneration}
      onRetry={restart}
    >
      <SafeAreaProvider key={`runtime:${runtimeGeneration}`}>
        <ValidatedRuntime
          feishuEvidence="feishu:UI-BOOT-READINESS-001:validated-runtime"
          onRestart={restart}
        />
      </SafeAreaProvider>
    </AppStartupBoundary>
  );
}
