#!/usr/bin/env bash
set -euo pipefail

# UI-ANDROID-COMPOSITION-001: exported Expo/Fabric tab roots must never be siblings.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ADB="$SDK_DIR/platform-tools/adb"
DEVICE="${DEVICE:-emulator-5556}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-composition-smoke}"
TAB_CYCLES="${TAB_CYCLES:-6}"
INSTALL_APK="${INSTALL_APK:-1}"
ALLOW_PHYSICAL_DEVICE="${ALLOW_PHYSICAL_DEVICE:-0}"

mkdir -p "$OUT_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

fail() {
  log "FAILED: $*"
  exit 1
}

adb_cmd() {
  "$ADB" -s "$DEVICE" "$@"
}

assert_installed_apk_matches() {
  local expected_hash
  local installed_hash
  local package_path
  expected_hash="$(sha256sum "$APK" | awk '{print $1}')"
  package_path="$(adb_cmd shell pm path com.laoji.app | tr -d '\r' | sed -n 's/^package://p' | awk '/\/base\.apk$/ {print; exit}')"
  [ -n "$package_path" ] || fail "com.laoji.app is not installed on $DEVICE"
  installed_hash="$(adb_cmd exec-out cat "$package_path" | sha256sum | awk '{print $1}')"
  printf '%s  %s\n' "$installed_hash" "$package_path" >"$OUT_DIR/installed-apk.sha256"
  [ "$installed_hash" = "$expected_hash" ] || fail "installed APK hash differs from target APK"
}

if [[ "$DEVICE" != emulator-* ]] && [ "$ALLOW_PHYSICAL_DEVICE" != "1" ]; then
  fail "physical target requires ALLOW_PHYSICAL_DEVICE=1: $DEVICE"
fi
if [ ! -x "$ADB" ]; then
  fail "adb not found: $ADB"
fi
if [ ! -f "$APK" ]; then
  fail "release APK not found: $APK"
fi
if [ "$(adb_cmd get-state 2>/dev/null || true)" != "device" ]; then
  fail "target device is not connected: $DEVICE"
fi
if [[ "$DEVICE" != emulator-* ]] && \
  [ "$(adb_cmd shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')" = "1" ]; then
  fail "physical mode resolved to an emulator: $DEVICE"
fi

dump_ui() {
  local name="$1"
  for _ in $(seq 1 8); do
    if adb_cmd shell uiautomator dump /sdcard/laoji-composition.xml >/dev/null 2>&1; then
      adb_cmd exec-out cat /sdcard/laoji-composition.xml >"$OUT_DIR/$name.xml"
      return 0
    fi
    sleep 0.5
  done
  fail "uiautomator dump failed: $name"
}

