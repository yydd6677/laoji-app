#!/usr/bin/env bash
set -euo pipefail

# UI-OVERLAY-WINDOW-001 / UI-ANDROID-COMPOSITION-001: every temporary Android
# surface is exercised through the single Activity-owned overlay root.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ADB="$SDK_DIR/platform-tools/adb"
DEVICE="${DEVICE:-emulator-5556}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-overlay-smoke}"
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
    if adb_cmd shell uiautomator dump /sdcard/laoji-overlay.xml >/dev/null 2>&1; then
      adb_cmd exec-out cat /sdcard/laoji-overlay.xml >"$OUT_DIR/$name.xml"
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

assert_label_not_clickable() {
  local file="$1"
  local label="$2"
  python3 - "$file" "$label" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
matched = False
for node in root.iter("node"):
    if label not in {node.attrib.get("text", ""), node.attrib.get("content-desc", "")}:
        continue
    matched = True
    if node.attrib.get("clickable") == "true":
        raise SystemExit(f"transient text exposes a false accessibility click action: {label!r}")
if not matched:
    raise SystemExit(f"accessibility node not found for {label!r}")
PY
}

assert_label_attribute() {
  local file="$1"
  local label="$2"
  local attribute="$3"
  local expected="$4"
  python3 - "$file" "$label" "$attribute" "$expected" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label, attribute, expected = sys.argv[2:]
nodes = [
    node for node in root.iter("node")
    if label in {node.attrib.get("text", ""), node.attrib.get("content-desc", "")}
]
if len(nodes) != 1:
    raise SystemExit(f"expected one node for {label!r}, got {len(nodes)}")
actual = nodes[0].attrib.get(attribute, "")
if actual != expected:
    raise SystemExit(f"{label!r} {attribute}: expected {expected!r}, got {actual!r}")
PY
}

assert_label_moves_down() {
  local upper_file="$1"
  local lower_file="$2"
  local label="$3"
  local minimum_delta_px="${4:-100}"
  python3 - "$upper_file" "$lower_file" "$label" "$minimum_delta_px" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

def label_bottom(path, label):
    root = ET.parse(path).getroot()
    for node in root.iter("node"):
        if label not in {node.attrib.get("text", ""), node.attrib.get("content-desc", "")}:
            continue
        values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
        if len(values) == 4:
            return values[3]
    raise SystemExit(f"label bounds not found: {label!r} in {path}")

upper = label_bottom(sys.argv[1], sys.argv[3])
lower = label_bottom(sys.argv[2], sys.argv[3])
minimum = int(sys.argv[4])
delta = lower - upper
if delta < minimum:
    raise SystemExit(f"toast did not follow IME resize: upper={upper} lower={lower} delta={delta}")
print(f"toast_ime_vertical_delta_px={delta}")
PY
}

