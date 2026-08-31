import { getSynchronousThemeId } from './nativeTheme';
import { type ThemeId } from './themeIds';
import {
  MIDNIGHT_COLORS,
  NEUTRAL_COLORS,
  PAPER_COLORS,
  VIVID_COLORS,
  type ColorPalette,
} from './colors';

export type UiColorScheme = 'light' | 'dark';

export const UI_FONT_SIZES = Object.freeze({
  title0: 26,
  title1: 24,
  title2: 20,
  title3: 17,
  body0: 16,
  body1: 14,
  caption1: 12,
  caption2: 10,
  caption3: 10,
} as const);

export const UI_RADII = Object.freeze({
  xs: 2,
  s: 4,
  m: 6,
  l: 8,
  xl: 10,
  xxl: 12,
} as const);

export const UI_DIMENSIONS = Object.freeze({
  divider: 0.5,
  titleBarHeight: 44,
  titleBarIconTarget: 44,
  compactIconTarget: 40,
  viewBarHeight: 50,
  fabSize: 48,
  fabInset: 16,
  startupStateVisualSize: 125,
  emptyIllustrationSize: 100,
  retryButtonWidth: 76,
  retryButtonHeight: 36,
  saveActionWidth: 64,
  toastMaxWidth: 295,
  toastIconSize: 20,
  toastActionMaxWidth: 75,
  dialogMaxWidth: 296,
  dialogActionHeight: 50,
  sheetMaxWidth: 450,
  sheetEdgeMargin: 12,
  sheetHeaderHeight: 52,
  sheetItemHeight: 52,
  sheetCancelHeight: 48,
} as const);

export const UI_MOTION = Object.freeze({
  fabSegment: 170,
  calendarDragHaptic: 80,
  minutesLongPressHaptic: 100,
  chapterHaptic: 20,
  playbackSpeedHaptic: 50,
  insufficientSpaceHaptic: 500,
} as const);

export type UiSemanticColors = Readonly<{
  backgroundBody: string;
  backgroundBodyOverlay: string;
  backgroundBase: string;
  backgroundFloat: string;
  backgroundFloatOverlay: string;
  backgroundMask: string;
  backgroundTips: string;
  textTitle: string;
  textCaption: string;
  textPlaceholder: string;
  textDisabled: string;
  textLink: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  iconDisabled: string;
  divider: string;
  pressedFill: string;
  primary: string;
  primarySoft: string;
  primaryHover: string;
  primaryPressed: string;
  primaryLoading: string;
  danger: string;
  dangerPressed: string;
  onPrimary: string;
  onTips: string;
  shadow: string;
}>;

function semanticColorsFromPalette(palette: ColorPalette): UiSemanticColors {
  return Object.freeze({
    backgroundBody: palette.body,
    backgroundBodyOverlay: palette.inputBg,
    backgroundBase: palette.appBg,
    backgroundFloat: palette.card,
    backgroundFloatOverlay: palette.tasksBg,
    backgroundMask: palette.overlay,
    backgroundTips: palette.text,
    textTitle: palette.text,
    textCaption: palette.sub,
    textPlaceholder: palette.faint,
    textDisabled: palette.disabled,
    textLink: palette.primary,
    iconPrimary: palette.text,
    iconSecondary: palette.sub,
    iconTertiary: palette.faint,
    iconDisabled: palette.disabled,
    divider: palette.divider,
    pressedFill: palette.pressed,
    primary: palette.primary,
    primarySoft: palette.primaryLight,
    primaryHover: palette.primaryHover,
    primaryPressed: palette.primaryPressed,
    primaryLoading: palette.disabled,
    danger: palette.red,
    dangerPressed: palette.red,
    onPrimary: '#FFFFFF',
    onTips: palette.appBg,
    shadow: palette.purpleDark,
  });
}

// UI-TOKENS-001 aliases are resolved against values + values-night.
export const NEUTRAL_LIGHT_COLORS: UiSemanticColors = semanticColorsFromPalette(NEUTRAL_COLORS);

