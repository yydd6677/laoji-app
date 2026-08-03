import { requireOptionalNativeModule } from 'expo-modules-core';
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from './themeIds';

type NativeThemeModule = {
  getThemePreference?: () => string;
  setThemePreference?: (themeId: string) => void;
  restartActivity?: () => void;
};

const nativeModule = requireOptionalNativeModule<NativeThemeModule>('LaojiNativePlatform');

/**
 * This value is read synchronously so module-level React Native StyleSheet
 * declarations can start with the persisted palette after an Android activity
 * recreation. AsyncStorage remains the portable JS source of record.
 */
export function getSynchronousThemeId(): ThemeId {
  try {
    const value = nativeModule?.getThemePreference?.();
    return isThemeId(value) ? value : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function setSynchronousThemeId(themeId: ThemeId): void {
  try {
    nativeModule?.setThemePreference?.(themeId);
  } catch {
    // The JS preference still persists when an optional native module is absent.
  }
}

export function restartNativeActivity(): boolean {
  try {
    if (!nativeModule?.restartActivity) return false;
    nativeModule.restartActivity();
    return true;
  } catch {
    return false;
  }
}

export function hasNativeThemeRuntime(): boolean {
  return Boolean(nativeModule?.getThemePreference && nativeModule?.setThemePreference);
}
