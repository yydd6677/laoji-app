import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';

export async function clearLocalAppFiles(): Promise<void> {
  const paths = [
    FileSystem.documentDirectory ? `${FileSystem.documentDirectory}avatars/` : null,
    FileSystem.documentDirectory ? `${FileSystem.documentDirectory}meeting-audio/` : null,
    FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}meeting-shares/` : null,
  ].filter((path): path is string => Boolean(path));

  const results = await Promise.allSettled(
    paths.map(path => FileSystem.deleteAsync(path, { idempotent: true })),
  );
  const failures = results.filter(result => result.status === 'rejected').length;
  if (failures > 0) throw new Error(`${failures} local data directories could not be deleted`);
}

export async function clearScheduledAppNotifications(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
