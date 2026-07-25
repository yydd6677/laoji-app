import { requireOptionalNativeModule } from 'expo-modules-core';
import type { NativePlatformCapabilities } from './contracts';

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
export * from './mediaClip';
export * from './systemEntries';
export * from './ui';

interface LaojiNativePlatformModule {
  evidenceSchemaVersion: number;
  implementation: string;
  createRandomUuid(): string;
  getCapabilities(): Promise<NativePlatformCapabilities>;
}

const nativeModule = requireOptionalNativeModule<LaojiNativePlatformModule>(
  'LaojiNativePlatform',
);

export function hasLaojiNativePlatform(): boolean {
  return nativeModule !== null;
}

export function createNativeRandomUuid(): string | null {
  return nativeModule?.createRandomUuid() ?? null;
}

export async function getNativePlatformCapabilities(): Promise<NativePlatformCapabilities> {
  if (!nativeModule) {
    return {
      calendarSurface: false,
      minutesSurface: false,
      nativeAudioRuntime: false,
      mediaPlayer: false,
    };
  }
  return nativeModule.getCapabilities();
}
