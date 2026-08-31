import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeCurrentLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  ageMs: number;
  provider: string;
  timestampMs?: number;
  source?: 'cache' | 'live';
};

interface LaojiLocationModule {
  getCurrentLocation(
    maxAgeMs: number,
    requiredAccuracyMeters: number,
    timeoutMs: number,
    requestId: string,
  ): Promise<NativeCurrentLocation | null>;
  cancelCurrentLocation?(requestId: string): void | Promise<void>;
}

const nativeModule = requireOptionalNativeModule<LaojiLocationModule>('LaojiLocation');

export function getNativeCurrentLocationAttempt(
  maxAgeMs: number,
  requiredAccuracyMeters: number,
  timeoutMs: number,
): {
  result: Promise<NativeCurrentLocation | null>;
  cancel: () => void;
} {
  const requestId = `location-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!nativeModule) {
    return { result: Promise.resolve(null), cancel: () => undefined };
  }
  let cancelled = false;
  let result: Promise<NativeCurrentLocation | null>;
  try {
    result = nativeModule.getCurrentLocation(
      maxAgeMs,
      requiredAccuracyMeters,
      timeoutMs,
      requestId,
    );
  } catch {
    // A partially installed native module must not take down the Expo provider
    // race; treat this provider as an immediate miss and let the other attempt
    // continue.
    return { result: Promise.resolve(null), cancel: () => undefined };
  }
  return {
    result,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      void nativeModule.cancelCurrentLocation?.(requestId);
    },
  };
}
