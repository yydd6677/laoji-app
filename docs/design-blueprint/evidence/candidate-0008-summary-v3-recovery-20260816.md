# Candidate 0008: v3 404 recovery identity

## Evidence boundary

- candidate path: `$CANDIDATE_ROOT/summary-v3-recovery-0008`
- implementation: isolated Node standard-library contract only
- production client, server, device, model and database: untouched

## Result

`node --test test_identity.mjs` passes 9/9 tests. It accepts a latest result only
when task ID, source fingerprint, transcript revision, model/prompt revision,
manual-note revision and attachment digest all match. It rejects a meeting-only
latest response, which is the unsafe shape currently returned by the v3 GET
fallback.

This is not an implementation of the mobile recovery path. Before adoption the
identity must be sourced from the durable task request, and the server GET/API
must expose enough metadata to perform the comparison without trusting client
body text.

