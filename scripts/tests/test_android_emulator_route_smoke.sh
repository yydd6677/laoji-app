#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/android-emulator-route-smoke.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

export ROUTE_SMOKE_LIBRARY_ONLY=1
export OUT_DIR="$TEMP_DIR/out"
# shellcheck source=../android-emulator-route-smoke.sh
source "$SCRIPT"

mkdir -p "$OUT_DIR"
cat >"$TEMP_DIR/window.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node text="" content-desc="游客体验" clickable="true" enabled="true" checked="false" bounds="[10,20][110,80]">
    <node text="游客体验" content-desc="" clickable="false" focusable="false" enabled="true" checked="false" bounds="[30,30][90,70]" />
  </node>
  <node text="同意用户协议和隐私政策" content-desc="" clickable="true" enabled="true" checked="true" bounds="[20,90][220,140]" />
  <node text="会议记录详情" content-desc="" clickable="false" enabled="true" checked="false" bounds="[0,150][300,200]" />
</hierarchy>
XML

[ "$(xml_node_count "$TEMP_DIR/window.xml" exact "游客体验")" = "1" ]
[ "$(xml_node_count "$TEMP_DIR/window.xml" exact "会议记录")" = "0" ]
[ "$(xml_node_count "$TEMP_DIR/window.xml" contains "会议记录")" = "1" ]
[ "$(xml_node_center "$TEMP_DIR/window.xml" exact "游客体验")" = "60 50" ]
[ "$(xml_node_attr "$TEMP_DIR/window.xml" exact "同意用户协议和隐私政策" checked)" = "true" ]
rg -q '^input_text_unique_node\(\)' "$SCRIPT"
rg -Fq 'for ((index = 0; index < ${#value}; index += 1)); do' "$SCRIPT"
rg -q '^force_microphone_permission_denied\(\)' "$SCRIPT"
rg -q '^clear_microphone_permission_test_flags\(\)' "$SCRIPT"
rg -q '^dismiss_stale_input_method\(\)' "$SCRIPT"
rg -q '^  dismiss_stale_input_method$' "$SCRIPT"
rg -q '^ensure_target_device\(\)' "$SCRIPT"
rg -Fq 'physical target requires ALLOW_PHYSICAL_DEVICE=1' "$SCRIPT"
rg -q '^  validate_boolean ALLOW_PHYSICAL_DEVICE "\$ALLOW_PHYSICAL_DEVICE"$' "$SCRIPT"

for resumed_field in mResumedActivity topResumedActivity ResumedActivity; do
  separator="="
  [ "$resumed_field" = "ResumedActivity" ] && separator=":"
  printf '%s%s ActivityRecord{abc u0 com.laoji.app/.MainActivity t1}\n' \
    "$resumed_field" "$separator" >"$TEMP_DIR/resumed-$resumed_field.txt"
  activity_state_has_resumed_main "$TEMP_DIR/resumed-$resumed_field.txt"
done
printf 'topResumedActivity=ActivityRecord{abc u0 com.android.launcher/.Launcher t1}\n' \
  >"$TEMP_DIR/not-resumed.txt"
if activity_state_has_resumed_main "$TEMP_DIR/not-resumed.txt"; then
  printf 'non-LaoJi activity was accepted as resumed MainActivity\n' >&2
  exit 1
fi

cat >"$TEMP_DIR/duplicate.xml" <<'XML'
<hierarchy>
  <node text="返回" bounds="[0,0][10,10]" />
  <node content-desc="返回" bounds="[10,0][20,10]" />
</hierarchy>
XML
if xml_node_center "$TEMP_DIR/duplicate.xml" exact "返回" >/dev/null 2>&1; then
  printf 'duplicate semantic nodes were not rejected\n' >&2
  exit 1
fi

mkdir -p "$TEMP_DIR/project/src"
printf 'old apk\n' >"$TEMP_DIR/project/app.apk"
sleep 1
printf 'new source\n' >"$TEMP_DIR/project/App.tsx"
find_newer_production_sources "$TEMP_DIR/project/app.apk" "$TEMP_DIR/project" >"$TEMP_DIR/newer.txt"
rg -q '/App\.tsx$' "$TEMP_DIR/newer.txt"
if assert_apk_fresh "$TEMP_DIR/project/app.apk" "$TEMP_DIR/project" "$TEMP_DIR/stale.txt"; then
  printf 'stale APK was not rejected\n' >&2
  exit 1
fi
touch "$TEMP_DIR/project/app.apk"
assert_apk_fresh "$TEMP_DIR/project/app.apk" "$TEMP_DIR/project" "$TEMP_DIR/fresh.txt"
sleep 1
mkdir -p "$TEMP_DIR/project/android/app"
printf 'implementation changed\n' >"$TEMP_DIR/project/android/app/build.gradle"
if assert_apk_fresh "$TEMP_DIR/project/app.apk" "$TEMP_DIR/project" "$TEMP_DIR/build-input-stale.txt"; then
  printf 'APK with a newer Gradle build input was not rejected\n' >&2
  exit 1
fi
rg -q '/android/app/build\.gradle$' "$TEMP_DIR/build-input-stale.txt"

