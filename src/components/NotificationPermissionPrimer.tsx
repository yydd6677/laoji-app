import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { getAppStorageItem, setAppStorageItem } from '../services/appStorage';
import {
  ensureNotificationPermission,
  getNotificationPermissionState,
  openNotificationSettings,
  prepareNotificationChannel,
} from '../services/notifications';
import { useLocalProfile } from '../store/LocalProfileStore';
import { useAppDialog } from './AppDialog';

export const NOTIFICATION_PERMISSION_PRIMER_KEY = '@laoji:notificationPermissionPrimer:v2';

async function markPrimerShown(): Promise<void> {
  await setAppStorageItem(NOTIFICATION_PERMISSION_PRIMER_KEY, 'shown').catch(() => {});
}

export function NotificationPermissionPrimer() {
  const { initializing } = useLocalProfile();
  const { showDialog } = useAppDialog();
  const startedRef = useRef(false);

  useEffect(() => {
    if (initializing || startedRef.current || Platform.OS === 'web') return;
    startedRef.current = true;
    let active = true;

    const openSettings = async () => {
      try {
        await openNotificationSettings();
      } catch {
        showDialog({
          title: '无法打开系统设置',
          message: '请在系统设置中打开老记通知。',
          tone: 'error',
        });
      }
    };

    const showSettingsFallback = () => {
      if (!active) return;
      showDialog({
        title: '通知尚未开启',
        message: '日程提醒不会发送。',
        tone: 'warning',
        icon: 'notifications-off-outline',
        actions: [
          { text: '打开系统设置', role: 'primary', onPress: openSettings },
          { text: '以后再说', role: 'cancel' },
        ],
      });
    };

    void (async () => {
      await prepareNotificationChannel().catch(() => {});
      const [permission, alreadyShown] = await Promise.all([
        getNotificationPermissionState().catch(() => null),
        getAppStorageItem(NOTIFICATION_PERMISSION_PRIMER_KEY).catch(() => null),
      ]);
      if (!active || alreadyShown) return;
      if (permission?.granted) {
        await markPrimerShown();
        return;
      }

      showDialog({
        title: '开启日程提醒',
        tone: 'info',
        icon: 'notifications-outline',
        onDismiss: () => { void markPrimerShown(); },
        actions: [
          {
            text: '继续开启',
            role: 'primary',
            onPress: async () => {
              try {
                const granted = await ensureNotificationPermission();
                await markPrimerShown();
                if (!granted) showSettingsFallback();
              } catch {
                await markPrimerShown();
                showSettingsFallback();
              }
            },
          },
          {
            text: '暂不开启',
            role: 'cancel',
            onPress: markPrimerShown,
          },
        ],
      });
    })();

    return () => {
      active = false;
    };
  }, [initializing, showDialog]);

  return null;
}
