import React, { useState, useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { BackHeader } from '../components/Common';
import { CalendarSwitch } from '../components/CalendarSwitch';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import {
  authenticateWithSystem,
  getBiometricUnavailableReason,
  loadPrivacyPrefs,
  savePrivacyPrefs,
} from '../services/privacy';
import { clearLocalAppFiles, clearScheduledAppNotifications } from '../services/localData';
import { clearAppStorage } from '../services/appStorage';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Privacy'> };

const APP_VERSION = Constants.expoConfig?.version ?? '未知';

function Toggle({
  label,
  on,
  onToggle,
  testID,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  testID: string;
}) {
  return (
    <CalendarSwitch
      checked={on}
      onChange={onToggle}
      accessibilityLabel={label}
      accessibilityHint={`双击以${on ? '关闭' : '开启'}${label}`}
      testID={testID}
    />
  );
}

export function PrivacyScreen({ navigation }: Props) {
  const [faceId, setFaceId] = useState(false);
  const [appLock, setAppLock] = useState(false);
  const { mode, session, signOut } = useAuth();
  const { showDialog } = useAppDialog();
  const scope = mode === 'authenticated' && session ? `user:${session.user.id}` : mode === 'guest' ? 'guest' : 'signed_out';

  useEffect(() => {
    let alive = true;
    loadPrivacyPrefs(scope).then(saved => {
      if (!alive) return;
      setFaceId(saved.biometricEnabled);
      setAppLock(saved.appLockEnabled);
    }).catch(() => {
      if (!alive) return;
      showDialog({ title: '读取失败', message: '隐私设置暂时无法读取，请返回后重试。', tone: 'error' });
    });
    return () => { alive = false; };
  }, [scope, showDialog]);

  const persistPrivacy = async (nextFaceId: boolean, nextAppLock: boolean) => {
    try {
      await savePrivacyPrefs(scope, { biometricEnabled: nextFaceId, appLockEnabled: nextAppLock });
      setFaceId(nextFaceId);
      setAppLock(nextAppLock);
      return true;
    } catch {
      showDialog({ title: '设置未保存', message: '隐私设置写入失败，请稍后重试。', tone: 'error' });
      return false;
    }
  };

  const enableBiometric = async () => {
    const unavailable = await getBiometricUnavailableReason();
    if (unavailable) {
      showDialog({ title: '无法启用系统验证', message: unavailable, tone: 'warning' });
      return false;
    }
    const ok = await authenticateWithSystem('启用老记系统验证');
    if (!ok) {
      showDialog({ title: '验证未通过', message: '未完成系统验证，因此没有开启该功能。', tone: 'warning' });
      return false;
    }
    return true;
  };

  const handleFaceIdToggle = async () => {
    if (faceId) {
      if (await persistPrivacy(false, false)) {
        showDialog({ title: '已关闭系统验证', message: '启动时验证也已同步关闭。', tone: 'success' });
      }
      return;
    }
    if (await enableBiometric()) {
      if (await persistPrivacy(true, appLock)) {
        showDialog({ title: '已启用系统验证', message: '现在可以用系统生物识别或设备密码验证身份。', tone: 'success' });
      }
    }
  };

  const handleAppLockToggle = async () => {
    if (appLock) {
      if (await persistPrivacy(faceId, false)) {
        showDialog({ title: '已关闭启动验证', message: '再次打开老记时不会自动要求验证。', tone: 'success' });
      }
      return;
    }
    const biometricReady = faceId || await enableBiometric();
    if (!biometricReady) return;
    if (await persistPrivacy(true, true)) {
      showDialog({ title: '已开启启动验证', message: '老记进入前台后会要求系统验证。', tone: 'success' });
    }
  };

  const handleClearLocalData = () => {
    showDialog({
      title: '清除本机数据',
      message: '将清除访客日程、个人资料、隐私偏好和本机缓存，并返回登录页。登录账号的云端日程不会被删除。',
      tone: 'danger',
      actions: [
        {
          text: '清除',
          role: 'destructive',
          onPress: async () => {
            const cleanupResults = await Promise.allSettled([
              clearLocalAppFiles(),
              clearScheduledAppNotifications(),
              clearAppStorage(),
            ]);
            let signOutFailed = false;
            try {
              await signOut();
            } catch {
              signOutFailed = true;
            }
            navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
            const failures = cleanupResults.filter(result => result.status === 'rejected').length
              + (signOutFailed ? 1 : 0);
            showDialog(failures > 0
              ? {
                title: '已退出，清理未完成',
                message: `有 ${failures} 项本机数据未能清除。请在系统设置中清除老记的应用存储后再使用。`,
                tone: 'error',
              }
              : { title: '本机数据已清除', message: '访客资料、会议文件、提醒和缓存均已清除。', tone: 'success' });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top', 'bottom']}>
      <BackHeader title="设置" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <SettingsGroup testID="privacy-settings-group">
          <SettingsRow label="账号与安全" onPress={() => navigation.navigate('Account')} />
          <SettingsRow
            label="数据存储说明"
            onPress={() => showDialog({ title: '数据存储说明', message: '登录账号的日程、会议列表与资料会按用户隔离；访客日程、会议、转写、总结和录音只保存在本机。登录账号也会缓存已读取的会议内容，断网时可继续查看缓存。', tone: 'info' })}
          />
          <SettingsRow
            label="录音数据说明"
            onPress={() => showDialog({ title: '录音数据说明', message: '日程语音和会议录音会发送到老记服务器上的语音识别服务。会议录音结束后会先保存在本机；登录账号会尝试上传，访客录音不上传。', tone: 'info' })}
          />
          <SettingsRow
            label="文件分享说明"
            onPress={() => showDialog({ title: '文件分享说明', message: '分享会议文档、完整资料包或录音文件时会打开系统分享面板，由你选择接收应用和对象。', tone: 'info' })}
          />
          <SettingsRow
            label="系统验证"
            right={(
              <Toggle
                label="系统验证"
                on={faceId}
                onToggle={handleFaceIdToggle}
                testID="privacy-system-verification-toggle"
              />
            )}
          />
          <SettingsRow
            label="启动时验证"
            right={(
              <Toggle
                label="启动时验证"
                on={appLock}
                onToggle={handleAppLockToggle}
                testID="privacy-app-lock-toggle"
              />
            )}
          />
          <SettingsRow label="清除本机数据" onPress={handleClearLocalData} destructive last />
        </SettingsGroup>

        <SettingsGroup testID="support-settings-group">
          <SettingsRow label="用户协议" onPress={() => navigation.navigate('Legal', { kind: 'terms' })} />
          <SettingsRow label="隐私政策" onPress={() => navigation.navigate('Legal', { kind: 'privacy' })} />
          <SettingsRow label="帮助中心" onPress={() => navigation.navigate('Legal', { kind: 'help' })} />
          <SettingsRow label="使用指南" onPress={() => navigation.navigate('Legal', { kind: 'guide' })} />
          <SettingsRow label="版本信息" value={APP_VERSION} onPress={() => navigation.navigate('Legal', { kind: 'version' })} />
          <SettingsRow label="联系我们" onPress={() => navigation.navigate('Legal', { kind: 'contact' })} last />
        </SettingsGroup>
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 32 },
});
