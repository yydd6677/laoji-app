import { clearAppStorage } from './appStorage';
import { closeDeviceDataEpoch, DeviceApiError } from './deviceApi';
import { clearDeviceIdentity } from './deviceIdentity';
import { clearLocalAppFiles, clearScheduledAppNotifications } from './localData';
import { clearThemePreference } from './themePreferences';
import { deleteMeetingDatabase } from '../data/db/openDatabase';
import { clearNativeTransferLease } from '../native/nativeTransferCoordinator';
import { clearNativeUpcomingEventsProjection } from 'laoji-native-platform';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import { clearPurgeJournal, readPurgeJournal, writePurgeJournal } from './purgeJournal';

export interface LocalDataEraseResult {
  localCleared: boolean;
  remoteCleanup: 'confirmed' | 'pending';
  failedSteps: readonly string[];
}

type EraseStep = { name: string; run: () => Promise<void> };

function remotePurgeAlreadyConfirmed(error: unknown): boolean {
  return error instanceof DeviceApiError
    && (error.code === 'EPOCH_UNKNOWN' || error.code === 'EPOCH_CLOSED');
}

/**
 * The only coordinator allowed to erase the installation's business data.
 * Local deletion never waits indefinitely for the network. The current
 * device identity is retained when remote epoch cleanup is pending, so a
 * later run can still authenticate the purge instead of orphaning it.
 */
export async function eraseLocalInstallationData(): Promise<LocalDataEraseResult> {
  let remoteCleanup: LocalDataEraseResult['remoteCleanup'] = 'confirmed';
  let epochId: string | null = null;
  try {
    const identity = await getOrCreateDeviceIdentity();
    epochId = identity.epochId;
    await writePurgeJournal(epochId, 'registering');
    await Promise.race([
      closeDeviceDataEpoch(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('remote cleanup timeout')), 5_000);
      }),
    ]);
    await writePurgeJournal(epochId, 'confirmed');
  } catch (error) {
    if (!remotePurgeAlreadyConfirmed(error)) remoteCleanup = 'pending';
    // Keep the opaque journal and identity so a later run can retry the
    // server-side purge.  Local business data is still erased below.
    if (epochId && remoteCleanup === 'pending') {
      await writePurgeJournal(epochId, 'pending').catch(() => undefined);
    }
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
      await clearPurgeJournal();
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

/**
 * Resume a previously interrupted remote purge without touching local
 * business data.  This is safe to call at app startup or when the privacy
 * screen is opened; a missing journal is a no-op.
 */
export async function resumePendingRemotePurge(): Promise<'none' | 'confirmed' | 'pending'> {
  const journal = await readPurgeJournal();
  if (!journal || journal.state === 'confirmed') return 'none';
  try {
    await closeDeviceDataEpoch();
    await clearDeviceIdentity();
    await clearPurgeJournal();
    return 'confirmed';
  } catch (error) {
    if (remotePurgeAlreadyConfirmed(error)) {
      await clearDeviceIdentity();
      await clearPurgeJournal();
      return 'confirmed';
    }
    await writePurgeJournal(journal.epochId, 'pending').catch(() => undefined);
    return 'pending';
  }
}
