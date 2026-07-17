#!/usr/bin/env bash
set -euo pipefail

# UI-ROUTES-001 / UI-ANDROID-DEVICE-ACCEPTANCE-001: authenticated route
# closure using a disposable server account and meeting owned only by that account.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTE_LIBRARY="$ROOT_DIR/scripts/android-emulator-route-smoke.sh"
FIXTURE_HELPER="$ROOT_DIR/scripts/device_route_fixture.js"
DEVICE="${DEVICE:-emulator-5554}"
APK="${APK:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
OUT_DIR="${OUT_DIR:-/tmp/laoji-account-route-smoke-$(date '+%Y%m%d-%H%M%S')-$$}"
FIXTURE_FILE="${FIXTURE_FILE:-$OUT_DIR/device-route-fixture.json}"
CREATE_FIXTURE="${CREATE_FIXTURE:-1}"
KEEP_FIXTURE="${KEEP_FIXTURE:-0}"
INSTALL_APK="${INSTALL_APK:-1}"
RESET_APP_DATA=1
ALLOW_ADDITIONAL_DEVICES="${ALLOW_ADDITIONAL_DEVICES:-0}"
ALLOW_PHYSICAL_DEVICE="${ALLOW_PHYSICAL_DEVICE:-0}"
RUN_COMPOSITION_SMOKE=0

mkdir -p "$OUT_DIR/checkpoints"

export ROUTE_SMOKE_LIBRARY_ONLY=1
# shellcheck source=android-emulator-route-smoke.sh
source "$ROUTE_LIBRARY"

fixture_cleaned=0

fixture_value() {
  node -e '
    const fs = require("fs");
    const [file, key] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"))[key];
    if (typeof value !== "string" || !value) process.exit(2);
    process.stdout.write(value);
  ' "$FIXTURE_FILE" "$1"
}

cleanup_fixture() {
  if [ "$fixture_cleaned" = "1" ] || [ ! -f "$FIXTURE_FILE" ] || [ "$KEEP_FIXTURE" = "1" ]; then
    return 0
  fi
  if node "$FIXTURE_HELPER" cleanup --input "$FIXTURE_FILE" >"$OUT_DIR/fixture-cleanup.json" 2>"$OUT_DIR/fixture-cleanup.err"; then
    fixture_cleaned=1
    log "deleted disposable account route fixture"
    return 0
  fi
  log "fixture cleanup failed; credentials remain protected at $FIXTURE_FILE"
  return 1
}

on_exit() {
  local status=$?
  adb_cmd shell rm -f "$REMOTE_XML" >/dev/null 2>&1 || true
  if [ "$status" != "0" ]; then
    cleanup_fixture || true
  fi
  return "$status"
}

trap on_exit EXIT

dismiss_primer_to_login() {
  local surface
  surface="$(wait_for_any_node "游客体验" "暂不开启" 20)" || fail "login surface did not appear"
  if [ "$surface" = "暂不开启" ]; then
    checkpoint account-notification-primer
    assert_absent_node "$LAST_XML" exact "游客体验"
    tap_unique_node "$LAST_XML" exact "暂不开启"
    wait_for_node exact "游客体验" 12
  fi
  checkpoint account-login
  assert_unique_node "$LAST_XML" exact "账号"
  assert_unique_node "$LAST_XML" exact "同意用户协议和隐私政策"
}

login_fixture_account() {
  local account="$1"
  local password="$2"
  tap_unique_node "$LAST_XML" exact "同意用户协议和隐私政策"
  input_text_unique_node "$LAST_XML" exact "账号" "$account"
  wait_for_node exact "下一步" 5
  checkpoint account-login-filled
  assert_node_attribute "$LAST_XML" exact "同意用户协议和隐私政策" checked true
  tap_unique_node "$LAST_XML" exact "下一步"
  wait_for_node exact "密码" 12
  checkpoint account-password
  input_text_unique_node "$LAST_XML" exact "密码" "$password"
  wait_for_node exact "登录" 5
  checkpoint account-password-filled
  tap_unique_node "$LAST_XML" exact "登录"
  wait_for_node exact "日程，当前页面" 30
  checkpoint account-schedule
  assert_absent_node "$LAST_XML" exact "游客体验"
}

