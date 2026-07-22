const LEGACY_DEFAULT_RECORDING_TITLE = /^新录音 \d{1,2}月\d{1,2}日 \d{2}:\d{2}$/;

/**
 * Feishu keeps the default recording name separate from its creation time.
 * LaoJi v96 and earlier persisted both in one title, so normalize that exact
 * legacy pattern at the presentation boundary. Empty user data also receives
 * a presentation-only label; neither fallback is written back to the title.
 */
export function displayMeetingTitle(value: string): string {
  const title = value.trim();
  if (!title) return '未命名会议';
  return LEGACY_DEFAULT_RECORDING_TITLE.test(title) ? '新录音' : title;
}

export function defaultMeetingTitle(): string {
  return '新录音';
}
