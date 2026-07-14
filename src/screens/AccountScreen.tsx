import React, { useState, useEffect } from 'react';
import { ActivityIndicator, Modal, View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { BackHeader } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { changePassword } from '../services/auth';
import { readableErrorMessage } from '../services/errors';
import {
  REMINDER_OPTIONS,
  ReminderMinutes,
  ensureNotificationPermission,
  getNotificationPermissionStatus,
  labelForReminder,
  loadNotificationPrefs,
  openNotificationSettings,
  saveNotificationPrefs,
  scheduleTestNotification,
} from '../services/notifications';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Account'>;
  route?: RouteProp<RootStackParamList, 'Account'>;
};

export function AccountScreen({ navigation, route }: Props) {
  const { isGuest, mode, session, accessToken, signOut, deleteAccount } = useAuth();
  const { showDialog } = useAppDialog();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notificationVisible, setNotificationVisible] = useState(false);
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(15);
  const [permissionStatus, setPermissionStatus] = useState('unknown');
  const [reminderSaving, setReminderSaving] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [notificationTestBusy, setNotificationTestBusy] = useState(false);
  const notificationScope = mode === 'authenticated' && session ? `user:${session.user.id}` : mode === 'guest' ? 'guest' : 'signed_out';
  const staticFields = [
    {
      l: '密码与安全',
      v: isGuest ? '访客模式不可用' : '修改密码',
      onPress: () => {
        if (isGuest) {
          showDialog({ title: '密码与安全', message: '访客模式没有云端账号密码。', tone: 'info' });
          return;
        }
        setPasswordVisible(true);
      },
    },
    {
      l: '通知与提醒',
      v: `默认${labelForReminder(defaultReminder)}`,
      onPress: () => {
        void refreshNotificationState();
        setNotificationVisible(true);
      },
    },
  ];

  useEffect(() => {
    void refreshNotificationState();
  }, [notificationScope]);

  useEffect(() => {
    if (route?.params?.section === 'deletion' && !isGuest) {
      setDeleteVisible(true);
    }
  }, [isGuest, route?.params?.section]);

  async function refreshNotificationState() {
    const [prefs, status] = await Promise.all([
      loadNotificationPrefs(notificationScope),
      getNotificationPermissionStatus().catch(() => 'unknown'),
    ]);
    setDefaultReminder(prefs.defaultReminderMinutes);
    setPermissionStatus(status);
  }

  const handleChangePassword = async () => {
    if (!accessToken) return;
    if (!currentPassword || !newPassword) {
      showDialog({ title: '请输入密码', message: '当前密码和新密码都需要填写。', tone: 'info' });
      return;
    }
    if (newPassword.length < 8) {
      showDialog({ title: '新密码过短', message: '新密码至少需要 8 位。', tone: 'warning' });
      return;
    }
    if (newPassword !== confirmPassword) {
      showDialog({ title: '两次密码不一致', message: '请重新确认新密码。', tone: 'warning' });
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(accessToken, currentPassword, newPassword);
      setPasswordVisible(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      showDialog({ title: '密码已修改', message: '下次登录请使用新密码。', tone: 'success' });
    } catch (err) {
      showDialog({ title: '修改失败', message: readableErrorMessage(err, '请检查当前密码后重试。'), tone: 'error' });
    } finally {
      setPasswordBusy(false);
    }
  };

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

  const handleRequestPermission = async () => {
    if (permissionBusy) return;
    setPermissionBusy(true);
    try {
      if (permissionStatus === 'granted') {
        try {
          await openNotificationSettings();
        } catch {
          showDialog({
            title: '无法打开系统设置',
            message: '请在手机设置的应用管理中找到“老记”，再进入通知管理。',
            tone: 'error',
          });
        }
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
          {
            text: '打开系统设置',
            role: 'primary',
            onPress: async () => {
              try {
                await openNotificationSettings();
              } catch {
                showDialog({
                  title: '无法打开系统设置',
                  message: '请在手机设置的应用管理中找到“老记”，再进入通知管理。',
                  tone: 'error',
                });
              }
            },
          },
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
      showDialog({
        title: '测试提醒已安排',
        message: '老记将在 3 秒后发送一条系统通知。',
        tone: 'success',
      });
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

  const closeDeleteSheet = () => {
    if (deleteBusy) return;
    setDeleteVisible(false);
    setDeletePassword('');
    setDeleteConfirmation('');
  };

  const handleDeleteAccount = async () => {
    if (isGuest || !accessToken) return;
    if (!deletePassword) {
      showDialog({ title: '请输入当前密码', message: '删除账号前需要重新验证当前密码。', tone: 'warning' });
      return;
    }
    if (deleteConfirmation !== '删除账号') {
      showDialog({ title: '确认文字不匹配', message: '请完整输入“删除账号”四个字。', tone: 'warning' });
      return;
    }
    setDeleteBusy(true);
    try {
      const result = await deleteAccount(deletePassword, deleteConfirmation);
      setDeleteVisible(false);
      setDeletePassword('');
      setDeleteConfirmation('');
      navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
      const localCleanupFailed = result.local_cleanup_failed ?? 0;
      showDialog({
        title: '账号已删除',
        message: localCleanupFailed > 0
          ? `账号与云端数据已删除，但有 ${localCleanupFailed} 项本机清理失败。请在系统设置中清除老记的应用存储。`
          : result.cleanup_pending > 0
            ? '账号与云端数据已删除，少量不可访问文件已进入服务端自动清理队列。'
            : '账号、云端日程、会议资料和本机缓存均已删除。',
        tone: localCleanupFailed > 0 ? 'warning' : 'success',
      });
    } catch (err) {
      showDialog({
        title: '账号尚未删除',
        message: readableErrorMessage(err, '请检查密码和网络后重试。你的登录态与数据没有被本机清除。'),
        tone: 'error',
      });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="账号与安全"
        onBack={() => navigation.goBack()}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.fieldsCard}>
          {staticFields.map((f, i) => (
            <TouchableOpacity
              key={f.l}
              style={[s.fieldRow, i < staticFields.length - 1 && s.fieldBorder]}
              onPress={f.onPress}
              activeOpacity={0.75}
            >
              <Text style={s.fieldLabel}>{f.l}</Text>
              <Text style={s.fieldValue} numberOfLines={1}>{f.v}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={s.logoutBtn}
          onPress={handleSignOut}
        >
          <Text style={s.logoutText}>{isGuest ? '退出访客模式' : '退出登录'}</Text>
        </TouchableOpacity>
        {!isGuest ? (
          <TouchableOpacity
            style={s.deleteAccountBtn}
            onPress={() => setDeleteVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="删除账号与云端数据"
            testID="open-account-deletion"
          >
            <Ionicons name="trash-outline" size={17} color={C.red} />
            <Text style={s.deleteAccountText}>删除账号与云端数据</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
      <BottomTabBar active="schedule" onSchedule={() => openScheduleTab(navigation)} onMeetings={() => openMeetingsTab(navigation)} />
      <PasswordSheet
        visible={passwordVisible}
        busy={passwordBusy}
        currentPassword={currentPassword}
        newPassword={newPassword}
        confirmPassword={confirmPassword}
        onCurrentPassword={setCurrentPassword}
        onNewPassword={setNewPassword}
        onConfirmPassword={setConfirmPassword}
        onClose={() => setPasswordVisible(false)}
        onSubmit={handleChangePassword}
      />
      <NotificationSheet
        visible={notificationVisible}
        permissionStatus={permissionStatus}
        defaultReminder={defaultReminder}
        reminderSaving={reminderSaving}
        permissionBusy={permissionBusy}
        notificationTestBusy={notificationTestBusy}
        onChoice={handleReminderChoice}
        onPermission={handleRequestPermission}
        onTestNotification={handleTestNotification}
        onClose={() => setNotificationVisible(false)}
      />
      <DeleteAccountSheet
        visible={deleteVisible}
        busy={deleteBusy}
        password={deletePassword}
        confirmation={deleteConfirmation}
        onPassword={setDeletePassword}
        onConfirmation={setDeleteConfirmation}
        onClose={closeDeleteSheet}
        onSubmit={handleDeleteAccount}
      />
    </ScreenContainer>
  );
}

function SheetFrame({ visible, title, children, onClose }: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalOverlay}>
        <SafeAreaView style={s.modalSheet} edges={['bottom']} testID="account-bottom-sheet">
          <View style={s.modalHandle} />
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.modalCloseText}>关闭</Text>
            </TouchableOpacity>
          </View>
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function PasswordSheet({
  visible,
  busy,
  currentPassword,
  newPassword,
  confirmPassword,
  onCurrentPassword,
  onNewPassword,
  onConfirmPassword,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy: boolean;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  onCurrentPassword: (value: string) => void;
  onNewPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <SheetFrame visible={visible} title="修改密码" onClose={onClose}>
      <TextInput style={s.modalInput} value={currentPassword} onChangeText={onCurrentPassword} secureTextEntry placeholder="当前密码" placeholderTextColor={C.faint} />
      <TextInput style={s.modalInput} value={newPassword} onChangeText={onNewPassword} secureTextEntry placeholder="新密码，至少 8 位" placeholderTextColor={C.faint} />
      <TextInput style={s.modalInput} value={confirmPassword} onChangeText={onConfirmPassword} secureTextEntry placeholder="再次输入新密码" placeholderTextColor={C.faint} />
      <TouchableOpacity onPress={onSubmit} disabled={busy} activeOpacity={0.86}>
        <LinearGradient colors={[C.gradFrom, C.gradTo]} start={{ x:0, y:0 }} end={{ x:1, y:0 }} style={s.modalPrimary}>
          <Text style={s.modalPrimaryText}>{busy ? '提交中…' : '确认修改'}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </SheetFrame>
  );
}

function DeleteAccountSheet({
  visible,
  busy,
  password,
  confirmation,
  onPassword,
  onConfirmation,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy: boolean;
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const ready = password.length >= 6 && confirmation === '删除账号';
  return (
    <SheetFrame visible={visible} title="删除账号" onClose={onClose}>
      <View style={s.deleteWarning}>
        <View style={s.deleteWarningIcon}>
          <Ionicons name="warning-outline" size={20} color={C.red} />
        </View>
        <View style={s.deleteWarningBody}>
          <Text style={s.deleteWarningTitle}>此操作不可撤销</Text>
          <Text style={s.deleteWarningText}>
            将删除账号、云端日程、会议录音、转写、总结、头像和所有登录会话，并清除本机缓存。
          </Text>
        </View>
      </View>
      <TextInput
        style={s.modalInput}
        value={password}
        onChangeText={onPassword}
        secureTextEntry
        autoCapitalize="none"
        placeholder="输入当前密码"
        placeholderTextColor={C.faint}
        editable={!busy}
        testID="account-deletion-password"
      />
      <Text style={s.deleteConfirmHint}>输入“删除账号”以确认</Text>
      <TextInput
        style={s.modalInput}
        value={confirmation}
        onChangeText={onConfirmation}
        autoCapitalize="none"
        placeholder="删除账号"
        placeholderTextColor={C.faint}
        editable={!busy}
        testID="account-deletion-confirmation"
      />
      <TouchableOpacity
        onPress={onSubmit}
        disabled={busy || !ready}
        activeOpacity={0.86}
        style={[s.deleteSubmit, (busy || !ready) && s.deleteSubmitDisabled]}
        accessibilityRole="button"
        testID="confirm-account-deletion"
      >
        {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="trash-outline" size={17} color="#fff" />}
        <Text style={s.deleteSubmitText}>{busy ? '正在删除…' : '永久删除账号'}</Text>
      </TouchableOpacity>
    </SheetFrame>
  );
}

function NotificationSheet({
  visible,
  permissionStatus,
  defaultReminder,
  reminderSaving,
  permissionBusy,
  notificationTestBusy,
  onChoice,
  onPermission,
  onTestNotification,
  onClose,
}: {
  visible: boolean;
  permissionStatus: string;
  defaultReminder: ReminderMinutes;
  reminderSaving: boolean;
  permissionBusy: boolean;
  notificationTestBusy: boolean;
  onChoice: (value: ReminderMinutes) => void | Promise<void>;
  onPermission: () => void | Promise<void>;
  onTestNotification: () => void | Promise<void>;
  onClose: () => void;
}) {
  const permissionText = permissionStatus === 'granted'
    ? '系统通知已开启'
    : permissionStatus === 'denied'
      ? '系统通知未开启'
      : '系统通知状态未知';
  return (
    <SheetFrame visible={visible} title="通知与提醒" onClose={onClose}>
      <View style={s.permissionBox}>
        <Text style={s.permissionTitle}>{permissionText}</Text>
        <Text style={s.permissionDesc}>新建有具体时间的日程会按默认提醒创建本机系统通知。</Text>
        <View style={s.permissionActions}>
          <TouchableOpacity
            style={s.permissionBtn}
            onPress={() => { void onPermission(); }}
            disabled={permissionBusy || notificationTestBusy}
            accessibilityRole="button"
            accessibilityState={{ disabled: permissionBusy || notificationTestBusy, busy: permissionBusy }}
            testID="notification-permission-button"
          >
            {permissionBusy
              ? <ActivityIndicator size="small" color={C.purple} />
              : <>
                  <Ionicons name="settings-outline" size={14} color={C.purple} />
                  <Text style={s.permissionBtnText}>
                    {permissionStatus === 'granted' ? '系统通知设置' : '检查并开启'}
                  </Text>
                </>}
          </TouchableOpacity>
          <TouchableOpacity
            style={s.permissionBtn}
            onPress={() => { void onTestNotification(); }}
            disabled={permissionBusy || notificationTestBusy}
            accessibilityRole="button"
            accessibilityState={{ disabled: permissionBusy || notificationTestBusy, busy: notificationTestBusy }}
            testID="notification-test-button"
          >
            {notificationTestBusy
              ? <ActivityIndicator size="small" color={C.purple} />
              : <>
                  <Ionicons name="notifications-outline" size={14} color={C.purple} />
                  <Text style={s.permissionBtnText}>发送测试提醒</Text>
                </>}
          </TouchableOpacity>
        </View>
      </View>
      <View style={s.reminderHeader}>
        <Text style={s.modalLabel}>默认提醒</Text>
        <View style={s.reminderBusySlot}>
          {reminderSaving ? <ActivityIndicator size="small" color={C.purple} /> : null}
        </View>
      </View>
      <View style={s.reminderGrid}>
        {REMINDER_OPTIONS.map(opt => {
          const selected = opt.value === defaultReminder;
          return (
            <TouchableOpacity
              key={opt.label}
              style={[s.reminderItem, selected && s.reminderSelected]}
              onPress={() => { void onChoice(opt.value); }}
              disabled={reminderSaving}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: reminderSaving, busy: reminderSaving }}
              testID={`notification-reminder-${opt.value ?? 'none'}`}
            >
              <Text style={[s.reminderText, selected && s.reminderSelectedText]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SheetFrame>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 14, paddingTop: 18, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  fieldsCard: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', marginBottom: 28, shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16 },
  fieldBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  fieldLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: C.text },
  fieldValue: { flexShrink: 1, minWidth: 0, fontSize: 13, color: C.sub, marginRight: 8 },
  logoutBtn: { alignItems: 'center', paddingVertical: 8 },
  logoutText: { fontSize: 14, color: C.red, fontWeight: '500' },
  deleteAccountBtn: { minHeight: 46, marginTop: 8, marginBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  deleteAccountText: { fontSize: 13, color: C.red, fontWeight: '700' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(28,27,51,0.34)' },
  modalSheet: { backgroundColor: C.card, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 34, maxHeight: '86%' },
  modalHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: '#E0D8F0', alignSelf: 'center', marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  modalCloseText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  modalInput: { height: 50, borderRadius: 15, backgroundColor: C.inputBg, paddingHorizontal: 15, marginBottom: 12, color: C.text, fontSize: 14 },
  modalPrimary: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  modalPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  deleteWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderRadius: 16, backgroundColor: '#FFF1F1', padding: 14, marginBottom: 14 },
  deleteWarningIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#FFE1E1', alignItems: 'center', justifyContent: 'center' },
  deleteWarningBody: { flex: 1, minWidth: 0 },
  deleteWarningTitle: { fontSize: 14, color: C.red, fontWeight: '800', marginBottom: 4 },
  deleteWarningText: { fontSize: 12, lineHeight: 19, color: '#6F4A55' },
  deleteConfirmHint: { fontSize: 12, lineHeight: 18, color: C.sub, marginBottom: 7, paddingHorizontal: 2 },
  deleteSubmit: { height: 50, borderRadius: 25, backgroundColor: C.red, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 6 },
  deleteSubmitDisabled: { opacity: 0.42 },
  deleteSubmitText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  permissionBox: { borderRadius: 18, backgroundColor: C.waveformBg, padding: 15, marginBottom: 16 },
  permissionTitle: { fontSize: 15, fontWeight: '800', color: C.text, marginBottom: 5 },
  permissionDesc: { fontSize: 12, color: C.sub, lineHeight: 18, marginBottom: 12 },
  permissionActions: { flexDirection: 'row', gap: 8 },
  permissionBtn: { flex: 1, minWidth: 0, height: 36, backgroundColor: C.card, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 9 },
  permissionBtnText: { fontSize: 12, color: C.purple, fontWeight: '800' },
  reminderHeader: { minHeight: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  reminderBusySlot: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  modalLabel: { fontSize: 13, color: C.sub, fontWeight: '700' },
  reminderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  reminderItem: { minWidth: '30%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', backgroundColor: C.inputBg },
  reminderSelected: { backgroundColor: C.purple },
  reminderText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  reminderSelectedText: { color: '#fff' },
});
