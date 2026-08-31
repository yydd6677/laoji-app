import { type ThemeId } from './themeIds';

export const THEME_FONT_FAMILIES = Object.freeze({
  neutral: 'LaojiThemeNeutral',
  vivid: 'LaojiThemeVivid',
  paper: 'LaojiThemePaper',
  midnight: 'LaojiThemeMidnight',
} satisfies Readonly<Record<ThemeId, string>>);

export type ThemeFontFamily = (typeof THEME_FONT_FAMILIES)[ThemeId];

export function getThemeFontFamily(themeId: ThemeId): ThemeFontFamily {
  return THEME_FONT_FAMILIES[themeId];
}
