#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ADB="${SDK_DIR}/platform-tools/adb"
EMULATOR="${SDK_DIR}/emulator/emulator"
AVD_NAME="${AVD_NAME:-LaoJi_API_35}"
DEVICE="${DEVICE:-emulator-5554}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-emulator-smoke}"
RESET_APP_DATA="${RESET_APP_DATA:-1}"

mkdir -p "$OUT_DIR"

today_label() {
  python3 <<'PY'
from datetime import date

weekdays = ["一", "二", "三", "四", "五", "六", "日"]
today = date.today()
print(f"{today.year}年{today.month}月{today.day}日 周{weekdays[today.weekday()]}")
PY
}

target_calendar_day() {
  python3 <<'PY'
from datetime import date

today = date.today()
print(18 if today.day == 17 else 17)
PY
}

relative_label_for_day() {
  local day="$1"
  python3 - "$day" <<'PY'
from datetime import date
import sys

today = date.today()
target = date(today.year, today.month, int(sys.argv[1]))
delta = (target - today).days
if delta > 0:
    print(f"{delta}天后")
elif delta < 0:
    print(f"{abs(delta)}天前")
else:
    print("今天")
PY
}

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

require_file() {
  if [ ! -e "$1" ]; then
    log "missing: $1"
    exit 1
  fi
}

adb_cmd() {
  "$ADB" -s "$DEVICE" "$@"
}

wait_boot() {
  for _ in $(seq 1 120); do
    local state
    state="$(adb_cmd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [ "$state" = "1" ]; then
      adb_cmd shell input keyevent 82 >/dev/null 2>&1 || true
      adb_cmd shell settings put system screen_off_timeout 2147483647 >/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
  done
  log "emulator boot timeout"
  "$ADB" devices -l || true
  exit 1
}

ensure_emulator() {
  require_file "$ADB"
  require_file "$EMULATOR"
  local connected
  connected="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  local unexpected
  unexpected="$(printf '%s\n' "$connected" | awk -v expected="$DEVICE" 'NF && $1 != expected { print $1 }')"
  if [ -n "$unexpected" ]; then
    log "unexpected adb device(s); disconnect phones before emulator-only validation:"
    printf '%s\n' "$unexpected"
    exit 1
  fi
  if "$ADB" devices | awk 'NR > 1 { print $1 }' | grep -qx "$DEVICE"; then
    log "emulator already connected: $DEVICE"
    wait_boot
    return 0
  fi

  log "starting emulator: $AVD_NAME"
  nohup "$EMULATOR" "@$AVD_NAME" \
    -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -accel on -cores 4 -memory 3072 -no-snapshot-save \
    >"$OUT_DIR/emulator.log" 2>&1 &
  wait_boot
}

dump_ui() {
  local name="$1"
  adb_cmd shell uiautomator dump /sdcard/window.xml >/dev/null
  adb_cmd exec-out cat /sdcard/window.xml >"$OUT_DIR/$name.xml"
  perl -pe 's/></>\n</g' "$OUT_DIR/$name.xml" >"$OUT_DIR/$name.pretty.xml"
}

screenshot() {
  local name="$1"
  adb_cmd exec-out screencap -p >"$OUT_DIR/$name.png"
}

assert_ui() {
  local name="$1"
  local pattern="$2"
  if ! rg -q "$pattern" "$OUT_DIR/$name.pretty.xml"; then
    log "assertion failed in $name: $pattern"
    tail -80 "$OUT_DIR/$name.pretty.xml" || true
    exit 1
  fi
  log "assert ok: $pattern"
}

tap_node() {
  local name="$1"
  local needle="$2"
  local xy
  xy="$(python3 - "$OUT_DIR/$name.xml" "$needle" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

xml_path, needle = sys.argv[1], sys.argv[2]
root = ET.parse(xml_path).getroot()

def bounds_center(bounds: str):
    nums = list(map(int, re.findall(r"\d+", bounds)))
    if len(nums) != 4:
        return None
    x1, y1, x2, y2 = nums
    return (x1 + x2) // 2, (y1 + y2) // 2

best = None
for node in root.iter("node"):
    text = node.attrib.get("text", "")
    desc = node.attrib.get("content-desc", "")
    if needle in text or needle in desc:
        center = bounds_center(node.attrib.get("bounds", ""))
        if center:
            clickable = node.attrib.get("clickable") == "true"
            score = 0
            if text == needle or desc == needle:
                score += 1000
            if desc.endswith(needle) or f", {needle}" in desc:
                score += 800
            if text.startswith(needle) or desc.startswith(needle):
                score += 200
            if clickable:
                score += 100
            # Bottom navigation labels can also appear in search placeholders.
            # Prefer lower clickable controls when several nodes contain the same text.
            score += center[1] / 10000
            candidate = (score, center[0], center[1])
            if best is None or candidate > best:
                best = candidate
if best:
    _, x, y = best
    print(x, y)
    sys.exit(0)
sys.exit(2)
PY
)"
  adb_cmd shell input tap $xy
  log "tap '$needle' at $xy"
}

type_ascii() {
  local value="$1"
  local escaped
  escaped="${value// /%s}"
  adb_cmd shell input text "$escaped"
  log "typed ascii: $value"
}

tap_xy() {
  local x="$1"
  local y="$2"
  adb_cmd shell input tap "$x" "$y"
  log "tap at $x $y"
}

launch_app() {
  adb_cmd shell am force-stop com.laoji.app >/dev/null 2>&1 || true
  adb_cmd shell monkey -p com.laoji.app -c android.intent.category.LAUNCHER 1 >/dev/null
  sleep 2
}

