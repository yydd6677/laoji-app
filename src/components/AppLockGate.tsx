import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { useAuth } from '../store/AuthStore';
import { Avatar } from './Common';
import {
  authenticateWithSystem,
  DEFAULT_PRIVACY_PREFS,
  loadPrivacyPrefs,
  PrivacyPrefs,
  savePrivacyPrefs,
  subscribePrivacyPrefs,
} from '../services/privacy';
import { setNotificationNavigationUnlocked } from '../navigation/notificationNavigation';

function scopeForAuth(mode: string, userId?: number): string {
  if (mode === 'authenticated' && userId) return `user:${userId}`;
  if (mode === 'guest') return 'guest';
  return 'signed_out';
}

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const { mode, session, profile } = useAuth();
  const scope = useMemo(() => scopeForAuth(mode, session?.user.id), [mode, session?.user.id]);
  const identityName = profile?.nickname?.trim()
    || session?.user.nickname?.trim()
    || (mode === 'guest' ? '访客用户' : '老记用户');
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

  const notificationNavigationUnlocked = mode === 'signed_out'
    || Boolean(prefs && !(prefs.appLockEnabled && locked));
  useEffect(() => {
    setNotificationNavigationUnlocked(notificationNavigationUnlocked);
    return () => setNotificationNavigationUnlocked(false);
  }, [notificationNavigationUnlocked]);

  if (mode === 'signed_out') {
    return <>{children}</>;
  }

  if (!prefs) {
    if (loadFailureScope === scope) {
      return (
        <View style={s.failureScreen} testID="app-lock-read-error">
          <View style={s.failureIcon}>
            <Ionicons name="shield-outline" size={40} color={C.faint} />
          </View>
          <Text style={s.failureTitle}>暂时无法读取隐私设置</Text>
          <Text style={s.failureMessage}>为保护日程与会议内容，设置恢复前不会显示业务页面。</Text>
          <View style={s.failureStatusSlot}>
            {checking ? <ActivityIndicator color={C.primary} /> : null}
            {!checking && error ? <Text style={s.error}>{error}</Text> : null}
          </View>
          <View style={s.failureActions}>
            <TouchableOpacity
              onPress={() => setReloadKey(value => value + 1)}
              activeOpacity={0.72}
              style={s.textAction}
              disabled={checking}
              accessibilityRole="button"
            >
              <Text style={[s.textActionText, checking && s.actionDisabled]}>重试读取</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={verifyAndResetPrivacy}
              activeOpacity={0.72}
              style={s.textAction}
              disabled={checking}
              accessibilityRole="button"
            >
              <Text style={[s.textActionText, checking && s.actionDisabled]}>验证身份并重置设置</Text>
            </TouchableOpacity>
          </View>
        </View>
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
        <View style={[s.lockScreen, s.lockOverlay]} testID="app-lock-screen">
          <View style={s.avatarSlot} testID="app-lock-avatar">
            <Avatar size={80} profile={profile} />
          </View>
          <Text style={s.userName} numberOfLines={1} testID="app-lock-user-name">{identityName}</Text>
          <Text style={s.lockHint} testID="app-lock-hint">老记已锁定，请使用系统生物识别或设备密码验证身份</Text>
          <View style={s.verificationStatus} testID="app-lock-status-slot">
            {checking ? <ActivityIndicator color={C.primary} /> : null}
            {!checking && error ? <Text style={s.error}>{error}</Text> : null}
          </View>
          <TouchableOpacity
            onPress={unlock}
            activeOpacity={0.72}
            style={s.textAction}
            disabled={checking}
            accessibilityRole="button"
            accessibilityLabel="重新验证"
          >
            <Text style={[s.textActionText, checking && s.actionDisabled]}>
              {checking ? '正在验证' : '重新验证'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  gateRoot: { flex: 1 },
  contentLayer: { flex: 1 },
  contentHidden: { opacity: 0 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.body },
  lockScreen: { flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: 20, backgroundColor: C.body },
  lockOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  avatarSlot: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    width: '100%',
    height: 32,
    marginTop: 8,
    paddingHorizontal: 16,
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '600',
    color: C.text,
    textAlign: 'center',
  },
  lockHint: {
    minHeight: 52,
    marginTop: 20,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500',
    color: C.text,
    textAlign: 'center',
  },
  verificationStatus: {
    width: '100%',
    height: 52,
    marginTop: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textAction: { minWidth: 120, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  textActionText: { fontSize: 13, lineHeight: 22, color: C.primary, fontWeight: '500' },
  actionDisabled: { color: C.faint },
  error: { fontSize: 13, color: C.red, textAlign: 'center', lineHeight: 20 },
  failureScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: C.body,
  },
  failureIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.inputBg,
  },
  failureTitle: { marginTop: 20, fontSize: 20, lineHeight: 28, fontWeight: '600', color: C.text, textAlign: 'center' },
  failureMessage: { marginTop: 8, fontSize: 14, lineHeight: 22, color: C.sub, textAlign: 'center' },
  failureStatusSlot: { width: '100%', height: 44, alignItems: 'center', justifyContent: 'center' },
  failureActions: { alignItems: 'center' },
});
