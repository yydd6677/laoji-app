import { requireOptionalNativeModule } from 'expo-modules-core';
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from './themeIds';

type NativeThemeModule = {
  getThemePreference?: () => string;
  setThemePreference?: (themeId: string) => void;
};

const nativeModule = requireOptionalNativeModule<NativeThemeModule>('LaojiNativePlatform');

/**
 * Seeds the first render from the persisted native preference. Live consumers
 * use ThemeProvider or their existing native appearance binding afterwards.
 * AsyncStorage remains the portable JS source of record.
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

export function hasNativeThemeRuntime(): boolean {
  return Boolean(nativeModule?.getThemePreference && nativeModule?.setThemePreference);
}
