import { getAppStorageItem, setAppStorageItem } from './appStorage';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  type ThemeId,
} from '../theme/themeIds';
import {
  getSynchronousThemeId,
  setSynchronousThemeId,
} from '../theme/nativeTheme';

export const THEME_PREFERENCE_KEY = '@laoji_theme';

export async function loadThemePreference(): Promise<ThemeId> {
  const raw = await getAppStorageItem(THEME_PREFERENCE_KEY);
  if (!raw) {
    return getSynchronousThemeId();
  }
  const themeId = isThemeId(raw.trim()) ? raw.trim() as ThemeId : DEFAULT_THEME_ID;
  // Keep module-level styles and native classic views in sync with the
  // portable storage source before the first screen is constructed.
  setSynchronousThemeId(themeId);
  return themeId;
}

export async function saveThemePreference(themeId: ThemeId): Promise<void> {
  setSynchronousThemeId(themeId);
  await setAppStorageItem(THEME_PREFERENCE_KEY, themeId);
}

export async function clearThemePreference(): Promise<void> {
  setSynchronousThemeId(DEFAULT_THEME_ID);
  await setAppStorageItem(THEME_PREFERENCE_KEY, DEFAULT_THEME_ID);
}
