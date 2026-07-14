import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { BackHeader } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
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

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[s.toggle, { backgroundColor: on ? C.purple : '#CCC8E0' }]}
      activeOpacity={0.8}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={`双击以${on ? '关闭' : '开启'}${label}`}
      accessibilityState={{ checked: on }}
    >
      <View style={[s.toggleThumb, { left: on ? 23 : 3 }]} />
    </TouchableOpacity>
  );
}

function Row({ icon, label, desc, right, border, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  desc: string;
  right: React.ReactNode;
  border?: boolean;
  onPress?: () => void;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={[s.row, border && s.rowBorder]} {...(onPress ? { onPress, activeOpacity: 0.7 } : {})}>
      <View style={s.rowIcon}>
        <Ionicons name={icon} size={18} color={C.purple} />
      </View>
      <View style={s.rowBody}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowDesc}>{desc}</Text>
      </View>
      {right}
    </Wrapper>
  );
}

function Section({ title, items }: { title: string; items: React.ReactNode[] }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionCard}>{items}</View>
    </View>
  );
}

const arrow = <Ionicons name="chevron-forward" size={16} color={C.faint} />;

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
    <ScreenContainer edges={['top']}>
      <BackHeader title="设置" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Section title="隐私与权限管理" items={[
          <Row key="account-security" border icon="key-outline" label="账号与安全"
            desc={mode === 'authenticated' ? '密码、通知、退出与账号删除' : '通知、访客模式与本机数据'} right={arrow}
            onPress={() => navigation.navigate('Account')} />,
          <Row key="1" border icon="folder-open-outline" label="数据存储说明" desc="账号数据按用户隔离，访客数据仅保存在本机" right={<Ionicons name="information-circle-outline" size={18} color={C.faint} />}
            onPress={() => showDialog({ title: '数据存储说明', message: '登录账号的日程、会议列表与资料会按用户隔离；访客日程、会议、转写、总结和录音只保存在本机。登录账号也会缓存已读取的会议内容，断网时可继续查看缓存。', tone: 'info' })} />,
          <Row key="2" border icon="mic-outline" label="录音数据说明" desc="语音会发送到老记语音服务进行转写" right={<Ionicons name="information-circle-outline" size={18} color={C.faint} />}
            onPress={() => showDialog({ title: '录音数据说明', message: '日程语音和会议录音会发送到老记服务器上的语音识别服务。会议录音结束后会先保存在本机；登录账号会尝试上传，访客录音不上传。', tone: 'info' })} />,
          <Row key="3" border icon="share-social-outline" label="文件分享说明" desc="使用系统分享面板确认接收方" right={<Ionicons name="information-circle-outline" size={18} color={C.faint} />}
            onPress={() => showDialog({ title: '文件分享说明', message: '分享会议文档、完整资料包或录音文件时会打开系统分享面板，由你选择接收应用和对象。', tone: 'info' })} />,
          <Row key="4" border icon="finger-print-outline" label="系统验证" desc="使用系统指纹、面容或设备密码验证"
            right={<Toggle label="系统验证" on={faceId} onToggle={handleFaceIdToggle} />} />,
          <Row key="5" border icon="lock-closed-outline" label="启动时验证" desc="打开老记时先验证身份"
            right={<Toggle label="启动时验证" on={appLock} onToggle={handleAppLockToggle} />} />,
          <Row key="6" icon="trash-bin-outline" label="清除本机数据" desc="仅清除缓存、访客日程与本地资料" right={arrow}
            onPress={handleClearLocalData} />,
        ]} />

        <Section title="帮助与支持" items={[
          <Row key="terms" border icon="document-text-outline" label="用户协议" desc="服务范围、账号和数据删除说明" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'terms' })} />,
          <Row key="privacy" border icon="shield-checkmark-outline" label="隐私政策" desc="权限、同步、外部服务和你的控制权" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'privacy' })} />,
          <Row key="1" border icon="help-circle-outline" label="帮助中心" desc="常见问题与解决方案" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'help' })} />,
          <Row key="2" border icon="book-outline" label="使用指南" desc="新手教程与功能介绍" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'guide' })} />,
          <Row key="3" border icon="information-circle-outline" label="版本信息" desc={`当前版本 ${APP_VERSION}`}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={s.newBadge}><Text style={s.newBadgeText}>当前版本</Text></View>
                {arrow}
              </View>
            }
            onPress={() => navigation.navigate('Legal', { kind: 'version' })} />,
          <Row key="4" icon="chatbubble-ellipses-outline" label="联系我们" desc="反馈问题与建议" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'contact' })} />,
        ]} />
        <View style={{ height: 16 }} />
      </ScrollView>
      <BottomTabBar active="schedule" onSchedule={() => openScheduleTab(navigation)} onMeetings={() => openMeetingsTab(navigation)} />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: C.sub, marginBottom: 8, paddingLeft: 4 },
  sectionCard: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, paddingHorizontal: 16 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  rowIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: C.text },
  rowDesc: { fontSize: 11, color: C.sub, marginTop: 2 },
  toggle: { width: 46, height: 26, borderRadius: 13, justifyContent: 'center' },
  toggleThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor: '#000', shadowOffset:{width:0,height:1}, shadowOpacity:0.18, shadowRadius:2, elevation:2 },
  newBadge: { backgroundColor: C.purpleLight, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  newBadgeText: { fontSize: 10, color: C.purple, fontWeight: '600' },
});
