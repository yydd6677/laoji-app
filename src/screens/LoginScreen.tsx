import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ScreenContainer } from '../components/ScreenContainer';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { Colors as C } from '../theme/colors';
import { Sparkle } from '../components/Common';
import { useAuth } from '../store/AuthStore';
import { useAppDialog } from '../components/AppDialog';
import { requestPasswordReset } from '../services/auth';
import { readableErrorMessage } from '../services/errors';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Login'> };

export function LoginScreen({ navigation }: Props) {
  const [showPwd, setShowPwd] = useState(false);
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const { signIn, register, continueAsGuest } = useAuth();
  const { showDialog } = useAppDialog();

  const validateAccount = () => {
    if (!email.trim()) {
      showDialog({ title: '提示', message: '请输入邮箱或手机号', tone: 'info' });
      return false;
    }
    if (!pwd.trim()) {
      showDialog({ title: '提示', message: '请输入密码', tone: 'info' });
      return false;
    }
    return true;
  };

  const handleLogin = async () => {
    if (!validateAccount()) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  const handleRegister = async () => {
    if (!validateAccount()) return;
    setBusy(true);
    try {
      await register(email.trim(), pwd);
    } catch (err) {
      const message = readableErrorMessage(err, '注册失败，请稍后重试');
      showDialog({ title: '注册失败', message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    const account = email.trim();
    if (!account) {
      showDialog({ title: '填写账号后重试', message: '请先输入邮箱或手机号，再提交人工重置请求。', tone: 'info' });
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  };

  const handleGuest = async () => {
    setBusy(true);
    try {
      await continueAsGuest();
    } catch {
      showDialog({ title: '进入失败', message: '访客模式初始化失败，请稍后重试', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer bg={C.loginTop}>
      <LinearGradient colors={[C.loginTop, C.loginBot]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={s.flex}>
        <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* Logo + sparkles */}
          <View style={s.logoWrap}>
            <View style={s.sparkle1}><Sparkle size={18} color="#C8A8F0" /></View>
            <View style={s.sparkle2}><Sparkle size={10} color="#E0B0DA" /></View>
            <LinearGradient colors={[C.logoFrom, C.logoTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.logoCircle}>
              <Text style={s.logoText}>记</Text>
            </LinearGradient>
          </View>

          <Text style={s.appName}>老记</Text>
          <Text style={s.welcome}>欢迎回来</Text>
          <Text style={s.subtitle}>登录账号，继续管理你的日程与会议记录</Text>

          {/* Email */}
          <View style={s.inputRow}>
            <Ionicons name="mail-outline" size={17} color={C.sub} />
            <TextInput
              style={s.input} placeholder="邮箱 / 手机号" placeholderTextColor={C.faint}
              value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
            />
          </View>

          {/* Password */}
          <View style={s.inputRow}>
            <Ionicons name="lock-closed-outline" size={17} color={C.sub} />
            <TextInput
              style={s.input} placeholder="密码" placeholderTextColor={C.faint}
              value={pwd} onChangeText={setPwd} secureTextEntry={!showPwd}
            />
            <TouchableOpacity onPress={() => setShowPwd(v => !v)}>
              <Ionicons name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={17} color={C.sub} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={s.forgot} onPress={handleForgotPassword}>
            <Text style={s.forgotText}>忘记密码?</Text>
          </TouchableOpacity>

          {/* 登录 */}
          <TouchableOpacity onPress={handleLogin} activeOpacity={0.85} style={{ width: '100%' }} disabled={busy}>
            <LinearGradient colors={[C.gradFrom, C.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.loginBtn}>
              <Text style={s.loginBtnText}>{busy ? '请稍候…' : '登录'}</Text>
            </LinearGradient>
          </TouchableOpacity>

          {/* 注册账号 */}
          <TouchableOpacity style={[s.registerBtn, busy && { opacity: 0.5 }]} onPress={handleRegister} disabled={busy}>
            <Text style={s.registerBtnText}>注册账号</Text>
          </TouchableOpacity>

          {/* Divider */}
          <View style={s.divider}>
            <View style={s.divLine} />
            <Text style={s.divOr}>或</Text>
            <View style={s.divLine} />
          </View>

          {/* 游客 */}
          <TouchableOpacity style={[s.guestBtn, busy && { opacity: 0.5 }]} onPress={handleGuest} disabled={busy}>
            <Text style={s.guestBtnText}>游客体验</Text>
          </TouchableOpacity>

          <Text style={s.terms}>
            登录即代表你同意
            <Text
              style={{ color: C.purple }}
              onPress={() => navigation.navigate('Legal', { kind: 'terms' })}
            >
              《用户协议》
            </Text>
            与
            <Text
              style={{ color: C.purple }}
              onPress={() => navigation.navigate('Legal', { kind: 'privacy' })}
            >
              《隐私政策》
            </Text>
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 28, paddingTop: 52, paddingBottom: 36 },
  logoWrap: { position: 'relative', marginBottom: 10 },
  sparkle1: { position: 'absolute', top: -12, right: -20, zIndex: 1 },
  sparkle2: { position: 'absolute', bottom: 6, left: -18, zIndex: 1 },
  logoCircle: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', shadowColor: '#B464DC', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 16, elevation: 8 },
  logoText: { fontSize: 30, fontWeight: '800', color: '#fff' },
  appName: { fontSize: 20, fontWeight: '800', color: '#3A2288', marginBottom: 32, letterSpacing: 4 },
  welcome: { fontSize: 26, fontWeight: '800', color: C.text, marginBottom: 8 },
  subtitle: { fontSize: 13, color: C.sub, marginBottom: 36, textAlign: 'center', lineHeight: 22 },
  inputRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.inputBg, borderRadius: 14, paddingHorizontal: 16, height: 52, marginBottom: 14 },
  input: { flex: 1, fontSize: 14, color: C.text },
  forgot: { width: '100%', alignItems: 'flex-end', marginBottom: 28 },
  forgotText: { color: C.purple, fontSize: 13 },
  loginBtn: { width: '100%', height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 14, shadowColor: '#6A38B2', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.45, shadowRadius: 12, elevation: 6 },
  loginBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  registerBtn: { width: '100%', height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 22, borderWidth: 2, borderColor: C.pinkBorder },
  registerBtnText: { fontSize: 15, fontWeight: '600', color: C.pink },
  divider: { flexDirection: 'row', alignItems: 'center', width: '100%', gap: 12, marginBottom: 22 },
  divLine: { flex: 1, height: 1, backgroundColor: '#E4DCF4' },
  divOr: { fontSize: 12, color: C.faint },
  guestBtn: { width: '100%', height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 32, borderWidth: 1.5, borderColor: '#D5D0EE' },
  guestBtnText: { fontSize: 14, fontWeight: '500', color: '#7A78A0' },
  terms: { fontSize: 11, color: C.faint, textAlign: 'center', lineHeight: 20 },
});
