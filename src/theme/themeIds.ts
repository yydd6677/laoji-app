export type ThemeId = 'neutral' | 'vivid';

export const DEFAULT_THEME_ID: ThemeId = 'neutral';

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = Object.freeze({
  neutral: '标准蓝',
  vivid: '绚彩',
});

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'neutral' || value === 'vivid';
}
