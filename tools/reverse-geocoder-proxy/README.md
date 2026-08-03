# LaoJi Reverse-Geocoder Proxy

This is an opt-in candidate service for the mobile `EXPO_PUBLIC_REVERSE_GEOCODER_URL` contract. The phone sends a user-triggered `POST /reverse` request to this service; the proxy may call a configured provider and returns the normalized `address_parts` shape expected by LaoJi.

An optional `LAOJI_REVERSE_GEOCODER_OFFLINE_CITY=1` mode uses the local
`reverse_geocoder` GeoNames city index when no approved upstream is available.
It returns only a low-confidence city-level estimate and never claims a street
or building address. An explicitly configured upstream remains preferred.

The service is disabled when `NOMINATIM_URL` or `NOMINATIM_USER_AGENT` is missing. It keeps an in-memory rounded-coordinate cache, serializes upstream calls, limits the request interval, caps the response body, and returns stable Chinese errors. It does not log coordinates or provider response bodies.

For development only, an explicit Nominatim configuration can be used:

```sh
NOMINATIM_URL=https://nominatim.openstreetmap.org/reverse \
NOMINATIM_USER_AGENT='LaoJi-dev/1.0 (+https://example.invalid/laoji)' \
NOMINATIM_MIN_INTERVAL_SECONDS=1.05 \
python3 -m uvicorn server:app --app-dir tools/reverse-geocoder-proxy --host 127.0.0.1 --port 8079
```

The public Nominatim service is not a production SLA. A production deployment must use a self-hosted or explicitly approved provider, retain the ability to switch providers, and keep the provider's attribution and privacy requirements. The mobile app remains coordinate-safe when this service is disabled or unavailable.
