import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeCurrentLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  ageMs: number;
  provider: string;
};

interface LaojiLocationModule {
  getCurrentLocation(
    maxAgeMs: number,
    requiredAccuracyMeters: number,
    timeoutMs: number,
  ): Promise<NativeCurrentLocation | null>;
}

const nativeModule = requireOptionalNativeModule<LaojiLocationModule>('LaojiLocation');

export async function getNativeCurrentLocation(
  maxAgeMs: number,
  requiredAccuracyMeters: number,
  timeoutMs: number,
): Promise<NativeCurrentLocation | null> {
  return nativeModule?.getCurrentLocation(maxAgeMs, requiredAccuracyMeters, timeoutMs) ?? null;
}
