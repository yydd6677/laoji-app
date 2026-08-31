#!/usr/bin/env python3
"""Fail closed when the hardware-recording UI regresses its public contract."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle not in text:
        failures.append(f"missing:{label}")


def forbid(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle.lower() in text.lower():
        failures.append(f"forbidden:{label}")


def require_order(text: str, first: str, second: str, label: str, failures: list[str]) -> None:
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index < 0 or second_index < 0 or first_index >= second_index:
        failures.append(f"wrong-order:{label}")


def main() -> int:
    failures: list[str] = []
    meeting = read("src/screens/MeetingListScreen.android.tsx")
    meeting_live = read("src/screens/MeetingLiveScreen.android.tsx")
    settings = read("src/screens/PrivacyScreen.tsx")
    hardware = read("src/screens/HardwareDevicesScreen.tsx")
    messages = read("src/services/hardwareUserMessages.ts")

    require(meeting, "label: '手机录音'", "phone-recording-branch", failures)
    require(meeting, "fastLocalResult: true", "phone-recording-stable-shell", failures)
    require(meeting, "startRequested: true", "phone-recording-explicit-start", failures)
    require(meeting, "label: '外接设备'", "external-device-branch", failures)
    require(meeting, "navigation.navigate('HardwareDevices')", "hardware-navigation", failures)
    require(meeting, "title=\"录音\"", "recording-choice-title", failures)
    forbid(settings, "privacy-hardware-row", "settings-hardware-entry", failures)

    require(meeting_live, "startDeferredRealtimeMeetingNativeRecorder(", "phone-local-first-capture", failures)
    require(meeting_live, "attachDeviceV2RealtimeRecording({", "phone-async-realtime-attach", failures)
    require_order(
        meeting_live,
        "startDeferredRealtimeMeetingNativeRecorder(",
        "attachDeviceV2RealtimeRecording({",
        "microphone-before-remote-attach",
        failures,
    )
    require(meeting_live, "startLocalMeetingNativeRecorder(", "phone-local-capture-fallback", failures)
    require(meeting_live, "正在启动录音", "local-capture-preparing-copy", failures)
    require(meeting_live, "录音中，文字稍后生成", "local-capture-recording-copy", failures)
    require(meeting_live, "meeting_recording_local_commit_with_transcript_recovery", "local-save-stop-success", failures)
    forbid(
        meeting_live,
        "录音已保存在本机，但实时转写结束确认超时",
        "remote-final-drain-presented-as-recording-error",
        failures,
    )

    require(hardware, "hardwareUserMessage(reason)", "hardware-error-boundary", failures)
    require(hardware, 'testID="hardware-device-recordings"', "device-recording-list", failures)
    require(hardware, "receiveHardwareDeviceRecording(", "device-recording-receive", failures)
    require(hardware, "renameHardwareDeviceRecording(", "device-recording-rename", failures)
    require(hardware, "deleteHardwareDeviceRecording(", "device-recording-delete", failures)
    forbid(hardware, "startDeferredRealtimeMeeting", "hardware-to-phone-microphone-failover", failures)
    forbid(hardware, "startLocalMeetingNativeRecorder", "hardware-to-phone-local-recorder-failover", failures)
    forbid(hardware, "function publicMessage", "screen-local-raw-error-boundary", failures)
    forbid(hardware, "return message;", "raw-error-pass-through", failures)
    forbid(hardware, "用支持数据传输的 OTG 线", "otg-tutorial-copy", failures)
    forbid(hardware, "测试板当前通过 USB", "test-board-tutorial-copy", failures)
    forbid(hardware, "结束外接录音后", "completion-tutorial-copy", failures)
    require(messages, "code === 'bluetooth_disabled'", "bluetooth-disabled-code", failures)
    require(messages, "请先开启蓝牙。", "bluetooth-disabled-copy", failures)
    require(messages, "call to function", "bridge-wrapper-filter", failures)
    require(messages, "has been rejected", "bridge-rejection-filter", failures)

    visible_roots = [
        ROOT / "src/screens",
        ROOT / "src/components",
        ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes",
        ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/schedulevoice",
        ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui",
    ]
    forbidden_fragments = ("call to function", "has been rejected", "codedexception")
    for base in visible_roots:
        for path in base.rglob("*"):
            if path.suffix.lower() not in {".ts", ".tsx", ".kt"}:
                continue
            content = path.read_text(encoding="utf-8").lower()
            for fragment in forbidden_fragments:
                if fragment in content:
                    failures.append(f"visible-internal-copy:{path.relative_to(ROOT)}:{fragment}")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print("PASS hardware recording UI contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
