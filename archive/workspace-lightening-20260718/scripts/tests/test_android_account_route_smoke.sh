#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/android-account-route-smoke.sh"
FIXTURE="$ROOT_DIR/scripts/device_route_fixture.js"

bash -n "$SCRIPT"
node --check "$FIXTURE"

for checkpoint in \
  account-transcription \
  account-speaker-enrollment \
  account-change-password \
  account-deletion \
  authenticated-schedule-final; do
  rg -q "checkpoint $checkpoint" "$SCRIPT"
done

rg -q 'assert_unique_node .* exact "文字记录"' "$SCRIPT"
rg -q 'assert_unique_node .* exact "纪要"' "$SCRIPT"

rg -q 'ALLOW_PHYSICAL_DEVICE' "$SCRIPT"
rg -q 'verify_final_artifact_identity' "$SCRIPT"
rg -q 'cleanup_fixture || fail' "$SCRIPT"
rg -q 'stat -c.*600' "$SCRIPT"
rg -q "status: 'completed'" "$FIXTURE"
rg -q 'unexpected status' "$FIXTURE"
if rg -q 'log .*\$(fixture_value (password|accessToken))' "$SCRIPT"; then
  printf 'fixture secret is written to route logs\n' >&2
  exit 1
fi

printf 'android authenticated route smoke contracts: ok\n'
