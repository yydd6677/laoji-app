import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { BackHeader } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import {
  authenticateWithSystem,
  getBiometricUnavailableReason,
  loadPrivacyPrefs,
  savePrivacyPrefs,
} from '../services/privacy';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Privacy'> };

const APP_VERSION = '1.0.0';

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[s.toggle, { backgroundColor: on ? C.purple : '#CCC8E0' }]}
      activeOpacity={0.8}
    >
      <View style={[s.toggleThumb, { left: on ? 23 : 3 }]} />
    </TouchableOpacity>
  );
}

function Row({ e, label, desc, right, border, onPress }: {
  e: string; label: string; desc: string; right: React.ReactNode; border?: boolean; onPress?: () => void;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={[s.row, border && s.rowBorder]} {...(onPress ? { onPress, activeOpacity: 0.7 } : {})}>
      <Text style={s.rowEmoji}>{e}</Text>
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
    });
    return () => { alive = false; };
  }, [scope]);

  const persistPrivacy = async (nextFaceId: boolean, nextAppLock: boolean) => {
    setFaceId(nextFaceId);
    setAppLock(nextAppLock);
    await savePrivacyPrefs(scope, { biometricEnabled: nextFaceId, appLockEnabled: nextAppLock });
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
      await persistPrivacy(false, false);
      showDialog({ title: '已关闭系统验证', message: '启动时验证也已同步关闭。', tone: 'success' });
      return;
    }
    if (await enableBiometric()) {
      await persistPrivacy(true, appLock);
      showDialog({ title: '已启用系统验证', message: '现在可以用系统生物识别或设备密码验证身份。', tone: 'success' });
    }
  };

  const handleAppLockToggle = async () => {
    if (appLock) {
      await persistPrivacy(faceId, false);
      showDialog({ title: '已关闭启动验证', message: '再次打开老记时不会自动要求验证。', tone: 'success' });
      return;
    }
    const biometricReady = faceId || await enableBiometric();
    if (!biometricReady) return;
    await persistPrivacy(true, true);
    showDialog({ title: '已开启启动验证', message: '老记进入前台后会要求系统验证。', tone: 'success' });
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
            await AsyncStorage.clear();
            await signOut();
            navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader title="隐私与帮助" onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={{ padding: 14 }} showsVerticalScrollIndicator={false}>
        <Section title="隐私与权限管理" items={[
          <Row key="1" border e="🗂️" label="数据权限管理" desc="账号日程云端保存，访客日程仅本机保存" right={arrow}
            onPress={() => showDialog({ title: '数据权限管理', message: '登录账号的日程会同步到老记日程服务；访客模式只保存在本机。会议转写与总结来自外部会议服务。', tone: 'info' })} />,
          <Row key="2" border e="🎙️" label="录音隐私设置" desc="语音能力来自外部 ASR 服务" right={arrow}
            onPress={() => showDialog({ title: '录音隐私设置', message: '老记 App 只负责采集语音并调用外部语音接口。语音识别服务端能力不属于 App 模块。', tone: 'info' })} />,
          <Row key="3" border e="📤" label="文件分享权限" desc="使用系统分享面板确认接收方" right={arrow}
            onPress={() => showDialog({ title: '文件分享权限', message: '分享转写或总结时会打开系统分享面板，由你选择接收应用和对象。', tone: 'info' })} />,
          <Row key="4" border e="🔐" label="系统验证" desc="使用系统指纹、面容或设备密码验证"
            right={<Toggle on={faceId} onToggle={handleFaceIdToggle} />} />,
          <Row key="5" border e="🔒" label="启动时验证" desc="打开老记时先验证身份"
            right={<Toggle on={appLock} onToggle={handleAppLockToggle} />} />,
          <Row key="6" e="🧹" label="清除本机数据" desc="清除缓存、访客日程与本地资料" right={arrow}
            onPress={handleClearLocalData} />,
        ]} />

        <Section title="帮助与支持" items={[
          <Row key="terms" border e="📄" label="用户协议" desc="服务范围、账号和数据删除说明" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'terms' })} />,
          <Row key="privacy" border e="🛡️" label="隐私政策" desc="权限、同步、外部服务和你的控制权" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'privacy' })} />,
          <Row key="1" border e="❓" label="帮助中心" desc="常见问题与解决方案" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'help' })} />,
          <Row key="2" border e="📖" label="使用指南" desc="新手教程与功能介绍" right={arrow}
            onPress={() => navigation.navigate('Legal', { kind: 'guide' })} />,
          <Row key="3" border e="ℹ️" label="版本信息" desc={`当前版本 ${APP_VERSION}`}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={s.newBadge}><Text style={s.newBadgeText}>当前版本</Text></View>
                {arrow}
              </View>
            }
            onPress={() => navigation.navigate('Legal', { kind: 'version' })} />,
          <Row key="4" e="📞" label="联系我们" desc="反馈问题与建议" right={arrow}
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
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: C.sub, marginBottom: 8, paddingLeft: 4 },
  sectionCard: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, paddingHorizontal: 16 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  rowEmoji: { fontSize: 18, width: 28, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: C.text },
  rowDesc: { fontSize: 11, color: C.sub, marginTop: 2 },
  toggle: { width: 46, height: 26, borderRadius: 13, justifyContent: 'center' },
  toggleThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor: '#000', shadowOffset:{width:0,height:1}, shadowOpacity:0.18, shadowRadius:2, elevation:2 },
  newBadge: { backgroundColor: C.purpleLight, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  newBadgeText: { fontSize: 10, color: C.purple, fontWeight: '600' },
});
