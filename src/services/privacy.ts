import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

export const PRIVACY_KEY = '@laoji_privacy';

export interface PrivacyPrefs {
  biometricEnabled: boolean;
  appLockEnabled: boolean;
}

export const DEFAULT_PRIVACY_PREFS: PrivacyPrefs = {
  biometricEnabled: false,
  appLockEnabled: false,
};

export function privacyKeyForScope(scope: string): string {
  return `${PRIVACY_KEY}:${scope}`;
}

export async function loadPrivacyPrefs(scope: string): Promise<PrivacyPrefs> {
  try {
    const raw = await AsyncStorage.getItem(privacyKeyForScope(scope));
    if (!raw) return DEFAULT_PRIVACY_PREFS;
    const saved = JSON.parse(raw);
    return {
      biometricEnabled: Boolean(saved.biometricEnabled ?? saved.faceId),
      appLockEnabled: Boolean(saved.appLockEnabled ?? saved.appLock),
    };
  } catch {
    return DEFAULT_PRIVACY_PREFS;
  }
}

export async function savePrivacyPrefs(scope: string, prefs: PrivacyPrefs): Promise<void> {
  await AsyncStorage.setItem(privacyKeyForScope(scope), JSON.stringify(prefs));
}

export async function getBiometricUnavailableReason(): Promise<string | null> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return '当前设备未检测到可用的生物识别硬件。';

  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!enrolled) return '系统里还没有录入指纹、面容或设备解锁方式。请先到系统设置完成录入。';

  return null;
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
