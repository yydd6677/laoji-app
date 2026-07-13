import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { useAuth } from '../store/AuthStore';
import {
  authenticateWithSystem,
  DEFAULT_PRIVACY_PREFS,
  loadPrivacyPrefs,
  PrivacyPrefs,
  savePrivacyPrefs,
  subscribePrivacyPrefs,
} from '../services/privacy';
import { Sparkle } from './Common';

function scopeForAuth(mode: string, userId?: number): string {
  if (mode === 'authenticated' && userId) return `user:${userId}`;
  if (mode === 'guest') return 'guest';
  return 'signed_out';
}

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const { mode, session } = useAuth();
  const scope = useMemo(() => scopeForAuth(mode, session?.user.id), [mode, session?.user.id]);
  const [loadedPrefs, setLoadedPrefs] = useState<{ scope: string; prefs: PrivacyPrefs } | null>(null);
  const prefs = loadedPrefs?.scope === scope ? loadedPrefs.prefs : null;
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [loadFailureScope, setLoadFailureScope] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const promptingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    let alive = true;
    let receivedLiveUpdate = false;
    const unsubscribe = subscribePrivacyPrefs(scope, next => {
      if (!alive) return;
      receivedLiveUpdate = true;
      setLoadedPrefs({ scope, prefs: next });
      setLoadFailureScope(null);
      if (!next.appLockEnabled) setLocked(false);
    });
    loadPrivacyPrefs(scope).then(next => {
      if (!alive || receivedLiveUpdate) return;
      setLoadedPrefs({ scope, prefs: next });
      setLoadFailureScope(null);
      setLocked(mode !== 'signed_out' && next.appLockEnabled);
      setError('');
    }).catch(() => {
      if (!alive || receivedLiveUpdate) return;
      setLoadFailureScope(scope);
      setLocked(true);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [mode, reloadKey, scope]);

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

  const verifyAndResetPrivacy = useCallback(async () => {
    if (promptingRef.current) return;
    promptingRef.current = true;
    setChecking(true);
    setError('');
    try {
      const ok = await authenticateWithSystem('恢复老记隐私设置');
      if (!ok) {
        setError('验证未通过，隐私设置没有重置。');
        return;
      }
      await savePrivacyPrefs(scope, DEFAULT_PRIVACY_PREFS);
      setLoadedPrefs({ scope, prefs: DEFAULT_PRIVACY_PREFS });
      setLoadFailureScope(null);
      setLocked(false);
    } catch {
      setError('隐私设置仍无法写入，请先重试读取。');
    } finally {
      promptingRef.current = false;
      setChecking(false);
    }
  }, [scope]);

  useEffect(() => {
    if (locked && prefs?.appLockEnabled && appStateRef.current === 'active') void unlock();
  }, [locked, prefs?.appLockEnabled, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      const previous = appStateRef.current;
      appStateRef.current = state;
      if (state !== 'active' && previous === 'active' && prefs?.appLockEnabled && mode !== 'signed_out') {
        setLocked(true);
      }
      if (state === 'active' && previous !== 'active' && prefs?.appLockEnabled && mode !== 'signed_out') {
        setLocked(true);
        void unlock();
      }
    });
    return () => sub.remove();
  }, [mode, prefs?.appLockEnabled, unlock]);

  if (mode === 'signed_out') {
    return <>{children}</>;
  }

  if (!prefs) {
    if (loadFailureScope === scope) {
      return (
        <LinearGradient colors={[C.loginTop, C.loginBot]} style={s.lockScreen}>
          <View style={s.logoWrap}>
            <LinearGradient colors={[C.logoFrom, C.logoTo]} style={s.logoCircle}>
              <Ionicons name="shield-outline" size={30} color="#fff" />
            </LinearGradient>
          </View>
          <Text style={s.title}>暂时无法读取隐私设置</Text>
          <Text style={s.subtitle}>为保护日程与会议内容，老记不会在设置恢复前显示业务页面。</Text>
          {checking ? (
            <ActivityIndicator color={C.purple} style={s.loading} />
          ) : (
            <>
              <TouchableOpacity
                onPress={() => setReloadKey(value => value + 1)}
                activeOpacity={0.86}
                style={s.unlockWrap}
                accessibilityRole="button"
              >
                <LinearGradient colors={[C.gradFrom, C.gradTo]} style={s.unlockBtn}>
                  <Text style={s.unlockText}>重试读取</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={verifyAndResetPrivacy}
                activeOpacity={0.78}
                style={s.resetButton}
                accessibilityRole="button"
              >
                <Text style={s.resetButtonText}>验证身份并重置设置</Text>
              </TouchableOpacity>
            </>
          )}
          {error ? <Text style={s.error}>{error}</Text> : null}
        </LinearGradient>
      );
    }
    return (
      <View style={s.loadingScreen} testID="app-lock-loading" accessibilityLabel="正在检查隐私设置">
        <ActivityIndicator color={C.purple} />
      </View>
    );
  }

  const isLocked = prefs.appLockEnabled && locked;
  return (
    <View style={s.gateRoot}>
      <View
        testID="app-lock-protected-content"
        style={[s.contentLayer, isLocked && s.contentHidden]}
        pointerEvents={isLocked ? 'none' : 'auto'}
        accessibilityElementsHidden={isLocked}
        importantForAccessibility={isLocked ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {isLocked ? (
        <LinearGradient colors={[C.loginTop, C.loginBot]} style={[s.lockScreen, s.lockOverlay]}>
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
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  gateRoot: { flex: 1 },
  contentLayer: { flex: 1 },
  contentHidden: { opacity: 0 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.appBg },
  lockScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  lockOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
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
  resetButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 18 },
  resetButtonText: { fontSize: 13, color: C.purple, fontWeight: '700' },
  error: { marginTop: 16, fontSize: 12, color: C.red, textAlign: 'center', lineHeight: 18 },
});
