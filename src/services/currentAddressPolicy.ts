export const DEFAULT_LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_REQUIRED_ACCURACY_METERS = 500;

export type LocationFixSource = 'cache' | 'live';
export type AddressGranularity =
  | 'street'
  | 'place'
  | 'district'
  | 'city'
  | 'region'
  | 'country'
  | 'coordinates'
  | 'unknown';
export type AddressConfidence = 'high' | 'medium' | 'low';

export type LocationFix = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  ageMs: number;
  timestampMs: number;
  provider: string;
  source: LocationFixSource;
};

export type LocationProviderAttempt = {
  provider: string;
  result: Promise<LocationFix | null>;
  cancel?: () => void;
};

export type LocationRaceOptions = {
  timeoutMs: number;
  degradedGraceMs?: number;
  maxCacheAgeMs?: number;
  requiredAccuracyMeters?: number;
};

export type GeocodedAddressParts = {
  formattedAddress?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  name?: string | null;
};

export type ReverseGeocoderAdapter = {
  provider: string;
  reverse(fix: LocationFix): Promise<readonly GeocodedAddressParts[]>;
};

export type GeocodedAddressResolution = {
  address: string;
  provider: string;
  granularity: AddressGranularity;
  confidence: AddressConfidence;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

export function isUsableLocationFix(fix: LocationFix): boolean {
  return finiteNumber(fix.latitude)
    && fix.latitude >= -90
    && fix.latitude <= 90
    && finiteNumber(fix.longitude)
    && fix.longitude >= -180
    && fix.longitude <= 180
    && (fix.accuracyMeters === null
      || (finiteNumber(fix.accuracyMeters) && fix.accuracyMeters >= 0))
    && finiteNumber(fix.ageMs)
    && fix.ageMs >= 0
    && finiteNumber(fix.timestampMs)
    && fix.timestampMs >= 0
    && Boolean(fix.provider.trim());
}

export function isEligibleCachedFix(
  fix: LocationFix,
  maxAgeMs = DEFAULT_LAST_KNOWN_MAX_AGE_MS,
  requiredAccuracyMeters = DEFAULT_REQUIRED_ACCURACY_METERS,
): boolean {
  return isUsableLocationFix(fix)
    && fix.source === 'cache'
    && fix.ageMs <= maxAgeMs
    && fix.accuracyMeters !== null
    && fix.accuracyMeters <= requiredAccuracyMeters;
}

function isEligibleRaceFix(
  fix: LocationFix,
  maxCacheAgeMs: number,
  requiredAccuracyMeters: number,
): boolean {
  if (!isUsableLocationFix(fix)) return false;
  if (fix.source === 'cache') {
    return isEligibleCachedFix(fix, maxCacheAgeMs, requiredAccuracyMeters);
  }
  return true;
}

function isPreferredFix(fix: LocationFix, requiredAccuracyMeters: number): boolean {
  return fix.accuracyMeters !== null && fix.accuracyMeters <= requiredAccuracyMeters;
}

function preferFallback(left: LocationFix | null, right: LocationFix): LocationFix {
  if (!left) return right;
  const leftAccuracy = left.accuracyMeters ?? Number.POSITIVE_INFINITY;
  const rightAccuracy = right.accuracyMeters ?? Number.POSITIVE_INFINITY;
  if (rightAccuracy !== leftAccuracy) return rightAccuracy < leftAccuracy ? right : left;
  if (right.ageMs !== left.ageMs) return right.ageMs < left.ageMs ? right : left;
  return right.provider.localeCompare(left.provider) < 0 ? right : left;
}

export function raceLocationProviders(
  attempts: readonly LocationProviderAttempt[],
  options: LocationRaceOptions,
): Promise<LocationFix> {
  const timeoutMs = Math.max(1, options.timeoutMs);
  const degradedGraceMs = Math.max(0, options.degradedGraceMs ?? 1_200);
  const maxCacheAgeMs = options.maxCacheAgeMs ?? DEFAULT_LAST_KNOWN_MAX_AGE_MS;
  const requiredAccuracyMeters = options.requiredAccuracyMeters
    ?? DEFAULT_REQUIRED_ACCURACY_METERS;

  if (attempts.length === 0) {
    return Promise.reject(new Error('no-location-provider'));
  }

  return new Promise<LocationFix>((resolve, reject) => {
    let finished = false;
    let remaining = attempts.length;
    let fallback: LocationFix | null = null;
    let lastError: unknown = new Error('location-provider-unavailable');
    let degradedTimer: ReturnType<typeof setTimeout> | undefined;

    const cancelOutstanding = () => {
      attempts.forEach(attempt => {
        try {
          attempt.cancel?.();
        } catch {
          // Cancellation is best-effort; the generation fence below remains authoritative.
        }
      });
    };
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (degradedTimer) clearTimeout(degradedTimer);
    };
    const finishWithFix = (fix: LocationFix) => {
      if (finished) return;
      finished = true;
      clearTimers();
      cancelOutstanding();
      resolve(fix);
    };
    const finishWithoutFix = () => {
      if (finished) return;
      if (fallback) {
        finishWithFix(fallback);
        return;
      }
      finished = true;
      clearTimers();
      cancelOutstanding();
      reject(lastError);
    };
    const scheduleDegradedFallback = () => {
      if (degradedTimer || degradedGraceMs === 0) {
        if (degradedGraceMs === 0 && fallback) finishWithFix(fallback);
        return;
      }
      degradedTimer = setTimeout(() => {
        if (fallback) finishWithFix(fallback);
      }, degradedGraceMs);
    };
    const completeAttempt = () => {
      remaining -= 1;
      if (remaining === 0) finishWithoutFix();
    };

    const timeoutTimer = setTimeout(finishWithoutFix, timeoutMs);
    attempts.forEach(attempt => {
      attempt.result.then(fix => {
        if (finished) return;
        if (fix && isEligibleRaceFix(fix, maxCacheAgeMs, requiredAccuracyMeters)) {
          if (isPreferredFix(fix, requiredAccuracyMeters)) {
            finishWithFix(fix);
            return;
          }
          fallback = preferFallback(fallback, fix);
          scheduleDegradedFallback();
        }
        completeAttempt();
      }).catch(reason => {
        if (finished) return;
        lastError = reason;
        completeAttempt();
      });
    });
  });
}

