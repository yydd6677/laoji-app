import { AppState, AppStateStatus } from 'react-native';
import { useEffect, useState } from 'react';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiConfig } from './config';
import { fetchWithTimeout as fetch, readJsonWithTimeout } from './http';
import { installVerifiedApk, sha256NativeFile } from 'laoji-native-platform';

export type AppUpdateStatus =
  | 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading'
  | 'ready_to_install' | 'failed';

export interface AppUpdateManifest {
  platform: 'android';
  version_name: string;
  version_code: number;
  apk_url: string;
  sha256: string;
  size_bytes: number;
  release_notes: string[];
  minimum_supported_version_code?: number;
}

export interface AppUpdateState {
  status: AppUpdateStatus;
  manifest: AppUpdateManifest | null;
  progress: number | null;
  message: string | null;
  checkedAtMs: number | null;
  downloadedUri: string | null;
}

const AUTO_CHECK_KEY = 'laoji.app-update.last-auto-check.v1';
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_APK_BYTES = 250 * 1024 * 1024;
const initialState: AppUpdateState = {
  status: 'idle', manifest: null, progress: null, message: null,
  checkedAtMs: null, downloadedUri: null,
};
let state = initialState;
const listeners = new Set<(next: AppUpdateState) => void>();

function publish(next: AppUpdateState): AppUpdateState {
  state = next;
  listeners.forEach(listener => listener(state));
  return state;
}

export function getAppUpdateState(): AppUpdateState { return state; }

