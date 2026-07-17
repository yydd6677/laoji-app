#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/android-device-install-verify.sh"

bash -n "$SCRIPT"
rg -q 'DEVICE must be the explicit physical-device serial' "$SCRIPT"
rg -q 'refuses emulator targets' "$SCRIPT"
rg -q 'this data-preserving gate refuses first install' "$SCRIPT"
rg -q 'firstInstallTime changed; app data was not preserved' "$SCRIPT"
rg -q 'package UID changed; installation was not an in-place update' "$SCRIPT"
rg -q 'record_and_verify_apk' "$SCRIPT"
rg -q 'verify_final_artifact_identity' "$SCRIPT"
rg -q 'assert_parity_attestation' "$SCRIPT"
rg -q 'parity-attestation.json' "$SCRIPT"

if rg -q 'shell pm clear|uninstall' "$SCRIPT"; then
  printf 'physical overwrite-install gate contains a destructive package operation\n' >&2
  exit 1
fi

if DEVICE=emulator-5554 bash "$SCRIPT" >/dev/null 2>&1; then
  printf 'physical overwrite-install gate accepted an emulator target\n' >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
FAKE_APK="$TEMP_DIR/app-release.apk"
FAKE_ATTESTATION="$FAKE_APK.attestation.json"
FAKE_ADB="$TEMP_DIR/adb"
OUT_DIR="$TEMP_DIR/evidence"
mkdir -p "$TEMP_DIR/apk/assets"
cat >"$TEMP_DIR/apk/assets/parity-attestation.json" <<'JSON'
{
  "schema_version": 1,
  "git_commit": "fixture",
  "baseline_id": "feishu-android-7.71.8",
  "source_lock_sha256": "source",
  "manifest_sha256": "manifest",
  "deviations_sha256": "deviations",
  "artifact_sha256": null,
  "artifact_hash_location": "sidecar"
}
JSON
(cd "$TEMP_DIR/apk" && zip -q "$FAKE_APK" assets/parity-attestation.json)
python3 - "$TEMP_DIR/apk/assets/parity-attestation.json" "$FAKE_APK" "$FAKE_ATTESTATION" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

embedded, artifact, sidecar = map(Path, sys.argv[1:])
value = json.loads(embedded.read_text(encoding="utf-8"))
value["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
value["artifact_size_bytes"] = artifact.stat().st_size
sidecar.write_text(json.dumps(value), encoding="utf-8")
PY

cat >"$FAKE_ADB" <<'MOCK_ADB'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "devices" ]; then
  printf 'List of devices attached\n'
  printf 'phone-serial\tdevice product:test model:Physical device:test transport_id:1\n'
  exit 0
fi

[ "$1" = "-s" ] || exit 80
[ "$2" = "phone-serial" ] || exit 81
shift 2

case "$*" in
  "shell getprop ro.kernel.qemu") printf '0\n' ;;
  "shell pm path com.laoji.app") printf 'package:/data/app/com.laoji.app/base.apk\n' ;;
  "exec-out cat /data/app/com.laoji.app/base.apk") cat "$FAKE_APK" ;;
  "shell dumpsys package com.laoji.app")
    printf '  firstInstallTime=2026-07-10 10:00:00\n'
    printf '  lastUpdateTime=2026-07-17 14:00:00\n'
    ;;
  "shell cmd package list packages -U com.laoji.app") printf 'package:com.laoji.app uid:10123\n' ;;
  "shell appops get com.laoji.app POST_NOTIFICATION") printf 'POST_NOTIFICATION: allow\n' ;;
  "shell getprop ro.product.manufacturer") printf 'Xiaomi\n' ;;
  "shell getprop ro.product.model") printf '23013RK75C\n' ;;
  "shell getprop ro.product.device") printf 'mondrian\n' ;;
  "shell getprop ro.build.version.release") printf '15\n' ;;
  "shell getprop ro.build.version.sdk") printf '35\n' ;;
  "shell getprop ro.build.fingerprint") printf 'mock/fingerprint\n' ;;
  "install --no-streaming -r "*) printf 'Success\n' ;;
  "logcat -c") ;;
  "shell am force-stop com.laoji.app") ;;
  "shell input keyevent KEYCODE_BACK") ;;
  "shell am start -W -n com.laoji.app/.MainActivity") printf 'Status: ok\n' ;;
  "shell dumpsys activity activities") printf 'mResumedActivity: com.laoji.app/.MainActivity\n' ;;
  "shell uiautomator dump "*) printf 'UI hierarchy dumped\n' ;;
  "exec-out cat /sdcard/laoji-route-"*)
    printf '%s\n' '<?xml version="1.0"?><hierarchy><node package="com.laoji.app" /></hierarchy>'
    ;;
  "logcat -d -v threadtime") ;;
  "shell rm -f "*) ;;
  *)
    printf 'unhandled mock adb command: %s\n' "$*" >&2
    exit 82
    ;;
esac
MOCK_ADB
chmod +x "$FAKE_ADB"

ADB="$FAKE_ADB" FAKE_APK="$FAKE_APK" DEVICE=phone-serial APK="$FAKE_APK" \
  ATTESTATION="$FAKE_ATTESTATION" OUT_DIR="$OUT_DIR" \
  bash "$SCRIPT" >/dev/null

rg -q '^result=passed$' "$OUT_DIR/result.txt"
rg -q '^first_install_time=2026-07-10 10:00:00$' "$OUT_DIR/result.txt"
[ "$(awk '{print $1}' "$OUT_DIR/device-base-after.sha256")" = "$(sha256sum "$FAKE_APK" | awk '{print $1}')" ]

printf 'android physical overwrite-install contracts: ok\n'
