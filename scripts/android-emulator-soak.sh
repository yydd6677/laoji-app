#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ADB="${SDK_DIR}/platform-tools/adb"
DEVICE="${DEVICE:-emulator-5554}"
DURATION_SECONDS="${DURATION_SECONDS:-10800}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-120}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-emulator-soak}"
SMOKE_SCRIPT="$ROOT_DIR/scripts/android-emulator-smoke.sh"
START_TS="$(date +%s)"
END_TS="$((START_TS + DURATION_SECONDS))"

mkdir -p "$OUT_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$OUT_DIR/soak.log"
}

adb_cmd() {
  "$ADB" -s "$DEVICE" "$@"
}

scan_crashes() {
  local run_dir="$1"
  local log_file="$run_dir/logcat.txt"
  adb_cmd logcat -d >"$log_file" || true
  if rg -i "FATAL EXCEPTION|ANR in com\\.laoji\\.app|E AndroidRuntime:|E ReactNativeJS:|E unknown:ReactNative|JavascriptException" "$log_file" >"$run_dir/crash-scan.txt"; then
    log "crash scan failed; see $run_dir/crash-scan.txt"
    cat "$run_dir/crash-scan.txt"
    exit 1
  fi
  log "crash scan ok"
}

iteration=0
log "soak start; duration=${DURATION_SECONDS}s interval=${INTERVAL_SECONDS}s out=$OUT_DIR"

while [ "$(date +%s)" -lt "$END_TS" ]; do
  iteration="$((iteration + 1))"
  run_dir="$OUT_DIR/run-$(printf '%03d' "$iteration")"
  mkdir -p "$run_dir"
  log "iteration $iteration start"
  adb_cmd logcat -c || true

  if [ "$iteration" -eq 1 ]; then
    reset_app_data=1
    expect_persisted_session=0
  else
    reset_app_data=0
    expect_persisted_session=1
  fi
  OUT_DIR="$run_dir" \
    RESET_APP_DATA="$reset_app_data" \
    EXPECT_PERSISTED_SESSION="$expect_persisted_session" \
    "$SMOKE_SCRIPT" >"$run_dir/smoke.log" 2>&1
  tail -8 "$run_dir/smoke.log" | tee -a "$OUT_DIR/soak.log"
  scan_crashes "$run_dir"

  if [ "$((iteration % 6))" -eq 0 ]; then
    log "periodic TypeScript check"
    (cd "$ROOT_DIR" && npx tsc --noEmit) >"$run_dir/tsc.log" 2>&1
    log "periodic TypeScript ok"
  fi

  if [ "$((iteration % 12))" -eq 0 ]; then
    log "periodic Jest check"
    (cd "$ROOT_DIR" && npm test -- --maxWorkers=75%) >"$run_dir/jest.log" 2>&1
    log "periodic Jest ok"
  fi

  now="$(date +%s)"
  if [ "$now" -lt "$END_TS" ]; then
    sleep_for="$INTERVAL_SECONDS"
    remaining="$((END_TS - now))"
    if [ "$sleep_for" -gt "$remaining" ]; then
      sleep_for="$remaining"
    fi
    log "iteration $iteration done; sleeping ${sleep_for}s"
    sleep "$sleep_for"
  fi
done

log "soak complete; elapsed=$(( $(date +%s) - START_TS ))s iterations=$iteration"
