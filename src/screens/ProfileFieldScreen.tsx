import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { FeishuSaveAction, FeishuSaveState } from '../components/FeishuForm';
import { AppToast } from '../components/AppToast';
import { FeishuTitleBar } from '../components/FeishuShell';
import { EditableProfileField, RootStackParamList } from '../types';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { readableErrorMessage } from '../services/errors';
import { FEISHU_DIMENSIONS, getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-FORM-001 / UI-SHELL-001: field validation drives the title-bar save state.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ProfileField'>;
  route: RouteProp<RootStackParamList, 'ProfileField'>;
};

const FIELD_CONFIG: Record<EditableProfileField, {
  title: string;
  placeholder: string;
  maxLength: number;
  keyboardType: 'default' | 'email-address' | 'phone-pad';
  inputMarginTop: number;
  description?: string;
  clearIconSize: number;
}> = {
  nickname: {
    title: '修改昵称',
    placeholder: '请输入昵称',
    maxLength: 40,
    keyboardType: 'default',
    inputMarginTop: 16,
    clearIconSize: 18,
  },
  email: {
    title: '修改邮箱',
    placeholder: '请输入邮箱',
    maxLength: 120,
    keyboardType: 'email-address',
    inputMarginTop: 16,
    clearIconSize: 18,
  },
  phone: {
    title: '修改手机号',
    placeholder: '请输入手机号或固定电话',
    maxLength: 20,
    keyboardType: 'phone-pad',
    inputMarginTop: 12,
    description: '请输入手机号或固定电话，固定电话请添加区号',
    clearIconSize: 16,
  },
};

export const PROFILE_FIELD_GEOMETRY = {
  inputHeight: 48,
  horizontalMargin: 16,
  textInputTopMargin: 16,
  phoneInputTopMargin: 12,
  inputRadius: 6,
  descriptionTopMargin: 2,
  descriptionHorizontalInset: 12,
} as const;

export const PROFILE_FIELD_SCREEN_OPTIONS = { animation: 'slide_from_bottom' as const };

function validateField(field: EditableProfileField, value: string): { title: string; message?: string } | null {
  if (field === 'nickname' && !value) return { title: '昵称不能为空' };
  if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { title: '邮箱格式不正确', message: '请输入有效邮箱地址，或清空后保存。' };
  }
  if (field === 'phone' && value && !/^[+\d\s-]{6,20}$/.test(value)) {
    return { title: '手机号格式不正确', message: '手机号只能包含数字、空格、加号或短横线。' };
  }
  return null;
}

export function ProfileFieldScreen({ navigation, route }: Props) {
  const { profile, updateProfile } = useAuth();
  const { showDialog } = useAppDialog();
  const field = route.params.field;
  const config = FIELD_CONFIG[field];
  const originalValue = profile[field];
  const [draft, setDraft] = React.useState(originalValue);
  const [saving, setSaving] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [validationToast, setValidationToast] = React.useState<{ key: number; message: string } | null>(null);
  const normalizedDraft = draft.trim();
  const changed = normalizedDraft !== originalValue;
  const currentValidation = validateField(field, normalizedDraft);
  const saveState: FeishuSaveState = saving
    ? 'fully-disabled'
    : currentValidation
      ? 'disabled-with-toast'
      : 'enabled';

  const showCurrentValidation = () => {
    if (currentValidation) {
      setValidationToast(current => ({
        key: (current?.key ?? 0) + 1,
        message: currentValidation.message ?? currentValidation.title,
      }));
    }
  };

  const handleSave = async () => {
    const validation = validateField(field, normalizedDraft);
    if (validation) {
      showDialog({ ...validation, tone: 'warning' });
      return;
    }
    if (saving) return;
    if (!changed) {
      navigation.goBack();
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        ...profile,
        [field]: normalizedDraft,
        avatarInitial: '',
        avatarInitialManual: false,
      });
      navigation.goBack();
    } catch (error) {
      showDialog({
        title: '资料同步失败',
        message: readableErrorMessage(error, '当前修改尚未保存，请检查网络后重试。'),
        tone: 'warning',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <FeishuTitleBar
        title={config.title}
        testID="profile-field-titlebar"
        leading={(
          <TouchableOpacity
            style={s.cancelAction}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="取消"
          >
            <Text style={s.cancelText}>取消</Text>
          </TouchableOpacity>
        )}
        trailing={(
          <FeishuSaveAction
            state={saveState}
            onSave={() => { void handleSave(); }}
            onDisabledPress={showCurrentValidation}
            disabledHint={currentValidation?.message ?? currentValidation?.title}
            testID="profile-field-save"
          />
        )}
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View
          style={[
            s.inputGroup,
            { marginTop: config.inputMarginTop },
            focused ? s.inputGroupFocused : s.inputGroupIdle,
          ]}
          testID="profile-field-input-group"
        >
          <TextInput
            autoFocus
            style={s.input}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={config.placeholder}
            placeholderTextColor={F.textPlaceholder}
            maxLength={config.maxLength}
            keyboardType={config.keyboardType}
            autoCapitalize={config.keyboardType === 'email-address' ? 'none' : 'sentences'}
            autoCorrect={config.keyboardType === 'default'}
            returnKeyType="done"
            onSubmitEditing={() => { if (saveState !== 'fully-disabled') void handleSave(); }}
            accessibilityLabel={config.title}
            testID="profile-field-input"
          />
          <TouchableOpacity
            style={s.clearAction}
            onPress={() => setDraft('')}
            disabled={!draft}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel="清空输入"
            accessibilityState={{ disabled: !draft }}
          >
            <Ionicons
              name="close-circle"
              size={config.clearIconSize}
              color={draft && (field !== 'phone' || focused) ? F.iconTertiary : 'transparent'}
              testID="profile-field-clear-icon"
            />
          </TouchableOpacity>
        </View>
        {config.description ? (
          <Text style={s.description} testID="profile-field-description">{config.description}</Text>
        ) : null}
      </KeyboardAvoidingView>
      <AppToast
        visible={validationToast !== null}
        message={validationToast?.message ?? ''}
        presentationKey={validationToast?.key ?? 0}
        onDismiss={() => setValidationToast(null)}
        bottom={24}
        testID="profile-field-validation-toast"
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  inputGroup: {
    height: PROFILE_FIELD_GEOMETRY.inputHeight,
    marginHorizontal: PROFILE_FIELD_GEOMETRY.horizontalMargin,
    paddingLeft: 16,
    borderWidth: 1,
    borderRadius: PROFILE_FIELD_GEOMETRY.inputRadius,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: F.backgroundBody,
  },
  inputGroupIdle: { borderColor: F.divider },
  inputGroupFocused: { borderColor: F.primary },
  input: {
    flex: 1,
    minWidth: 0,
    height: 48,
    paddingVertical: 0,
    fontSize: 16,
    lineHeight: 22,
    color: F.textTitle,
  },
  clearAction: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  description: {
    marginTop: PROFILE_FIELD_GEOMETRY.descriptionTopMargin,
    marginHorizontal: PROFILE_FIELD_GEOMETRY.horizontalMargin + PROFILE_FIELD_GEOMETRY.descriptionHorizontalInset,
    fontSize: 14,
    lineHeight: 20,
    color: F.textCaption,
  },
  cancelAction: { width: 56, height: FEISHU_DIMENSIONS.titleBarHeight, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: 17, lineHeight: 24, color: F.textTitle },
});
