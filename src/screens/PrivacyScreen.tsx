import React, { useState, useEffect } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { SettingsGroup, SettingsRow, SettingsTitleBar } from '../components/SettingsGroup';
import { ThemePickerSheet } from '../components/ThemePickerSheet';
import { useAppDialog } from '../components/AppDialog';
import {
  authenticateWithSystem,
  getBiometricUnavailableReason,
  loadPrivacyPrefs,
  savePrivacyPrefs,
} from '../services/privacy';
import { UI_MOTION } from '../theme/uiTokens';
import { useTheme } from '../theme/ThemeProvider';
import { THEME_LABELS } from '../theme/themeIds';
import { eraseLocalInstallationData } from '../services/localDataEraseCoordinator';
import {
  loadGenerationRetentionPreference,
  saveGenerationRetentionPreference,
} from '../services/generationPrivacy';
import { useAppUpdate } from '../services/appUpdate';

// UI-TOKENS-001 / UI-MOTION-001: privacy controls use semantic colors and fixed motion geometry.

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Privacy'> };

const APP_VERSION = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '未知';

function Toggle({
  label,
  on,
  onToggle,
  disabled,
  testID,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  disabled: boolean;
  testID: string;
}) {
  const { tokens } = useTheme();
  const colors = tokens.colors;
  const progress = React.useRef(new Animated.Value(on ? 1 : 0)).current;

  React.useEffect(() => {
    Animated.timing(progress, {
      toValue: on ? 1 : 0,
      duration: UI_MOTION.fabSegment,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [on, progress]);

  return (
    <TouchableOpacity
      style={s.toggle}
      onPress={onToggle}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={`双击以${on ? '关闭' : '开启'}${label}`}
      accessibilityState={{ checked: on, disabled }}
      testID={testID}
    >
      <View
        style={[s.toggleTrack, { backgroundColor: on ? colors.primary : colors.iconDisabled }]}
        testID={`${testID}-track`}
      />
      <Animated.View
        style={[
          s.toggleThumb,
          {
            backgroundColor: colors.backgroundFloat,
            shadowColor: colors.shadow,
            transform: [{
              translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 16] }),
            }],
          },
        ]}
        testID={`${testID}-thumb`}
      />
    </TouchableOpacity>
  );
}

