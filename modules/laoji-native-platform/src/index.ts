import { requireOptionalNativeModule } from 'expo-modules-core';

export * from './contracts';
export * from './calendar';
export * from './calendarPages';
export * from './transfer';
export * from './minutes';
export * from './audio';
export * from './scheduleVoice';
export * from './speaker';
export * from './location';
export * from './mediaImport';
export * from './systemEntries';
export * from './ui';
export * from './deviceAuth';
export * from './hardware';

interface LaojiNativePlatformModule {
  createRandomUuid(): string;
  sha256File(fileUri: string): Promise<{ checksumSha256: string; byteSize: number }>;
  getThemePreference?(): string;
  setThemePreference?(themeId: string): void;
  restartActivity?(): void;
  installApk?(fileUri: string, expectedVersionCode: number): boolean;
  openApkInstallSettings?(): boolean;
}

const nativeModule = requireOptionalNativeModule<LaojiNativePlatformModule>(
  'LaojiNativePlatform',
);

export function createNativeRandomUuid(): string | null {
  return nativeModule?.createRandomUuid() ?? null;
}

export async function sha256NativeFile(fileUri: string): Promise<{
  checksumSha256: string;
  byteSize: number;
}> {
  if (!nativeModule) throw new Error('当前设备无法校验附件文件。');
  const result = await nativeModule.sha256File(fileUri);
  const checksumSha256 = result?.checksumSha256?.trim().toLocaleLowerCase();
  const byteSize = Number(result?.byteSize);
  if (!/^sha256:[0-9a-f]{64}$/.test(checksumSha256) || !Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error('附件文件校验失败。');
  }
  return { checksumSha256, byteSize };
}

export function installVerifiedApk(fileUri: string, expectedVersionCode: number): boolean {
  if (!nativeModule?.installApk) throw new Error('当前设备不支持应用内安装更新。');
  return nativeModule.installApk(fileUri, expectedVersionCode);
}

export function openApkInstallSettings(): boolean {
  if (!nativeModule?.openApkInstallSettings) throw new Error('当前设备无法打开安装权限设置。');
  return nativeModule.openApkInstallSettings();
}
