import { getSynchronousThemeId } from './nativeTheme';
import { type ThemeId } from './themeIds';
import { getThemeFontFamily, type ThemeFontFamily } from './typography';

// Legacy key names remain temporarily so existing screens can share one
// palette while they migrate to the semantic UI token owner.
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
  appBg:      '#F3F6FA',
  body:       '#FCFDFF',
  card:       '#FFFFFF',
  inputBg:    '#EEF3FA',
  tasksBg:    '#EFF4FF',
  waveformBg: '#EDF3FB',

  loginTop:   '#FFFFFF',
  loginBot:   '#F2F3F5',

  logoFrom:   '#5B91F2',
  logoTo:     '#2768E8',

  primary:    '#2768E8',
  primaryHover: '#3C78EE',
  primaryPressed: '#1B55C8',
  primaryLight: '#EAF1FF',
  purple:     '#2768E8',
  purpleDark: '#1B55C8',
  gradFrom:   '#4D7FEA',
  gradTo:     '#2768E8',
  purpleLight:'#EAF1FF',

  text:       '#172033',
  sub:        '#5B6577',
  faint:      '#8792A5',
  disabled:   '#B4BCC8',
  pressed:    'rgba(23,32,51,0.10)',

  green:      '#258832',
  orange:     '#C25705',
  blue:       '#336DF4',
  pink:       '#D1498B',
  pinkBorder: '#DEE0E3',
  red:        '#E22E28',
  teal:       '#168F9D',

  border:     '#DCE3EC',
  divider:    'rgba(23,32,51,0.13)',
  // [PRODUCT] Month-grid hairlines are slightly deeper for scanability while
  // the shared divider remains unchanged for non-calendar surfaces.
  calendarGridDivider: 'rgba(23,32,51,0.17)',
  overlay:    'rgba(15,23,38,0.34)',
});

// [PRODUCT] This palette preserves LaoJi's earlier Figma direction while
// remaining part of the current product-owned theme system.
export const VIVID_COLORS: ColorPalette = Object.freeze({
  appBg:      '#F8F6FC',
  body:       '#FFFDFE',
  card:       '#FFFFFF',
  inputBg:    '#F2EEFC',
  tasksBg:    '#FFF0F5',
  waveformBg: '#EFECFA',

  loginTop:   '#FCFAFF',
  loginBot:   '#F5F0FC',

  logoFrom:   '#8A72D8',
  logoTo:     '#E17A9E',

  primary:    '#7255C9',
  primaryHover: '#8467D8',
  primaryPressed: '#5B40AE',
  primaryLight: '#EEE9FC',
  purple:     '#7255C9',
  purpleDark: '#4F369D',
  gradFrom:   '#8265D4',
  gradTo:     '#D86F99',
  purpleLight:'#EEE9FC',

  text:       '#211D2D',
  sub:        '#6E687B',
  faint:      '#9992A7',
  disabled:   '#C9C4D1',
  pressed:    'rgba(114,85,201,0.11)',

  green:      '#52C41A',
  orange:     '#FF9500',
  blue:       '#5B8CFF',
  pink:       '#FF8FAB',
  pinkBorder: '#FFB5CC',
  red:        '#FF4D4F',
  teal:       '#26C6DA',

  border:     '#E4DDEC',
  divider:    'rgba(71,55,92,0.13)',
  calendarGridDivider: 'rgba(71,55,92,0.17)',
  overlay:    'rgba(36,25,54,0.36)',
});