export function PrivacyScreen({ navigation }: Props) {
  const appUpdate = useAppUpdate();
  const [faceId, setFaceId] = useState(false);
  const [appLock, setAppLock] = useState(false);
  const [hideWidgetTitles, setHideWidgetTitles] = useState(true);
  const [retainGeneratedResults, setRetainGeneratedResults] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const { showDialog } = useAppDialog();
  const { themeId, setTheme, tokens } = useTheme();
  const [themeSheetVisible, setThemeSheetVisible] = useState(false);
  const scope = 'guest' as const;

  useEffect(() => {
    let alive = true;
    Promise.all([loadPrivacyPrefs(scope), loadGenerationRetentionPreference()]).then(([saved, retain]) => {
      if (!alive) return;
      setFaceId(saved.biometricEnabled);
      setAppLock(saved.appLockEnabled);
      setHideWidgetTitles(saved.hideWidgetTitles);
      setRetainGeneratedResults(retain);
    }).catch(() => {
      if (!alive) return;
      showDialog({ title: '读取失败', message: '隐私设置暂时无法读取，请返回后重试。', tone: 'error' });
    });
    return () => { alive = false; };
  }, [scope, showDialog]);

  const handleGenerationRetentionToggle = async () => {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    const next = !retainGeneratedResults;
    try {
      await saveGenerationRetentionPreference(next);
      setRetainGeneratedResults(next);
    } catch {
      showDialog({ title: '设置未保存', message: '生成结果保留设置暂时无法保存，请稍后重试。', tone: 'error' });
    } finally {
      setPrivacyBusy(false);
    }
  };

  const persistPrivacy = async (
    nextFaceId: boolean,
    nextAppLock: boolean,
    nextHideWidgetTitles = hideWidgetTitles,
  ) => {
    try {
      await savePrivacyPrefs(scope, {
        biometricEnabled: nextFaceId,
        appLockEnabled: nextAppLock,
        hideWidgetTitles: nextHideWidgetTitles,
      });
      setFaceId(nextFaceId);
      setAppLock(nextAppLock);
      setHideWidgetTitles(nextHideWidgetTitles);
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
    if (privacyBusy) return;
    setPrivacyBusy(true);
    try {
      if (faceId) {
        await persistPrivacy(false, false);
        return;
      }
      if (await enableBiometric()) {
        await persistPrivacy(true, appLock);
      }
    } finally {
      setPrivacyBusy(false);
    }
  };

  const handleAppLockToggle = async () => {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    try {
      if (appLock) {
        await persistPrivacy(faceId, false);
        return;
      }
      const biometricReady = faceId || await enableBiometric();
      if (!biometricReady) return;
      await persistPrivacy(true, true);
    } finally {
      setPrivacyBusy(false);
    }
  };

  const handleWidgetTitleToggle = async () => {
    if (privacyBusy || !appLock) return;
    setPrivacyBusy(true);
    try {
      await persistPrivacy(faceId, appLock, !hideWidgetTitles);
    } finally {
      setPrivacyBusy(false);
    }
  };

  const handleClearLocalData = () => {
    showDialog({
      title: '清除本机数据',
      message: '将清除本机日程、会议记录、个人资料、隐私偏好和缓存。此操作不会影响手机系统中的其他应用。',
      tone: 'danger',
      actions: [
        {
          text: '清除',
          role: 'destructive',
          onPress: async () => {
            const result = await eraseLocalInstallationData();
            const failures = result.failedSteps.length + (result.remoteCleanup === 'pending' ? 1 : 0);
            showDialog(failures > 0
              ? {
                title: '已退出，清理未完成',
                message: result.remoteCleanup === 'pending'
                  ? '本机文件已清除，但服务端设备数据尚未删除；联网后请再次执行清除本机数据。'
                  : `有 ${failures} 项本机数据未能清除。请在系统设置中清除老记的应用存储后再使用。`,
                tone: 'error',
              }
              : { title: '本机数据已清除', tone: 'success' });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={tokens.colors.backgroundBase}>
      <SettingsTitleBar title="设置" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <SettingsGroup testID="privacy-settings-group">
          <SettingsRow
            label="皮肤主题"
            value={THEME_LABELS[themeId]}
            onPress={() => setThemeSheetVisible(true)}
            testID="privacy-theme-row"
          />
          <SettingsRow
            label="系统验证"
            right={(
              <Toggle
                label="系统验证"
                on={faceId}
                onToggle={handleFaceIdToggle}
                disabled={privacyBusy}
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
                disabled={privacyBusy}
                testID="privacy-app-lock-toggle"
              />
            )}
          />
          {appLock ? (
            <SettingsRow
              label="锁屏隐藏标题"
              right={(
                <Toggle
                  label="锁屏隐藏标题"
                  on={hideWidgetTitles}
                  onToggle={handleWidgetTitleToggle}
                  disabled={privacyBusy}
                  testID="privacy-widget-title-toggle"
                />
              )}
            />
          ) : null}
          <SettingsRow
            label="保留匿名生成结果"
            right={(
              <Toggle
                label="保留匿名生成结果"
                on={retainGeneratedResults}
                onToggle={() => { void handleGenerationRetentionToggle(); }}
                disabled={privacyBusy}
                testID="privacy-generation-retention-toggle"
              />
            )}
          />
          <SettingsRow label="清除本机数据" onPress={handleClearLocalData} destructive last />
        </SettingsGroup>

        <SettingsGroup testID="support-settings-group">
          <SettingsRow label="用户协议" onPress={() => navigation.navigate('Legal', { kind: 'terms' })} />
          <SettingsRow label="隐私政策" onPress={() => navigation.navigate('Legal', { kind: 'privacy' })} />
          <SettingsRow label="帮助中心" onPress={() => navigation.navigate('Legal', { kind: 'help' })} />
          <SettingsRow
            label="版本信息"
            value={appUpdate.status === 'available' && appUpdate.manifest
              ? `${APP_VERSION} · 有更新`
              : APP_VERSION}
            onPress={() => navigation.navigate('Legal', { kind: 'version' })}
            testID="privacy-version-row"
          />
          <SettingsRow label="联系我们" onPress={() => navigation.navigate('Legal', { kind: 'contact' })} last />
        </SettingsGroup>
      </ScrollView>
      <ThemePickerSheet
        visible={themeSheetVisible}
        selected={themeId}
        onSelect={id => {
          if (id === themeId) {
            setThemeSheetVisible(false);
            return;
          }
          void setTheme(id).catch(() => {
            showDialog({ title: '主题未保存', message: '请重试。', tone: 'error' });
          });
        }}
        onClose={() => setThemeSheetVisible(false)}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 32 },
  toggle: { width: 36, height: 20, justifyContent: 'center' },
  toggleTrack: { position: 'absolute', left: 0, right: 0, top: 3, height: 14, borderRadius: 7 },
  toggleThumb: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 2,
  },
});
