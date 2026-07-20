import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { getNativeCurrentLocation } from 'laoji-native-platform';

const CURRENT_LOCATION_TIMEOUT_MS = 12_000;
const NATIVE_LOCATION_TIMEOUT_MS = 10_000;
const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;
const LAST_KNOWN_REQUIRED_ACCURACY_METERS = 500;

type CurrentCoordinates = {
  latitude: number;
  longitude: number;
};

export type CurrentAddressResult = {
  address: string;
  usedCoordinateFallback: boolean;
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

function cleanPart(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function uniqueParts(values: Array<string | null | undefined>): string[] {
  const parts: string[] = [];
  values.forEach(value => {
    const part = cleanPart(value);
    if (!part) return;
    if (parts.some(existing => existing === part || existing.endsWith(part))) return;
    parts.push(part);
  });
  return parts;
}

export function formatGeocodedAddress(value: Location.LocationGeocodedAddress | undefined): string {
  if (!value) return '';
  const formatted = cleanPart(value.formattedAddress);
  const startsWithPlusCode = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,}/i.test(formatted);
  if (formatted && !startsWithPlusCode) return formatted;

  const parts = uniqueParts([
    value.country,
    value.region,
    value.city,
    value.district,
    value.subregion,
    value.street,
    value.streetNumber,
    value.name,
  ]);
  if (parts.length === 0) return formatted;
  const containsCjk = parts.some(part => /[\u3400-\u9fff]/.test(part));
  return parts.join(containsCjk ? '' : ', ');
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

async function firstSuccessful<T>(promises: Array<Promise<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remaining = promises.length;
    let lastError: unknown = new Error('no-location-provider');
    promises.forEach(promise => {
      promise.then(resolve).catch(reason => {
        lastError = reason;
        remaining -= 1;
        if (remaining === 0) reject(lastError);
      });
    });
  });
}

async function position(): Promise<CurrentCoordinates> {
  const cached = await Location.getLastKnownPositionAsync({
    maxAge: LAST_KNOWN_MAX_AGE_MS,
    requiredAccuracy: LAST_KNOWN_REQUIRED_ACCURACY_METERS,
  }).catch(() => null);
  if (cached) return cached.coords;

  const candidates: Array<Promise<CurrentCoordinates>> = [
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: true,
    }).then(value => value.coords),
  ];
  if (Platform.OS === 'android') {
    candidates.push(
      getNativeCurrentLocation(
        LAST_KNOWN_MAX_AGE_MS,
        LAST_KNOWN_REQUIRED_ACCURACY_METERS,
        NATIVE_LOCATION_TIMEOUT_MS,
      ).then(value => {
        if (!value) throw new Error('android-location-unavailable');
        return { latitude: value.latitude, longitude: value.longitude };
      }),
    );
  }

  try {
    return await withTimeout(firstSuccessful(candidates), CURRENT_LOCATION_TIMEOUT_MS);
  } catch {
    throw new CurrentAddressError('unavailable', '系统定位器暂未返回位置，请稍后重试。');
  }
}

export async function getCurrentAddress(): Promise<CurrentAddressResult> {
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => false);
  if (!servicesEnabled) {
    throw new CurrentAddressError('services-disabled', '系统定位服务未开启，请开启后重试。');
  }

  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== 'granted' && permission.canAskAgain) {
    permission = await Location.requestForegroundPermissionsAsync();
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
  try {
    const results = await withTimeout(
      Location.reverseGeocodeAsync({
        latitude: current.latitude,
        longitude: current.longitude,
      }),
      CURRENT_LOCATION_TIMEOUT_MS,
    );
    const address = formatGeocodedAddress(results[0]);
    if (address) return { address: address.slice(0, 400), usedCoordinateFallback: false };
  } catch {
    // Coordinates remain useful when the platform geocoder has no result.
  }

  return {
    address: `${current.latitude.toFixed(6)}, ${current.longitude.toFixed(6)}`,
    usedCoordinateFallback: true,
  };
}
