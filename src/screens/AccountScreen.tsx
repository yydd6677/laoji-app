import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { ScreenContainer } from '../components/ScreenContainer';
import { RootStackParamList } from '../types';
import { BackHeader } from '../components/Common';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { labelForReminder, loadNotificationPrefs, ReminderMinutes } from '../services/notifications';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Account'>;
  route?: RouteProp<RootStackParamList, 'Account'>;
};

export function AccountScreen({ navigation, route }: Props) {
  const { isGuest, mode, session, signOut } = useAuth();
  const { showDialog } = useAppDialog();
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(15);
  const notificationScope = mode === 'authenticated' && session
    ? `user:${session.user.id}`
    : mode === 'guest'
      ? 'guest'
      : 'signed_out';

  const refreshReminder = useCallback(async () => {
    const prefs = await loadNotificationPrefs(notificationScope);
    setDefaultReminder(prefs.defaultReminderMinutes);
  }, [notificationScope]);

  useEffect(() => {
    void refreshReminder();
    const unsubscribe = navigation.addListener?.('focus', () => { void refreshReminder(); });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [navigation, refreshReminder]);

  useEffect(() => {
    if (route?.params?.section === 'deletion' && !isGuest) {
      navigation.navigate('AccountDeletion');
    }
  }, [isGuest, navigation, route?.params?.section]);

  const handleSignOut = () => {
    showDialog({
      title: isGuest ? '退出访客模式' : '退出登录',
      message: '确认返回登录页？',
      tone: 'danger',
      actions: [
        {
          text: '退出',
          role: 'destructive',
          onPress: async () => {
            await signOut();
            navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const openPassword = () => {
    if (isGuest) {
      showDialog({ title: '密码与安全', message: '访客模式没有云端账号密码。', tone: 'info' });
      return;
    }
    navigation.navigate('ChangePassword');
  };

  return (
    <ScreenContainer edges={['top', 'bottom']}>
      <BackHeader title="账号与安全" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <SettingsGroup testID="account-settings-group">
          <SettingsRow
            label="密码与安全"
            value={isGuest ? '访客模式不可用' : '修改密码'}
            onPress={openPassword}
            testID="account-setting-0"
          />
          <SettingsRow
            label="通知与提醒"
            value={`默认${labelForReminder(defaultReminder)}`}
            onPress={() => navigation.navigate('NotificationSettings')}
            last
            testID="account-setting-1"
          />
        </SettingsGroup>

        <SettingsGroup testID="account-session-group">
          <SettingsRow
            label={isGuest ? '退出访客模式' : '退出登录'}
            onPress={handleSignOut}
            centered
            destructive
            last
          />
        </SettingsGroup>

        {!isGuest ? (
          <SettingsGroup testID="account-deletion-group">
            <SettingsRow
              label="删除账号与云端数据"
              onPress={() => navigation.navigate('AccountDeletion')}
              centered
              destructive
              last
              accessibilityLabel="删除账号与云端数据"
              testID="open-account-deletion"
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 32 },
});