assert_toast_timing_log() {
  adb_cmd logcat -d -v brief -s LaojiWindowToast:I '*:S' >"$OUT_DIR/toast-timing-log.txt"
  python3 - "$OUT_DIR/toast-timing-log.txt" <<'PY'
import re
import sys

lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
shows = []
starts = []
ends = []
for line in lines:
    match = re.search(r"show sequence=(\d+) atElapsedMs=(\d+) durationMs=(\d+|none)", line)
    if match:
        shows.append((int(match.group(1)), int(match.group(2)), match.group(3)))
    match = re.search(
        r"dismiss-start sequence=(\d+) reason=([^ ]+) atElapsedMs=(\d+) visibleForMs=(\d+)",
        line,
    )
    if match:
        starts.append(tuple(int(value) if index != 1 else value for index, value in enumerate(match.groups())))
    match = re.search(
        r"dismiss-end sequence=(\d+) reason=([^ ]+) atElapsedMs=(\d+) animationMs=(\d+)",
        line,
    )
    if match:
        ends.append(tuple(int(value) if index != 1 else value for index, value in enumerate(match.groups())))

if len(shows) < 2:
    raise SystemExit(f"expected two toast presentations, got {shows}")
first, last = shows[-2], shows[-1]
if first[0] == last[0] or last[1] - first[1] >= int(first[2]):
    raise SystemExit(f"same-message reentry did not replace the active timer: {first}, {last}")
matching_starts = [item for item in starts if item[0] == last[0] and item[1] == "timeout"]
matching_ends = [item for item in ends if item[0] == last[0] and item[1] == "timeout"]
if not matching_starts or not matching_ends:
    raise SystemExit(f"missing timeout lifecycle for sequence {last[0]}")
start = matching_starts[-1]
end = matching_ends[-1]
duration = int(last[2])
if not duration - 120 <= start[3] <= duration + 800:
    raise SystemExit(f"timeout drift is outside tolerance: duration={duration} visible={start[3]}")
if not 120 <= end[3] <= 450:
    raise SystemExit(f"toast exit animation is not approximately 200ms: {end[3]}ms")
print(
    f"toast_reentry_ms={last[1] - first[1]} "
    f"visible_ms={start[3]} exit_animation_ms={end[3]}"
)
PY
}

tap_label() {
  local file="$1"
  local label="$2"
  local horizontal_fraction="${3:-0.5}"
  local xy
  xy="$(python3 - "$file" "$label" "$horizontal_fraction" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
fraction = float(sys.argv[3])
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
    x = round(x1 + (x2 - x1) * fraction)
    candidates.append((score, x, (y1 + y2) // 2))
if not candidates:
    raise SystemExit(2)
_, x, y = max(candidates)
print(x, y)
PY
)" || fail "label not found: $label"
  adb_cmd shell input tap $xy
  log "tap '$label' at $xy"
}

tap_calendar_fab() {
  local file="$1"
  local density
  local xy
  density="$(adb_cmd shell wm density | sed -n 's/.*Override density: //p' | tail -1)"
  if [ -z "$density" ]; then
    density="$(adb_cmd shell wm density | sed -n 's/.*Physical density: //p' | tail -1)"
  fi
  [ -n "$density" ] || fail "could not read emulator density"
  xy="$(python3 - "$file" "$density" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
density_scale = float(sys.argv[2]) / 160.0
for node in root.iter("node"):
    if node.attrib.get("content-desc") != "新建日程":
        continue
    values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
    if len(values) == 4:
        _, _, right, bottom = values
        offset = round(24 * density_scale)
        print(right - offset, bottom - offset)
        raise SystemExit(0)
raise SystemExit(2)
PY
)" || fail "calendar FAB bounds not found"
  adb_cmd shell input tap $xy
  log "tap calendar FAB at $xy"
}

assert_nonblank_frame() {
  local name="$1"
  adb_cmd exec-out screencap -p >"$OUT_DIR/$name.png"
  python3 - "$OUT_DIR/$name.png" <<'PY'
import sys
from PIL import Image

image = Image.open(sys.argv[1]).convert("RGB")
width, height = image.size
content = image.crop((0, int(height * 0.06), width, int(height * 0.94)))
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
box = (0, int(height * 0.06), width, int(height * 0.94))
diff = ImageChops.difference(current.crop(box), reference.crop(box)).convert("L")
histogram = diff.histogram()
print(f"{sum(histogram[9:]) / (diff.width * diff.height):.8f}")
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
if ratio < 0.03:
    raise SystemExit(f"overlay did not alter its target ROI: changed_ratio={ratio:.8f}")
PY
  log "overlay frame differs from page baseline: changed_ratio=$ratio"
}

assert_toast_frame_differs() {
  local current="$1"
  local reference="$2"
  local ratio
  ratio="$(frame_changed_ratio "$current" "$reference")"
  python3 - "$ratio" <<'PY'
import sys
ratio = float(sys.argv[1])
if ratio < 0.001:
    raise SystemExit(f"toast did not alter its target ROI: changed_ratio={ratio:.8f}")
PY
  log "toast frame differs from page baseline: changed_ratio=$ratio"
}

