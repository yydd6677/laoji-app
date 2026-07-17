import { StyleSheet } from 'react-native';

// UI-SHELL-BOTTOM-MAIN-001: Feishu keeps a physical-pixel divider outside its 65dp bar.
export const NATIVE_BOTTOM_BAR_CONTENT_HEIGHT = 65;
export const NATIVE_BOTTOM_BAR_DIVIDER_HEIGHT = StyleSheet.hairlineWidth ?? 1;

export function getNativeBottomBarHeight(bottomInset: number): number {
  return NATIVE_BOTTOM_BAR_DIVIDER_HEIGHT + NATIVE_BOTTOM_BAR_CONTENT_HEIGHT + Math.max(0, bottomInset);
}
