import type {
  GeocodedAddressParts,
  LocationFix,
  ReverseGeocoderAdapter,
} from './currentAddressPolicy';

const MAX_RESPONSE_CHARS = 128_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export type ReverseGeocoderHttpResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type ReverseGeocoderFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<ReverseGeocoderHttpResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function addressParts(value: unknown): GeocodedAddressParts | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.address)
    ? value.address
    : isRecord(value.addressComponent)
      ? value.addressComponent
      : isRecord(value.address_component)
        ? value.address_component
        : null;
  const read = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) return value[key];
      if (nested && nested[key] !== undefined && nested[key] !== null) return nested[key];
    }
    return undefined;
  };
  const parts: GeocodedAddressParts = {
    formattedAddress: stringValue(read(
      'formattedAddress',
      'formatted_address',
      'display_name',
      'displayName',
      'label',
    )),
    provider: stringValue(read('provider', 'source_provider', 'sourceProvider')),
    country: stringValue(read('country', 'country_name')),
    region: stringValue(read('region', 'state', 'province', 'state_name')),
    city: stringValue(read('city', 'town', 'city_name')),
    district: stringValue(read(
      'district',
      'county',
      'suburb',
      'suburb_name',
      'neighbourhood',
      'neighborhood',
    )),
    subregion: stringValue(read('subregion', 'village')),
    street: stringValue(read('street', 'road', 'street_name')),
    streetNumber: stringValue(read(
      'streetNumber',
      'street_number',
      'house_number',
      'houseNumber',
    )),
    name: stringValue(read('name', 'building', 'poi')),
  };
  return Object.entries(parts).some(([key, part]) => key !== 'provider' && Boolean(part))
    ? parts
    : null;
}

function payloadParts(payload: unknown): readonly GeocodedAddressParts[] {
  if (Array.isArray(payload)) {
    return payload.map(addressParts).filter((value): value is GeocodedAddressParts => value !== null);
  }
  if (!isRecord(payload)) return [];

  const payloadProvider = stringValue(
    payload.provider ?? payload.source_provider ?? payload.sourceProvider,
  );
  const attachProvider = (parts: GeocodedAddressParts[]): GeocodedAddressParts[] => (
    payloadProvider
      ? parts.map(partsValue => ({
        ...partsValue,
        provider: partsValue.provider ?? payloadProvider,
      }))
      : parts
  );

  const candidates = payload.address_parts
    ?? payload.addressParts
    ?? payload.parts
    ?? payload.results
    ?? payload.result
    ?? payload.regeocode
    ?? payload.address;
  if (Array.isArray(candidates)) {
    const values = candidates
      .map(addressParts)
      .filter((value): value is GeocodedAddressParts => value !== null);
    if (values.length > 0) return attachProvider(values);
  } else {
    const single = addressParts(candidates);
    if (single) return attachProvider([single]);
  }

  const formattedAddress = stringValue(
    payload.address
      ?? payload.formatted_address
      ?? payload.formattedAddress
      ?? payload.display_name
      ?? payload.displayName
      ?? payload.label,
  );
  return formattedAddress
    ? [{ formattedAddress, ...(payloadProvider ? { provider: payloadProvider } : {}) }]
    : [];
}

function endpointUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) throw new Error('invalid reverse geocoder URL');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('invalid reverse geocoder URL');
  }
}

function timeoutValue(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(10, Math.min(15_000, Math.floor(value as number)));
}

const defaultFetch: ReverseGeocoderFetch = (url, init) => (
  fetch(url, init as RequestInit) as unknown as Promise<ReverseGeocoderHttpResponse>
);

export function createHttpReverseGeocoder(
  url: string,
  fetchImpl: ReverseGeocoderFetch = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ReverseGeocoderAdapter {
  const endpoint = endpointUrl(url);
  const requestTimeoutMs = timeoutValue(timeoutMs);
  return {
    provider: 'configured-http',
    async reverse(fix: LocationFix): Promise<readonly GeocodedAddressParts[]> {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Keep the deadline around both the fetch handshake and response body.
        // A server can accept the connection and then never finish `text()`;
        // timing only the first promise would leave the UI waiting forever.
        const request = Promise.resolve()
          .then(() => fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              schema_version: 1,
              latitude: fix.latitude,
              longitude: fix.longitude,
              accuracy_meters: fix.accuracyMeters,
              timestamp_ms: fix.timestampMs,
              source: fix.source,
            }),
            ...(controller ? { signal: controller.signal } : {}),
          }))
          .then(async response => {
            if (!response.ok || response.status < 200 || response.status >= 300) {
              throw new Error('reverse geocoder request failed');
            }
            return response.text();
          });
        const text = await Promise.race([
          request,
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
              controller?.abort();
              reject(new Error('reverse geocoder timeout'));
            }, requestTimeoutMs);
          }),
        ]);
        if (text.length > MAX_RESPONSE_CHARS) throw new Error('reverse geocoder response too large');
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new Error('reverse geocoder response is invalid');
        }
        return payloadParts(payload);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
