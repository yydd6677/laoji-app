import React, { useState } from 'react';
import {
  ActivityIndicator,
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
import { BackHeader } from '../components/Common';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { changePassword } from '../services/auth';
import { readableErrorMessage } from '../services/errors';
import { Colors as C } from '../theme/colors';
import { RootStackParamList } from '../types';

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
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <BackHeader title="修改密码" onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          testID="change-password-page"
        >
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
            placeholder="输入新密码，至少 8 位"
            value={newPassword}
            onChangeText={setNewPassword}
            editable={!busy}
            testID="change-password-new"
          />
          <PasswordField
            label="确认新密码"
            placeholder="再次输入新密码"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            editable={!busy}
            testID="change-password-confirm"
          />
        </ScrollView>

        <View style={s.footer} testID="change-password-footer">
          <TouchableOpacity
            style={s.primaryButton}
            onPress={() => { void handleSubmit(); }}
            disabled={busy}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            testID="change-password-submit"
          >
            <View style={s.buttonBusySlot}>
              {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
            </View>
            <Text style={s.primaryButtonText}>{busy ? '提交中' : '确认修改'}</Text>
            <View style={s.buttonBusySlot} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function PasswordField({ label, placeholder, value, onChangeText, editable, testID }: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  editable: boolean;
  testID: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={s.field} testID={`${testID}-field`}>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
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
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={18} color={C.faint} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: ACCOUNT_SECURITY_GEOMETRY.pagePadding, paddingTop: 24, paddingBottom: 24 },
  field: {
    height: ACCOUNT_SECURITY_GEOMETRY.inputHeight,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    marginBottom: 16,
  },
  input: { flex: 1, minWidth: 0, height: ACCOUNT_SECURITY_GEOMETRY.inputHeight, paddingVertical: 0, fontSize: 16, color: C.text },
  visibilityButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.body },
  primaryButton: {
    height: ACCOUNT_SECURITY_GEOMETRY.actionHeight,
    borderRadius: ACCOUNT_SECURITY_GEOMETRY.actionRadius,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.primary,
  },
  primaryButtonText: { fontSize: 17, lineHeight: 24, fontWeight: '500', color: '#FFFFFF' },
  buttonBusySlot: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
});