printf 'packaged-apk-bytes\n' >"$TEMP_DIR/fake-base.apk"
cat >"$TEMP_DIR/fake-adb" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
shift 2
if [ "$1 $2 $3 ${4:-}" = "shell pm path com.laoji.app" ]; then
  printf 'package:/data/app/com.laoji.app/base.apk\n'
elif [ "$1 $2 $3" = "exec-out cat /data/app/com.laoji.app/base.apk" ]; then
  cat "$FAKE_BASE_APK"
elif [ "$1 $2" = "shell pm" ]; then
  printf '%s\n' "$*" >>"$FAKE_ADB_LOG"
else
  printf 'unexpected fake adb invocation: %s\n' "$*" >&2
  exit 2
fi
SH
chmod +x "$TEMP_DIR/fake-adb"
export FAKE_BASE_APK="$TEMP_DIR/fake-base.apk"
export FAKE_ADB_LOG="$TEMP_DIR/fake-adb.log"
: >"$FAKE_ADB_LOG"
ADB="$TEMP_DIR/fake-adb"
DEVICE="emulator-test"
expected_hash="$(sha256sum "$TEMP_DIR/fake-base.apk" | awk '{print $1}')"
[ "$(device_apk_hash "$TEMP_DIR/device.sha256")" = "$expected_hash" ]
rg -q "^$expected_hash  /data/app/com\.laoji\.app/base\.apk$" "$TEMP_DIR/device.sha256"
force_microphone_permission_denied
clear_microphone_permission_test_flags
rg -q '^shell pm revoke com\.laoji\.app android\.permission\.RECORD_AUDIO$' "$FAKE_ADB_LOG"
rg -q '^shell pm set-permission-flags com\.laoji\.app android\.permission\.RECORD_AUDIO user-set user-fixed$' "$FAKE_ADB_LOG"
[ "$(rg -c '^shell pm clear-permission-flags com\.laoji\.app android\.permission\.RECORD_AUDIO user-set user-fixed$' "$FAKE_ADB_LOG")" = "2" ]

for signature in \
  '07-17 AndroidRuntime: FATAL EXCEPTION: main' \
  '07-17 libc: Fatal signal 11 (SIGSEGV)' \
  '07-17 ReactNativeJS: TypeError: route failed'; do
  printf '%s\n' "$signature" >"$TEMP_DIR/bad.log"
  if scan_logcat_file "$TEMP_DIR/bad.log" "$TEMP_DIR/bad.scan"; then
    printf 'crash signature was not detected: %s\n' "$signature" >&2
    exit 1
  fi
  [ -s "$TEMP_DIR/bad.scan" ]
done
printf '07-17 ReactNativeJS: running application\n' >"$TEMP_DIR/good.log"
scan_logcat_file "$TEMP_DIR/good.log" "$TEMP_DIR/good.scan"
[ ! -s "$TEMP_DIR/good.scan" ]

rg -q '^PACKAGE_NAME="com\.laoji\.app"$' "$SCRIPT"
rg -q '^MAIN_ACTIVITY="\$PACKAGE_NAME/\.MainActivity"$' "$SCRIPT"
rg -q 'shell am start -W -n "\$MAIN_ACTIVITY"' "$SCRIPT"
rg -q 'assert_restored_schedule_checkpoint home-restore' "$SCRIPT"
rg -q 'assert_restored_schedule_checkpoint force-stop-cold-start' "$SCRIPT"
rg -q 'checkpoint create-action-sheet' "$SCRIPT"
rg -q 'tap_unique_node "\$LAST_XML" exact "手动新建"' "$SCRIPT"
rg -q 'checkpoint add-event' "$SCRIPT"
rg -q 'assert_unique_node "\$LAST_XML" exact "添加主题"' "$SCRIPT"
rg -q 'checkpoint schedule-after-add-event' "$SCRIPT"
rg -q 'checkpoint add-event-for-detail' "$SCRIPT"
rg -q 'input_text_unique_node "\$LAST_XML" exact "添加主题" "RouteSmokeEvent"' "$SCRIPT"
rg -q 'checkpoint event-detail' "$SCRIPT"
rg -q 'assert_unique_node "\$LAST_XML" exact "编辑日程"' "$SCRIPT"
rg -q 'checkpoint speaker-manager' "$SCRIPT"
rg -q 'checkpoint meeting-live-permission-guard' "$SCRIPT"
rg -q 'checkpoint meeting-live-idle' "$SCRIPT"
rg -q 'pm set-permission-flags "\$PACKAGE_NAME" android.permission.RECORD_AUDIO user-set user-fixed' "$SCRIPT"
rg -q 'checkpoint profile-field' "$SCRIPT"
rg -q 'checkpoint account' "$SCRIPT"
rg -q 'checkpoint notification-settings' "$SCRIPT"
rg -q 'checkpoint privacy-after-account' "$SCRIPT"
if rg -q '欢迎使用老记' "$SCRIPT"; then
  printf 'stale login copy remains in route smoke\n' >&2
  exit 1
fi
if rg -q 'shell input tap [0-9]+ [0-9]+' "$SCRIPT"; then
  printf 'fixed UI coordinates remain in route smoke\n' >&2
  exit 1
fi

printf 'android emulator route smoke helpers: ok\n'