has_label() {
  local file="$1"
  local label="$2"
  python3 - "$file" "$label" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
for node in root.iter("node"):
    if label in node.attrib.get("text", "") or label in node.attrib.get("content-desc", ""):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

tap_label() {
  local file="$1"
  local label="$2"
  local xy
  xy="$(python3 - "$file" "$label" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
candidates = []
for node in root.iter("node"):
    text = node.attrib.get("text", "")
    desc = node.attrib.get("content-desc", "")
    if label not in text and label not in desc:
        continue
    values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
    if len(values) != 4:
        continue
    x1, y1, x2, y2 = values
    score = 100 if node.attrib.get("clickable") == "true" else 0
    score += 1000 if text == label or desc == label else 0
    score += y2 / 10000
    candidates.append((score, (x1 + x2) // 2, (y1 + y2) // 2))
if not candidates:
    raise SystemExit(2)
_, x, y = max(candidates)
print(x, y)
PY
)" || fail "label not found: $label"
  adb_cmd shell input tap $xy
  log "tap '$label' at $xy"
}

dismiss_notification_primer() {
  local name="$1"
  dump_ui "$name"
  if has_label "$OUT_DIR/$name.xml" "暂不开启"; then
    tap_label "$OUT_DIR/$name.xml" "暂不开启"
    sleep 0.8
  fi
}

ensure_guest_main() {
  dismiss_notification_primer launch
  dump_ui route
  if has_label "$OUT_DIR/route.xml" "游客体验"; then
    if has_label "$OUT_DIR/route.xml" "同意用户协议和隐私政策"; then
      tap_label "$OUT_DIR/route.xml" "同意用户协议和隐私政策"
      sleep 0.3
      dump_ui route_checked
      tap_label "$OUT_DIR/route_checked.xml" "游客体验"
    else
      tap_label "$OUT_DIR/route.xml" "游客体验"
    fi
    sleep 1.5
    dismiss_notification_primer guest_primer
  fi
}

launch_app() {
  adb_cmd shell am start -W -n com.laoji.app/.MainActivity >/dev/null
  sleep 2
}

assert_native_root() {
  local expected="$1"
  local dump="$OUT_DIR/hierarchy-$expected.txt"
  adb_cmd shell dumpsys activity top >"$dump"
  rg -q "com\.laoji\.nativeplatform\.$expected" "$dump" || fail "missing native root: $expected"
  [ "$(rg -c 'LaojiNativeBottomBarView' "$dump")" = "1" ] || fail "expected one internal bottom bar for $expected"
  if rg -q 'LaojiNativeMainContainerView' "$dump"; then
    fail "obsolete exported main container is mounted"
  fi
  local exported_count
  exported_count="$(rg -c 'CalendarHostView|LaojiMinutesView' "$dump")"
  [ "$exported_count" = "1" ] || fail "expected one exported tab root, found $exported_count"
}

assert_title_below_status_bar() {
  local xml="$1"
  local label="$2"
  python3 - "$xml" "$label" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
tops = []
for node in root.iter("node"):
    if label not in node.attrib.get("text", "") and label not in node.attrib.get("content-desc", ""):
        continue
    values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
    if len(values) == 4:
        tops.append(values[1])
if not tops or max(tops) < 90:
    raise SystemExit(f"{label!r} overlaps status bar: tops={tops}")
PY
}

assert_nonblank_frame() {
  local name="$1"
  adb_cmd exec-out screencap -p >"$OUT_DIR/$name.png"
  python3 - "$OUT_DIR/$name.png" <<'PY'
import sys
from PIL import Image

image = Image.open(sys.argv[1]).convert("RGB")
width, height = image.size
content = image.crop((0, int(height * 0.06), width, int(height * 0.90)))
colors = content.getcolors(maxcolors=10_000_000)
if not colors or len(colors) < 50:
    raise SystemExit(f"blank or uninspectable frame: unique={None if colors is None else len(colors)}")
dominant = max(count for count, _ in colors) / (content.width * content.height)
if dominant >= 0.995:
    raise SystemExit(f"blank frame: dominant_ratio={dominant:.6f}")
print(f"unique_colors={len(colors)} dominant_ratio={dominant:.6f}")
PY
}

frame_changed_ratio() {
  local current="$1"
  local reference="$2"
  python3 - "$current" "$reference" <<'PY'
import sys
from PIL import Image, ImageChops

current = Image.open(sys.argv[1]).convert("RGB")
reference = Image.open(sys.argv[2]).convert("RGB")
if current.size != reference.size:
    raise SystemExit("frame sizes differ")
width, height = current.size
box = (0, int(height * 0.06), width, int(height * 0.90))
diff = ImageChops.difference(current.crop(box), reference.crop(box)).convert("L")
histogram = diff.histogram()
ratio = sum(histogram[9:]) / (diff.width * diff.height)
print(f"{ratio:.8f}")
PY
}

assert_frame_differs() {
  local current="$1"
  local reference="$2"
  local ratio
  ratio="$(frame_changed_ratio "$current" "$reference")"
  python3 - "$ratio" <<'PY'
import sys
ratio = float(sys.argv[1])
if ratio < 0.02:
    raise SystemExit(f"target page did not replace the baseline frame: changed_ratio={ratio:.8f}")
PY
  log "frame differs from baseline: changed_ratio=$ratio"
}

assert_frame_matches() {
  local current="$1"
  local reference="$2"
  local ratio
  ratio="$(frame_changed_ratio "$current" "$reference")"
  python3 - "$ratio" <<'PY'
import sys
ratio = float(sys.argv[1])
if ratio > 0.005:
    raise SystemExit(f"calendar frame did not recover to baseline: changed_ratio={ratio:.8f}")
PY
  log "frame matches calendar baseline: changed_ratio=$ratio"
}

assert_schedule() {
  dump_ui schedule-current
  has_label "$OUT_DIR/schedule-current.xml" "日程，当前页面" || fail "schedule tab is not selected"
  has_label "$OUT_DIR/schedule-current.xml" "日视图" || fail "calendar controls are missing"
  assert_title_below_status_bar "$OUT_DIR/schedule-current.xml" "选择年月"
  assert_native_root 'calendar.CalendarHostView'
}

assert_meetings() {
  dump_ui meetings-current
  has_label "$OUT_DIR/meetings-current.xml" "会议记录" || fail "meeting title is missing"
  has_label "$OUT_DIR/meetings-current.xml" "会议，当前页面" || fail "meetings tab is not selected"
  assert_title_below_status_bar "$OUT_DIR/meetings-current.xml" "会议记录"
  assert_native_root 'minutes.LaojiMinutesView'
}

if [ "$INSTALL_APK" = "1" ]; then
  log "install release APK: $APK"
  adb_cmd install --no-streaming -r "$APK" >/dev/null
fi
sha256sum "$APK" >"$OUT_DIR/apk.sha256"
assert_installed_apk_matches
adb_cmd shell getprop ro.build.fingerprint >"$OUT_DIR/device-fingerprint.txt"
adb_cmd logcat -c
adb_cmd shell am force-stop com.laoji.app
launch_app
ensure_guest_main

assert_schedule
assert_nonblank_frame schedule

for cycle in $(seq 1 "$TAB_CYCLES"); do
  dump_ui "schedule-$cycle"
  tap_label "$OUT_DIR/schedule-$cycle.xml" "会议"
  sleep 0.35
  assert_meetings
  assert_nonblank_frame "meetings-$cycle"
  assert_frame_differs "$OUT_DIR/meetings-$cycle.png" "$OUT_DIR/schedule.png"
  dump_ui "meetings-$cycle"
  tap_label "$OUT_DIR/meetings-$cycle.xml" "日程"
  sleep 0.35
  assert_schedule
  assert_nonblank_frame "schedule-return-$cycle"
  assert_frame_matches "$OUT_DIR/schedule-return-$cycle.png" "$OUT_DIR/schedule.png"
done

dump_ui schedule-profile
tap_label "$OUT_DIR/schedule-profile.xml" "个人资料"
sleep 0.5
dump_ui profile
has_label "$OUT_DIR/profile.xml" "我" || fail "profile route did not open"
adb_cmd shell input keyevent 4
sleep 0.6
assert_schedule
assert_nonblank_frame schedule-profile-return
assert_frame_matches "$OUT_DIR/schedule-profile-return.png" "$OUT_DIR/schedule.png"

adb_cmd shell input keyevent 3
sleep 0.5
launch_app
assert_schedule
assert_nonblank_frame schedule-home-restore
assert_frame_matches "$OUT_DIR/schedule-home-restore.png" "$OUT_DIR/schedule.png"

adb_cmd shell am force-stop com.laoji.app
launch_app
assert_schedule
assert_nonblank_frame schedule-force-stop-restart
assert_frame_matches "$OUT_DIR/schedule-force-stop-restart.png" "$OUT_DIR/schedule.png"

for launch in 1 2 3; do
  adb_cmd shell am start -W -n com.laoji.app/.MainActivity >/dev/null
  sleep 0.3
  assert_schedule
  assert_nonblank_frame "schedule-repeat-$launch"
  assert_frame_matches "$OUT_DIR/schedule-repeat-$launch.png" "$OUT_DIR/schedule.png"
done

assert_nonblank_frame schedule-final
assert_frame_matches "$OUT_DIR/schedule-final.png" "$OUT_DIR/schedule.png"
adb_cmd logcat -d -v brief >"$OUT_DIR/logcat.txt"
if rg -q 'FATAL EXCEPTION|AndroidRuntime.*FATAL|SIG(SEGV|ABRT)|ReactNativeJS.*(TypeError|Error:)' "$OUT_DIR/logcat.txt"; then
  rg 'FATAL EXCEPTION|AndroidRuntime.*FATAL|SIG(SEGV|ABRT)|ReactNativeJS.*(TypeError|Error:)' "$OUT_DIR/logcat.txt" >"$OUT_DIR/crash-scan.txt"
  fail "crash signature found; see $OUT_DIR/crash-scan.txt"
fi

log "composition smoke passed: $OUT_DIR"
