import { clearAppStorage } from './appStorage';
import { closeDeviceDataEpoch, DeviceApiError } from './deviceApi';
import { clearDeviceIdentity } from './deviceIdentity';
import { clearLocalAppFiles, clearScheduledAppNotifications } from './localData';
import { clearThemePreference } from './themePreferences';
import { deleteMeetingDatabase } from '../data/db/openDatabase';
import { deleteScheduleDatabase } from '../data/db/openScheduleDatabase';
import { clearNativeTransferLease } from '../native/nativeTransferCoordinator';
import { clearNativeUpcomingEventsProjection } from 'laoji-native-platform';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import {
  clearLegacyEpochCleanupJournal,
  readLegacyEpochCleanupJournal,
  writeLegacyEpochCleanupJournal,
} from './legacyEpochCleanupJournal';
import {
  beginDeviceV2PurgeOnlyErase,
  resumeDeviceV2PurgeOnlyErase,
} from './deviceV2Api';
import { supportsPurgeOnlyJournal } from 'laoji-native-platform';

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
  let legacyRemotePending = false;
  if (supportsPurgeOnlyJournal()) {
    try {
      const prepared = beginDeviceV2PurgeOnlyErase();
      if (prepared.rowCount > 0) {
        const resumed = await Promise.race([
          resumeDeviceV2PurgeOnlyErase(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('v2 purge timeout')), 5_000);
          }),
        ]);
        if (resumed.rowCount > 0) remoteCleanup = 'pending';
      }
    } catch {
      // The native journal remains encrypted and retryable after ordinary
      // identity/SecureStore cleanup; local erasure must still continue.
      remoteCleanup = 'pending';
    }
  }
  let epochId: string | null = null;
  try {
    const identity = await getOrCreateDeviceIdentity();
    epochId = identity.epochId;
    await writeLegacyEpochCleanupJournal(epochId, 'registering');
    await Promise.race([
      closeDeviceDataEpoch(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('remote cleanup timeout')), 5_000);
      }),
    ]);
    await writeLegacyEpochCleanupJournal(epochId, 'confirmed');
  } catch (error) {
    if (!remotePurgeAlreadyConfirmed(error)) {
      remoteCleanup = 'pending';
      legacyRemotePending = true;
    }
    // Keep the opaque journal and identity so a later run can retry the
    // server-side purge.  Local business data is still erased below.
    if (epochId && remoteCleanup === 'pending') {
      await writeLegacyEpochCleanupJournal(epochId, 'pending').catch(() => undefined);
    }
  }

  const preDatabaseSteps: EraseStep[] = [
    {
      name: 'native-transfer',
      run: async () => {
        // v2 credentials are scoped by epoch, not by the legacy guest label.
        // Clear both before local media deletion so no queued worker can wake
        // after the files have been erased.
        await clearNativeTransferLease('guest');
        if (epochId) await clearNativeTransferLease(`device-v2:${epochId}`);
      },
    },
    { name: 'native-calendar-projection', run: clearNativeUpcomingEventsProjection },
    { name: 'notifications', run: clearScheduledAppNotifications },
    { name: 'files', run: clearLocalAppFiles },
  ];
  const preResults = await Promise.allSettled(preDatabaseSteps.map(step => step.run()));

  const ownerSteps: EraseStep[] = [
    { name: 'async-storage', run: clearAppStorage },
    { name: 'meeting-database', run: deleteMeetingDatabase },
    { name: 'schedule-database', run: deleteScheduleDatabase },
    { name: 'theme-preference', run: clearThemePreference },
  ];
  const ownerResults = await Promise.allSettled(ownerSteps.map(step => step.run()));

  const failedSteps = [
    ...preDatabaseSteps.filter((_, index) => preResults[index]?.status === 'rejected').map(step => step.name),
    ...ownerSteps.filter((_, index) => ownerResults[index]?.status === 'rejected').map(step => step.name),
  ];
  if (!legacyRemotePending) {
    try {
      await clearDeviceIdentity();
      await clearLegacyEpochCleanupJournal();
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
  let v2Pending = false;
  if (supportsPurgeOnlyJournal()) {
    try {
      const v2 = await resumeDeviceV2PurgeOnlyErase();
      v2Pending = v2.rowCount > 0;
    } catch {
      v2Pending = true;
    }
  }
  const journal = await readLegacyEpochCleanupJournal();
  if (!journal || journal.state === 'confirmed') return v2Pending ? 'pending' : 'none';
  try {
    await closeDeviceDataEpoch();
    await clearDeviceIdentity();
    await clearLegacyEpochCleanupJournal();
    return v2Pending ? 'pending' : 'confirmed';
  } catch (error) {
    if (remotePurgeAlreadyConfirmed(error)) {
      await clearDeviceIdentity();
      await clearLegacyEpochCleanupJournal();
      return v2Pending ? 'pending' : 'confirmed';
    }
    await writeLegacyEpochCleanupJournal(journal.epochId, 'pending').catch(() => undefined);
    return 'pending';
  }
}