export function subscribeAppUpdate(listener: (next: AppUpdateState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function currentVersionCode(): number {
  const value = Number(Constants.expoConfig?.android?.versionCode ?? Constants.nativeBuildVersion ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function currentVersionName(): string {
  return String(Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '未知');
}

export function appUpdateUserMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (raw.includes('允许老记安装')) return '请先允许老记安装应用更新。';
  if (raw.includes('安装文件版本不匹配')) return '安装文件版本不匹配，已取消安装。';
  if (raw.includes('安装文件无法识别') || raw.includes('安装文件不存在')) return '安装文件不可用，请重新下载。';
  if (raw.includes('校验失败')) return '下载文件校验失败，已取消安装。';
  if (raw.includes('没有可安装')) return '没有可安装的新版本。';
  if (raw.includes('缓存目录')) return '本机存储暂不可用，请检查剩余空间。';
  return '更新暂时无法完成，请稍后重试。';
}

function manifestUrl(): string {
  return `${getApiConfig().apiBase}/downloads/android/latest.json`;
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(getApiConfig().apiBase);
    return url.protocol === 'https:' && url.origin === base.origin && !url.username && !url.password;
  } catch { return false; }
}

function normalizeManifest(value: unknown): AppUpdateManifest {
  if (!value || typeof value !== 'object') throw new Error('版本清单格式无效');
  const raw = value as Record<string, unknown>;
  const versionName = typeof raw.version_name === 'string' ? raw.version_name.trim() : '';
  const versionCode = Number(raw.version_code);
  const apkUrl = typeof raw.apk_url === 'string' ? raw.apk_url.trim() : '';
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  const sizeBytes = Number(raw.size_bytes);
  const notes = Array.isArray(raw.release_notes)
    ? raw.release_notes.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : [];
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(versionName)
      || !Number.isSafeInteger(versionCode) || versionCode < 1
      || !isPublicHttpsUrl(apkUrl) || !/^sha256:[0-9a-f]{64}$/.test(sha256)
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_APK_BYTES) {
    throw new Error('版本清单格式无效');
  }
  return {
    platform: 'android', version_name: versionName, version_code: versionCode,
    apk_url: apkUrl, sha256, size_bytes: sizeBytes, release_notes: notes,
    minimum_supported_version_code: Number.isSafeInteger(Number(raw.minimum_supported_version_code))
      ? Number(raw.minimum_supported_version_code) : undefined,
  };
}

export async function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<AppUpdateState> {
  if (state.status === 'checking' || state.status === 'downloading') return state;
  const manual = options.manual === true;
  if (!manual) {
    const last = Number(await AsyncStorage.getItem(AUTO_CHECK_KEY).catch(() => '0'));
    if (Number.isFinite(last) && Date.now() - last < AUTO_CHECK_INTERVAL_MS) return state;
    await AsyncStorage.setItem(AUTO_CHECK_KEY, String(Date.now())).catch(() => undefined);
  }
  const previous = state;
  publish({ ...state, status: 'checking', message: null, progress: null });
  try {
    const response = await fetch(manifestUrl(), { headers: { Accept: 'application/json' } }, 15_000);
    if (!response.ok) throw new Error('暂时无法获取版本信息，请稍后重试。');
    const manifest = normalizeManifest(await readJsonWithTimeout(response, 10_000));
    if (manifest.version_code <= currentVersionCode()) {
      return publish({ ...state, status: 'up_to_date', manifest, checkedAtMs: Date.now(), message: '当前已是最新版本。' });
    }
    return publish({ ...state, status: 'available', manifest, checkedAtMs: Date.now(), message: `发现新版本 ${manifest.version_name}。` });
  } catch (error) {
    if (!manual) return publish({ ...previous, status: previous.status === 'checking' ? 'idle' : previous.status });
    return publish({ ...state, status: 'failed', checkedAtMs: Date.now(), message: error instanceof Error ? error.message : '版本检查失败，请稍后重试。' });
  }
}

export async function downloadAndInstallAppUpdate(): Promise<AppUpdateState> {
  const manifest = state.manifest;
  if (!manifest || manifest.version_code <= currentVersionCode()) {
    throw new Error('没有可安装的新版本。');
  }
  if (state.status === 'ready_to_install' && state.downloadedUri) {
    try {
      installVerifiedApk(state.downloadedUri, manifest.version_code);
    } catch (error) {
      throw new Error(appUpdateUserMessage(error));
    }
    return state;
  }
  publish({ ...state, status: 'downloading', progress: null, message: null });
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) throw new Error('本机缓存目录不可用。');
  const updateDir = `${cacheDir}updates/`;
  await FileSystem.makeDirectoryAsync(updateDir, { intermediates: true });
  const targetUri = `${updateDir}laoji-${manifest.version_name}-${manifest.version_code}.apk`;
  try {
    const existing = await FileSystem.readDirectoryAsync(updateDir).catch(() => []);
    await Promise.all(existing
      .filter(name => name.endsWith('.apk') && `${updateDir}${name}` !== targetUri)
      .map(name => FileSystem.deleteAsync(`${updateDir}${name}`, { idempotent: true })));
    await FileSystem.deleteAsync(targetUri, { idempotent: true });
    const download = FileSystem.createDownloadResumable(
      manifest.apk_url,
      targetUri,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : manifest.size_bytes;
        const progress = Math.max(0, Math.min(1, totalBytesWritten / total));
        publish({ ...state, status: 'downloading', progress, message: null });
      },
    );
    const result = await download.downloadAsync();
    if (!result) throw new Error('下载更新失败，请稍后重试。');
    if (result.status < 200 || result.status >= 300) {
      throw new Error('下载更新失败，请稍后重试。');
    }
    const checksum = await sha256NativeFile(result.uri);
    if (checksum.checksumSha256 !== manifest.sha256 || checksum.byteSize !== manifest.size_bytes) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true });
      throw new Error('下载文件校验失败，已取消安装。');
    }
    publish({ ...state, status: 'ready_to_install', progress: 1, downloadedUri: result.uri, message: null });
  } catch (error) {
    await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
    publish({ ...state, status: 'failed', progress: null, message: error instanceof Error ? error.message : '下载更新失败，请稍后重试。' });
    throw error;
  }
  try {
    installVerifiedApk(state.downloadedUri!, manifest.version_code);
  } catch (error) {
    throw new Error(appUpdateUserMessage(error));
  }
  return state;
}

export function useAppUpdate(): AppUpdateState {
  const [current, setCurrent] = useState<AppUpdateState>(state);
  useEffect(() => subscribeAppUpdate(setCurrent), []);
  return current;
}

export function startAutomaticAppUpdateChecks(): () => void {
  const initialTimer = setTimeout(() => { void checkForAppUpdate(); }, 4_000);
  const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') void checkForAppUpdate();
  });
  return () => {
    clearTimeout(initialTimer);
    subscription.remove();
  };
}
