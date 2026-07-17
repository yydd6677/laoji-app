import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsGroup, SettingsRow, SettingsTitleBar } from '../components/SettingsGroup';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import {
  REMINDER_OPTIONS,
  ReminderMinutes,
  ensureNotificationPermission,
  getNotificationPermissionStatus,
  openNotificationSettings,
  loadNotificationPrefs,
  saveNotificationPrefs,
  scheduleTestNotification,
} from '../services/notifications';
import { RootStackParamList } from '../types';
import { getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-FORM-001 / UI-TOKENS-001: notification actions retain fixed right-side status slots.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'NotificationSettings'>;
};

export function NotificationSettingsScreen({ navigation }: Props) {
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(15);
  const [permissionStatus, setPermissionStatus] = useState('unknown');
  const [reminderSaving, setReminderSaving] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [notificationTestBusy, setNotificationTestBusy] = useState(false);
  const notificationScope = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest'
      ? 'guest'
      : 'signed_out';

  useEffect(() => {
    let active = true;
    const refreshPermission = () => {
      void getNotificationPermissionStatus().catch(() => 'unknown').then(status => {
        if (active) setPermissionStatus(status);
      });
    };
    void loadNotificationPrefs(notificationScope).then(prefs => {
      if (!active) return;
      setDefaultReminder(prefs.defaultReminderMinutes);
    });
    refreshPermission();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refreshPermission();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [notificationScope]);

  const handleReminderChoice = async (value: ReminderMinutes) => {
    if (reminderSaving || value === defaultReminder) return;
    setReminderSaving(true);
    try {
      await saveNotificationPrefs(notificationScope, { defaultReminderMinutes: value });
      setDefaultReminder(value);
    } catch {
      showDialog({
        title: '提醒设置未保存',
        message: '本机存储暂时不可用，默认提醒仍保持原设置。',
        tone: 'error',
      });
    } finally {
      setReminderSaving(false);
    }
  };

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

  const handleRequestPermission = async () => {
    if (permissionBusy) return;
    setPermissionBusy(true);
    try {
      if (permissionStatus === 'granted') {
        await openSettings();
        return;
      }
      const granted = await ensureNotificationPermission();
      const status = await getNotificationPermissionStatus().catch(() => granted ? 'granted' : 'denied');
      setPermissionStatus(status);
      showDialog({
        title: granted ? '通知已开启' : '通知未开启',
        message: granted ? '老记可以为有提醒的日程创建系统通知。' : '未获得系统通知权限，日程提醒不会弹出系统通知。',
        tone: granted ? 'success' : 'warning',
        actions: granted ? undefined : [
          { text: '打开系统设置', role: 'primary', onPress: openSettings },
          { text: '以后再说', role: 'cancel' },
        ],
      });
    } catch {
      setPermissionStatus('unknown');
      showDialog({
        title: '无法检查通知权限',
        message: '系统通知状态读取失败，请稍后重试或前往系统设置检查。',
        tone: 'error',
      });
    } finally {
      setPermissionBusy(false);
    }
  };

  const handleTestNotification = async () => {
    if (notificationTestBusy) return;
    setNotificationTestBusy(true);
    try {
      await scheduleTestNotification();
      setPermissionStatus('granted');
      showDialog({ title: '测试提醒已安排', message: '老记将在 3 秒后发送一条系统通知。', tone: 'success' });
    } catch {
      const status = await getNotificationPermissionStatus().catch(() => 'unknown');
      setPermissionStatus(status);
      showDialog({
        title: '测试提醒未发送',
        message: status === 'granted'
          ? '系统通知已开启，但提醒调度失败。请稍后重试。'
          : '请先开启老记的系统通知，再发送测试提醒。',
        tone: 'warning',
      });
    } finally {
      setNotificationTestBusy(false);
    }
  };

  const permissionText = permissionStatus === 'granted'
    ? '系统通知已开启'
    : permissionStatus === 'denied'
      ? '系统通知未开启'
      : '系统通知状态未知';

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar title="通知与提醒" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false} testID="notification-settings-page">
        <Text style={s.sectionLabel}>通知权限</Text>
        <SettingsGroup style={s.groupAfterLabel} testID="notification-permission-group">
          <SettingsRow label="当前状态" value={permissionText} />
          <SettingsRow
            label={permissionStatus === 'granted' ? '系统通知设置' : '检查并开启'}
            onPress={() => { void handleRequestPermission(); }}
            disabled={permissionBusy || notificationTestBusy}
            right={<BusySlot busy={permissionBusy} />}
            testID="notification-permission-button"
          />
          <SettingsRow
            label="发送测试提醒"
            onPress={() => { void handleTestNotification(); }}
            disabled={permissionBusy || notificationTestBusy}
            right={<BusySlot busy={notificationTestBusy} />}
            showChevron={false}
            last
            testID="notification-test-button"
          />
        </SettingsGroup>

        <View style={s.sectionHeader}>
          <Text style={s.sectionLabelText}>默认提醒</Text>
          <BusySlot busy={reminderSaving} />
        </View>
        <SettingsGroup style={s.groupAfterLabel} testID="notification-reminder-group">
          {REMINDER_OPTIONS.map((option, index) => {
            const selected = option.value === defaultReminder;
            return (
              <SettingsRow
                key={option.label}
                label={option.label}
                onPress={() => { void handleReminderChoice(option.value); }}
                disabled={reminderSaving}
                selected={selected}
                showChevron={false}
                last={index === REMINDER_OPTIONS.length - 1}
                height={52}
                right={(
                  <View style={s.checkSlot}>
                    {selected ? <Ionicons name="checkmark" size={24} color={F.primary} /> : null}
                  </View>
                )}
                testID={`notification-reminder-${option.value ?? 'none'}`}
              />
            );
          })}
        </SettingsGroup>
      </ScrollView>
    </ScreenContainer>
  );
}

function BusySlot({ busy }: { busy: boolean }) {
  return (
    <View style={s.busySlot}>
      {busy ? <ActivityIndicator size="small" color={F.primary} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 32 },
  sectionLabel: { paddingLeft: 16, paddingTop: 16, paddingBottom: 4, fontSize: 14, lineHeight: 20, color: F.textCaption },
  sectionHeader: { minHeight: 40, marginTop: 8, paddingLeft: 16, paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabelText: { fontSize: 14, lineHeight: 20, color: F.textCaption },
  groupAfterLabel: { marginTop: 0 },
  busySlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  checkSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
});
