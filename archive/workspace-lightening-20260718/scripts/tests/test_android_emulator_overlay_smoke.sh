#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/android-emulator-overlay-smoke.sh"

bash -n "$SCRIPT"

capture_line="$(rg -n 'assert_nonblank_frame event-toast-visible' "$SCRIPT" | cut -d: -f1)"
dump_line="$(rg -n '^dump_ui event-toast$' "$SCRIPT" | cut -d: -f1)"
[ -n "$capture_line" ] && [ -n "$dump_line" ] && [ "$capture_line" -lt "$dump_line" ] || {
  printf 'toast frame must be captured before the slower UIAutomator dump\n' >&2
  exit 1
}

rg -q 'assert_single_overlay NativeToastHostView event-toast-before-background' "$SCRIPT"
rg -q 'assert_single_overlay NativeToastHostView event-toast-visible' "$SCRIPT"
rg -q 'assert_single_overlay NativeToastHostView event-toast-ime-visible' "$SCRIPT"
rg -q 'assert_label_attribute .*"添加主题" focused true' "$SCRIPT"
if rg -q 'assert_single_overlay NativeToastHostView event-toast-card-tap$' "$SCRIPT"; then
  printf 'card-tap assertion still depends on the expired toast lifetime\n' >&2
  exit 1
fi
printf 'android overlay physical-device timing contracts: ok\n'
