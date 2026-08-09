import { getAppStorageItem, setAppStorageItem } from './appStorage';

const GENERATION_RETENTION_KEY = '@laoji:privacy:retainGeneratedResults:v1';

/**
 * The default is deliberately false.  This is a local preference rather than
 * an account setting because the device is the owner of the user's data.
 */
export async function loadGenerationRetentionPreference(): Promise<boolean> {
  try {
    return (await getAppStorageItem(GENERATION_RETENTION_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function saveGenerationRetentionPreference(value: boolean): Promise<void> {
  await setAppStorageItem(GENERATION_RETENTION_KEY, value ? 'true' : 'false');
}
