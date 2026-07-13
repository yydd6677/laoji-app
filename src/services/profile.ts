import * as FileSystem from 'expo-file-system/legacy';
import { getAppStorageItem, setAppStorageItem } from './appStorage';

export const PROFILE_KEY = '@laoji_profile';

export type AvatarColors = [string, string];

export interface UserProfile {
  nickname: string;
  email: string;
  phone: string;
  avatarInitial: string;
  avatarInitialManual?: boolean;
  avatarColors: AvatarColors;
  avatarUrl?: string | null;
  avatarLocalUri?: string | null;
}

export const AVATAR_PRESETS: AvatarColors[] = [
  ['#F5A7D0', '#C9A6F5'],
  ['#9268E0', '#6A38B2'],
  ['#5B8CFF', '#26C6DA'],
  ['#FF8FAB', '#FF5C8A'],
  ['#52C41A', '#9EE37D'],
  ['#FF9500', '#FFC05C'],
];

export const DEFAULT_PROFILE: UserProfile = {
  nickname: '老记用户',
  email: '',
  phone: '',
  avatarInitial: '',
  avatarInitialManual: false,
  avatarColors: AVATAR_PRESETS[0],
  avatarUrl: null,
  avatarLocalUri: null,
};

export const GUEST_PROFILE: UserProfile = {
  nickname: '访客用户',
  email: '',
  phone: '',
  avatarInitial: '',
  avatarInitialManual: false,
  avatarColors: AVATAR_PRESETS[1],
  avatarUrl: null,
  avatarLocalUri: null,
};

function keyForScope(scope?: string): string {
  return scope ? `${PROFILE_KEY}:${scope}` : PROFILE_KEY;
}

export async function loadProfile(scope?: string, fallback: UserProfile = DEFAULT_PROFILE): Promise<UserProfile> {
  try {
    const raw = await getAppStorageItem(keyForScope(scope));
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    const nickname = saved.nickname === '王多鱼' ? fallback.nickname : saved.nickname || fallback.nickname;
    const email = ['wangduoyu@email.com', '访客模式'].includes(saved.email) ? fallback.email : saved.email ?? fallback.email;
    const phone = ['138 **** 8888', '未绑定'].includes(saved.phone) ? fallback.phone : saved.phone ?? fallback.phone;
    const savedColors = Array.isArray(saved.avatarColors) && saved.avatarColors.length >= 2
      ? [String(saved.avatarColors[0]), String(saved.avatarColors[1])] as AvatarColors
      : fallback.avatarColors;
    return {
      nickname,
      email,
      phone,
      avatarInitial: '',
      avatarInitialManual: false,
      avatarColors: savedColors,
      avatarUrl: saved.avatarUrl ?? fallback.avatarUrl ?? null,
      avatarLocalUri: saved.avatarLocalUri ?? fallback.avatarLocalUri ?? null,
    };
  } catch {
    return fallback;
  }
}

export async function saveProfile(profile: UserProfile, scope?: string): Promise<void> {
  await setAppStorageItem(keyForScope(scope), JSON.stringify(profile));
}

export async function persistLocalAvatar(uri: string, scope = 'default'): Promise<string> {
  if (!FileSystem.documentDirectory || uri.startsWith(`${FileSystem.documentDirectory}avatars/`)) return uri;
  const directory = `${FileSystem.documentDirectory}avatars/`;
  const extensionMatch = uri.split(/[?#]/, 1)[0].match(/\.([A-Za-z0-9]{2,5})$/);
  const extension = extensionMatch?.[1]?.toLowerCase() || 'jpg';
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default';
  const destination = `${directory}${safeScope}-${Date.now()}.${extension}`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.copyAsync({ from: uri, to: destination });
  return destination;
}

export async function removeManagedLocalAvatar(uri?: string | null): Promise<void> {
  if (!uri || !FileSystem.documentDirectory || !uri.startsWith(`${FileSystem.documentDirectory}avatars/`)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A stale avatar cache must not block profile changes.
  }
}

export function normalizeAvatarColors(value: unknown, fallback: AvatarColors = DEFAULT_PROFILE.avatarColors): AvatarColors {
  if (Array.isArray(value) && value.length >= 2) {
    const first = String(value[0] ?? '').trim();
    const second = String(value[1] ?? '').trim();
    if (first && second) return [first, second];
  }
  return fallback;
}