export const NEUTRAL_DARK_COLORS: UiSemanticColors = Object.freeze({
  backgroundBody: '#1A1A1A',
  backgroundBodyOverlay: '#292929',
  backgroundBase: '#0A0A0A',
  backgroundFloat: '#292929',
  backgroundFloatOverlay: '#373737',
  backgroundMask: 'rgba(0,0,0,0.60)',
  backgroundTips: '#505050',
  textTitle: '#EBEBEB',
  textCaption: '#A6A6A6',
  textPlaceholder: '#757575',
  textDisabled: '#5F5F5F',
  textLink: '#4C88FF',
  iconPrimary: '#E8E8E8',
  iconSecondary: '#A6A6A6',
  iconTertiary: '#757575',
  iconDisabled: '#5F5F5F',
  divider: 'rgba(207,207,207,0.15)',
  pressedFill: 'rgba(235,235,235,0.12)',
  primary: '#3370EB',
  primarySoft: '#152340',
  primaryHover: '#275FCE',
  primaryPressed: '#4C88FF',
  primaryLoading: '#2655B6',
  danger: '#F05B56',
  dangerPressed: '#F05B56',
  onPrimary: '#FFFFFF',
  onTips: '#FFFFFF',
  shadow: '#000000',
});

// [PRODUCT] LaoJi's vivid skin keeps the same semantic roles and geometry as
// the standard skin while restoring the earlier lavender and pink direction.
export const VIVID_LIGHT_COLORS: UiSemanticColors = semanticColorsFromPalette(VIVID_COLORS);

export const PAPER_LIGHT_COLORS: UiSemanticColors = semanticColorsFromPalette(PAPER_COLORS);

// `夜航` is a deliberate dark skin, independent of the operating-system
// appearance. Both token schemes therefore use its own layered palette.
export const MIDNIGHT_THEME_COLORS: UiSemanticColors = semanticColorsFromPalette(MIDNIGHT_COLORS);

export const VIVID_DARK_COLORS: UiSemanticColors = Object.freeze({
  backgroundBody: '#211C2B',
  backgroundBodyOverlay: '#30283D',
  backgroundBase: '#17131E',
  backgroundFloat: '#30283D',
  backgroundFloatOverlay: '#44375A',
  backgroundMask: 'rgba(0,0,0,0.60)',
  backgroundTips: '#5B4385',
  textTitle: '#F7F1FF',
  textCaption: '#C5B7D8',
  textPlaceholder: '#9889AE',
  textDisabled: '#665975',
  textLink: '#C3A3FF',
  iconPrimary: '#F7F1FF',
  iconSecondary: '#C5B7D8',
  iconTertiary: '#9889AE',
  iconDisabled: '#665975',
  divider: 'rgba(235,220,255,0.16)',
  pressedFill: 'rgba(235,220,255,0.12)',
  primary: '#A982E8',
  primarySoft: '#3B2C55',
  primaryHover: '#C3A3FF',
  primaryPressed: '#D8C4FF',
  primaryLoading: '#6E588C',
  danger: '#FF7B7B',
  dangerPressed: '#FF4D4F',
  onPrimary: '#211C2B',
  onTips: '#FFFFFF',
  shadow: '#000000',
});

export type UiTokens = Readonly<{
  scheme: UiColorScheme;
  colors: UiSemanticColors;
  fontSize: typeof UI_FONT_SIZES;
  radius: typeof UI_RADII;
  dimension: typeof UI_DIMENSIONS;
  motion: typeof UI_MOTION;
}>;

function createTokens(
  scheme: UiColorScheme,
  colors: UiSemanticColors,
): UiTokens {
  return Object.freeze({
    scheme,
    colors,
    fontSize: UI_FONT_SIZES,
    radius: UI_RADII,
    dimension: UI_DIMENSIONS,
    motion: UI_MOTION,
  });
}

export const NEUTRAL_UI_TOKENS: Readonly<Record<UiColorScheme, UiTokens>> = Object.freeze({
  light: createTokens('light', NEUTRAL_LIGHT_COLORS),
  dark: createTokens('dark', NEUTRAL_DARK_COLORS),
});

export const THEME_UI_TOKENS: Readonly<Record<ThemeId, Readonly<Record<UiColorScheme, UiTokens>>>> = Object.freeze({
  neutral: NEUTRAL_UI_TOKENS,
  vivid: Object.freeze({
    light: createTokens('light', VIVID_LIGHT_COLORS),
    dark: createTokens('dark', VIVID_DARK_COLORS),
  }),
  paper: Object.freeze({
    light: createTokens('light', PAPER_LIGHT_COLORS),
    dark: createTokens('dark', PAPER_LIGHT_COLORS),
  }),
  midnight: Object.freeze({
    light: createTokens('dark', MIDNIGHT_THEME_COLORS),
    dark: createTokens('dark', MIDNIGHT_THEME_COLORS),
  }),
});

export function getUiTokens(
  scheme: UiColorScheme = 'light',
  themeId: ThemeId = getSynchronousThemeId(),
): UiTokens {
  return THEME_UI_TOKENS[themeId][scheme];
}
