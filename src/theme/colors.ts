import { getSynchronousThemeId } from './nativeTheme';
import { type ThemeId } from './themeIds';

// Legacy key names remain temporarily so existing screens can share one
// palette while they migrate to semantic Feishu tokens.
export type ColorPalette = Readonly<{
  appBg: string;
  body: string;
  card: string;
  inputBg: string;
  tasksBg: string;
  waveformBg: string;
  loginTop: string;
  loginBot: string;
  logoFrom: string;
  logoTo: string;
  primary: string;
  primaryHover: string;
  primaryPressed: string;
  primaryLight: string;
  purple: string;
  purpleDark: string;
  gradFrom: string;
  gradTo: string;
  purpleLight: string;
  text: string;
  sub: string;
  faint: string;
  disabled: string;
  pressed: string;
  green: string;
  orange: string;
  blue: string;
  pink: string;
  pinkBorder: string;
  red: string;
  teal: string;
  border: string;
  divider: string;
  calendarGridDivider: string;
  overlay: string;
}>;

export const NEUTRAL_COLORS: ColorPalette = Object.freeze({
  appBg:      '#F2F3F5',
  body:       '#FFFFFF',
  card:       '#FFFFFF',
  inputBg:    '#F2F3F5',
  tasksBg:    '#F2F3F5',
  waveformBg: '#F2F3F5',

  loginTop:   '#FFFFFF',
  loginBot:   '#F2F3F5',

  logoFrom:   '#5083FB',
  logoTo:     '#1456F0',

  primary:    '#1456F0',
  primaryHover: '#336DF4',
  primaryPressed: '#0C4CD3',
  primaryLight: '#F0F4FF',
  purple:     '#1456F0',
  purpleDark: '#0C4CD3',
  gradFrom:   '#336DF4',
  gradTo:     '#1456F0',
  purpleLight:'#F0F4FF',

  text:       '#1F2329',
  sub:        '#646A73',
  faint:      '#8F959E',
  disabled:   '#BBBFC4',
  pressed:    'rgba(31,35,41,0.12)',

  green:      '#258832',
  orange:     '#C25705',
  blue:       '#336DF4',
  pink:       '#D1498B',
  pinkBorder: '#DEE0E3',
  red:        '#E22E28',
  teal:       '#168F9D',

  border:     '#DEE0E3',
  divider:    'rgba(31,35,41,0.15)',
  // [PRODUCT] Month-grid hairlines are slightly deeper for scanability while
  // the shared divider remains unchanged for non-calendar surfaces.
  calendarGridDivider: 'rgba(31,35,41,0.18)',
  overlay:    'rgba(31,35,41,0.30)',
});

// [PRODUCT] Historical Figma design reference from the pre-Feishu visual
// direction. This is intentionally a LaoJi-only theme, not a Feishu source
// palette claim.
export const VIVID_COLORS: ColorPalette = Object.freeze({
  appBg:      '#FFF0F6',
  body:       '#FFF7FB',
  card:       '#FDEAF5',
  inputBg:    '#F0E8FF',
  tasksBg:    '#FFE5F1',
  waveformBg: '#ECE5FF',

  loginTop:   '#F8EAFE',
  loginBot:   '#FFE8F4',

  logoFrom:   '#CEAAF5',
  logoTo:     '#F0BEE0',

  primary:    '#7B5CB8',
  primaryHover: '#9268E0',
  primaryPressed: '#2E1880',
  primaryLight: '#EDE8FF',
  purple:     '#7B5CB8',
  purpleDark: '#2E1880',
  gradFrom:   '#9268E0',
  gradTo:     '#6A38B2',
  purpleLight:'#EDE8FF',

  text:       '#1C1B33',
  sub:        '#9490B5',
  faint:      '#B8B4D4',
  disabled:   '#D2CEE3',
  pressed:    'rgba(123,92,184,0.12)',

  green:      '#52C41A',
  orange:     '#FF9500',
  blue:       '#5B8CFF',
  pink:       '#FF8FAB',
  pinkBorder: '#FFB5CC',
  red:        '#FF4D4F',
  teal:       '#26C6DA',

  border:     'rgba(150,100,200,0.22)',
  divider:    'rgba(150,100,200,0.18)',
  calendarGridDivider: 'rgba(150,100,200,0.24)',
  overlay:    'rgba(46,24,128,0.34)',
});

export const THEME_COLORS: Readonly<Record<ThemeId, ColorPalette>> = Object.freeze({
  neutral: NEUTRAL_COLORS,
  vivid: VIVID_COLORS,
});

export function getColorsForTheme(themeId: ThemeId): ColorPalette {
  return THEME_COLORS[themeId];
}

export type ThemeAppearance = Readonly<{
  cardRadius: number;
  bottomBarRadius: number;
  bottomBarInset: number;
  surfaceInset: number;
  surfaceRadius: number;
  borderWidth: number;
  shadowOpacity: number;
}>;

// [PRODUCT] The vivid skin changes the surface silhouette as well as its
// palette: softly inset cards and a floating bottom bar restore the original
// LaoJi Figma direction. Standard blue retains the source-shaped flat shell.
export const THEME_APPEARANCE: Readonly<Record<ThemeId, ThemeAppearance>> = Object.freeze({
  neutral: Object.freeze({
    cardRadius: 6,
    bottomBarRadius: 0,
    bottomBarInset: 0,
    surfaceInset: 0,
    surfaceRadius: 0,
    borderWidth: 0,
    shadowOpacity: 0.18,
  }),
  vivid: Object.freeze({
    cardRadius: 16,
    bottomBarRadius: 18,
    bottomBarInset: 8,
    surfaceInset: 8,
    surfaceRadius: 16,
    borderWidth: 1,
    shadowOpacity: 0.12,
  }),
});

export function getThemeAppearance(themeId: ThemeId): ThemeAppearance {
  return THEME_APPEARANCE[themeId];
}

export const Appearance = getThemeAppearance(getSynchronousThemeId());

/** Apply alpha to a hex theme token without reintroducing page-local colors. */
export function withAlpha(color: string, alpha: number): string {
  const normalized = color.trim();
  const match = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (!match) return normalized;
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => (value >> shift) & 0xff;
  return `rgba(${channel(16)},${channel(8)},${channel(0)},${Math.max(0, Math.min(1, alpha))})`;
}

// Module-level styles use this synchronous native preference after an Android
// activity recreation. The portable provider supplies the same theme to
// components that already render semantic values at runtime.
export const Colors: ColorPalette = getColorsForTheme(getSynchronousThemeId());

export type ColorKey = keyof typeof Colors;

export const Radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  full: 999,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const Motion = {
  fast: 120,
  standard: 180,
  panel: 240,
} as const;
