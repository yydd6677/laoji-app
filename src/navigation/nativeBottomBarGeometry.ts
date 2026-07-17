// UI-SHELL-002 / UI-MOTION-001: Feishu's main tab bar is 65dp above system navigation.
export const NATIVE_BOTTOM_BAR_CONTENT_HEIGHT = 65;

export function getNativeBottomBarHeight(bottomInset: number): number {
  return NATIVE_BOTTOM_BAR_CONTENT_HEIGHT + Math.max(0, bottomInset);
}
