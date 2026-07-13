import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { Avatar } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { readableErrorMessage } from '../services/errors';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export function ProfileScreen({ navigation }: Props) {
  const { events } = useEvents();
  const { meetings } = useMeetings();
  const { profile, isGuest, updateProfile, uploadAvatar, deleteAvatar } = useAuth();
  const { showDialog } = useAppDialog();
  const [nickname, setNickname] = useState(profile.nickname);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone);
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  useEffect(() => {
    setNickname(profile.nickname);
    setEmail(profile.email);
    setPhone(profile.phone);
  }, [profile]);

  const currentYearMonth = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }, []);

  const stats = useMemo(() => {
    const monthlyEvents = events.filter(e => e.startDate.startsWith(currentYearMonth)).length;
    const meetingCount = meetings.length;
    const importantDates = events.filter(e => e.isAllDay !== true).length;
    return [
      { l: '本月日程', v: String(monthlyEvents), u: '个' },
      { l: '会议记录', v: String(meetingCount),   u: '篇' },
      { l: '定时日程', v: String(importantDates), u: '次' },
    ];
  }, [events, meetings, currentYearMonth]);

  const profileDirty = nickname !== profile.nickname
    || email !== profile.email
    || phone !== profile.phone;

  const handleSave = async () => {
    const nextNickname = nickname.trim() || profile.nickname;
    const nextEmail = email.trim();
    const nextPhone = phone.trim();
    if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      showDialog({ title: '邮箱格式不正确', message: '请输入有效邮箱地址，或留空后重新保存。', tone: 'warning' });
      return;
    }
    if (nextPhone && !/^[+\d\s-]{6,20}$/.test(nextPhone)) {
      showDialog({ title: '手机号格式不正确', message: '手机号只能包含数字、空格、加号或短横线。', tone: 'warning' });
      return;
    }
    setSaving(true);
    try {
      await updateProfile({
        ...profile,
        nickname: nextNickname,
        email: nextEmail,
        phone: nextPhone,
        avatarInitial: '',
        avatarInitialManual: false,
      });
      showDialog({
        title: '资料已保存',
        message: isGuest ? '个人资料已保存在本机。' : '个人资料已同步。',
        tone: 'success',
      });
    } catch (error) {
      showDialog({
        title: '资料同步失败',
        message: readableErrorMessage(error, '资料已保存在本机，稍后可重新同步。'),
        tone: 'warning',
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePickAvatar = async () => {
    setAvatarBusy(true);
    try {
      if (Platform.OS === 'ios') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          showDialog({ title: '无法访问相册', message: '请在系统设置中允许老记访问照片后重试。', tone: 'warning' });
          return;
        }
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
      showDialog({ title: '头像已更新', message: isGuest ? '头像已保存在本机。' : '头像已同步。', tone: 'success' });
    } catch (error) {
      showDialog({
        title: '头像更新失败',
        message: readableErrorMessage(error, '请检查图片和网络后重试。'),
        tone: 'warning',
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleDeleteAvatar = async () => {
    setAvatarBusy(true);
    try {
      await deleteAvatar();
      showDialog({ title: '头像已移除', message: '已恢复为默认头像。', tone: 'success' });
    } catch (error) {
      showDialog({ title: '头像移除失败', message: readableErrorMessage(error, '请检查网络后重试。'), tone: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <ScreenContainer edges={['top']}>
      <View style={s.topBar}>
        <View style={{ width: 32 }} />
        <Text style={s.topTitle}>我</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate('Privacy')}
          accessibilityRole="button"
          accessibilityLabel="打开设置"
          testID="profile-open-settings"
        >
          <Ionicons name="settings-outline" size={22} color={C.sub} />
        </TouchableOpacity>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* User card */}
        <View style={s.userCard}>
          <Avatar size={62} profile={profile} />
          <View style={s.userIdentity} testID="profile-identity">
            <View style={s.nameRow}>
              <Text style={s.name} numberOfLines={1} ellipsizeMode="tail" testID="profile-nickname">
                {profile.nickname}
              </Text>
              <LinearGradient colors={isGuest ? ['#FFD700', '#FFA500'] : [C.gradFrom, C.gradTo]} start={{ x:0,y:0 }} end={{ x:1,y:0 }} style={s.vipBadge}>
                <Text style={s.vipText}>{isGuest ? '访客' : '已登录'}</Text>
              </LinearGradient>
            </View>
            <Text style={s.email} numberOfLines={1} ellipsizeMode="middle" testID="profile-email">
              {isGuest ? '未登录账号' : profile.email || profile.phone || '未设置联系方式'}
            </Text>
          </View>
        </View>

        {/* Stats */}
        <View style={s.statsCard}>
          {stats.map((stat, i) => (
            <View key={stat.l} style={[s.statItem, i < stats.length - 1 && s.statBorder]}>
              <Text style={s.statLabel}>{stat.l}</Text>
              <Text style={s.statValue}>{stat.v}<Text style={s.statUnit}> {stat.u}</Text></Text>
            </View>
          ))}
        </View>

        <View style={s.profileFieldsCard}>
          <View style={[s.profileFieldRow, s.profileFieldBorder]}>
            <View style={s.profileFieldLabelWrap}>
              <Ionicons name="image-outline" size={18} color={C.purple} />
              <Text style={s.profileFieldLabel}>头像</Text>
            </View>
            <View style={s.avatarActions}>
              <View style={s.avatarPreview} accessibilityElementsHidden>
                <Avatar size={42} profile={profile} />
                {avatarBusy ? (
                  <View style={s.avatarBusy}>
                    <ActivityIndicator size="small" color="#fff" />
                  </View>
                ) : null}
              </View>
              <TouchableOpacity
                style={s.avatarAction}
                onPress={handlePickAvatar}
                disabled={avatarBusy}
                accessibilityRole="button"
                accessibilityLabel="更换头像"
                accessibilityState={{ disabled: avatarBusy, busy: avatarBusy }}
                testID="profile-avatar-picker"
              >
                <Text style={s.avatarActionText}>更换</Text>
              </TouchableOpacity>
              {profile.avatarUrl || profile.avatarLocalUri ? (
                <TouchableOpacity
                  style={s.avatarRemove}
                  onPress={handleDeleteAvatar}
                  disabled={avatarBusy}
                  accessibilityRole="button"
                  accessibilityLabel="移除头像"
                  accessibilityState={{ disabled: avatarBusy, busy: avatarBusy }}
                >
                  <Ionicons name="trash-outline" size={16} color={C.red} />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <ProfileField
            icon="person-outline"
            label="昵称"
            value={nickname}
            onChangeText={setNickname}
            placeholder="请输入昵称"
            maxLength={40}
            testID="profile-nickname-input"
          />
          <ProfileField
            icon="mail-outline"
            label="邮箱"
            value={email}
            onChangeText={setEmail}
            placeholder="未设置"
            maxLength={120}
            keyboardType="email-address"
            testID="profile-email-input"
          />
          <ProfileField
            icon="phone-portrait-outline"
            label="手机号"
            value={phone}
            onChangeText={setPhone}
            placeholder="未设置"
            maxLength={20}
            keyboardType="phone-pad"
            border={false}
            testID="profile-phone-input"
          />
        </View>

        <TouchableOpacity
          style={[s.saveProfileButton, (!profileDirty || saving) && s.saveProfileButtonDisabled]}
          onPress={handleSave}
          disabled={!profileDirty || saving}
          accessibilityRole="button"
          accessibilityLabel="保存个人资料"
          accessibilityState={{ disabled: !profileDirty || saving, busy: saving }}
          testID="profile-save"
        >
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={18} color="#fff" />}
          <Text style={s.saveProfileText}>{saving ? '保存中' : '保存修改'}</Text>
        </TouchableOpacity>

      </ScrollView>

      <BottomTabBar
        active="schedule"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
      />
    </ScreenContainer>
  );
}

function ProfileField({ icon, label, value, onChangeText, placeholder, maxLength, keyboardType, border = true, testID }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  maxLength: number;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  border?: boolean;
  testID: string;
}) {
  return (
    <View style={[s.profileFieldRow, border && s.profileFieldBorder]}>
      <View style={s.profileFieldLabelWrap}>
        <Ionicons name={icon} size={18} color={C.purple} />
        <Text style={s.profileFieldLabel}>{label}</Text>
      </View>
      <TextInput
        style={s.profileFieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        maxLength={maxLength}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'sentences'}
        textAlign="right"
        testID={testID}
        accessibilityLabel={label}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  topTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  scroll: { flex: 1 },
  content: { paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  userCard: { marginHorizontal: 14, marginBottom: 12, backgroundColor: C.card, borderRadius: 20, padding: 18, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: '#6432B4', shadowOffset:{width:0,height:2}, shadowOpacity:0.08, shadowRadius:14, elevation:3 },
  userIdentity: { flex: 1, minWidth: 0 },
  nameRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  name: { minWidth: 0, flexShrink: 1, fontSize: 18, fontWeight: '800', color: C.text },
  vipBadge: { flexShrink: 0, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  vipText: { fontSize: 10, fontWeight: '800', color: '#fff' },
  email: { minWidth: 0, flexShrink: 1, fontSize: 12, color: C.sub },
  statsCard: { marginHorizontal: 14, marginBottom: 12, backgroundColor: C.card, borderRadius: 18, padding: 18, paddingHorizontal: 16, flexDirection: 'row', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  statItem: { flex: 1, alignItems: 'center', paddingHorizontal: 6 },
  statBorder: { borderRightWidth: 1, borderRightColor: C.border },
  statLabel: { fontSize: 10, color: C.sub, marginBottom: 8, lineHeight: 14, textAlign: 'center' },
  statValue: { fontSize: 26, fontWeight: '800', color: C.text, lineHeight: 28 },
  statUnit: { fontSize: 11, fontWeight: '500' },
  profileFieldsCard: { marginHorizontal: 14, backgroundColor: C.card, borderRadius: 18, overflow: 'hidden', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  profileFieldRow: { minHeight: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  profileFieldBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  profileFieldLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  profileFieldLabel: { fontSize: 14, fontWeight: '600', color: C.text },
  profileFieldInput: { flex: 1, minWidth: 0, paddingVertical: 10, fontSize: 13, color: C.text },
  avatarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatarPreview: { width: 42, height: 42 },
  avatarBusy: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 21, backgroundColor: 'rgba(28,27,51,0.32)', alignItems: 'center', justifyContent: 'center' },
  avatarAction: { paddingHorizontal: 4, paddingVertical: 8 },
  avatarActionText: { fontSize: 12, color: C.purple, fontWeight: '700' },
  avatarRemove: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  saveProfileButton: { height: 48, marginHorizontal: 14, marginTop: 12, marginBottom: 12, borderRadius: 14, backgroundColor: C.purple, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  saveProfileButtonDisabled: { backgroundColor: '#BDB7CF' },
  saveProfileText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
