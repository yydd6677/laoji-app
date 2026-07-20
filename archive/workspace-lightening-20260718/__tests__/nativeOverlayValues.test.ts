import {
  compactNativeBridgeValue,
  compactNativeOverlaySnapshot,
} from '../modules/laoji-native-platform/src/nativeValues';

describe('native overlay bridge values [UI-OVERLAY-WINDOW-001]', () => {
  it('removes undefined recursively before Expo converts values to Kotlin', () => {
    expect(compactNativeOverlaySnapshot({
      visible: true,
      title: '会议记录',
      hint: undefined,
      items: [
        { key: 'profile', label: '个人资料', destructive: undefined },
        undefined,
      ],
    })).toEqual({
      visible: true,
      title: '会议记录',
      items: [{ key: 'profile', label: '个人资料' }],
    });
  });

  it('retains null and supported nested scalar values', () => {
    expect(compactNativeBridgeValue({ value: null, flags: [false, 0, ''] })).toEqual({
      value: null,
      flags: [false, 0, ''],
    });
  });
});