assert_frame_matches() {
  local current="$1"
  local reference="$2"
  local ratio
  ratio="$(frame_changed_ratio "$current" "$reference")"
  python3 - "$ratio" <<'PY'
import sys
ratio = float(sys.argv[1])
if ratio > 0.01:
    raise SystemExit(f"restored frame diverged from baseline: changed_ratio={ratio:.8f}")
PY
  log "restored frame matches baseline: changed_ratio=$ratio"
}

assert_root_limit() {
  local name="$1"
  local require_main="${2:-0}"
  local dump="$OUT_DIR/hierarchy-$name.txt"
  local count
  adb_cmd shell dumpsys activity top >"$dump"
  count="$(rg -c 'CalendarHostView|LaojiMinutesView' "$dump" || true)"
  count="${count:-0}"
  [ "$count" -le 1 ] || fail "multiple exported main roots at $name: $count"
  if [ "$require_main" = "1" ]; then
    [ "$count" = "1" ] || fail "missing exported main root at $name"
    local bottom_count
    bottom_count="$(rg -c 'LaojiNativeBottomBarView' "$dump" || true)"
    bottom_count="${bottom_count:-0}"
    [ "$bottom_count" = "1" ] || fail "missing single internal bottom bar at $name"
  fi
  if rg -q 'LaojiNativeMainContainerView' "$dump"; then
    fail "obsolete main container mounted at $name"
  fi
}

assert_class_absent() {
  local class_name="$1"
  local dump="$OUT_DIR/hierarchy-absent-$class_name.txt"
  adb_cmd shell dumpsys activity top >"$dump"
  if rg -q "$class_name" "$dump"; then
    fail "stale overlay class remains mounted: $class_name"
  fi
}

assert_single_overlay() {
  local expected="$1"
  local name="$2"
  local dump="$OUT_DIR/hierarchy-overlay-$name.txt"
  local expected_count
  local total_count
  adb_cmd shell dumpsys activity top >"$dump"
  expected_count="$(rg -c "$expected" "$dump" || true)"
  expected_count="${expected_count:-0}"
  total_count="$( { rg -o 'CalendarSearchPageView|LaojiNativeActionSheetHostView|ScheduleVoiceHostView|LaojiNativeDialogHostView|NativeToastHostView' "$dump" || true; } | wc -l | tr -d ' ')"
  [ "$expected_count" = "1" ] || fail "expected one $expected at $name, found $expected_count"
  [ "$total_count" = "1" ] || fail "expected one total window overlay at $name, found $total_count"
}

launch_app() {
  adb_cmd shell am start -W -n com.laoji.app/.MainActivity >/dev/null
  sleep 2
}

ensure_guest_main() {
  dump_ui launch
  if has_label "$OUT_DIR/launch.xml" "暂不开启"; then
    tap_label "$OUT_DIR/launch.xml" "暂不开启"
    sleep 0.8
    dump_ui launch
  fi
  if has_label "$OUT_DIR/launch.xml" "游客体验"; then
    if has_label "$OUT_DIR/launch.xml" "同意用户协议和隐私政策"; then
      tap_label "$OUT_DIR/launch.xml" "同意用户协议和隐私政策"
      sleep 0.3
      dump_ui login-checked
      tap_label "$OUT_DIR/login-checked.xml" "游客体验"
    else
      tap_label "$OUT_DIR/launch.xml" "游客体验"
    fi
    sleep 1.5
    dump_ui guest-main
    if has_label "$OUT_DIR/guest-main.xml" "暂不开启"; then
      tap_label "$OUT_DIR/guest-main.xml" "暂不开启"
      sleep 0.8
    fi
  fi
}