run_login_route() {
  dump_ui login
  screenshot login
  assert_ui login 'text="老记"'
  assert_ui login 'text="游客体验"'

  tap_node login '登录'
  sleep 1
  dump_ui login_empty_dialog
  screenshot login_empty_dialog
  assert_ui login_empty_dialog 'text="提示"'
  assert_ui login_empty_dialog 'text="请输入邮箱或手机号"'
  tap_node login_empty_dialog '知道了'
  sleep 0.5
  dump_ui login_after_empty

  tap_node login_after_empty '忘记密码?'
  sleep 1
  dump_ui forgot_empty_dialog
  screenshot forgot_empty_dialog
  assert_ui forgot_empty_dialog 'text="填写账号后重试"'
  assert_ui forgot_empty_dialog 'text="请先输入邮箱或手机号，再提交人工重置请求。"'
  tap_node forgot_empty_dialog '知道了'
  sleep 0.5

  dump_ui login_after_forgot
  # The legal links are nested Text spans; use stable Pixel 6 coordinates
  # inside the rendered terms line to verify both documents.
  tap_xy 524 2140
  sleep 1
  dump_ui terms
  screenshot terms
  assert_ui terms 'text="用户协议"'
  assert_ui terms 'text="服务范围"'
  adb_cmd shell input keyevent 4
  sleep 0.7

  dump_ui login_after_terms
  tap_xy 760 2140
  sleep 1
  dump_ui privacy_policy
  screenshot privacy_policy
  assert_ui privacy_policy 'text="隐私政策"'
  assert_ui privacy_policy 'text="我们处理的数据"'
  adb_cmd shell input keyevent 4
  sleep 0.7
}

run_main_route() {
  dump_ui before_guest
  if rg -q 'content-desc="游客体验"|text="游客体验"' "$OUT_DIR/before_guest.pretty.xml"; then
    tap_node before_guest "游客体验"
    sleep 2
  fi

  dump_ui schedule
  screenshot schedule
  assert_ui schedule 'text="日程"'
  assert_ui schedule 'text="今日待办"'
  local today_text
  today_text="$(today_label)"
  assert_ui schedule "text=\"$today_text\""

  local target_day
  local relative_text
  target_day="$(target_calendar_day)"
  relative_text="$(relative_label_for_day "$target_day")"
  tap_node schedule "$target_day"
  sleep 1
  dump_ui selected_17
  screenshot selected_17
  assert_ui selected_17 'text="当日待办"'
  if [ "$relative_text" != "今天" ]; then
    assert_ui selected_17 "text=\"$relative_text\""
  fi
  assert_ui selected_17 'text="当日暂无待办"'

  tap_node selected_17 '会议'
  sleep 2
  dump_ui meetings
  screenshot meetings
  assert_ui meetings 'text="会议记录"'

  tap_node meetings '日程'
  sleep 1
  dump_ui schedule_back
  screenshot schedule_back
  assert_ui schedule_back 'text="日程"'

  tap_xy 990 211
  sleep 1
  dump_ui profile
  screenshot profile
  assert_ui profile 'text="我"'
  assert_ui profile 'text="本地体验账号"'
  assert_ui profile 'text="编辑资料"'

  tap_node profile '编辑资料'
  sleep 1
  dump_ui account
  screenshot account
  assert_ui account 'text="账号与资料"'
  assert_ui account 'text="头像"'
  assert_ui account 'text="选择图片"'
  assert_ui account 'text="通知与提醒"'

  tap_node account '通知与提醒'
  sleep 1
  dump_ui notification_sheet
  screenshot notification_sheet
  assert_ui notification_sheet 'text="通知与提醒"'
  assert_ui notification_sheet 'text="默认提醒"'
  assert_ui notification_sheet 'text="检查并开启通知"'
  tap_node notification_sheet '关闭'
  sleep 0.5

  dump_ui account_after_notification
  tap_node account_after_notification '密码与安全'
  sleep 1
  dump_ui guest_password_dialog
  screenshot guest_password_dialog
  assert_ui guest_password_dialog 'text="密码与安全"'
  assert_ui guest_password_dialog 'text="访客模式没有云端账号密码。"'
  tap_node guest_password_dialog '知道了'
  sleep 0.5

  dump_ui account_after_password
  tap_node account_after_password '退出访客模式'
  sleep 1
  dump_ui signout_dialog
  screenshot signout_dialog
  assert_ui signout_dialog 'text="退出访客模式"'
  assert_ui signout_dialog 'text="确认返回登录页？"'
  tap_node signout_dialog '取消'
  sleep 0.5

  adb_cmd shell input keyevent 4
  sleep 0.7
  dump_ui profile_back
  adb_cmd shell input keyevent 4
  sleep 0.7
  dump_ui schedule_after_profile
  assert_ui schedule_after_profile 'text="日程"'

  tap_xy 540 2098
  sleep 1
  dump_ui voice_modal
  screenshot voice_modal
  assert_ui voice_modal 'text="老记，说出你的日程"'
  assert_ui voice_modal 'text="输入或说出日程内容.*"'

  tap_node voice_modal '输入或说出日程内容'
  type_ascii 'meeting tomorrow at 3pm'
  sleep 1
  dump_ui voice_text
  screenshot voice_text
  assert_ui voice_text 'text="解析"'
}

main() {
  require_file "$APK"
  ensure_emulator

  log "installing APK: $APK"
  adb_cmd install -r "$APK" >/dev/null
  if [ "$RESET_APP_DATA" = "1" ]; then
    adb_cmd shell pm clear com.laoji.app >/dev/null
    log "cleared app data for clean validation"
  fi
  launch_app
  dump_ui launch
  screenshot launch
  run_login_route
  run_main_route

  log "smoke completed; artifacts: $OUT_DIR"
}

main "$@"
