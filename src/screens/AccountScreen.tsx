import React, { useState, useEffect } from 'react';
import { ActivityIndicator, Modal, View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { BackHeader, Avatar } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { AVATAR_PRESETS, profileInitial } from '../services/profile';
import { changePassword } from '../services/auth';
import { readableErrorMessage } from '../services/errors';
import {
  REMINDER_OPTIONS,
  ReminderMinutes,
  ensureNotificationPermission,
  getNotificationPermissionStatus,
  labelForReminder,
  loadNotificationPrefs,
  saveNotificationPrefs,
} from '../services/notifications';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Account'> };

export function AccountScreen({ navigation }: Props) {
  const { profile, isGuest, mode, session, accessToken, updateProfile, uploadAvatar, deleteAvatar, signOut } = useAuth();
  const { showDialog } = useAppDialog();
  const [nickname, setNickname] = useState(profile.nickname);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone);
  const [avatarInitial, setAvatarInitial] = useState(profile.avatarInitial);
  const [avatarColors, setAvatarColors] = useState(profile.avatarColors);
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [notificationVisible, setNotificationVisible] = useState(false);
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(15);
  const [permissionStatus, setPermissionStatus] = useState('unknown');
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
    setNickname(profile.nickname);
    setEmail(profile.email);
    setPhone(profile.phone);
    setAvatarInitial(profile.avatarInitial);
    setAvatarColors(profile.avatarColors);
  }, [profile]);

  useEffect(() => {
    void refreshNotificationState();
  }, [notificationScope]);

  async function refreshNotificationState() {
    const [prefs, status] = await Promise.all([
      loadNotificationPrefs(notificationScope),
      getNotificationPermissionStatus().catch(() => 'unknown'),
    ]);
    setDefaultReminder(prefs.defaultReminderMinutes);
    setPermissionStatus(status);
  }

  const handleSave = async () => {
    setSaving(true);
    const nextNickname = nickname.trim() || profile.nickname;
    const nextEmail = email.trim();
    const nextPhone = phone.trim();
    if (nextEmail && nextEmail !== '访客模式' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      showDialog({ title: '邮箱格式不正确', message: '请输入有效邮箱地址，或留空后重新保存。', tone: 'warning' });
      setSaving(false);
      return;
    }
    if (nextPhone && nextPhone !== '未绑定' && !/^[+\d\s-]{6,20}$/.test(nextPhone)) {
      showDialog({ title: '手机号格式不正确', message: '手机号只能包含数字、空格、加号或短横线。', tone: 'warning' });
      setSaving(false);
      return;
    }
    try {
      await updateProfile({
        ...profile,
        nickname: nextNickname,
        email: nextEmail || profile.email,
        phone: nextPhone || profile.phone,
        avatarInitial: avatarInitial.trim().slice(0, 1) || profileInitial(nextNickname),
        avatarColors,
      });
      showDialog({ title: '保存成功', message: isGuest ? '个人信息已保存在本机' : '个人信息已同步到云端', tone: 'success' });
    } catch (err) {
      showDialog({
        title: '云端同步失败',
        message: readableErrorMessage(err, '资料已保存在本机，但云端同步失败，请稍后重试。'),
        tone: 'warning',
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePickAvatar = async () => {
    setAvatarBusy(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showDialog({ title: '无法访问相册', message: '请在系统设置中允许老记访问照片后重试。', tone: 'warning' });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.82,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      await uploadAvatar(asset.uri, asset.fileName ?? undefined, asset.mimeType ?? undefined);
      showDialog({ title: '头像已更新', message: isGuest ? '头像已保存在本机' : '头像已上传并同步到云端', tone: 'success' });
    } catch (err) {
      showDialog({ title: '头像更新失败', message: readableErrorMessage(err, '请检查网络或稍后重试。'), tone: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleDeleteAvatar = async () => {
    setAvatarBusy(true);
    try {
      await deleteAvatar();
      showDialog({ title: '头像已移除', message: '已恢复为文字头像。', tone: 'success' });
    } catch (err) {
      showDialog({ title: '头像移除失败', message: readableErrorMessage(err, '请检查网络后重试。'), tone: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

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
    setDefaultReminder(value);
    await saveNotificationPrefs(notificationScope, { defaultReminderMinutes: value });
  };

  const handleRequestPermission = async () => {
    const granted = await ensureNotificationPermission();
    const status = await getNotificationPermissionStatus().catch(() => granted ? 'granted' : 'denied');
    setPermissionStatus(status);
    showDialog({
      title: granted ? '通知已开启' : '通知未开启',
      message: granted ? '老记可以为有提醒的日程创建系统通知。' : '未获得系统通知权限，日程提醒不会弹出系统通知。',
      tone: granted ? 'success' : 'warning',
    });
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

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="账号与资料"
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity hitSlop={{ top:8, bottom:8, left:8, right:8 }} onPress={handleSave}>
            <Text style={s.saveLink}>{saving ? '保存中' : '保存'}</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Avatar */}
        <View style={s.avatarCard}>
          <Text style={s.fieldLabel}>头像</Text>
          <View style={s.avatarRight}>
            <TouchableOpacity onPress={handlePickAvatar} disabled={avatarBusy} activeOpacity={0.82}>
              <Avatar size={58} profile={{ ...profile, avatarInitial, avatarColors }} />
              {avatarBusy && <View style={s.avatarBusy}><ActivityIndicator size="small" color="#fff" /></View>}
            </TouchableOpacity>
            <View style={s.avatarEditor}>
              <Text style={s.avatarHint}>头像文字</Text>
              <TextInput
                style={s.avatarInput}
                value={avatarInitial}
                onChangeText={value => setAvatarInitial(value.slice(0, 1))}
                placeholder={profileInitial(nickname)}
                placeholderTextColor={C.faint}
                maxLength={1}
              />
              <TouchableOpacity onPress={handlePickAvatar} disabled={avatarBusy}>
                <Text style={s.avatarAction}>选择图片</Text>
              </TouchableOpacity>
              {(profile.avatarUrl || profile.avatarLocalUri) ? (
                <TouchableOpacity onPress={handleDeleteAvatar} disabled={avatarBusy}>
                  <Text style={s.avatarDelete}>移除图片</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </View>

        <View style={s.avatarPaletteCard}>
          <Text style={s.avatarPaletteTitle}>头像颜色</Text>
          <View style={s.paletteRow}>
            {AVATAR_PRESETS.map(colors => {
              const selected = colors[0] === avatarColors[0] && colors[1] === avatarColors[1];
              return (
                <TouchableOpacity
                  key={colors.join('-')}
                  style={[s.paletteItem, selected && s.paletteSelected]}
                  onPress={() => setAvatarColors(colors)}
                  activeOpacity={0.8}
                >
                  <LinearGradient
                    colors={colors}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={s.paletteDot}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Editable Fields */}
        <View style={s.fieldsCard}>
          {/* Nickname */}
          <View style={[s.fieldRow, s.fieldBorder]}>
            <Text style={s.fieldLabel}>昵称</Text>
            <TextInput
              style={s.fieldInput}
              value={nickname}
              onChangeText={setNickname}
              placeholder="请输入昵称"
              placeholderTextColor={C.faint}
            />
          </View>

          {/* Email */}
          <View style={[s.fieldRow, s.fieldBorder]}>
            <Text style={s.fieldLabel}>邮箱</Text>
            <TextInput
              style={s.fieldInput}
              value={email}
              onChangeText={setEmail}
              placeholder="请输入邮箱"
              placeholderTextColor={C.faint}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View style={[s.fieldRow, s.fieldBorder]}>
            <Text style={s.fieldLabel}>手机号</Text>
            <TextInput
              style={s.fieldInput}
              value={phone}
              onChangeText={setPhone}
              placeholder="请输入手机号"
              placeholderTextColor={C.faint}
              keyboardType="phone-pad"
            />
          </View>

          {/* Static fields */}
          {staticFields.map((f, i) => (
            <TouchableOpacity
              key={f.l}
              style={[s.fieldRow, i < staticFields.length - 1 && s.fieldBorder]}
              onPress={f.onPress}
              activeOpacity={0.75}
            >
              <Text style={s.fieldLabel}>{f.l}</Text>
              <Text style={s.fieldValue}>{f.v}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity activeOpacity={0.85} onPress={handleSave} disabled={saving}>
          <LinearGradient
            colors={['#352070', '#2E1880']}
            start={{ x:0, y:0 }} end={{ x:1, y:0 }}
            style={s.saveBtn}
          >
            <Text style={s.saveBtnText}>{saving ? '保存中…' : '保存修改'}</Text>
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.logoutBtn}
          onPress={handleSignOut}
        >
          <Text style={s.logoutText}>{isGuest ? '退出访客模式' : '退出登录'}</Text>
        </TouchableOpacity>
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
        onChoice={handleReminderChoice}
        onPermission={handleRequestPermission}
        onClose={() => setNotificationVisible(false)}
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
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.modalCloseText}>关闭</Text>
            </TouchableOpacity>
          </View>
          {children}
        </View>
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

function NotificationSheet({
  visible,
  permissionStatus,
  defaultReminder,
  onChoice,
  onPermission,
  onClose,
}: {
  visible: boolean;
  permissionStatus: string;
  defaultReminder: ReminderMinutes;
  onChoice: (value: ReminderMinutes) => void | Promise<void>;
  onPermission: () => void | Promise<void>;
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
        <TouchableOpacity style={s.permissionBtn} onPress={() => { void onPermission(); }}>
          <Text style={s.permissionBtnText}>检查并开启通知</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.modalLabel}>默认提醒</Text>
      <View style={s.reminderGrid}>
        {REMINDER_OPTIONS.map(opt => {
          const selected = opt.value === defaultReminder;
          return (
            <TouchableOpacity key={opt.label} style={[s.reminderItem, selected && s.reminderSelected]} onPress={() => { void onChoice(opt.value); }}>
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
  content: { padding: 14, paddingTop: 18 },
  saveLink: { color: C.purple, fontSize: 15, fontWeight: '700' },
  avatarCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  avatarRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarHint: { fontSize: 13, color: C.sub },
  avatarEditor: { alignItems: 'flex-end', gap: 6 },
  avatarBusy: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 29, backgroundColor: 'rgba(28,27,51,0.28)', alignItems: 'center', justifyContent: 'center' },
  avatarInput: { minWidth: 44, height: 36, borderRadius: 12, backgroundColor: C.inputBg, color: C.text, fontSize: 17, fontWeight: '800', textAlign: 'center', paddingVertical: 0 },
  avatarAction: { fontSize: 12, color: C.purple, fontWeight: '700' },
  avatarDelete: { fontSize: 12, color: C.red, fontWeight: '700' },
  avatarPaletteCard: { backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  avatarPaletteTitle: { fontSize: 14, fontWeight: '700', color: C.text, marginBottom: 12 },
  paletteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  paletteItem: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  paletteSelected: { borderColor: C.purple },
  paletteDot: { width: 28, height: 28, borderRadius: 14 },
  fieldsCard: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', marginBottom: 28, shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16 },
  fieldBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  fieldLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: C.text },
  fieldValue: { fontSize: 13, color: C.sub, marginRight: 8 },
  fieldInput: { flex: 2, fontSize: 13, color: C.text, textAlign: 'right', paddingVertical: 0 },
  saveBtn: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 18, shadowColor: '#352070', shadowOffset:{width:0,height:4}, shadowOpacity:0.35, shadowRadius:10, elevation:5 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  logoutBtn: { alignItems: 'center', paddingVertical: 8 },
  logoutText: { fontSize: 14, color: C.red, fontWeight: '500' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(28,27,51,0.34)' },
  modalSheet: { backgroundColor: C.card, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 34, maxHeight: '86%' },
  modalHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: '#E0D8F0', alignSelf: 'center', marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  modalCloseText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  modalInput: { height: 50, borderRadius: 15, backgroundColor: C.inputBg, paddingHorizontal: 15, marginBottom: 12, color: C.text, fontSize: 14 },
  modalPrimary: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  modalPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  permissionBox: { borderRadius: 18, backgroundColor: C.waveformBg, padding: 15, marginBottom: 16 },
  permissionTitle: { fontSize: 15, fontWeight: '800', color: C.text, marginBottom: 5 },
  permissionDesc: { fontSize: 12, color: C.sub, lineHeight: 18, marginBottom: 12 },
  permissionBtn: { alignSelf: 'flex-start', backgroundColor: C.card, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  permissionBtnText: { fontSize: 12, color: C.purple, fontWeight: '800' },
  modalLabel: { fontSize: 13, color: C.sub, fontWeight: '700', marginBottom: 10 },
  reminderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  reminderItem: { minWidth: '30%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', backgroundColor: C.inputBg },
  reminderSelected: { backgroundColor: C.purple },
  reminderText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  reminderSelectedText: { color: '#fff' },
});
