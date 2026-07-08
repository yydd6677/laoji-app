import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { useAuth } from '../store/AuthStore';
import { authenticateWithSystem, loadPrivacyPrefs, PrivacyPrefs } from '../services/privacy';
import { Sparkle } from './Common';

function scopeForAuth(mode: string, userId?: number): string {
  if (mode === 'authenticated' && userId) return `user:${userId}`;
  if (mode === 'guest') return 'guest';
  return 'signed_out';
}

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const { mode, session } = useAuth();
  const scope = useMemo(() => scopeForAuth(mode, session?.user.id), [mode, session?.user.id]);
  const [prefs, setPrefs] = useState<PrivacyPrefs | null>(null);
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const promptingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadPrivacyPrefs(scope).then(next => {
      if (!alive) return;
      setPrefs(next);
      setLocked(mode !== 'signed_out' && next.appLockEnabled);
      setError('');
    });
    return () => { alive = false; };
  }, [mode, scope]);

  const unlock = useCallback(async () => {
    if (promptingRef.current) return;
    promptingRef.current = true;
    setChecking(true);
    setError('');
    try {
      const ok = await authenticateWithSystem('解锁老记');
      if (ok) setLocked(false);
      else setError('验证未通过，请重试。');
    } catch {
      setError('系统验证不可用，请检查设备解锁设置。');
    } finally {
      promptingRef.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (locked && prefs?.appLockEnabled) void unlock();
  }, [locked, prefs?.appLockEnabled, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && prefs?.appLockEnabled && mode !== 'signed_out') {
        setLocked(true);
      }
    });
    return () => sub.remove();
  }, [mode, prefs?.appLockEnabled]);

  if (!prefs || mode === 'signed_out' || !prefs.appLockEnabled || !locked) {
    return <>{children}</>;
  }

  return (
    <LinearGradient colors={[C.loginTop, C.loginBot]} style={s.lockScreen}>
      <View style={s.logoWrap}>
        <View style={s.sparkle1}><Sparkle size={18} color="#C8A8F0" /></View>
        <LinearGradient colors={[C.logoFrom, C.logoTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.logoCircle}>
          <Ionicons name="lock-closed-outline" size={30} color="#fff" />
        </LinearGradient>
      </View>
      <Text style={s.title}>老记已锁定</Text>
      <Text style={s.subtitle}>验证身份后继续查看日程与会议记录</Text>
      {checking ? (
        <ActivityIndicator color={C.purple} style={s.loading} />
      ) : (
        <TouchableOpacity onPress={unlock} activeOpacity={0.86} style={s.unlockWrap}>
          <LinearGradient colors={[C.gradFrom, C.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.unlockBtn}>
            <Text style={s.unlockText}>验证并解锁</Text>
          </LinearGradient>
        </TouchableOpacity>
      )}
      {error ? <Text style={s.error}>{error}</Text> : null}
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  lockScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  logoWrap: { position: 'relative', marginBottom: 18 },
  sparkle1: { position: 'absolute', top: -12, right: -20, zIndex: 1 },
  logoCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#B464DC',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  title: { fontSize: 24, fontWeight: '800', color: C.text, marginBottom: 8 },
  subtitle: { fontSize: 13, color: C.sub, lineHeight: 22, textAlign: 'center', marginBottom: 28 },
  loading: { marginTop: 6 },
  unlockWrap: { width: '100%' },
  unlockBtn: {
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6A38B2',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.34,
    shadowRadius: 12,
    elevation: 6,
  },
  unlockText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  error: { marginTop: 16, fontSize: 12, color: C.red, textAlign: 'center', lineHeight: 18 },
});
