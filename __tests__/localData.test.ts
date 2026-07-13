import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import { clearLocalAppFiles, clearScheduledAppNotifications } from '../src/services/localData';

describe('local data cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue(undefined);
  });

  it('removes durable avatars, meeting audio, and share cache', async () => {
    await clearLocalAppFiles();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///tmp/laoji-documents/avatars/',
      { idempotent: true },
    );
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///tmp/laoji-documents/meeting-audio/',
      { idempotent: true },
    );
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///tmp/laoji-cache/meeting-shares/',
      { idempotent: true },
    );
  });

  it('cancels all scheduled LaoJi reminders', async () => {
    await clearScheduledAppNotifications();
    expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it('reports a partial file cleanup instead of silently claiming success', async () => {
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (path: string) => {
      if (path.includes('meeting-audio')) throw new Error('file busy');
    });

    await expect(clearLocalAppFiles()).rejects.toThrow('1 local data directories could not be deleted');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
  });

  it('reports notification cleanup failures', async () => {
    (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockRejectedValue(new Error('system unavailable'));
    await expect(clearScheduledAppNotifications()).rejects.toThrow('system unavailable');
  });
});
