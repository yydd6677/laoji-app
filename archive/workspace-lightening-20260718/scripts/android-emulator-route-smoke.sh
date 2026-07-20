#!/usr/bin/env bash
set -euo pipefail

# UI-ROUTES-001: packaged MainActivity route gate driven by accessibility semantics.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ADB="${ADB:-$SDK_DIR/platform-tools/adb}"
EMULATOR="${EMULATOR:-$SDK_DIR/emulator/emulator}"
AVD_NAME="${AVD_NAME:-LaoJi_API_35}"
DEVICE="${DEVICE:-emulator-5554}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
PACKAGE_NAME="com.laoji.app"
MAIN_ACTIVITY="$PACKAGE_NAME/.MainActivity"
OUT_DIR="${OUT_DIR:-/tmp/laoji-emulator-route-smoke-$(date '+%Y%m%d-%H%M%S')-$$}"
INSTALL_APK="${INSTALL_APK:-1}"
RESET_APP_DATA="${RESET_APP_DATA:-1}"
ALLOW_ADDITIONAL_DEVICES="${ALLOW_ADDITIONAL_DEVICES:-0}"
ALLOW_PHYSICAL_DEVICE="${ALLOW_PHYSICAL_DEVICE:-0}"
RUN_COMPOSITION_SMOKE="${RUN_COMPOSITION_SMOKE:-1}"
COMPOSITION_TAB_CYCLES="${COMPOSITION_TAB_CYCLES:-2}"
COMPOSITION_SCRIPT="$ROOT_DIR/scripts/android-emulator-composition-smoke.sh"
REMOTE_XML="/sdcard/laoji-route-$$.xml"
CHECKPOINT_INDEX=0
LAST_XML=""

mkdir -p "$OUT_DIR/checkpoints"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$OUT_DIR/route-smoke.log"
}

fail() {
  log "FAILED: $*"
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

require_executable() {
  [ -x "$1" ] || fail "missing executable: $1"
}

adb_cmd() {
  "$ADB" -s "$DEVICE" "$@"
}

validate_boolean() {
  case "$2" in
    0|1) ;;
    *) fail "$1 must be 0 or 1, got: $2" ;;
  esac
}

# Prints production inputs that are newer than an APK. Tests source this file and
# exercise the helper against a synthetic tree, so artifact freshness is not an
# untested shell-only promise.
find_newer_production_sources() {
  local apk="$1"
  local root="${2:-$ROOT_DIR}"
  local path
  local roots=(
    "$root/src"
    "$root/android/app/src/main"
    "$root/android/app/src/release"
    "$root/modules/laoji-native-platform/android/src/main"
    "$root/modules/laoji-native-platform/src"
    "$root/assets"
  )

  for path in \
    "$root/App.tsx" \
    "$root/index.ts" \
    "$root/index.js" \
    "$root/app.config.js" \
    "$root/package.json" \
    "$root/package-lock.json" \
    "$root/android/settings.gradle" \
    "$root/android/build.gradle" \
    "$root/android/gradle.properties" \
    "$root/android/app/build.gradle" \
    "$root/android/app/src/main/AndroidManifest.xml" \
    "$root/plugins/withLaojiNativePlatform.js" \
    "$root/modules/laoji-native-platform/index.ts" \
    "$root/modules/laoji-native-platform/android/build.gradle" \
    "$root/modules/laoji-native-platform/expo-module.config.json"; do
    if [ -f "$path" ] && [ "$path" -nt "$apk" ]; then
      printf '%s\n' "$path"
    fi
  done
  for path in "${roots[@]}"; do
    [ -d "$path" ] || continue
    while IFS= read -r -d '' source; do
      if [ "$source" -nt "$apk" ]; then
        printf '%s\n' "$source"
      fi
    done < <(find "$path" -type f \( \
      -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
      -o -name '*.kt' -o -name '*.java' -o -name '*.xml' \
      -o -name '*.png' -o -name '*.webp' -o -name '*.jpg' \
    \) -print0)
  done
}

assert_apk_fresh() {
  local apk="$1"
  local root="${2:-$ROOT_DIR}"
  local stale_list="${3:-$OUT_DIR/apk-newer-production-sources.txt}"
  : >"$stale_list"
  find_newer_production_sources "$apk" "$root" | LC_ALL=C sort -u >"$stale_list"
  if [ -s "$stale_list" ]; then
    log "release APK is older than Android/TypeScript production source:"
    sed "s#^$root/##" "$stale_list" | tee -a "$OUT_DIR/route-smoke.log"
    return 1
  fi
}

