#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. UI-ROUTES-001 owns the current packaged route gate.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/android-emulator-route-smoke.sh" "$@"
