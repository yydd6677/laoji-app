#!/usr/bin/env python3
"""Verify calendar edit actions cannot be disabled by the runtime Context type."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VIEW = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages/CalendarEditPageView.kt"
SCREEN = ROOT / "src/screens/AddEventScreen.android.tsx"


def main() -> int:
    view = VIEW.read_text(encoding="utf-8")
    screen = SCREEN.read_text(encoding="utf-8")
    forbidden = "if (context !is ComponentActivity) onAction(payload)"
    required_view = (
        "private var bridgeEventsEnabled = true",
        "actionListener?.invoke(payload)",
        "if (bridgeEventsEnabled) onAction(payload)",
        'setLeftTextAction("取消", debounce = true) { emit("cancel") }',
    )
    required_screen = (
        "case 'cancel':",
        "requestLeave();",
        "case 'save':",
        "beginSave(action.draft);",
    )
    missing = [value for value in required_view if value not in view]
    missing += [value for value in required_screen if value not in screen]
    if forbidden in view or missing:
        raise SystemExit(
            f"calendar_edit_action_bridge=failed forbidden={forbidden in view} missing={missing}"
        )
    print("calendar_edit_action_bridge=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
