import { type ThemeId } from './themeIds';
import { GENERATED_FONT_FAMILY } from './generatedUiTokens';

export const THEME_FONT_FAMILIES = GENERATED_FONT_FAMILY satisfies Readonly<Record<ThemeId, string>>;

export type ThemeFontFamily = (typeof THEME_FONT_FAMILIES)[ThemeId];

export function getThemeFontFamily(themeId: ThemeId): ThemeFontFamily {
  return THEME_FONT_FAMILIES[themeId];
}
