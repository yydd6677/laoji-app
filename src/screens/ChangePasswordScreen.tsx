import React, { useState } from 'react';
import {
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
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { FeishuSaveAction, FeishuSaveState } from '../components/FeishuForm';
import { AppToast } from '../components/AppToast';
import { SettingsTitleBar } from '../components/SettingsGroup';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { changePassword } from '../services/auth';
import { readableErrorMessage } from '../services/errors';
import { RootStackParamList } from '../types';
import { FEISHU_DIMENSIONS, getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-FORM-001 / UI-SHELL-001: validation and submit lifecycle map to the three save states.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ChangePassword'>;
};

export const ACCOUNT_SECURITY_GEOMETRY = {
  pagePadding: 16,
  inputHeight: 48,
  actionHeight: 48,
  actionRadius: 6,
} as const;

export function ChangePasswordScreen({ navigation }: Props) {
  const { accessToken } = useAuth();
  const { showDialog } = useAppDialog();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [validationToast, setValidationToast] = useState<{ key: number; message: string } | null>(null);
  const formValid = Boolean(accessToken)
    && Boolean(currentPassword)
    && newPassword.length >= 8
    && newPassword === confirmPassword;
  const saveState: FeishuSaveState = busy
    ? 'fully-disabled'
    : formValid
      ? 'enabled'
      : 'disabled-with-toast';

  const explainDisabledSave = () => {
    let message = '';
    if (!accessToken) message = '当前登录状态不可用，请重新登录后再试';
    else if (!currentPassword || !newPassword || !confirmPassword) message = '请填写当前密码、新密码和确认密码';
    else if (newPassword.length < 8) message = '新密码至少需要 8 位';
    else if (newPassword !== confirmPassword) message = '两次输入的新密码不一致';
    if (message) {
      setValidationToast(current => ({ key: (current?.key ?? 0) + 1, message }));
    }
  };

  const handleSubmit = async () => {
    if (!accessToken) {
      showDialog({ title: '无法修改密码', message: '当前登录状态不可用，请重新登录后再试。', tone: 'warning' });
      return;
    }
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

    setBusy(true);
    try {
      await changePassword(accessToken, currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      navigation.goBack();
      showDialog({ title: '密码已修改', message: '下次登录请使用新密码。', tone: 'success' });
    } catch (error) {
      showDialog({ title: '修改失败', message: readableErrorMessage(error, '请检查当前密码后重试。'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar
        title="修改密码"
        onBack={() => navigation.goBack()}
        trailing={(
          <View style={s.titleActionSlot} testID="change-password-footer">
            <FeishuSaveAction
              state={saveState}
              label={busy ? '保存中' : '保存'}
              onSave={() => { void handleSubmit(); }}
              onDisabledPress={explainDisabledSave}
              disabledHint="填写并确认新密码后保存"
              testID="change-password-submit"
            />
          </View>
        )}
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          testID="change-password-page"
        >
          <View style={s.formSurface}>
            <PasswordField
              label="当前密码"
              placeholder="输入当前密码"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              editable={!busy}
              testID="change-password-current"
            />
            <PasswordField
              label="新密码"
              placeholder="至少 8 位"
              value={newPassword}
              onChangeText={setNewPassword}
              editable={!busy}
              testID="change-password-new"
            />
            <PasswordField
              label="确认新密码"
              placeholder="再次输入"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              editable={!busy}
              testID="change-password-confirm"
              last
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <AppToast
        visible={validationToast !== null}
        message={validationToast?.message ?? ''}
        presentationKey={validationToast?.key ?? 0}
        onDismiss={() => setValidationToast(null)}
        bottom={24}
        testID="change-password-validation-toast"
      />
    </ScreenContainer>
  );
}

function PasswordField({ label, placeholder, value, onChangeText, editable, testID, last = false }: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  editable: boolean;
  testID: string;
  last?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={[s.field, last && s.lastField]} testID={`${testID}-field`}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={F.textPlaceholder}
        accessibilityLabel={label}
        testID={testID}
      />
      <TouchableOpacity
        style={s.visibilityButton}
        onPress={() => setVisible(current => !current)}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={visible ? `隐藏${label}` : `显示${label}`}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={18} color={F.iconTertiary} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 12, paddingBottom: 24 },
  formSurface: { backgroundColor: F.backgroundBody },
  field: {
    height: ACCOUNT_SECURITY_GEOMETRY.inputHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: ACCOUNT_SECURITY_GEOMETRY.pagePadding,
    borderBottomWidth: FEISHU_DIMENSIONS.divider,
    borderBottomColor: F.divider,
  },
  lastField: { borderBottomWidth: 0 },
  fieldLabel: { width: 104, fontSize: 16, lineHeight: 22, color: F.textTitle },
  input: { flex: 1, minWidth: 0, height: ACCOUNT_SECURITY_GEOMETRY.inputHeight, paddingVertical: 0, fontSize: 16, color: F.textTitle },
  visibilityButton: { width: 44, height: ACCOUNT_SECURITY_GEOMETRY.inputHeight, alignItems: 'center', justifyContent: 'center' },
  titleActionSlot: { width: FEISHU_DIMENSIONS.saveActionWidth, height: FEISHU_DIMENSIONS.titleBarHeight },
});
