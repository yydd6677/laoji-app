import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsTitleBar } from '../components/SettingsGroup';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { readableErrorMessage } from '../services/errors';
import { RootStackParamList } from '../types';
import { ACCOUNT_SECURITY_GEOMETRY } from './ChangePasswordScreen';
import { FEISHU_DIMENSIONS, getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-FORM-001 / UI-TOKENS-001: destructive confirmation keeps stable input and action slots.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AccountDeletion'>;
};

const CONSEQUENCES = [
  '账号资料与所有登录会话',
  '云端日程与会议资料',
  '会议录音、转写与总结',
  '本机缓存与已调度提醒',
];

export function AccountDeletionScreen({ navigation }: Props) {
  const { isGuest, accessToken, deleteAccount } = useAuth();
  const { showDialog } = useAppDialog();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const confirmationFocusedRef = useRef(false);
  const ready = !isGuest && Boolean(accessToken) && password.length >= 6 && confirmation === '删除账号';

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      if (confirmationFocusedRef.current) {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
    });
    return () => shown.remove();
  }, []);

  const handleDelete = async () => {
    if (isGuest || !accessToken) {
      showDialog({ title: '无法删除账号', message: '当前没有可删除的云端账号。', tone: 'warning' });
      return;
    }
    if (!password) {
      showDialog({ title: '请输入当前密码', message: '删除账号前需要重新验证当前密码。', tone: 'warning' });
      return;
    }
    if (confirmation !== '删除账号') {
      showDialog({ title: '确认文字不匹配', message: '请完整输入“删除账号”四个字。', tone: 'warning' });
      return;
    }

    setBusy(true);
    try {
      const result = await deleteAccount(password, confirmation);
      setPassword('');
      setConfirmation('');
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
    } catch (error) {
      showDialog({
        title: '账号尚未删除',
        message: readableErrorMessage(error, '请检查密码和网络后重试。你的登录态与数据没有被本机清除。'),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar title="删除账号" onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'android' ? 20 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={s.flex}
          contentContainerStyle={s.content}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          testID="account-deletion-page"
        >
          <View style={s.notice} testID="account-deletion-notice">
            <Text style={s.noticeTitle}>删除后无法恢复</Text>
            <Text style={s.noticeText}>账号删除后，以下数据将被永久删除，该操作不可撤销。</Text>
            <View style={s.consequenceList}>
              {CONSEQUENCES.map(item => (
                <View key={item} style={s.consequenceRow}>
                  <View style={s.bullet} />
                  <Text style={s.consequenceText}>{item}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={s.formGroup} testID="account-deletion-form">
            <Text style={s.fieldLabel}>当前密码</Text>
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="输入当前密码"
              placeholderTextColor={F.textPlaceholder}
              editable={!busy}
              accessibilityLabel="当前密码"
              testID="account-deletion-password"
            />
            <Text style={[s.fieldLabel, s.confirmLabel]}>输入“删除账号”以确认</Text>
            <TextInput
              style={s.input}
              value={confirmation}
              onChangeText={setConfirmation}
              onFocus={() => {
                confirmationFocusedRef.current = true;
                requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
              }}
              onBlur={() => { confirmationFocusedRef.current = false; }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="删除账号"
              placeholderTextColor={F.textPlaceholder}
              editable={!busy}
              accessibilityLabel="删除账号确认文字"
              testID="account-deletion-confirmation"
            />
          </View>
        </ScrollView>

        <View style={s.footer} testID="account-deletion-footer">
          <TouchableOpacity
            onPress={() => { void handleDelete(); }}
            disabled={busy || !ready}
            activeOpacity={0.78}
            style={[s.deleteButton, (busy || !ready) && s.deleteButtonDisabled]}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy || !ready }}
            testID="confirm-account-deletion"
          >
            <View style={s.busySlot}>{busy ? <ActivityIndicator size="small" color={F.onPrimary} /> : null}</View>
            <Text style={s.deleteButtonText}>{busy ? '正在删除' : '永久删除账号'}</Text>
            <View style={s.busySlot} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 24 },
  notice: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 4 },
  noticeTitle: { fontSize: 20, lineHeight: 28, fontWeight: '600', color: F.textTitle },
  noticeText: { marginTop: 8, fontSize: 14, lineHeight: 22, color: F.textCaption },
  consequenceList: { marginTop: 12, gap: 8 },
  consequenceRow: { minHeight: 22, flexDirection: 'row', alignItems: 'flex-start' },
  bullet: { width: 4, height: 4, borderRadius: 2, marginTop: 9, marginRight: 10, backgroundColor: F.iconTertiary },
  consequenceText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 22, color: F.textCaption },
  formGroup: { marginTop: 16, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, backgroundColor: F.backgroundBody },
  fieldLabel: { fontSize: 14, lineHeight: 20, color: F.textCaption },
  confirmLabel: { marginTop: 16 },
  input: {
    height: ACCOUNT_SECURITY_GEOMETRY.inputHeight,
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderBottomWidth: FEISHU_DIMENSIONS.divider,
    borderBottomColor: F.divider,
    fontSize: 16,
    color: F.textTitle,
  },
  footer: { padding: 16, borderTopWidth: FEISHU_DIMENSIONS.divider, borderTopColor: F.divider, backgroundColor: F.backgroundBody },
  deleteButton: {
    height: ACCOUNT_SECURITY_GEOMETRY.actionHeight,
    borderRadius: ACCOUNT_SECURITY_GEOMETRY.actionRadius,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: F.danger,
  },
  deleteButtonDisabled: { opacity: 0.42 },
  deleteButtonText: { fontSize: 17, lineHeight: 24, fontWeight: '500', color: F.onPrimary },
  busySlot: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
});