if [ "$INSTALL_APK" = "1" ]; then
  log "install release APK: $APK"
  adb_cmd install --no-streaming -r "$APK" >/dev/null
fi
sha256sum "$APK" >"$OUT_DIR/apk.sha256"
assert_installed_apk_matches
adb_cmd shell getprop ro.build.fingerprint >"$OUT_DIR/device-fingerprint.txt"
adb_cmd shell am force-stop com.laoji.app
adb_cmd logcat -c
launch_app
ensure_guest_main

dump_ui schedule
has_label "$OUT_DIR/schedule.xml" "日程，当前页面" || fail "schedule route is not active"
assert_root_limit schedule 1
assert_nonblank_frame schedule-baseline
tap_label "$OUT_DIR/schedule.xml" "搜索日程"
sleep 1
dump_ui search-open
has_label "$OUT_DIR/search-open.xml" "关闭搜索" || fail "calendar search overlay did not open"
adb_cmd shell dumpsys input_method >"$OUT_DIR/input-method-open.txt"
rg -q 'mInputShown=true' "$OUT_DIR/input-method-open.txt" || fail "search keyboard did not open"
assert_root_limit search-open 1
assert_single_overlay CalendarSearchPageView search-open
assert_nonblank_frame search-open
assert_frame_differs "$OUT_DIR/search-open.png" "$OUT_DIR/schedule-baseline.png"
tap_label "$OUT_DIR/search-open.xml" "关闭搜索"
sleep 1
dump_ui search-closed
has_label "$OUT_DIR/search-closed.xml" "关闭搜索" && fail "calendar search overlay did not close"
adb_cmd shell dumpsys input_method >"$OUT_DIR/input-method-closed.txt"
rg -q 'mInputShown=false' "$OUT_DIR/input-method-closed.txt" || fail "search keyboard remained visible"
assert_class_absent CalendarSearchPageView
assert_nonblank_frame search-closed
assert_frame_matches "$OUT_DIR/search-closed.png" "$OUT_DIR/schedule-baseline.png"

tap_label "$OUT_DIR/search-closed.xml" "会议"
sleep 0.8
dump_ui meetings
has_label "$OUT_DIR/meetings.xml" "会议，当前页面" || fail "meetings tab was blocked after keyboard dismissal"
assert_root_limit meetings 1
assert_nonblank_frame meetings-baseline
tap_label "$OUT_DIR/meetings.xml" "更多会议操作" 0.25
sleep 0.8
dump_ui meeting-sheet
for label in "管理讲话人" "个人资料" "取消"; do
  has_label "$OUT_DIR/meeting-sheet.xml" "$label" || fail "meeting sheet is missing: $label"
done
assert_root_limit meeting-sheet 1
assert_single_overlay LaojiNativeActionSheetHostView meeting-sheet
assert_nonblank_frame meeting-sheet
assert_frame_differs "$OUT_DIR/meeting-sheet.png" "$OUT_DIR/meetings-baseline.png"
adb_cmd shell input keyevent 3
sleep 0.5
launch_app
dump_ui meeting-sheet-restored
has_label "$OUT_DIR/meeting-sheet-restored.xml" "管理讲话人" || fail "meeting sheet was lost across Home/restore"
assert_single_overlay LaojiNativeActionSheetHostView meeting-sheet-restored
assert_nonblank_frame meeting-sheet-restored
assert_frame_matches "$OUT_DIR/meeting-sheet-restored.png" "$OUT_DIR/meeting-sheet.png"
tap_label "$OUT_DIR/meeting-sheet-restored.xml" "取消"
sleep 0.8
assert_class_absent LaojiNativeActionSheetHostView

