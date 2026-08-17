import { clearAppStorage } from './appStorage';
import { closeDeviceDataEpoch } from './deviceApi';
import { clearDeviceIdentity } from './deviceIdentity';
import { clearLocalAppFiles, clearScheduledAppNotifications } from './localData';
import { clearThemePreference } from './themePreferences';
import { deleteMeetingDatabase } from '../data/db/openDatabase';
import { clearNativeTransferLease } from '../native/nativeTransferCoordinator';
import { clearNativeUpcomingEventsProjection } from 'laoji-native-platform';

export interface LocalDataEraseResult {
  localCleared: boolean;
  remoteCleanup: 'confirmed' | 'pending';
  failedSteps: readonly string[];
}

type EraseStep = { name: string; run: () => Promise<void> };

/**
 * The only coordinator allowed to erase the installation's business data.
 * Local deletion never waits indefinitely for the network. The current
 * device identity is retained when remote epoch cleanup is pending, so a
 * later run can still authenticate the purge instead of orphaning it.
 */
export async function eraseLocalInstallationData(): Promise<LocalDataEraseResult> {
  let remoteCleanup: LocalDataEraseResult['remoteCleanup'] = 'confirmed';
  try {
    await Promise.race([
      closeDeviceDataEpoch(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('remote cleanup timeout')), 5_000);
      }),
    ]);
  } catch {
    remoteCleanup = 'pending';
  }

  const preDatabaseSteps: EraseStep[] = [
    { name: 'native-transfer', run: () => clearNativeTransferLease('guest') },
    { name: 'native-calendar-projection', run: clearNativeUpcomingEventsProjection },
    { name: 'notifications', run: clearScheduledAppNotifications },
    { name: 'files', run: clearLocalAppFiles },
  ];
  const preResults = await Promise.allSettled(preDatabaseSteps.map(step => step.run()));

  const ownerSteps: EraseStep[] = [
    { name: 'async-storage', run: clearAppStorage },
    { name: 'meeting-database', run: deleteMeetingDatabase },
    { name: 'theme-preference', run: clearThemePreference },
  ];
  const ownerResults = await Promise.allSettled(ownerSteps.map(step => step.run()));

  const failedSteps = [
    ...preDatabaseSteps.filter((_, index) => preResults[index]?.status === 'rejected').map(step => step.name),
    ...ownerSteps.filter((_, index) => ownerResults[index]?.status === 'rejected').map(step => step.name),
  ];
  if (remoteCleanup === 'confirmed') {
    try {
      await clearDeviceIdentity();
    } catch {
      failedSteps.push('device-identity');
    }
  }
  return {
    localCleared: failedSteps.length === 0,
    remoteCleanup,
    failedSteps,
  };
}