export const PAPER_COLORS: ColorPalette = Object.freeze({
  appBg:      '#F3F0E7',
  body:       '#FCFBF6',
  card:       '#F8F6EF',
  inputBg:    '#EFEEE6',
  tasksBg:    '#F3F1E8',
  waveformBg: '#ECEBE3',

  loginTop:   '#FCFBF6',
  loginBot:   '#F1EEE3',

  logoFrom:   '#82943D',
  logoTo:     '#607624',

  primary:    '#637824',
  primaryHover: '#758A32',
  primaryPressed: '#4D6018',
  primaryLight: '#E9EDD9',
  purple:     '#637824',
  purpleDark: '#4D6018',
  gradFrom:   '#82943D',
  gradTo:     '#607624',
  purpleLight:'#E9EDD9',

  text:       '#252621',
  sub:        '#62635D',
  faint:      '#85867E',
  disabled:   '#B4B5AD',
  pressed:    'rgba(37,38,33,0.09)',

  green:      '#5F7D28',
  orange:     '#B56A22',
  blue:       '#3E718F',
  pink:       '#A95C72',
  pinkBorder: '#D8C5CB',
  red:        '#C95045',
  teal:       '#3F7C78',

  border:     '#D8D7CD',
  divider:    'rgba(37,38,33,0.13)',
  calendarGridDivider: 'rgba(37,38,33,0.17)',
  overlay:    'rgba(34,35,30,0.38)',
});

export const MIDNIGHT_COLORS: ColorPalette = Object.freeze({
  appBg:      '#10141B',
  body:       '#151A22',
  card:       '#1B222D',
  inputBg:    '#202834',
  tasksBg:    '#1D2630',
  waveformBg: '#18212B',

  loginTop:   '#151A22',
  loginBot:   '#10141B',

  logoFrom:   '#8AB6FF',
  logoTo:     '#5E91EB',

  primary:    '#74A7FF',
  primaryHover: '#8BB6FF',
  primaryPressed: '#5A8DE7',
  primaryLight: '#1E3250',
  purple:     '#74A7FF',
  purpleDark: '#5A8DE7',
  gradFrom:   '#74A7FF',
  gradTo:     '#59B9B7',
  purpleLight:'#1E3250',

  text:       '#EEF3FA',
  sub:        '#B0BAC8',
  faint:      '#7F8A9A',
  disabled:   '#566170',
  pressed:    'rgba(238,243,250,0.10)',

  green:      '#67C587',
  orange:     '#E0A45C',
  blue:       '#75A9FF',
  pink:       '#E588B2',
  pinkBorder: '#704A5F',
  red:        '#FF7770',
  teal:       '#63C7C7',

  border:     '#2C3745',
  divider:    'rgba(222,231,242,0.14)',
  calendarGridDivider: 'rgba(222,231,242,0.18)',
  overlay:    'rgba(0,0,0,0.58)',
});

export const THEME_COLORS: Readonly<Record<ThemeId, ColorPalette>> = Object.freeze({
  neutral: NEUTRAL_COLORS,
  vivid: VIVID_COLORS,
  paper: PAPER_COLORS,
  midnight: MIDNIGHT_COLORS,
});

export function getColorsForTheme(themeId: ThemeId): ColorPalette {
  return THEME_COLORS[themeId];
}

export type ThemeAppearance = Readonly<{
  surfaceMode: 'flat' | 'soft' | 'editorial' | 'layered';
  motionStyle: 'direct' | 'spring' | 'lift' | 'luminous';
  stackAnimation: 'slide_from_right' | 'fade_from_bottom' | 'fade' | 'simple_push';
  modalAnimation: 'slide_from_bottom' | 'fade_from_bottom' | 'fade' | 'simple_push';
  tabAnimation: 'shift' | 'fade';
  cardRadius: number;
  controlRadius: number;
  iconRadius: number;
  primaryActionRadius: number;
  bottomBarRadius: number;
  bottomBarInset: number;
  surfaceInset: number;
  surfaceRadius: number;
  borderWidth: number;
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
  fontFamily: ThemeFontFamily;
  titleFontFamily: ThemeFontFamily;
  titleLetterSpacing: number;
  pressScale: number;
  pressOpacity: number;
  pressInMs: number;
  pressOutMs: number;
  panelEnterOffset: number;
  panelDurationMs: number;
  tabDurationMs: number;
  motionScale: number;
  springy: boolean;
}>;