# XML query modes: count, center, or attr. Matching is intentionally exact by
# default because every route checkpoint must expose one unambiguous target.
xml_query() {
  local xml="$1"
  local operation="$2"
  local match_mode="$3"
  local needle="$4"
  local attribute="${5:-}"
  python3 - "$xml" "$operation" "$match_mode" "$needle" "$attribute" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

xml_path, operation, match_mode, needle, attribute = sys.argv[1:]
root = ET.parse(xml_path).getroot()

def matches(node):
    values = (node.attrib.get("text", ""), node.attrib.get("content-desc", ""))
    if match_mode == "exact":
        return needle in values
    if match_mode == "contains":
        return any(needle in value for value in values)
    raise SystemExit(f"unsupported match mode: {match_mode}")

nodes = [node for node in root.iter("node") if matches(node)]

# React Native commonly exposes a labelled control and its non-focusable Text
# child as two UIAutomator nodes. For interaction queries, the actionable node
# is the semantic target; two actionable matches remain an ambiguity and fail.
actionable = [
    node for node in nodes
    if any(node.attrib.get(name, "false") == "true" for name in ("clickable", "focusable", "checkable"))
]
if actionable:
    nodes = actionable
if operation == "count":
    print(len(nodes))
    raise SystemExit(0)
if len(nodes) != 1:
    raise SystemExit(f"expected one node for {needle!r}, found {len(nodes)}")
node = nodes[0]
if operation == "attr":
    print(node.attrib.get(attribute, ""))
    raise SystemExit(0)
if operation == "center":
    values = [int(value) for value in re.findall(r"-?\d+", node.attrib.get("bounds", ""))]
    if len(values) != 4:
        raise SystemExit(f"invalid bounds for {needle!r}: {node.attrib.get('bounds', '')!r}")
    x1, y1, x2, y2 = values
    if x2 <= x1 or y2 <= y1:
        raise SystemExit(f"empty bounds for {needle!r}: {values}")
    if node.attrib.get("enabled", "true") != "true":
        raise SystemExit(f"node is disabled: {needle!r}")
    print((x1 + x2) // 2, (y1 + y2) // 2)
    raise SystemExit(0)
raise SystemExit(f"unsupported operation: {operation}")
PY
}

xml_node_count() {
  xml_query "$1" count "$2" "$3"
}

xml_node_center() {
  xml_query "$1" center "$2" "$3"
}

xml_node_attr() {
  xml_query "$1" attr "$2" "$3" "$4"
}

assert_unique_node() {
  local xml="$1"
  local match_mode="$2"
  local needle="$3"
  local count
  count="$(xml_node_count "$xml" "$match_mode" "$needle")"
  [ "$count" = "1" ] || fail "expected one '$needle' node in $(basename "$xml"), found $count"
  log "unique node: $needle"
}

assert_absent_node() {
  local xml="$1"
  local match_mode="$2"
  local needle="$3"
  local count
  count="$(xml_node_count "$xml" "$match_mode" "$needle")"
  [ "$count" = "0" ] || fail "hidden layer is still reachable via '$needle' in $(basename "$xml")"
  log "hidden node absent: $needle"
}

assert_node_attribute() {
  local xml="$1"
  local match_mode="$2"
  local needle="$3"
  local attribute="$4"
  local expected="$5"
  assert_unique_node "$xml" "$match_mode" "$needle"
  local actual
  actual="$(xml_node_attr "$xml" "$match_mode" "$needle" "$attribute")"
  [ "$actual" = "$expected" ] || fail "$needle attribute $attribute: expected '$expected', got '$actual'"
  log "node attribute: $needle $attribute=$expected"
}

tap_unique_node() {
  local xml="$1"
  local match_mode="$2"
  local needle="$3"
  local xy
  assert_unique_node "$xml" "$match_mode" "$needle"
  xy="$(xml_node_center "$xml" "$match_mode" "$needle")" || fail "cannot resolve bounds for: $needle"
  adb_cmd shell input tap $xy
  log "tap '$needle' at $xy"
}

input_text_unique_node() {
  local xml="$1"
  local match_mode="$2"
  local needle="$3"
  local value="$4"
  tap_unique_node "$xml" "$match_mode" "$needle"
  sleep 0.2
  local index character
  for ((index = 0; index < ${#value}; index += 1)); do
    character="${value:index:1}"
    if [ "$character" = " " ]; then
      character='%s'
    fi
    adb_cmd shell input text "$character"
    sleep 0.04
  done
  log "input text into '$needle'"
}

force_microphone_permission_denied() {
  adb_cmd shell pm clear-permission-flags "$PACKAGE_NAME" android.permission.RECORD_AUDIO user-set user-fixed >/dev/null 2>&1 || true
  adb_cmd shell pm revoke "$PACKAGE_NAME" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
  adb_cmd shell pm set-permission-flags "$PACKAGE_NAME" android.permission.RECORD_AUDIO user-set user-fixed
  log "microphone permission fixed to denied for side-effect-free MeetingLive route coverage"
}

clear_microphone_permission_test_flags() {
  adb_cmd shell pm clear-permission-flags "$PACKAGE_NAME" android.permission.RECORD_AUDIO user-set user-fixed >/dev/null 2>&1 || true
  log "cleared microphone permission test flags"
}

scan_logcat_file() {
  local log_file="$1"
  local output_file="${2:-/dev/stdout}"
  local pattern
  pattern='FATAL EXCEPTION|AndroidRuntime.*FATAL|Fatal signal [0-9]+|SIG(SEGV|ABRT|BUS|ILL)|ReactNativeJS.*(TypeError|ReferenceError|Unhandled|Invariant Violation|ERROR|Error:)|ReactNative.*JavascriptException|Unable to load script'
  if rg -n -i "$pattern" "$log_file" >"$output_file"; then
    return 1
  fi
  : >"$output_file"
}

dump_ui_to() {
  local destination="$1"
  local attempt
  for attempt in $(seq 1 12); do
    if adb_cmd shell uiautomator dump --compressed "$REMOTE_XML" >/dev/null 2>&1 && \
      adb_cmd exec-out cat "$REMOTE_XML" >"$destination" && [ -s "$destination" ]; then
      return 0
    fi
    sleep 0.4
  done
  fail "uiautomator dump failed after $attempt attempts"
}

wait_for_node() {
  local match_mode="$1"
  local needle="$2"
  local timeout_seconds="${3:-12}"
  local deadline=$((SECONDS + timeout_seconds))
  local temp_xml="$OUT_DIR/.wait.xml"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if dump_ui_to "$temp_xml"; then
      local count
      count="$(xml_node_count "$temp_xml" "$match_mode" "$needle")"
      if [ "$count" = "1" ]; then
        return 0
      fi
    fi
    sleep 0.35
  done
  fail "timed out waiting for unique node: $needle"
}

wait_for_any_node() {
  local first="$1"
  local second="$2"
  local timeout_seconds="${3:-12}"
  local deadline=$((SECONDS + timeout_seconds))
  local temp_xml="$OUT_DIR/.wait-any.xml"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if dump_ui_to "$temp_xml"; then
      if [ "$(xml_node_count "$temp_xml" exact "$first")" = "1" ]; then
        printf '%s\n' "$first"
        return 0
      fi
      if [ "$(xml_node_count "$temp_xml" exact "$second")" = "1" ]; then
        printf '%s\n' "$second"
        return 0
      fi
    fi
    sleep 0.35
  done
  return 1
}

checkpoint() {
  local name="$1"
  CHECKPOINT_INDEX=$((CHECKPOINT_INDEX + 1))
  local prefix
  prefix="$(printf '%02d-%s' "$CHECKPOINT_INDEX" "$name")"
  LAST_XML="$OUT_DIR/checkpoints/$prefix.xml"
  dump_ui_to "$LAST_XML"
  sed 's/></>\n</g' "$LAST_XML" >"$OUT_DIR/checkpoints/$prefix.pretty.xml"
  {
    printf 'checkpoint=%s\ncreated_at=%s\n' "$name" "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    adb_cmd shell dumpsys activity top
    adb_cmd shell dumpsys window windows
  } >"$OUT_DIR/checkpoints/$prefix.state.log" 2>&1
  adb_cmd logcat -d -v threadtime >"$OUT_DIR/checkpoints/$prefix.logcat.log" 2>&1 || true
  printf '%02d\t%s\t%s\n' "$CHECKPOINT_INDEX" "$name" "$LAST_XML" >>"$OUT_DIR/checkpoints.tsv"
  log "checkpoint $prefix"
}

activity_state_has_resumed_main() {
  local state_file="$1"
  rg -q "(mResumedActivity|topResumedActivity|ResumedActivity)[=:].*$PACKAGE_NAME/\\.MainActivity" "$state_file"
}

assert_main_activity() {
  local state_file="$OUT_DIR/current-activity.txt"
  adb_cmd shell dumpsys activity activities >"$state_file"
  activity_state_has_resumed_main "$state_file" || \
    fail "MainActivity is not the resumed packaged activity"
}

installed_base_path() {
  adb_cmd shell pm path "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' | \
    sed -n 's/^package://p' | awk '/\/base\.apk$/ {print; exit}'
}

device_apk_hash() {
  local destination="$1"
  local path
  path="$(installed_base_path)"
  if [ -z "$path" ]; then
    printf 'not-installed  %s\n' "$PACKAGE_NAME" >"$destination"
    return 1
  fi
  local hash
  hash="$(adb_cmd exec-out cat "$path" | sha256sum | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "$path" >"$destination"
  printf '%s\n' "$hash"
}

wait_boot() {
  local attempt
  for attempt in $(seq 1 120); do
    if [ "$(adb_cmd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      adb_cmd shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
      adb_cmd shell wm dismiss-keyguard >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  fail "emulator boot timed out"
}

ensure_target_device() {
  require_executable "$ADB"
  if [[ "$DEVICE" != emulator-* ]] && [ "$ALLOW_PHYSICAL_DEVICE" != "1" ]; then
    fail "physical target requires ALLOW_PHYSICAL_DEVICE=1: $DEVICE"
  fi
  local connected
  connected="$($ADB devices | awk 'NR > 1 && $2 == "device" {print $1}')"
  local unexpected
  unexpected="$(printf '%s\n' "$connected" | awk -v expected="$DEVICE" 'NF && $1 != expected {print $1}')"
  if [ -n "$unexpected" ] && [ "$ALLOW_ADDITIONAL_DEVICES" != "1" ]; then
    log "unexpected adb device(s):"
    printf '%s\n' "$unexpected" | tee -a "$OUT_DIR/route-smoke.log"
    fail "disconnect extra devices or set ALLOW_ADDITIONAL_DEVICES=1"
  fi
  if printf '%s\n' "$connected" | rg -qx "$DEVICE"; then
    if [[ "$DEVICE" == emulator-* ]]; then
      wait_boot
    else
      [ "$(adb_cmd shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')" != "1" ] || \
        fail "physical mode resolved to an emulator: $DEVICE"
    fi
    return 0
  fi

  [[ "$DEVICE" == emulator-* ]] || fail "physical target is not connected: $DEVICE"

  require_executable "$EMULATOR"
  local port="${DEVICE#emulator-}"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "cannot derive emulator port from DEVICE=$DEVICE"
  log "starting AVD $AVD_NAME on $DEVICE"
  nohup "$EMULATOR" "@$AVD_NAME" -port "$port" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -accel on -cores 4 -memory 3072 -no-snapshot-save \
    >"$OUT_DIR/emulator.log" 2>&1 &
  wait_boot
}

record_and_verify_apk() {
  local target_before target_after installed_before installed_after
  target_before="$(sha256sum "$APK" | awk '{print $1}')"
  printf '%s  %s\n' "$target_before" "$APK" >"$OUT_DIR/target-apk-before.sha256"
  installed_before="$(device_apk_hash "$OUT_DIR/device-base-before.sha256" || true)"
  {
    printf 'target_before=%s\n' "$target_before"
    printf 'device_before=%s\n' "${installed_before:-not-installed}"
    if [ -z "$installed_before" ]; then
      printf 'before_status=not-installed\n'
    elif [ "$installed_before" = "$target_before" ]; then
      printf 'before_status=match\n'
    else
      printf 'before_status=different-version\n'
    fi
  } >"$OUT_DIR/apk-hash-verification.txt"

  if [ "$INSTALL_APK" = "1" ]; then
    log "installing release APK: $APK"
    adb_cmd install --no-streaming -r "$APK" >"$OUT_DIR/install.log"
  elif [ -z "$installed_before" ]; then
    fail "$PACKAGE_NAME is not installed and INSTALL_APK=0"
  fi

  target_after="$(sha256sum "$APK" | awk '{print $1}')"
  printf '%s  %s\n' "$target_after" "$APK" >"$OUT_DIR/target-apk-after.sha256"
  [ "$target_after" = "$target_before" ] || fail "target APK changed while the gate was installing it"
  installed_after="$(device_apk_hash "$OUT_DIR/device-base-after.sha256" || true)"
  [ -n "$installed_after" ] || fail "$PACKAGE_NAME is not installed after install step"
  [ "$installed_after" = "$target_after" ] || fail "device base.apk SHA256 differs from target APK"
  if [ "$INSTALL_APK" = "0" ]; then
    [ "$installed_before" = "$target_before" ] || fail "installed APK differs from target while INSTALL_APK=0"
  fi
  {
    printf 'target_after=%s\n' "$target_after"
    printf 'device_after=%s\n' "$installed_after"
    printf 'after_status=match\n'
  } >>"$OUT_DIR/apk-hash-verification.txt"
  log "APK SHA256 verified: $target_after"
}

verify_final_artifact_identity() {
  local expected target installed
  expected="$(awk '{print $1}' "$OUT_DIR/target-apk-before.sha256")"
  target="$(sha256sum "$APK" | awk '{print $1}')"
  installed="$(device_apk_hash "$OUT_DIR/device-base-final.sha256" || true)"
  [ "$target" = "$expected" ] || fail "target APK changed during UI-ROUTES-001"
  [ "$installed" = "$expected" ] || fail "device base.apk changed during UI-ROUTES-001"
  assert_apk_fresh "$APK" "$ROOT_DIR" "$OUT_DIR/apk-newer-production-sources-final.txt" || \
    fail "production source changed after the release APK during UI-ROUTES-001"
  log "final source/APK/device identity verified"
}

start_main_activity() {
  local label="$1"
  adb_cmd shell am start -W -n "$MAIN_ACTIVITY" >"$OUT_DIR/$label-am-start.log"
  rg -q '^Status: ok' "$OUT_DIR/$label-am-start.log" || fail "MainActivity launch failed: $label"
}

dismiss_stale_input_method() {
  # Package reinstall/pm clear does not dismiss an IME owned by the previous
  # focused editor. Normalize it before the cold launch so route geometry is
  # measured against the full application viewport.
  adb_cmd shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
  sleep 0.5
  log "dismissed any stale input method before cold launch"
}

launch_initial_main_activity() {
  start_main_activity "$1"
  wait_for_any_node "游客体验" "暂不开启" 20 >/dev/null || \
    fail "packaged MainActivity did not expose login or notification primer"
  assert_main_activity
}

scan_current_logcat() {
  local label="$1"
  local log_file="$OUT_DIR/logcat-$label.txt"
  local scan_file="$OUT_DIR/crash-scan-$label.txt"
  adb_cmd logcat -d -v threadtime >"$log_file" 2>&1 || true
  if ! scan_logcat_file "$log_file" "$scan_file"; then
    cat "$scan_file" | tee -a "$OUT_DIR/route-smoke.log"
    fail "fatal/native/React JS signature found in logcat ($label)"
  fi
  log "logcat scan passed: $label"
}

run_route() {
  local first_surface
  first_surface="$(wait_for_any_node "游客体验" "暂不开启" 20)" || \
    fail "login surface did not become reachable"
  if [ "$first_surface" = "暂不开启" ]; then
    checkpoint notification-primer
    assert_unique_node "$LAST_XML" exact "暂不开启"
    assert_absent_node "$LAST_XML" exact "游客体验"
    tap_unique_node "$LAST_XML" exact "暂不开启"
    wait_for_node exact "游客体验" 12
  else
    # Give the asynchronous primer one final chance to replace the login tree.
    sleep 1.2
    first_surface="$(wait_for_any_node "暂不开启" "游客体验" 4)" || fail "login surface disappeared"
    if [ "$first_surface" = "暂不开启" ]; then
      checkpoint notification-primer
      assert_unique_node "$LAST_XML" exact "暂不开启"
      assert_absent_node "$LAST_XML" exact "游客体验"
      tap_unique_node "$LAST_XML" exact "暂不开启"
      wait_for_node exact "游客体验" 12
    fi
  fi

  checkpoint login-clean
  assert_unique_node "$LAST_XML" exact "游客体验"
  assert_unique_node "$LAST_XML" exact "同意用户协议和隐私政策"
  assert_absent_node "$LAST_XML" exact "日程，当前页面"

  tap_unique_node "$LAST_XML" exact "游客体验"
  wait_for_node exact "勾选用户协议和隐私政策后才能继续。" 8
  checkpoint protocol-guard
  assert_unique_node "$LAST_XML" exact "勾选用户协议和隐私政策后才能继续。"
  assert_unique_node "$LAST_XML" exact "知道了"
  assert_absent_node "$LAST_XML" exact "游客体验"

  tap_unique_node "$LAST_XML" exact "知道了"
  wait_for_node exact "游客体验" 8
  checkpoint login-after-guard
  assert_unique_node "$LAST_XML" exact "游客体验"
  assert_absent_node "$LAST_XML" exact "勾选用户协议和隐私政策后才能继续。"

  tap_unique_node "$LAST_XML" exact "同意用户协议和隐私政策"
  wait_for_node exact "同意用户协议和隐私政策" 5
  checkpoint login-consented
  assert_node_attribute "$LAST_XML" exact "同意用户协议和隐私政策" checked true
  assert_absent_node "$LAST_XML" exact "勾选用户协议和隐私政策后才能继续。"

  tap_unique_node "$LAST_XML" exact "游客体验"
  wait_for_node exact "日程，当前页面" 20
  checkpoint schedule-main
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_unique_node "$LAST_XML" exact "新建日程"
  assert_absent_node "$LAST_XML" exact "游客体验"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"

  # UI-ROUTES-001 / CAL-DETAIL-CLOSURE-001: exercise the packaged AddEvent
  # route without creating fixture data or touching a network service.
  tap_unique_node "$LAST_XML" exact "新建日程"
  wait_for_node exact "手动新建" 12
  checkpoint create-action-sheet
  assert_unique_node "$LAST_XML" exact "语音输入"
  assert_unique_node "$LAST_XML" exact "手动新建"

  tap_unique_node "$LAST_XML" exact "手动新建"
  wait_for_node exact "添加主题" 12
  checkpoint add-event
  assert_unique_node "$LAST_XML" exact "添加主题"
  assert_unique_node "$LAST_XML" exact "保存"
  assert_unique_node "$LAST_XML" exact "取消"
  assert_absent_node "$LAST_XML" exact "日程，当前页面"

  tap_unique_node "$LAST_XML" exact "取消"
  wait_for_node exact "日程，当前页面" 12
  checkpoint schedule-after-add-event
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_unique_node "$LAST_XML" exact "新建日程"
  assert_absent_node "$LAST_XML" exact "添加主题"

  tap_unique_node "$LAST_XML" exact "新建日程"
  wait_for_node exact "手动新建" 12
  checkpoint create-action-sheet-for-event
  tap_unique_node "$LAST_XML" exact "手动新建"
  wait_for_node exact "添加主题" 12
  checkpoint add-event-for-detail
  input_text_unique_node "$LAST_XML" exact "添加主题" "RouteSmokeEvent"
  wait_for_node exact "RouteSmokeEvent" 8
  checkpoint add-event-filled
  assert_unique_node "$LAST_XML" exact "保存"
  tap_unique_node "$LAST_XML" exact "保存"

  local post_save_surface
  post_save_surface="$(wait_for_any_node "日程，当前页面" "知道了" 20)" || \
    fail "saved guest event did not return to schedule or expose its reminder warning"
  if [ "$post_save_surface" = "知道了" ]; then
    checkpoint add-event-warning
    assert_unique_node "$LAST_XML" exact "知道了"
    tap_unique_node "$LAST_XML" exact "知道了"
    wait_for_node exact "日程，当前页面" 12
  fi

  wait_for_node contains "RouteSmokeEvent" 15
  checkpoint schedule-with-event
  assert_unique_node "$LAST_XML" contains "RouteSmokeEvent"
  tap_unique_node "$LAST_XML" contains "RouteSmokeEvent"
  wait_for_node exact "编辑日程" 12
  checkpoint event-detail
  assert_unique_node "$LAST_XML" exact "编辑日程"
  assert_unique_node "$LAST_XML" exact "删除日程"
  assert_absent_node "$LAST_XML" exact "日程，当前页面"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "日程，当前页面" 12
  checkpoint schedule-after-event-detail
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_unique_node "$LAST_XML" contains "RouteSmokeEvent"

  tap_unique_node "$LAST_XML" exact "会议"
  wait_for_node exact "会议，当前页面" 15
  checkpoint meetings-main
  assert_unique_node "$LAST_XML" exact "会议，当前页面"
  assert_unique_node "$LAST_XML" exact "会议记录"
  assert_absent_node "$LAST_XML" exact "日程，当前页面"
  assert_absent_node "$LAST_XML" exact "新建日程"

  tap_unique_node "$LAST_XML" exact "更多会议操作"
  wait_for_node exact "管理讲话人" 12
  checkpoint meetings-app-menu
  assert_unique_node "$LAST_XML" exact "管理讲话人"
  assert_unique_node "$LAST_XML" exact "个人资料"

  tap_unique_node "$LAST_XML" exact "管理讲话人"
  wait_for_node exact "登录账号" 12
  checkpoint speaker-manager
  assert_unique_node "$LAST_XML" exact "登录账号"
  assert_unique_node "$LAST_XML" exact "返回"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "会议，当前页面" 12
  checkpoint meetings-after-speaker-manager
  assert_unique_node "$LAST_XML" exact "会议记录"
  assert_absent_node "$LAST_XML" exact "登录账号"

  force_microphone_permission_denied
  tap_unique_node "$LAST_XML" exact "开始录音"
  wait_for_node exact "无法录音" 15
  checkpoint meeting-live-permission-guard
  assert_unique_node "$LAST_XML" exact "无法录音"
  assert_unique_node "$LAST_XML" exact "知道了"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"

  tap_unique_node "$LAST_XML" exact "知道了"
  wait_for_node exact "开始会议录音" 12
  checkpoint meeting-live-idle
  assert_unique_node "$LAST_XML" exact "开始会议录音"
  assert_unique_node "$LAST_XML" exact "返回"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "会议，当前页面" 12
  clear_microphone_permission_test_flags
  checkpoint meetings-after-live
  assert_unique_node "$LAST_XML" exact "会议记录"
  assert_unique_node "$LAST_XML" exact "开始录音"
  assert_absent_node "$LAST_XML" exact "开始会议录音"

  tap_unique_node "$LAST_XML" exact "日程"
  wait_for_node exact "日程，当前页面" 15
  checkpoint schedule-return
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_unique_node "$LAST_XML" exact "个人资料"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"
  assert_absent_node "$LAST_XML" exact "会议记录"

  tap_unique_node "$LAST_XML" exact "个人资料"
  wait_for_node exact "打开设置" 12
  checkpoint profile
  assert_unique_node "$LAST_XML" exact "打开设置"
  assert_unique_node "$LAST_XML" exact "未登录账号"
  assert_absent_node "$LAST_XML" exact "日程，当前页面"
  assert_absent_node "$LAST_XML" exact "新建日程"

  tap_unique_node "$LAST_XML" exact "编辑昵称"
  wait_for_node exact "清空输入" 12
  checkpoint profile-field
  assert_unique_node "$LAST_XML" exact "清空输入"
  assert_unique_node "$LAST_XML" exact "取消"
  assert_absent_node "$LAST_XML" exact "打开设置"

  tap_unique_node "$LAST_XML" exact "取消"
  wait_for_node exact "打开设置" 12
  checkpoint profile-after-field
  assert_unique_node "$LAST_XML" exact "编辑昵称"
  assert_absent_node "$LAST_XML" exact "清空输入"

  tap_unique_node "$LAST_XML" exact "打开设置"
  wait_for_node exact "账号与安全" 12
  checkpoint privacy-settings
  assert_unique_node "$LAST_XML" exact "账号与安全"
  assert_unique_node "$LAST_XML" exact "用户协议"
  assert_absent_node "$LAST_XML" exact "打开设置"
  assert_absent_node "$LAST_XML" exact "未登录账号"

  tap_unique_node "$LAST_XML" exact "账号与安全"
  wait_for_node exact "密码与安全" 12
  checkpoint account
  assert_unique_node "$LAST_XML" exact "密码与安全"
  assert_unique_node "$LAST_XML" exact "通知与提醒"
  assert_unique_node "$LAST_XML" exact "退出访客模式"
  assert_absent_node "$LAST_XML" exact "用户协议"

  tap_unique_node "$LAST_XML" exact "通知与提醒"
  wait_for_node exact "发送测试提醒" 12
  checkpoint notification-settings
  assert_unique_node "$LAST_XML" exact "发送测试提醒"
  assert_unique_node "$LAST_XML" exact "当前状态"
  assert_absent_node "$LAST_XML" exact "退出访客模式"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "退出访客模式" 12
  checkpoint account-after-notifications
  assert_unique_node "$LAST_XML" exact "密码与安全"
  assert_unique_node "$LAST_XML" exact "退出访客模式"
  assert_absent_node "$LAST_XML" exact "发送测试提醒"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "用户协议" 12
  checkpoint privacy-after-account
  assert_unique_node "$LAST_XML" exact "账号与安全"
  assert_unique_node "$LAST_XML" exact "用户协议"
  assert_absent_node "$LAST_XML" exact "退出访客模式"

  tap_unique_node "$LAST_XML" exact "用户协议"
  wait_for_node exact "服务范围" 12
  checkpoint legal-terms
  assert_unique_node "$LAST_XML" exact "服务范围"
  assert_unique_node "$LAST_XML" exact "返回"
  assert_absent_node "$LAST_XML" exact "账号与安全"
  assert_absent_node "$LAST_XML" exact "清除本机数据"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "账号与安全" 12
  checkpoint privacy-after-legal
  assert_unique_node "$LAST_XML" exact "账号与安全"
  assert_absent_node "$LAST_XML" exact "服务范围"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "打开设置" 12
  checkpoint profile-return
  assert_unique_node "$LAST_XML" exact "打开设置"
  assert_absent_node "$LAST_XML" exact "账号与安全"

  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "日程，当前页面" 12
  checkpoint schedule-final
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_absent_node "$LAST_XML" exact "打开设置"
  assert_main_activity
}

assert_restored_schedule_checkpoint() {
  local name="$1"
  wait_for_node exact "日程，当前页面" 20
  checkpoint "$name"
  assert_unique_node "$LAST_XML" exact "日程，当前页面"
  assert_unique_node "$LAST_XML" exact "新建日程"
  assert_absent_node "$LAST_XML" exact "游客体验"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"
  assert_absent_node "$LAST_XML" exact "打开设置"
  assert_main_activity
}

run_lifecycle_route() {
  adb_cmd shell input keyevent KEYCODE_HOME
  sleep 0.5
  adb_cmd shell dumpsys activity activities >"$OUT_DIR/home-background.state.log"
  if activity_state_has_resumed_main "$OUT_DIR/home-background.state.log"; then
    fail "KEYCODE_HOME did not background MainActivity"
  fi
  start_main_activity home-restore
  assert_restored_schedule_checkpoint home-restore

  adb_cmd shell am force-stop "$PACKAGE_NAME"
  start_main_activity force-stop-cold-start
  assert_restored_schedule_checkpoint force-stop-cold-start

  local launch
  for launch in 1 2 3; do
    start_main_activity "repeat-launch-$launch"
    assert_restored_schedule_checkpoint "repeat-launch-$launch"
  done
}

main() {
  validate_boolean INSTALL_APK "$INSTALL_APK"
  validate_boolean RESET_APP_DATA "$RESET_APP_DATA"
  validate_boolean ALLOW_ADDITIONAL_DEVICES "$ALLOW_ADDITIONAL_DEVICES"
  validate_boolean ALLOW_PHYSICAL_DEVICE "$ALLOW_PHYSICAL_DEVICE"
  validate_boolean RUN_COMPOSITION_SMOKE "$RUN_COMPOSITION_SMOKE"
  require_file "$APK"
  require_file "$COMPOSITION_SCRIPT"
  assert_apk_fresh "$APK" "$ROOT_DIR" || fail "rebuild the final release APK before running UI-ROUTES-001"
  ensure_target_device
  adb_cmd shell getprop ro.build.fingerprint >"$OUT_DIR/device-fingerprint.txt"
  record_and_verify_apk
  if [ "$RESET_APP_DATA" = "1" ]; then
    adb_cmd shell pm clear "$PACKAGE_NAME" >"$OUT_DIR/pm-clear.log"
    log "cleared $PACKAGE_NAME app data"
  fi
  : >"$OUT_DIR/checkpoints.tsv"
  adb_cmd logcat -c
  adb_cmd shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  dismiss_stale_input_method
  launch_initial_main_activity initial
  run_route
  run_lifecycle_route
  scan_current_logcat route

  if [ "$RUN_COMPOSITION_SMOKE" = "1" ]; then
    log "running reusable Home/force-stop/repeated-launch composition gate"
    DEVICE="$DEVICE" APK="$APK" INSTALL_APK=0 TAB_CYCLES="$COMPOSITION_TAB_CYCLES" \
      ALLOW_PHYSICAL_DEVICE="$ALLOW_PHYSICAL_DEVICE" \
      OUT_DIR="$OUT_DIR/composition" "$COMPOSITION_SCRIPT" | tee "$OUT_DIR/composition-smoke.log"
    [ -s "$OUT_DIR/composition/logcat.txt" ] || fail "composition gate did not preserve logcat evidence"
    if [ -s "$OUT_DIR/composition/crash-scan.txt" ]; then
      fail "composition gate reported a crash signature"
    fi
  fi

  scan_current_logcat final
  verify_final_artifact_identity
  log "UI-ROUTES-001 passed; artifacts: $OUT_DIR"
}

if [ "${ROUTE_SMOKE_LIBRARY_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

trap 'adb_cmd shell rm -f "$REMOTE_XML" >/dev/null 2>&1 || true' EXIT
main "$@"
