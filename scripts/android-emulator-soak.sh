#!/usr/bin/env bash
set -euo pipefail

# The former duration loop repeatedly exercised a stale route script. Keep this
# entrypoint as one bounded route/composition pass; long-running soak is deferred.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/laoji-emulator-bounded-gate-$(date '+%Y%m%d-%H%M%S')-$$}"

mkdir -p "$OUT_DIR"
printf '[%s] bounded emulator gate; long-duration soak is disabled\n' "$(date '+%F %T')" | \
  tee "$OUT_DIR/soak.log"

OUT_DIR="$OUT_DIR/route" \
COMPOSITION_TAB_CYCLES="${COMPOSITION_TAB_CYCLES:-3}" \
"$ROOT_DIR/scripts/android-emulator-route-smoke.sh" "$@" | tee -a "$OUT_DIR/soak.log"
