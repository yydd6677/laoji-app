import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { getApiConfig } from './config';
import {
  getNativeCurrentLocationAttempt,
  type NativeCurrentLocation,
} from 'laoji-native-platform';
import {
  DEFAULT_LAST_KNOWN_MAX_AGE_MS,
  DEFAULT_REQUIRED_ACCURACY_METERS,
  coordinateConfidence,
  createSingleFlight,
  formatGeocodedAddressParts,
  isEligibleCachedFix,
  raceLocationProviders,
  resolveGeocodedAddress,
  type AddressConfidence,
  type AddressGranularity,
  type GeocodedAddressParts,
  type LocationFix,
  type LocationProviderAttempt,
  type ReverseGeocoderAdapter,
} from './currentAddressPolicy';
import { createHttpReverseGeocoder } from './reverseGeocoder';

const CURRENT_LOCATION_TIMEOUT_MS = 12_000;
const NATIVE_LOCATION_TIMEOUT_MS = 10_000;
const DEGRADED_LOCATION_GRACE_MS = 1_200;
const SYSTEM_GEOCODER_TIMEOUT_MS = 4_000;
const CONFIGURED_GEOCODER_TIMEOUT_MS = 5_000;

export type CurrentAddressResult = {
  address: string;
  usedCoordinateFallback: boolean;
  locationProvider: string;
  addressProvider: string | null;
  granularity: AddressGranularity;
  confidence: AddressConfidence;
  accuracyMeters: number | null;
  ageMs: number;
  timestampMs: number;
};

export class CurrentAddressError extends Error {
  constructor(
    readonly code: 'services-disabled' | 'permission-denied' | 'permission-blocked' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'CurrentAddressError';
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizedAccuracy(value: unknown): number | null {
  return finiteNumber(value) && value >= 0 ? value : null;
}

function expoAddressParts(value: Location.LocationGeocodedAddress): GeocodedAddressParts {
  return {
    formattedAddress: value.formattedAddress,
    country: value.country,
    region: value.region,
    city: value.city,
    district: value.district,
    subregion: value.subregion,
    street: value.street,
    streetNumber: value.streetNumber,
    name: value.name,
  };
}

export function formatGeocodedAddress(value: Location.LocationGeocodedAddress | undefined): string {
  return formatGeocodedAddressParts(value ? expoAddressParts(value) : undefined);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('location-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function expoLocationFix(
  value: Location.LocationObject,
  source: LocationFix['source'],
  provider: string,
): LocationFix {
  const receivedAtMs = Date.now();
  const timestampMs = finiteNumber(value.timestamp) && value.timestamp >= 0
    ? value.timestamp
    : receivedAtMs;
  return {
    latitude: value.coords.latitude,
    longitude: value.coords.longitude,
    accuracyMeters: normalizedAccuracy(value.coords.accuracy),
    ageMs: Math.max(0, receivedAtMs - timestampMs),
    timestampMs,
    provider,
    source,
  };
}

function nativeLocationFix(value: NativeCurrentLocation): LocationFix {
  const receivedAtMs = Date.now();
  const nativeAgeMs = finiteNumber(value.ageMs) && value.ageMs >= 0 ? value.ageMs : 0;
  const timestampMs = finiteNumber(value.timestampMs) && value.timestampMs >= 0
    ? value.timestampMs
    : Math.max(0, receivedAtMs - nativeAgeMs);
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    accuracyMeters: normalizedAccuracy(value.accuracy),
    ageMs: nativeAgeMs,
    timestampMs,
    provider: value.provider?.trim() || 'android-native',
    source: value.source === 'cache' ? 'cache' : 'live',
  };
}

const systemGeocoder: ReverseGeocoderAdapter = {
  provider: 'system',
  async reverse(fix) {
    const values = await Location.reverseGeocodeAsync({
      latitude: fix.latitude,
      longitude: fix.longitude,
    });
    return values.map(expoAddressParts);
  },
};

function configuredGeocoder(): ReverseGeocoderAdapter | null {
  const url = getApiConfig().reverseGeocoderUrl;
  if (!url) return null;
  try {
    return createHttpReverseGeocoder(url, undefined, CONFIGURED_GEOCODER_TIMEOUT_MS);
  } catch {
    // Configuration validation normally rejects this before a build is made;
    // keep a malformed runtime extra fail-closed and retain coordinate fallback.
    return null;
  }
}

async function position(): Promise<LocationFix> {
  const cached = await Location.getLastKnownPositionAsync({
    maxAge: DEFAULT_LAST_KNOWN_MAX_AGE_MS,
    requiredAccuracy: DEFAULT_REQUIRED_ACCURACY_METERS,
  }).catch(() => null);
  if (cached) {
    const cachedFix = expoLocationFix(cached, 'cache', 'expo-last-known');
    if (isEligibleCachedFix(cachedFix)) return cachedFix;
  }

  const candidates: LocationProviderAttempt[] = [
    expoLiveLocationAttempt(),
    expoCurrentPositionAttempt(),
  ];
  if (Platform.OS === 'android') {
    const nativeAttempt = getNativeCurrentLocationAttempt(
      DEFAULT_LAST_KNOWN_MAX_AGE_MS,
      DEFAULT_REQUIRED_ACCURACY_METERS,
      NATIVE_LOCATION_TIMEOUT_MS,
    );
    candidates.push({
      provider: 'android-native',
      result: nativeAttempt.result.then(value => value ? nativeLocationFix(value) : null),
      cancel: nativeAttempt.cancel,
    });
  }

  try {
    return await raceLocationProviders(candidates, {
      timeoutMs: CURRENT_LOCATION_TIMEOUT_MS,
      degradedGraceMs: DEGRADED_LOCATION_GRACE_MS,
    });
  } catch {
    throw new CurrentAddressError('unavailable', '系统定位器暂未返回位置，请稍后重试。');
  }
}

function expoLiveLocationAttempt(): LocationProviderAttempt {
  let subscription: Location.LocationSubscription | null = null;
  let cancelled = false;
  let resolveResult: (value: Location.LocationObject | null) => void = () => undefined;
  let rejectResult: (reason: unknown) => void = () => undefined;
  const result = new Promise<Location.LocationObject | null>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
    void Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, mayShowUserSettingsDialog: true },
      value => {
        if (cancelled) return;
        subscription?.remove();
        subscription = null;
        resolve(value);
      },
    ).then(value => {
      if (cancelled) {
        value.remove();
        return;
      }
      subscription = value;
    }).catch(reject);
  });
  return {
    provider: 'expo-live',
    result: result.then(value => value ? expoLocationFix(value, 'live', 'expo-live') : null),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      subscription?.remove();
      subscription = null;
      resolveResult(null);
    },
  };
}

