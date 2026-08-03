# Candidate deployment

This directory describes an isolated Linux deployment candidate. It is not a
production install script and does not alter any running LaoJi service.

1. Create a dedicated Python environment and install
   `tools/reverse-geocoder-proxy/requirements.txt`.
2. Copy `reverse-geocoder.env.example` to a protected configuration path and
   replace the example upstream with an approved provider. Keep the provider
   credentials out of the repository.
3. Install `reverse-geocoder.service.example` only on a host that has an
   explicit service owner, a local API gateway, and an approved provider.
4. Verify `GET /health` and `GET /ready` locally. `/ready` must be `200` only
   when both the upstream URL and identifying User-Agent are configured.
5. Route the mobile build's
   `EXPO_PUBLIC_REVERSE_GEOCODER_URL` to the authenticated gateway path, not
   directly to port 8079. The proxy is intentionally bound to loopback.

The mobile contract remains `POST /reverse`. Provider errors return a stable
Chinese `502`, while the client keeps the validated coordinate fallback. Public
Nominatim is suitable only for a one-off candidate probe because it has no LaoJi
availability or privacy SLA.