export function formatGeocodedAddressParts(value: GeocodedAddressParts | undefined): string {
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

export function addressGranularity(value: GeocodedAddressParts): AddressGranularity {
  if (cleanPart(value.street)) return 'street';
  if (cleanPart(value.name)) return 'place';
  if (cleanPart(value.district) || cleanPart(value.subregion)) return 'district';
  if (cleanPart(value.city)) return 'city';
  if (cleanPart(value.region)) return 'region';
  if (cleanPart(value.country)) return 'country';
  return 'unknown';
}

export function addressConfidence(
  granularity: AddressGranularity,
  accuracyMeters: number | null,
): AddressConfidence {
  const accuracy = accuracyMeters ?? Number.POSITIVE_INFINITY;
  if ((granularity === 'street' || granularity === 'place') && accuracy <= 100) {
    return 'high';
  }
  if (
    ((granularity === 'street' || granularity === 'place') && accuracy <= 500)
    || (granularity === 'district' && accuracy <= 1_000)
  ) {
    return 'medium';
  }
  return 'low';
}

export function coordinateConfidence(accuracyMeters: number | null): AddressConfidence {
  if (accuracyMeters !== null && accuracyMeters <= 100) return 'high';
  if (accuracyMeters !== null && accuracyMeters <= 500) return 'medium';
  return 'low';
}

export async function resolveGeocodedAddress(
  adapter: ReverseGeocoderAdapter,
  fix: LocationFix,
): Promise<GeocodedAddressResolution | null> {
  const values = await adapter.reverse(fix);
  const first = values[0];
  const address = formatGeocodedAddressParts(first);
  if (!first || !address) return null;
  const granularity = addressGranularity(first);
  return {
    address,
    provider: adapter.provider,
    granularity,
    confidence: addressConfidence(granularity, fix.accuracyMeters),
  };
}

export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    let shared: Promise<T>;
    shared = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (inFlight === shared) inFlight = null;
      });
    inFlight = shared;
    return shared;
  };
}
