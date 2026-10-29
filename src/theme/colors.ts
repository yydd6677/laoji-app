import { getSynchronousThemeId } from './nativeTheme';
import { GENERATED_PALETTES } from './generatedUiTokens';
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

// Color values are authored once in core.tokens.json for RN and Android.
export const NEUTRAL_COLORS: ColorPalette = GENERATED_PALETTES.neutral;
export const VIVID_COLORS: ColorPalette = GENERATED_PALETTES.vivid;
export const PAPER_COLORS: ColorPalette = GENERATED_PALETTES.paper;
export const MIDNIGHT_COLORS: ColorPalette = GENERATED_PALETTES.midnight;

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

// Initial palette for non-reactive utilities and portable legacy renderers.
// Live UI consumes ThemeProvider; this value is not a theme-update owner.
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
