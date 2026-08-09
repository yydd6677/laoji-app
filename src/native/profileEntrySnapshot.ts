import type { NativeProfileEntrySnapshot } from 'laoji-native-platform';
import type { UserProfile } from '../services/profile';

export function buildNativeProfileEntrySnapshot(
  profile: UserProfile,
  isGuest: boolean,
): NativeProfileEntrySnapshot {
  void isGuest; // retained for the compatibility call sites during cutover
  const nickname = profile.nickname.trim();
  return {
    avatarUri: profile.avatarUrl?.trim() || profile.avatarLocalUri?.trim() || null,
    accessibilityLabel: nickname
      ? `打开设置，${nickname}`
      : '打开设置',
  };
}
