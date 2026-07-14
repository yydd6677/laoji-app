import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { getAppStorageItem, setAppStorageItem } from '../services/appStorage';
import {
  ensureNotificationPermission,
  getNotificationPermissionState,
  openNotificationSettings,
  prepareNotificationChannel,
} from '../services/notifications';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from './AppDialog';

export const NOTIFICATION_PERMISSION_PRIMER_KEY = '@laoji:notificationPermissionPrimer:v2';

async function markPrimerShown(): Promise<void> {
  await setAppStorageItem(NOTIFICATION_PERMISSION_PRIMER_KEY, 'shown').catch(() => {});
}

export function NotificationPermissionPrimer() {
  const { initializing } = useAuth();
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
          message: '请在手机设置的应用管理中找到“老记”，再进入通知管理。',
          tone: 'error',
        });
      }
    };

    const showSettingsFallback = () => {
      if (!active) return;
      showDialog({
        title: '通知尚未开启',
        message: '日程仍会正常保存，但不会收到系统提醒。你可以前往老记的系统通知设置手动开启。',
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
        showDialog({
          title: '日程提醒已开启',
          message: '系统已允许老记发送通知。有具体时间和提醒设置的日程，会按时发送本机通知。',
          hint: '通知开关位于手机的“应用通知”或“通知管理”，不一定显示在普通权限列表中。',
          tone: 'success',
          icon: 'notifications-outline',
          onDismiss: () => { void markPrimerShown(); },
          actions: [
            { text: '知道了', role: 'primary', onPress: markPrimerShown },
          ],
        });
        return;
      }

      showDialog({
        title: '开启日程提醒',
        message: '老记需要通知权限，才能在日程开始前发送系统提醒。拒绝权限不会影响创建和查看日程。',
        hint: '点击“继续开启”后，手机会显示系统权限窗口。',
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
