import * as LocalAuthentication from 'expo-local-authentication';
import { getAppStorageItem, setAppStorageItem } from './appStorage';

export const PRIVACY_KEY = '@laoji_privacy';

export interface PrivacyPrefs {
  biometricEnabled: boolean;
  appLockEnabled: boolean;
  hideWidgetTitles: boolean;
}

export const DEFAULT_PRIVACY_PREFS: PrivacyPrefs = {
  biometricEnabled: false,
  appLockEnabled: false,
  hideWidgetTitles: true,
};

type PrivacyPrefsListener = (prefs: PrivacyPrefs) => void;
const privacyListeners = new Map<string, Set<PrivacyPrefsListener>>();

function emitPrivacyPrefs(scope: string, prefs: PrivacyPrefs): void {
  privacyListeners.get(scope)?.forEach(listener => listener({ ...prefs }));
}

export function subscribePrivacyPrefs(scope: string, listener: PrivacyPrefsListener): () => void {
  const listeners = privacyListeners.get(scope) ?? new Set<PrivacyPrefsListener>();
  listeners.add(listener);
  privacyListeners.set(scope, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) privacyListeners.delete(scope);
  };
}

export function privacyKeyForScope(scope: string): string {
  return `${PRIVACY_KEY}:${scope}`;
}

export async function loadPrivacyPrefs(scope: string): Promise<PrivacyPrefs> {
  const raw = await getAppStorageItem(privacyKeyForScope(scope));
  if (!raw) return DEFAULT_PRIVACY_PREFS;
  try {
    const saved = JSON.parse(raw);
    return {
      biometricEnabled: Boolean(saved.biometricEnabled ?? saved.faceId),
      appLockEnabled: Boolean(saved.appLockEnabled ?? saved.appLock),
      hideWidgetTitles: saved.hideWidgetTitles !== false,
    };
  } catch {
    throw new Error('privacy preferences are corrupted');
  }
}

export async function savePrivacyPrefs(scope: string, prefs: PrivacyPrefs): Promise<void> {
  await setAppStorageItem(privacyKeyForScope(scope), JSON.stringify(prefs));
  emitPrivacyPrefs(scope, prefs);
}

export async function getBiometricUnavailableReason(): Promise<string | null> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) {
      return '系统里还没有设置指纹、面容、设备密码或解锁图案。请先到系统设置完成设置。';
    }
    return null;
  } catch {
    return '暂时无法读取系统验证状态，请稍后重试。';
  }
}

export async function authenticateWithSystem(promptMessage = '验证身份'): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: '取消',
    fallbackLabel: '使用系统密码',
    disableDeviceFallback: false,
  });
  return result.success;
}
