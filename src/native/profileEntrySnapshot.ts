import type { NativeProfileEntrySnapshot } from 'laoji-native-platform';
import type { UserProfile } from '../services/profile';

export function buildNativeProfileEntrySnapshot(
  profile: UserProfile,
  isGuest: boolean,
): NativeProfileEntrySnapshot {
  void isGuest; // retained for the compatibility call sites during cutover
  const nickname = profile.nickname.trim();
  return {
    // The product is accountless: this leading control opens Settings, so an
    // old profile/avatar projection must not bring the former “我” identity
    // entry back into the title bar.
    avatarUri: null,
    accessibilityLabel: nickname
      ? `打开设置，${nickname}`
      : '打开设置',
  };
}