dump_ui meetings-closed
tap_label "$OUT_DIR/meetings-closed.xml" "日程"
sleep 0.8
dump_ui schedule-create
assert_nonblank_frame schedule-create-baseline
assert_frame_matches "$OUT_DIR/schedule-create-baseline.png" "$OUT_DIR/schedule-baseline.png"
tap_calendar_fab "$OUT_DIR/schedule-create.xml"
sleep 0.8
dump_ui create-sheet
for label in "语音输入" "手动新建" "取消"; do
  has_label "$OUT_DIR/create-sheet.xml" "$label" || fail "create sheet is missing: $label"
done
assert_root_limit create-sheet 1
assert_single_overlay LaojiNativeActionSheetHostView create-sheet
assert_nonblank_frame create-sheet
assert_frame_differs "$OUT_DIR/create-sheet.png" "$OUT_DIR/schedule-create-baseline.png"
tap_label "$OUT_DIR/create-sheet.xml" "语音输入"
sleep 1
dump_ui voice-open
for label in "语音新建日程" "输入或说出日程内容" "解析日程"; do
  has_label "$OUT_DIR/voice-open.xml" "$label" || fail "voice overlay is missing: $label"
done
assert_root_limit voice-open 1
assert_single_overlay ScheduleVoiceHostView voice-open
assert_nonblank_frame voice-open
assert_frame_differs "$OUT_DIR/voice-open.png" "$OUT_DIR/schedule-create-baseline.png"
tap_label "$OUT_DIR/voice-open.xml" "输入或说出日程内容"
sleep 0.5
adb_cmd shell input text test123
sleep 0.5
dump_ui voice-input
has_label "$OUT_DIR/voice-input.xml" "test123" || fail "voice text input did not update"
adb_cmd shell dumpsys input_method >"$OUT_DIR/voice-input-method-open.txt"
rg -q 'mInputShown=true' "$OUT_DIR/voice-input-method-open.txt" || fail "voice input keyboard did not open"
tap_label "$OUT_DIR/voice-input.xml" "关闭语音新建日程"
sleep 0.8
assert_class_absent ScheduleVoiceHostView
adb_cmd shell dumpsys input_method >"$OUT_DIR/voice-input-method-closed.txt"
rg -q 'mInputShown=false' "$OUT_DIR/voice-input-method-closed.txt" || fail "voice input keyboard remained visible"

dump_ui schedule-after-voice
tap_calendar_fab "$OUT_DIR/schedule-after-voice.xml"
sleep 0.6
dump_ui create-sheet-manual
tap_label "$OUT_DIR/create-sheet-manual.xml" "手动新建"
sleep 0.8
dump_ui event-editor
has_label "$OUT_DIR/event-editor.xml" "新建日程" || fail "manual event editor did not open"
has_label "$OUT_DIR/event-editor.xml" "保存" || fail "manual event editor save action is missing"
assert_nonblank_frame event-editor-baseline
tap_label "$OUT_DIR/event-editor.xml" "保存"
sleep 0.15
# Physical-device UIAutomator dumps can consume most of the 3000ms production
# toast lifetime. Capture the rendered frame first, then collect semantics.
assert_nonblank_frame event-toast-visible
assert_toast_frame_differs "$OUT_DIR/event-toast-visible.png" "$OUT_DIR/event-editor-baseline.png"
assert_single_overlay NativeToastHostView event-toast-visible
dump_ui event-toast
has_label "$OUT_DIR/event-toast.xml" "请输入事项标题" || fail "event validation toast did not open"
assert_label_not_clickable "$OUT_DIR/event-toast.xml" "请输入事项标题"