function expoCurrentPositionAttempt(): LocationProviderAttempt {
  let cancelled = false;
  const result = Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
    // The watch provider owns the optional system-settings prompt. Avoid two
    // simultaneous prompts when both Expo providers race on Android.
    mayShowUserSettingsDialog: false,
  }).then(value => {
    if (cancelled) return null;
    return expoLocationFix(value, 'live', 'expo-current');
  });
  return {
    provider: 'expo-current',
    result,
    cancel: () => {
      cancelled = true;
    },
  };
}

async function resolveCurrentAddress(): Promise<CurrentAddressResult> {
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => null);
  if (servicesEnabled === null) {
    throw new CurrentAddressError('unavailable', '暂时无法检查系统定位服务，请稍后重试。');
  }
  if (!servicesEnabled) {
    throw new CurrentAddressError('services-disabled', '系统定位服务未开启，请开启后重试。');
  }

  let permission = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!permission) {
    throw new CurrentAddressError('unavailable', '暂时无法检查位置权限，请稍后重试。');
  }
  if (permission.status !== 'granted' && permission.canAskAgain) {
    permission = await Location.requestForegroundPermissionsAsync().catch(() => null);
    if (!permission) {
      throw new CurrentAddressError('unavailable', '暂时无法申请位置权限，请稍后重试。');
    }
  }
  if (permission.status !== 'granted') {
    throw new CurrentAddressError(
      permission.canAskAgain ? 'permission-denied' : 'permission-blocked',
      permission.canAskAgain
        ? '未获得位置权限，无法获取当前位置。'
        : '位置权限已关闭，请在系统设置中开启后重试。',
    );
  }

  const current = await position();
  const configured = configuredGeocoder();
  // An explicitly configured provider is the product's deliberate address
  // source; prefer it so a coarse system result cannot hide a more precise
  // server result. The system provider remains the privacy-preserving fallback.
  const adapters = configured ? [configured, systemGeocoder] : [systemGeocoder];
  for (const adapter of adapters) {
    try {
      const resolution = await withTimeout(
        resolveGeocodedAddress(adapter, current),
        adapter.provider === systemGeocoder.provider
          ? SYSTEM_GEOCODER_TIMEOUT_MS
          : CONFIGURED_GEOCODER_TIMEOUT_MS,
      );
      if (resolution) {
        return {
          address: resolution.address.slice(0, 400),
          usedCoordinateFallback: false,
          locationProvider: current.provider,
          addressProvider: resolution.provider,
          granularity: resolution.granularity,
          confidence: resolution.confidence,
          accuracyMeters: current.accuracyMeters,
          ageMs: current.ageMs,
          timestampMs: current.timestampMs,
        };
      }
    } catch {
      // A provider failure must not discard an already verified coordinate.
    }
  }

  return {
    address: `${current.latitude.toFixed(6)}, ${current.longitude.toFixed(6)}`,
    usedCoordinateFallback: true,
    locationProvider: current.provider,
    addressProvider: null,
    granularity: 'coordinates',
    confidence: coordinateConfidence(current.accuracyMeters),
    accuracyMeters: current.accuracyMeters,
    ageMs: current.ageMs,
    timestampMs: current.timestampMs,
  };
}

export const getCurrentAddress = createSingleFlight(resolveCurrentAddress);
