#!/usr/bin/env bash
set -euo pipefail

# UI-ANDROID-DEVICE-ACCEPTANCE-001 / DEVICE-APK-IDENTITY-001: preserve the
# installed app data while binding the physical phone to one frozen APK hash.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTE_LIBRARY="$ROOT_DIR/scripts/android-emulator-route-smoke.sh"
DEVICE="${DEVICE:-}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
ATTESTATION="${ATTESTATION:-$APK.attestation.json}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-device-install-$(date '+%Y%m%d-%H%M%S')-$$}"
INSTALL_APK=1
RESET_APP_DATA=0
ALLOW_ADDITIONAL_DEVICES=1
ALLOW_PHYSICAL_DEVICE=1
RUN_COMPOSITION_SMOKE=0

[ -n "$DEVICE" ] || {
  printf 'DEVICE must be the explicit physical-device serial\n' >&2
  exit 1
}
[[ "$DEVICE" != emulator-* ]] || {
  printf 'android-device-install-verify.sh refuses emulator targets\n' >&2
  exit 1
}

mkdir -p "$OUT_DIR/checkpoints"

export ROUTE_SMOKE_LIBRARY_ONLY=1
# shellcheck source=android-emulator-route-smoke.sh
source "$ROUTE_LIBRARY"

package_snapshot() {
  local destination="$1"
  {
    adb_cmd shell dumpsys package "$PACKAGE_NAME"
    adb_cmd shell cmd package list packages -U "$PACKAGE_NAME"
    adb_cmd shell appops get "$PACKAGE_NAME" POST_NOTIFICATION 2>/dev/null || true
  } >"$destination"
}

snapshot_value() {
  local snapshot="$1"
  local key="$2"
  case "$key" in
    firstInstallTime)
      sed -n 's/^[[:space:]]*firstInstallTime=//p' "$snapshot" | head -n 1
      ;;
    uid)
      sed -n "s/^package:$PACKAGE_NAME uid://p" "$snapshot" | head -n 1
      ;;
    *)
      fail "unsupported package snapshot key: $key"
      ;;
  esac
}

assert_only_target_physical_device() {
  local serial kernel_qemu
  while read -r serial state _; do
    [ "$state" = "device" ] || continue
    [ "$serial" != "$DEVICE" ] || continue
    kernel_qemu="$($ADB -s "$serial" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')"
    [ "$kernel_qemu" = "1" ] || fail "another physical adb device is connected: $serial"
  done < <("$ADB" devices -l | tail -n +2)
}

assert_packaged_ui_visible() {
  local ui="$OUT_DIR/post-install-ui.xml"
  local attempt
  for attempt in $(seq 1 12); do
    if adb_cmd shell uiautomator dump "$REMOTE_XML" >/dev/null 2>&1 \
      && adb_cmd exec-out cat "$REMOTE_XML" >"$ui" \
      && rg -q 'package="com\.laoji\.app"' "$ui"; then
      return 0
    fi
    sleep 0.5
  done
  fail "MainActivity did not expose a packaged UI tree after overwrite install"
}

assert_parity_attestation() {
  local embedded="$OUT_DIR/checkpoints/parity-attestation.json"
  require_file "$ATTESTATION"
  command -v unzip >/dev/null 2>&1 || fail "unzip is required to verify the embedded parity attestation"
  unzip -p "$APK" assets/parity-attestation.json >"$embedded" \
    || fail "APK has no embedded parity-attestation.json"
  python3 - "$embedded" "$ATTESTATION" "$APK" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

embedded_path, sidecar_path, artifact_path = map(Path, sys.argv[1:])
embedded = json.loads(embedded_path.read_text(encoding="utf-8"))
sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
for key in (
    "git_commit",
    "baseline_id",
    "source_lock_sha256",
    "manifest_sha256",
    "deviations_sha256",
    "product_scope_sha256",
    "tombstones_sha256",
    "audit_reports",
    "closed_evidence",
    "artifact_hash_location",
):
    if sidecar.get(key) != embedded.get(key):
        raise SystemExit(f"parity attestation mismatch: {key}")
digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
if sidecar.get("artifact_sha256") != digest:
    raise SystemExit("parity attestation artifact hash mismatch")
if sidecar.get("artifact_size_bytes") != artifact_path.stat().st_size:
    raise SystemExit("parity attestation artifact size mismatch")
PY
}

main() {
  require_file "$APK"
  require_file "$ROUTE_LIBRARY"
  assert_parity_attestation
  assert_apk_fresh "$APK" "$ROOT_DIR" || fail "rebuild the release APK before physical installation"
  ensure_target_device
  assert_only_target_physical_device

  local installed_before first_install_before uid_before first_install_after uid_after
  installed_before="$(device_apk_hash "$OUT_DIR/device-base-before.sha256" || true)"
  [ -n "$installed_before" ] || fail "$PACKAGE_NAME is not installed; this data-preserving gate refuses first install"

  package_snapshot "$OUT_DIR/package-before.txt"
  first_install_before="$(snapshot_value "$OUT_DIR/package-before.txt" firstInstallTime)"
  uid_before="$(snapshot_value "$OUT_DIR/package-before.txt" uid)"
  [ -n "$first_install_before" ] || fail "could not read firstInstallTime before install"
  [ -n "$uid_before" ] || fail "could not read package UID before install"

  {
    printf 'serial=%s\n' "$DEVICE"
    printf 'manufacturer=%s\n' "$(adb_cmd shell getprop ro.product.manufacturer | tr -d '\r')"
    printf 'model=%s\n' "$(adb_cmd shell getprop ro.product.model | tr -d '\r')"
    printf 'device=%s\n' "$(adb_cmd shell getprop ro.product.device | tr -d '\r')"
    printf 'android=%s\n' "$(adb_cmd shell getprop ro.build.version.release | tr -d '\r')"
    printf 'sdk=%s\n' "$(adb_cmd shell getprop ro.build.version.sdk | tr -d '\r')"
    printf 'fingerprint=%s\n' "$(adb_cmd shell getprop ro.build.fingerprint | tr -d '\r')"
  } >"$OUT_DIR/device.txt"

  record_and_verify_apk
  package_snapshot "$OUT_DIR/package-after.txt"
  first_install_after="$(snapshot_value "$OUT_DIR/package-after.txt" firstInstallTime)"
  uid_after="$(snapshot_value "$OUT_DIR/package-after.txt" uid)"
  [ "$first_install_after" = "$first_install_before" ] || fail "firstInstallTime changed; app data was not preserved"
  [ "$uid_after" = "$uid_before" ] || fail "package UID changed; installation was not an in-place update"

  adb_cmd logcat -c
  adb_cmd shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  dismiss_stale_input_method
  start_main_activity device-overwrite-cold-start
  sleep 2
  assert_main_activity
  assert_packaged_ui_visible
  scan_current_logcat device-overwrite-cold-start
  verify_final_artifact_identity

  {
    printf 'first_install_time=%s\n' "$first_install_after"
    printf 'package_uid=%s\n' "$uid_after"
    printf 'target_sha256=%s\n' "$(sha256sum "$APK" | awk '{print $1}')"
    printf 'result=passed\n'
  } >"$OUT_DIR/result.txt"
  adb_cmd shell rm -f "$REMOTE_XML" >/dev/null 2>&1 || true
  log "physical overwrite install and APK identity passed; artifacts: $OUT_DIR"
}

trap 'adb_cmd shell rm -f "$REMOTE_XML" >/dev/null 2>&1 || true' EXIT
main "$@"