# The Activity-owned host must pass taps outside the card to the editor. Opening
# the title field also proves the toast follows adjustResize instead of covering
# the IME. A repeated save uses the same message and refreshes the native timer.
tap_label "$OUT_DIR/event-toast.xml" "添加主题"
sleep 0.3
adb_cmd shell dumpsys input_method >"$OUT_DIR/event-toast-input-method-open.txt"
rg -q 'mInputShown=true' "$OUT_DIR/event-toast-input-method-open.txt" || fail "toast host blocked the title input"
tap_label "$OUT_DIR/event-toast.xml" "保存"
sleep 0.15
assert_single_overlay NativeToastHostView event-toast-ime-visible
dump_ui event-toast-ime
has_label "$OUT_DIR/event-toast-ime.xml" "请输入事项标题" || fail "toast was lost while the IME was open"
assert_label_not_clickable "$OUT_DIR/event-toast-ime.xml" "请输入事项标题"
assert_label_moves_down "$OUT_DIR/event-toast-ime.xml" "$OUT_DIR/event-toast.xml" "请输入事项标题" 100
tap_label "$OUT_DIR/event-toast-ime.xml" "请输入事项标题"
sleep 0.15
adb_cmd shell dumpsys input_method >"$OUT_DIR/event-toast-card-tap-input-method.txt"
rg -q 'mInputShown=true' "$OUT_DIR/event-toast-card-tap-input-method.txt" || fail "toast card tap leaked to the editor"
dump_ui event-toast-card-tap-after
assert_label_attribute "$OUT_DIR/event-toast-card-tap-after.xml" "添加主题" focused true
adb_cmd shell input keyevent 4
sleep 0.3
adb_cmd shell dumpsys input_method >"$OUT_DIR/event-toast-input-method-closed.txt"
rg -q 'mInputShown=false' "$OUT_DIR/event-toast-input-method-closed.txt" || fail "event editor IME did not close"

# Refresh the same-message timer immediately before backgrounding; otherwise a
# slower OEM UI dump can let the previous presentation expire before Home.
tap_label "$OUT_DIR/event-toast-ime.xml" "保存"
sleep 0.15
assert_single_overlay NativeToastHostView event-toast-before-background
adb_cmd shell input keyevent 3
sleep 0.4
launch_app
dump_ui event-toast-background-dismissed
has_label "$OUT_DIR/event-toast-background-dismissed.xml" "请输入事项标题" && fail "toast survived in the background"
has_label "$OUT_DIR/event-toast-background-dismissed.xml" "新建日程" || fail "event editor did not recover after toast background dismissal"
assert_class_absent NativeToastHostView

# Android may legitimately restore the focused editor together with its IME.
# Normalize only the keyboard state, then compare the timed toast against this
# exact post-lifecycle page rather than the earlier unfocused editor frame.
adb_cmd shell dumpsys input_method >"$OUT_DIR/event-editor-restored-input-method.txt"
if rg -q 'mInputShown=true' "$OUT_DIR/event-editor-restored-input-method.txt"; then
  adb_cmd shell input keyevent 4
  sleep 0.4
fi
adb_cmd shell dumpsys input_method >"$OUT_DIR/event-editor-restored-input-method-closed.txt"
rg -q 'mInputShown=false' "$OUT_DIR/event-editor-restored-input-method-closed.txt" || fail "restored editor IME did not close"
dump_ui event-editor-restored-baseline
has_label "$OUT_DIR/event-editor-restored-baseline.xml" "新建日程" || fail "normalized event editor is missing"
assert_nonblank_frame event-editor-restored-baseline

# A second presentation before the first 3000ms deadline must own the timeout.
# The native monotonic log validates both that reset and the 200ms alpha exit.
adb_cmd logcat -c
tap_label "$OUT_DIR/event-editor-restored-baseline.xml" "保存"
sleep 1.6
tap_label "$OUT_DIR/event-editor-restored-baseline.xml" "保存"
sleep 1.65
assert_single_overlay NativeToastHostView event-toast-reentry-alive
sleep 1.75
dump_ui event-toast-timeout-finished
has_label "$OUT_DIR/event-toast-timeout-finished.xml" "请输入事项标题" && fail "toast did not auto-dismiss"
assert_class_absent NativeToastHostView
assert_toast_timing_log
assert_nonblank_frame event-toast-timeout-finished
assert_frame_matches "$OUT_DIR/event-toast-timeout-finished.png" "$OUT_DIR/event-editor-restored-baseline.png"
adb_cmd shell input keyevent 4
sleep 0.8

