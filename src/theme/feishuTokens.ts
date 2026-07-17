export type FeishuColorScheme = 'light' | 'dark';

export const FEISHU_FONT_SIZES = Object.freeze({
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

export const FEISHU_RADII = Object.freeze({
  xs: 2,
  s: 4,
  m: 6,
  l: 8,
  xl: 10,
  xxl: 12,
} as const);

export const FEISHU_DIMENSIONS = Object.freeze({
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

export const FEISHU_MOTION = Object.freeze({
  fabSegment: 170,
  calendarDragHaptic: 80,
  minutesLongPressHaptic: 100,
  chapterHaptic: 20,
  playbackSpeedHaptic: 50,
  insufficientSpaceHaptic: 500,
} as const);

export type FeishuSemanticColors = Readonly<{
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
  primaryHover: string;
  primaryPressed: string;
  primaryLoading: string;
  danger: string;
  dangerPressed: string;
  onPrimary: string;
  onTips: string;
  shadow: string;
}>;

// UI-TOKENS-001 aliases are resolved against values + values-night.
export const FEISHU_LIGHT_COLORS: FeishuSemanticColors = Object.freeze({
  backgroundBody: '#FFFFFF',
  backgroundBodyOverlay: '#F5F6F7',
  backgroundBase: '#F2F3F5',
  backgroundFloat: '#FFFFFF',
  backgroundFloatOverlay: '#F5F6F7',
  backgroundMask: 'rgba(0,0,0,0.55)',
  backgroundTips: '#1F2329',
  textTitle: '#1F2329',
  textCaption: '#646A73',
  textPlaceholder: '#8F959E',
  textDisabled: '#BBBFC4',
  textLink: '#1456F0',
  iconPrimary: '#2B2F36',
  iconSecondary: '#646A73',
  iconTertiary: '#8F959E',
  iconDisabled: '#BBBFC4',
  divider: 'rgba(31,35,41,0.15)',
  pressedFill: 'rgba(31,35,41,0.12)',
  primary: '#1456F0',
  primaryHover: '#336DF4',
  primaryPressed: '#0442D2',
  primaryLoading: '#94B4FF',
  danger: '#F54A45',
  dangerPressed: '#E22E28',
  onPrimary: '#FFFFFF',
  onTips: '#FFFFFF',
  shadow: '#000000',
});

export const FEISHU_DARK_COLORS: FeishuSemanticColors = Object.freeze({
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
  primaryHover: '#275FCE',
  primaryPressed: '#4C88FF',
  primaryLoading: '#2655B6',
  danger: '#F05B56',
  dangerPressed: '#F05B56',
  onPrimary: '#FFFFFF',
  onTips: '#FFFFFF',
  shadow: '#000000',
});

export type FeishuTokens = Readonly<{
  scheme: FeishuColorScheme;
  colors: FeishuSemanticColors;
  fontSize: typeof FEISHU_FONT_SIZES;
  radius: typeof FEISHU_RADII;
  dimension: typeof FEISHU_DIMENSIONS;
  motion: typeof FEISHU_MOTION;
}>;

function createTokens(
  scheme: FeishuColorScheme,
  colors: FeishuSemanticColors,
): FeishuTokens {
  return Object.freeze({
    scheme,
    colors,
    fontSize: FEISHU_FONT_SIZES,
    radius: FEISHU_RADII,
    dimension: FEISHU_DIMENSIONS,
    motion: FEISHU_MOTION,
  });
}

export const FEISHU_TOKENS: Readonly<Record<FeishuColorScheme, FeishuTokens>> = Object.freeze({
  light: createTokens('light', FEISHU_LIGHT_COLORS),
  dark: createTokens('dark', FEISHU_DARK_COLORS),
});

export function getFeishuTokens(scheme: FeishuColorScheme = 'light'): FeishuTokens {
  return FEISHU_TOKENS[scheme];
}
