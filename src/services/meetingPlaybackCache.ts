import * as FileSystem from 'expo-file-system/legacy';
import type { ApiMeetingAudioInfo } from './api';
import { validateMeetingAudioUrl } from './meetingAudioSecurity';

const PLAYBACK_CACHE_DIRECTORY = 'meeting-playback/';
const inFlightDownloads = new Map<string, Promise<string>>();

function cacheRoot(): string {
  if (!FileSystem.cacheDirectory) throw new Error('meeting playback cache unavailable');
  return `${FileSystem.cacheDirectory}${PLAYBACK_CACHE_DIRECTORY}`;
}

function audioExtension(info: ApiMeetingAudioInfo): string {
  const source = info.file_name || info.url.split(/[?#]/)[0];
  const match = source.match(/\.([A-Za-z0-9]{2,6})$/);
  if (match) return `.${match[1].toLowerCase()}`;
  const mime = info.mime_type?.toLowerCase();
  if (mime?.includes('mpeg')) return '.mp3';
  if (mime?.includes('mp4') || mime?.includes('m4a')) return '.m4a';
  if (mime?.includes('aac')) return '.aac';
  if (mime?.includes('ogg')) return '.ogg';
  if (mime?.includes('webm')) return '.webm';
  return '.wav';
}

function safeIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'meeting';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function existingFile(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && (typeof info.size !== 'number' || info.size > 0);
  } catch {
    return false;
  }
}

export async function materializeMeetingPlaybackAudio(input: {
  meetingId: string;
  meetingUpdatedAt?: string | null;
  audio: ApiMeetingAudioInfo;
  accessToken?: string | null;
}): Promise<string> {
  const { audio } = input;
  if (audio.url.startsWith('file://') || audio.url.startsWith('content://')) return audio.url;
  if (audio.requires_auth && !input.accessToken) throw new Error('meeting playback authentication required');

  const remoteUrl = validateMeetingAudioUrl(audio.url, {
    requiresAuth: audio.requires_auth,
    expiresAt: audio.expires_at,
  });
  const version = stableHash([
    input.meetingUpdatedAt ?? '',
    audio.file_name ?? '',
    audio.mime_type ?? '',
    String(audio.duration_sec ?? ''),
  ].join('|'));
  const root = cacheRoot();
  const target = `${root}${safeIdentity(input.meetingId)}-${version}${audioExtension(audio)}`;
  if (await existingFile(target)) return target;

  const current = inFlightDownloads.get(target);
  if (current) return current;
  const operation = (async () => {
    await FileSystem.makeDirectoryAsync(root, { intermediates: true });
    if (await existingFile(target)) return target;
    const temporary = `${target}.${Date.now()}.part`;
    try {
      const result = await FileSystem.downloadAsync(remoteUrl, temporary, {
        headers: audio.requires_auth && input.accessToken
          ? { Authorization: `Bearer ${input.accessToken}` }
          : undefined,
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`meeting playback download failed: ${result.status}`);
      }
      if (await existingFile(target)) {
        await FileSystem.deleteAsync(temporary, { idempotent: true });
        return target;
      }
      await FileSystem.moveAsync({ from: temporary, to: target });
      return target;
    } catch (error) {
      await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => {});
      throw error;
    }
  })();
  inFlightDownloads.set(target, operation);
  try {
    return await operation;
  } finally {
    if (inFlightDownloads.get(target) === operation) inFlightDownloads.delete(target);
  }
}

export async function deleteMeetingPlaybackCache(meetingId: string): Promise<void> {
  const prefix = `${safeIdentity(meetingId)}-`;
  const root = cacheRoot();
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter(name => name.startsWith(prefix))
      .map(name => FileSystem.deleteAsync(`${root}${name}`, { idempotent: true })),
  );
}
