import React, { useState } from 'react';
import { ActivityIndicator, Platform, View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { Avatar } from '../components/Common';
import { FeishuSheet, FeishuOverlayAction } from '../components/FeishuOverlay';
import {
  SETTINGS_GROUP_GEOMETRY,
  SettingsGroup,
  SettingsRow,
  SettingsTitleBar,
} from '../components/SettingsGroup';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { readableErrorMessage } from '../services/errors';
import { getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-SHELL-001 / UI-OVERLAY-001: profile editing uses the shared shell and role-based sheet.

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export function ProfileScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { profile, uploadAvatar, deleteAvatar } = useAuth();
  const { showDialog } = useAppDialog();
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMenuVisible, setAvatarMenuVisible] = useState(false);

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
    } catch (error) {
      showDialog({ title: '头像移除失败', message: readableErrorMessage(error, '请检查网络后重试。'), tone: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const avatarActions: FeishuOverlayAction[] = [
    {
      key: 'choose-avatar',
      label: '从相册选择',
      role: 'primary',
      onPress: () => { void handlePickAvatar(); },
    },
    ...((profile.avatarUrl || profile.avatarLocalUri) ? [{
      key: 'remove-avatar',
      label: '移除头像',
      role: 'destructive' as const,
      onPress: () => { void handleDeleteAvatar(); },
    }] : []),
  ];

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar
        title="设置"
        onBack={() => navigation.goBack()}
        trailing={(
          <TouchableOpacity
            style={s.headerAction}
            onPress={() => navigation.navigate('Privacy')}
            accessibilityRole="button"
            accessibilityLabel="打开设置"
            testID="profile-open-settings"
          >
            <Ionicons
              name="settings-outline"
              size={24}
              color={F.iconPrimary}
              testID="profile-settings-icon"
            />
          </TouchableOpacity>
        )}
      />

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SettingsGroup testID="profile-settings-group">
          <SettingsRow
            label="头像"
            height={SETTINGS_GROUP_GEOMETRY.avatarRowHeight}
            onPress={() => setAvatarMenuVisible(true)}
            disabled={avatarBusy}
            accessibilityLabel="更换头像"
            testID="profile-avatar-picker"
            right={(
              <View style={s.avatarPreview} accessibilityElementsHidden>
                <Avatar size={40} profile={profile} />
                {avatarBusy ? (
                  <View style={s.avatarBusy}>
                    <ActivityIndicator size="small" color={F.onPrimary} />
                  </View>
                ) : null}
              </View>
            )}
          />
          <SettingsRow
            label="昵称"
            value={profile.nickname}
            height={52}
            onPress={() => navigation.navigate('ProfileField', { field: 'nickname' })}
            accessibilityLabel="编辑昵称"
            testID="profile-nickname-row"
          />
          <SettingsRow
            label="邮箱"
            value={profile.email || '未设置'}
            height={52}
            onPress={() => navigation.navigate('ProfileField', { field: 'email' })}
            accessibilityLabel="编辑邮箱"
            testID="profile-email-row"
          />
          <SettingsRow
            label="手机号"
            value={profile.phone || '未设置'}
            height={52}
            onPress={() => navigation.navigate('ProfileField', { field: 'phone' })}
            accessibilityLabel="编辑手机号"
            last
            testID="profile-phone-row"
          />
        </SettingsGroup>
      </ScrollView>

      <FeishuSheet
        visible={avatarMenuVisible}
        title="头像"
        actions={avatarActions}
        bottomInset={insets.bottom}
        onRequestClose={() => setAvatarMenuVisible(false)}
        testID="profile-avatar-sheet"
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 24 },
  headerAction: { width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  avatarPreview: { width: 40, height: 40 },
  avatarBusy: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 20, backgroundColor: F.backgroundMask, alignItems: 'center', justifyContent: 'center' },
  accountState: { marginTop: 8, marginHorizontal: 16, fontSize: 12, lineHeight: 18, color: F.textCaption },
});