open_authenticated_meeting_routes() {
  local meeting_title="$1"
  tap_unique_node "$LAST_XML" exact "会议"
  wait_for_node exact "$meeting_title" 30
  checkpoint account-meetings
  assert_unique_node "$LAST_XML" exact "会议，当前页面"
  assert_unique_node "$LAST_XML" exact "$meeting_title"

  tap_unique_node "$LAST_XML" exact "$meeting_title"
  wait_for_node exact "编辑会议标题" 20
  checkpoint account-transcription
  assert_unique_node "$LAST_XML" exact "文字记录"
  assert_unique_node "$LAST_XML" exact "纪要"
  assert_unique_node "$LAST_XML" exact "发言人"
  assert_unique_node "$LAST_XML" exact "分享会议资料"
  assert_absent_node "$LAST_XML" exact "会议，当前页面"
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "会议，当前页面" 12

  checkpoint account-meetings-after-detail
  tap_unique_node "$LAST_XML" exact "更多会议操作"
  wait_for_node exact "管理讲话人" 8
  checkpoint account-meetings-menu
  tap_unique_node "$LAST_XML" exact "管理讲话人"
  wait_for_node exact "新建讲话人" 20
  checkpoint account-speaker-manager
  assert_absent_node "$LAST_XML" exact "登录账号"

  tap_unique_node "$LAST_XML" exact "新建讲话人"
  wait_for_node exact "声纹采集" 12
  checkpoint account-speaker-enrollment
  assert_unique_node "$LAST_XML" exact "输入人名"
  assert_unique_node "$LAST_XML" exact "开始录制"
  assert_unique_node "$LAST_XML" contains "同意将本次录音上传"
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "新建讲话人" 12
  checkpoint account-speaker-manager-return
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "会议，当前页面" 12
}

open_authenticated_account_routes() {
  checkpoint account-meetings-before-profile
  tap_unique_node "$LAST_XML" exact "日程"
  wait_for_node exact "日程，当前页面" 12
  checkpoint account-schedule-before-profile
  tap_unique_node "$LAST_XML" exact "个人资料"
  wait_for_node exact "打开设置" 12
  checkpoint authenticated-profile
  assert_absent_node "$LAST_XML" exact "未登录账号"

  tap_unique_node "$LAST_XML" exact "打开设置"
  wait_for_node exact "账号与安全" 12
  checkpoint authenticated-settings
  tap_unique_node "$LAST_XML" exact "账号与安全"
  wait_for_node exact "删除账号与云端数据" 12
  checkpoint authenticated-account
  assert_unique_node "$LAST_XML" exact "退出登录"

  tap_unique_node "$LAST_XML" exact "密码与安全"
  wait_for_node exact "修改密码" 12
  checkpoint account-change-password
  assert_unique_node "$LAST_XML" exact "当前密码"
  assert_unique_node "$LAST_XML" exact "新密码"
  assert_unique_node "$LAST_XML" exact "确认新密码"
  assert_unique_node "$LAST_XML" exact "保存"
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "删除账号与云端数据" 12

  checkpoint authenticated-account-return
  tap_unique_node "$LAST_XML" exact "删除账号与云端数据"
  wait_for_node exact "删除后无法恢复" 12
  checkpoint account-deletion
  assert_unique_node "$LAST_XML" exact "当前密码"
  assert_unique_node "$LAST_XML" exact "删除账号确认文字"
  assert_unique_node "$LAST_XML" exact "永久删除账号"
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "删除账号与云端数据" 12

  checkpoint authenticated-account-final
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "账号与安全" 12
  checkpoint authenticated-settings-return
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "打开设置" 12
  checkpoint authenticated-profile-return
  tap_unique_node "$LAST_XML" exact "返回"
  wait_for_node exact "日程，当前页面" 12
  checkpoint authenticated-schedule-final
}

main() {
  validate_boolean CREATE_FIXTURE "$CREATE_FIXTURE"
  validate_boolean KEEP_FIXTURE "$KEEP_FIXTURE"
  validate_boolean INSTALL_APK "$INSTALL_APK"
  validate_boolean ALLOW_ADDITIONAL_DEVICES "$ALLOW_ADDITIONAL_DEVICES"
  validate_boolean ALLOW_PHYSICAL_DEVICE "$ALLOW_PHYSICAL_DEVICE"
  require_file "$APK"
  require_file "$FIXTURE_HELPER"
  assert_apk_fresh "$APK" "$ROOT_DIR" || fail "rebuild the release APK before account route smoke"
  ensure_target_device

  if [ "$CREATE_FIXTURE" = "1" ]; then
    node "$FIXTURE_HELPER" create --output "$FIXTURE_FILE" >"$OUT_DIR/fixture-create.json"
  else
    require_file "$FIXTURE_FILE"
  fi
  [ "$(stat -c '%a' "$FIXTURE_FILE")" = "600" ] || fail "fixture file permissions must be 600"
  local account password meeting_title
  account="$(fixture_value account)"
  password="$(fixture_value password)"
  meeting_title="$(fixture_value meetingTitle)"

  record_and_verify_apk
  adb_cmd shell pm clear "$PACKAGE_NAME" >"$OUT_DIR/pm-clear.log"
  adb_cmd logcat -c
  adb_cmd shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  dismiss_stale_input_method
  launch_initial_main_activity account-initial
  dismiss_primer_to_login
  login_fixture_account "$account" "$password"
  open_authenticated_meeting_routes "$meeting_title"
  open_authenticated_account_routes
  scan_current_logcat account-routes
  verify_final_artifact_identity

  cleanup_fixture || fail "disposable server fixture could not be deleted"
  adb_cmd shell pm clear "$PACKAGE_NAME" >"$OUT_DIR/pm-clear-final.log"
  adb_cmd shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  log "authenticated route smoke passed; artifacts: $OUT_DIR"
}

main "$@"