// [PRODUCT] The vivid skin changes the surface silhouette as well as its
// palette: softly inset cards and a floating bottom bar restore the original
// LaoJi Figma direction. Standard blue retains the source-shaped flat shell.
export const THEME_APPEARANCE: Readonly<Record<ThemeId, ThemeAppearance>> = Object.freeze({
  neutral: Object.freeze({
    surfaceMode: 'flat',
    motionStyle: 'direct',
    stackAnimation: 'slide_from_right',
    modalAnimation: 'slide_from_bottom',
    tabAnimation: 'shift',
    cardRadius: 8,
    controlRadius: 10,
    iconRadius: 10,
    primaryActionRadius: 24,
    bottomBarRadius: 0,
    bottomBarInset: 0,
    surfaceInset: 0,
    surfaceRadius: 0,
    borderWidth: 0.5,
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 0,
    fontFamily: getThemeFontFamily('neutral'),
    titleFontFamily: getThemeFontFamily('neutral'),
    titleLetterSpacing: 0,
    pressScale: 0.97,
    pressOpacity: 0.94,
    pressInMs: 90,
    pressOutMs: 110,
    panelEnterOffset: 6,
    panelDurationMs: 220,
    tabDurationMs: 165,
    motionScale: 0.92,
    springy: false,
  }),
  vivid: Object.freeze({
    surfaceMode: 'soft',
    motionStyle: 'spring',
    stackAnimation: 'fade_from_bottom',
    modalAnimation: 'fade_from_bottom',
    tabAnimation: 'fade',
    cardRadius: 16,
    controlRadius: 14,
    iconRadius: 14,
    primaryActionRadius: 16,
    bottomBarRadius: 16,
    bottomBarInset: 0,
    surfaceInset: 0,
    surfaceRadius: 0,
    borderWidth: 1,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 1,
    fontFamily: getThemeFontFamily('vivid'),
    titleFontFamily: getThemeFontFamily('vivid'),
    titleLetterSpacing: 0.1,
    pressScale: 0.94,
    pressOpacity: 0.96,
    pressInMs: 100,
    pressOutMs: 250,
    panelEnterOffset: 10,
    panelDurationMs: 280,
    tabDurationMs: 210,
    motionScale: 1,
    springy: true,
  }),
  paper: Object.freeze({
    surfaceMode: 'editorial',
    motionStyle: 'lift',
    stackAnimation: 'fade',
    modalAnimation: 'fade',
    tabAnimation: 'fade',
    cardRadius: 10,
    controlRadius: 10,
    iconRadius: 8,
    primaryActionRadius: 12,
    bottomBarRadius: 0,
    bottomBarInset: 0,
    surfaceInset: 0,
    surfaceRadius: 0,
    borderWidth: 0.5,
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 0,
    fontFamily: getThemeFontFamily('paper'),
    titleFontFamily: getThemeFontFamily('paper'),
    titleLetterSpacing: 0.15,
    pressScale: 0.985,
    pressOpacity: 0.92,
    pressInMs: 100,
    pressOutMs: 180,
    panelEnterOffset: 8,
    panelDurationMs: 280,
    tabDurationMs: 220,
    motionScale: 1.04,
    springy: false,
  }),
  midnight: Object.freeze({
    surfaceMode: 'layered',
    motionStyle: 'luminous',
    stackAnimation: 'simple_push',
    modalAnimation: 'fade_from_bottom',
    tabAnimation: 'shift',
    cardRadius: 12,
    controlRadius: 12,
    iconRadius: 11,
    primaryActionRadius: 18,
    bottomBarRadius: 0,
    bottomBarInset: 0,
    surfaceInset: 0,
    surfaceRadius: 0,
    borderWidth: 1,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    fontFamily: getThemeFontFamily('midnight'),
    titleFontFamily: getThemeFontFamily('midnight'),
    titleLetterSpacing: 0.05,
    pressScale: 0.975,
    pressOpacity: 0.82,
    pressInMs: 70,
    pressOutMs: 100,
    panelEnterOffset: 4,
    panelDurationMs: 160,
    tabDurationMs: 145,
    motionScale: 0.88,
    springy: false,
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
  pressIn: 90,
  pressOut: 110,
  fast: 120,
  select: 170,
  standard: 180,
  feedback: 210,
  panel: 240,
  spatial: 280,
  ambient: 1200,
} as const;
