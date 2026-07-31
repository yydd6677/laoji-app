import type { NativeProfileEntrySnapshot } from 'laoji-native-platform';
import type { UserProfile } from '../services/profile';

export function buildNativeProfileEntrySnapshot(
  profile: UserProfile,
  isGuest: boolean,
): NativeProfileEntrySnapshot {
  const nickname = profile.nickname.trim();
  return {
    avatarUri: profile.avatarUrl?.trim() || profile.avatarLocalUri?.trim() || null,
    accessibilityLabel: nickname
      ? `打开个人资料，${nickname}${isGuest ? '，访客' : ''}`
      : isGuest ? '打开个人资料，访客' : '打开个人资料',
  };
}