dump_ui schedule-profile
tap_label "$OUT_DIR/schedule-profile.xml" "个人资料"
sleep 0.8
dump_ui profile
tap_label "$OUT_DIR/profile.xml" "打开设置" 0.25
sleep 0.8
dump_ui settings
assert_nonblank_frame settings-baseline
tap_label "$OUT_DIR/settings.xml" "清除本机数据"
sleep 0.8
dump_ui clear-dialog
has_label "$OUT_DIR/clear-dialog.xml" "关闭提示" || fail "global dialog did not open"
has_label "$OUT_DIR/clear-dialog.xml" "登录账号的云端日程不会被删除" || fail "clear-data dialog content is incomplete"
assert_root_limit clear-dialog
assert_single_overlay LaojiNativeDialogHostView clear-dialog
assert_nonblank_frame clear-dialog
assert_frame_differs "$OUT_DIR/clear-dialog.png" "$OUT_DIR/settings-baseline.png"
adb_cmd shell input keyevent 3
sleep 0.5
launch_app
dump_ui dialog-background-dismissed
has_label "$OUT_DIR/dialog-background-dismissed.xml" "关闭提示" && fail "private dialog survived in the background"
has_label "$OUT_DIR/dialog-background-dismissed.xml" "清除本机数据" || fail "settings route did not recover after dialog privacy dismissal"
assert_class_absent LaojiNativeDialogHostView
assert_nonblank_frame dialog-background-dismissed
assert_frame_matches "$OUT_DIR/dialog-background-dismissed.png" "$OUT_DIR/settings-baseline.png"
tap_label "$OUT_DIR/dialog-background-dismissed.xml" "清除本机数据"
sleep 0.8
dump_ui clear-dialog-reopened
has_label "$OUT_DIR/clear-dialog-reopened.xml" "登录账号的云端日程不会被删除" || fail "dialog could not reopen after foreground recovery"
assert_single_overlay LaojiNativeDialogHostView clear-dialog-reopened
assert_nonblank_frame clear-dialog-reopened
assert_frame_differs "$OUT_DIR/clear-dialog-reopened.png" "$OUT_DIR/settings-baseline.png"
tap_label "$OUT_DIR/clear-dialog-reopened.xml" "取消" 0.25
sleep 0.8
assert_class_absent LaojiNativeDialogHostView
adb_cmd shell input keyevent 4
sleep 0.5
adb_cmd shell input keyevent 4
sleep 0.8
dump_ui schedule-final
has_label "$OUT_DIR/schedule-final.xml" "日程，当前页面" || fail "calendar did not recover after overlay routes"
assert_root_limit schedule-final 1
assert_nonblank_frame schedule-final
assert_frame_matches "$OUT_DIR/schedule-final.png" "$OUT_DIR/schedule-baseline.png"

adb_cmd logcat -d -v brief >"$OUT_DIR/logcat.txt"
if rg -q 'Cannot convert.*Kotlin type|failed to present (action sheet|toast)|LaojiWindowOverlay.*present failed|FATAL EXCEPTION|AndroidRuntime.*FATAL|SIG(SEGV|ABRT)|ReactNativeJS.*(TypeError|Error:)' "$OUT_DIR/logcat.txt"; then
  rg 'Cannot convert.*Kotlin type|failed to present (action sheet|toast)|LaojiWindowOverlay.*present failed|FATAL EXCEPTION|AndroidRuntime.*FATAL|SIG(SEGV|ABRT)|ReactNativeJS.*(TypeError|Error:)' "$OUT_DIR/logcat.txt" >"$OUT_DIR/failure-scan.txt"
  fail "runtime error signature found; see $OUT_DIR/failure-scan.txt"
fi

log "overlay smoke passed: $OUT_DIR"
