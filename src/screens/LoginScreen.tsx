import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { Colors as C } from '../theme/colors';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { requestPasswordReset } from '../services/auth';
import { readableErrorMessage } from '../services/errors';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Login'> };
type LoginStep = 'account' | 'password';
type AuthIntent = 'login' | 'register';
type BusyAction = AuthIntent | 'guest' | 'reset' | null;

export function LoginScreen({ navigation }: Props) {
  const [step, setStep] = useState<LoginStep>('account');
  const [intent, setIntent] = useState<AuthIntent>('login');
  const [showPwd, setShowPwd] = useState(false);
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [accountFocused, setAccountFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const { signIn, register, continueAsGuest, sessionNotice, clearSessionNotice } = useAuth();
  const { showDialog } = useAppDialog();
  const busy = busyAction !== null;

  useEffect(() => {
    if (!sessionNotice) return;
    clearSessionNotice();
    showDialog({
      title: '请重新登录',
      message: sessionNotice,
      hint: '本机缓存仍按原账号隔离保存，重新登录后会继续同步。',
      tone: 'warning',
    });
  }, [clearSessionNotice, sessionNotice, showDialog]);

  const validateAccount = () => {
    if (!email.trim()) {
      showDialog({ title: '提示', message: '请输入邮箱或手机号', tone: 'info' });
      return false;
    }
    return true;
  };

  const validatePassword = () => {
    if (!pwd.trim()) {
      showDialog({ title: '提示', message: '请输入密码', tone: 'info' });
      return false;
    }
    return true;
  };

  const openPasswordStep = (nextIntent: AuthIntent) => {
    if (!validateAccount()) return;
    Keyboard.dismiss();
    setIntent(nextIntent);
    setStep('password');
  };

  const handleAccountChange = (value: string) => {
    if (value !== email) setPwd('');
    setEmail(value);
  };

  const handleLogin = async () => {
    if (!validateAccount() || !validatePassword()) return;
    setBusyAction('login');
    try {
      await signIn(email.trim(), pwd);
    } catch (err) {
      Keyboard.dismiss();
      showDialog({
        title: '登录失败',
        message: readableErrorMessage(err, '登录失败，请检查账号、密码或网络后重试。'),
        hint: '请确认账号和密码输入无误；如果服务暂时不可用，也可以先使用游客体验。',
        tone: 'error',
        actions: [
          { text: '重新输入', role: 'primary' },
          { text: '先用游客体验', role: 'secondary', onPress: handleGuest },
        ],
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRegister = async () => {
    if (!validateAccount() || !validatePassword()) return;
    if (pwd.length < 8) {
      showDialog({ title: '密码过短', message: '注册密码至少需要 8 位。', tone: 'warning' });
      return;
    }
    setBusyAction('register');
    try {
      await register(email.trim(), pwd);
    } catch (err) {
      const message = readableErrorMessage(err, '注册失败，请稍后重试');
      showDialog({ title: '注册失败', message, tone: 'error' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleForgotPassword = async () => {
    const account = email.trim();
    if (!account) {
      showDialog({ title: '填写账号后重试', message: '请先输入邮箱或手机号，再提交人工重置请求。', tone: 'info' });
      return;
    }
    setBusyAction('reset');
    try {
      const result = await requestPasswordReset(account);
      showDialog({
        title: '已提交重置请求',
        message: result.message || '管理员会根据账号信息处理密码重置，请留意与你账号绑定的联系方式。',
        tone: 'success',
      });
    } catch (err) {
      showDialog({ title: '提交失败', message: readableErrorMessage(err, '暂时无法提交重置请求，请稍后重试。'), tone: 'error' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleGuest = async () => {
    setBusyAction('guest');
    try {
      await continueAsGuest();
    } catch {
      showDialog({ title: '进入失败', message: '访客模式初始化失败，请稍后重试', tone: 'error' });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePasswordSubmit = () => {
    if (intent === 'register') {
      void handleRegister();
      return;
    }
    void handleLogin();
  };

  const legalCopy = (
    <Text style={s.terms}>
      继续即代表你已阅读并同意
      <Text
        style={s.link}
        onPress={() => navigation.navigate('Legal', { kind: 'terms' })}
      >
        《用户协议》
      </Text>
      和
      <Text
        style={s.link}
        onPress={() => navigation.navigate('Legal', { kind: 'privacy' })}
      >
        《隐私政策》
      </Text>
    </Text>
  );

  return (
    <ScreenContainer bg={C.body}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === 'account' ? (
            <View style={s.page} testID="login-account-step">
              <View style={s.topBar} />
              <View style={s.accountContent}>
                <View style={s.logo} testID="login-logo">
                  <Text style={s.logoText}>记</Text>
                </View>
                <Text style={s.title}>欢迎使用老记</Text>
                <Text style={s.loginTip}>请使用老记账号登录</Text>

                <View style={[s.underlineInput, s.accountInputSpacing, accountFocused && s.underlineInputFocused]}>
                  <TextInput
                    style={s.input}
                    placeholder="邮箱或手机号"
                    placeholderTextColor={C.faint}
                    value={email}
                    onChangeText={handleAccountChange}
                    keyboardType="default"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    onSubmitEditing={() => openPasswordStep('login')}
                    onFocus={() => setAccountFocused(true)}
                    onBlur={() => setAccountFocused(false)}
                    accessibilityLabel="账号"
                    testID="login-account-input"
                  />
                  <View style={s.inputActionSlot}>
                    {email ? (
                      <TouchableOpacity
                        style={s.inputIconButton}
                        onPress={() => handleAccountChange('')}
                        accessibilityRole="button"
                        accessibilityLabel="清除账号"
                      >
                        <Ionicons name="close-circle" size={16} color={C.faint} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => openPasswordStep('login')}
                  activeOpacity={0.78}
                  style={s.primaryButton}
                  disabled={busy}
                  accessibilityRole="button"
                  testID="login-next"
                >
                  <Text style={s.primaryButtonText}>下一步</Text>
                </TouchableOpacity>

                <View style={s.registerPrompt}>
                  <Text style={s.registerPromptText}>还没有账号？</Text>
                  <TouchableOpacity
                    onPress={() => openPasswordStep('register')}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Text style={s.registerLink}>立即注册</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={s.accountFooter}>
                <View style={s.divider}>
                  <View style={s.divLine} />
                  <Text style={s.divOr}>更多登录方式</Text>
                  <View style={s.divLine} />
                </View>
                <TouchableOpacity
                  style={[s.secondaryButton, busy && s.buttonDisabled]}
                  onPress={handleGuest}
                  disabled={busy}
                  accessibilityRole="button"
                  testID="login-guest"
                >
                  {busyAction === 'guest'
                    ? <ActivityIndicator size="small" color={C.text} />
                    : <Text style={s.secondaryButtonText}>游客体验</Text>}
                </TouchableOpacity>
                {legalCopy}
              </View>
            </View>
          ) : (
            <View style={s.page} testID="login-password-step">
              <View style={s.passwordTopBar}>
                <TouchableOpacity
                  style={s.backButton}
                  onPress={() => setStep('account')}
                  accessibilityRole="button"
                  accessibilityLabel="返回账号输入"
                >
                  <Ionicons name="chevron-back" size={22} color={C.text} />
                </TouchableOpacity>
              </View>

              <View style={s.passwordContent}>
                <Text style={s.title}>{intent === 'register' ? '设置密码' : '输入密码'}</Text>
                <Text style={s.passwordAccount} numberOfLines={1} ellipsizeMode="middle">{email.trim()}</Text>

                <View style={[s.underlineInput, s.passwordInputSpacing, passwordFocused && s.underlineInputFocused]}>
                  <TextInput
                    style={s.input}
                    placeholder="请输入密码"
                    placeholderTextColor={C.faint}
                    value={pwd}
                    onChangeText={setPwd}
                    secureTextEntry={!showPwd}
                    autoCapitalize="none"
                    returnKeyType="done"
                    onSubmitEditing={handlePasswordSubmit}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
                    accessibilityLabel="密码"
                    testID="login-password-input"
                    autoFocus
                  />
                  <View style={s.inputActionSlot}>
                    <TouchableOpacity
                      style={s.inputIconButton}
                      onPress={() => setShowPwd(v => !v)}
                      accessibilityRole="button"
                      accessibilityLabel={showPwd ? '隐藏密码' : '显示密码'}
                      testID="login-password-visibility"
                    >
                      <Ionicons name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={18} color={C.faint} />
                    </TouchableOpacity>
                  </View>
                </View>

                {intent === 'login' ? (
                  <TouchableOpacity
                    style={s.forgot}
                    onPress={handleForgotPassword}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Text style={s.forgotText}>{busyAction === 'reset' ? '提交中…' : '忘记密码'}</Text>
                  </TouchableOpacity>
                ) : <View style={s.forgotPlaceholder} />}

                <TouchableOpacity
                  onPress={handlePasswordSubmit}
                  activeOpacity={0.78}
                  style={[s.primaryButton, busy && s.buttonDisabled]}
                  disabled={busy}
                  accessibilityRole="button"
                  testID="login-primary"
                >
                  {busyAction === intent
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={s.primaryButtonText}>{intent === 'register' ? '注册' : '登录'}</Text>}
                </TouchableOpacity>

                {intent === 'register' ? <View style={s.passwordLegal}>{legalCopy}</View> : null}
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },
  page: { flex: 1, minHeight: 640, backgroundColor: C.body },
  topBar: { position: 'absolute', left: 0, right: 0, top: 0, height: 44 },
  accountContent: { paddingHorizontal: 16, paddingTop: 64 },
  logo: { width: 56, height: 56, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary },
  logoText: { fontSize: 24, lineHeight: 30, fontWeight: '700', color: '#fff' },
  title: { marginTop: 24, fontSize: 26, lineHeight: 34, fontWeight: '700', color: C.text, letterSpacing: 0 },
  loginTip: { marginTop: 10, fontSize: 12, lineHeight: 18, color: C.faint, textAlign: 'center' },
  accountInputSpacing: { marginTop: 34 },
  underlineInput: { height: 48, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.border },
  underlineInputFocused: { borderBottomColor: C.primary, borderBottomWidth: 2 },
  input: { flex: 1, minWidth: 0, height: 48, paddingHorizontal: 12, paddingVertical: 0, fontSize: 17, lineHeight: 24, color: C.text },
  inputActionSlot: { width: 36, height: 48, alignItems: 'center', justifyContent: 'center' },
  inputIconButton: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  primaryButton: { width: '100%', height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginTop: 16, backgroundColor: C.primary },
  primaryButtonText: { fontSize: 17, lineHeight: 24, fontWeight: '500', color: '#fff' },
  registerPrompt: { marginTop: 12, minHeight: 28, flexDirection: 'row', alignItems: 'center' },
  registerPromptText: { fontSize: 14, lineHeight: 20, color: C.sub },
  registerLink: { paddingVertical: 4, fontSize: 14, lineHeight: 20, color: C.primary },
  accountFooter: { marginTop: 'auto', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 20 },
  divider: { flexDirection: 'row', alignItems: 'center', width: '100%', marginBottom: 16 },
  divLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  divOr: { marginHorizontal: 10, fontSize: 12, lineHeight: 18, color: C.faint },
  secondaryButton: { width: '100%', height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.body },
  secondaryButtonText: { fontSize: 16, lineHeight: 22, fontWeight: '400', color: C.text },
  buttonDisabled: { opacity: 0.5 },
  terms: { marginTop: 16, fontSize: 12, lineHeight: 18, color: C.faint, textAlign: 'center' },
  link: { color: C.primary },
  passwordTopBar: { height: 44, paddingHorizontal: 16, justifyContent: 'center' },
  backButton: { width: 44, height: 44, marginLeft: -12, alignItems: 'center', justifyContent: 'center' },
  passwordContent: { paddingHorizontal: 16 },
  passwordAccount: { marginTop: 10, fontSize: 14, lineHeight: 20, color: C.sub },
  passwordInputSpacing: { marginTop: 32 },
  forgot: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', marginTop: 4 },
  forgotPlaceholder: { height: 44 },
  forgotText: { color: C.primary, fontSize: 14, lineHeight: 20 },
  passwordLegal: { marginTop: 8 },
});
