import {
  FEISHU_DARK_COLORS,
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  FEISHU_LIGHT_COLORS,
  FEISHU_MOTION,
  FEISHU_RADII,
  FEISHU_TOKENS,
  getFeishuTokens,
} from '../src/theme/feishuTokens';

describe('Feishu semantic tokens', () => {
  it('publishes the sourced typography, radii and stable dimensions', () => {
    expect(FEISHU_FONT_SIZES).toEqual({
      title0: 26,
      title1: 24,
      title2: 20,
      title3: 17,
      body0: 16,
      body1: 14,
      caption1: 12,
      caption2: 10,
      caption3: 10,
    });
    expect(FEISHU_RADII).toEqual({ xs: 2, s: 4, m: 6, l: 8, xl: 10, xxl: 12 });
    expect(FEISHU_DIMENSIONS).toEqual(expect.objectContaining({
      divider: 0.5,
      titleBarHeight: 44,
      viewBarHeight: 50,
      fabSize: 48,
      emptyIllustrationSize: 100,
      retryButtonWidth: 76,
      retryButtonHeight: 36,
    }));
    expect(FEISHU_MOTION.fabSegment).toBe(170);
  });

  it('resolves day and night semantic aliases independently', () => {
    expect(FEISHU_LIGHT_COLORS).toEqual(expect.objectContaining({
      backgroundBody: '#FFFFFF',
      textTitle: '#1F2329',
      primary: '#1456F0',
      divider: 'rgba(31,35,41,0.15)',
    }));
    expect(FEISHU_DARK_COLORS).toEqual(expect.objectContaining({
      backgroundBody: '#1A1A1A',
      backgroundFloat: '#292929',
      textTitle: '#EBEBEB',
      primary: '#3370EB',
      divider: 'rgba(207,207,207,0.15)',
    }));
    expect(getFeishuTokens('dark')).toBe(FEISHU_TOKENS.dark);
    expect(getFeishuTokens()).toBe(FEISHU_TOKENS.light);
  });
});
