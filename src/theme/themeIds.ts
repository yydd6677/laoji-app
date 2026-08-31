export const THEME_IDS = ['neutral', 'vivid', 'paper', 'midnight'] as const;

export type ThemeId = typeof THEME_IDS[number];

export const DEFAULT_THEME_ID: ThemeId = 'neutral';

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = Object.freeze({
  neutral: '标准',
  vivid: '绚彩',
  paper: '纸境',
  midnight: '夜航',
});

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}
