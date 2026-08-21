#!/usr/bin/env python3
"""Run repeatable real-audio schedule voice replays on the LaoJi emulator."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET


AUDIT_RE = re.compile(r"\[laoji-audit\] (schedule_voice_[a-z_]+) (\{.*\})")
BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


def _adb(serial: str, *args: str, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["adb", "-s", serial, *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _nodes(serial: str) -> list[dict[str, str]]:
    remote = "/sdcard/laoji-vnext-voice-replay.xml"
    with tempfile.TemporaryDirectory(prefix="laoji-voice-ui-") as directory:
        local = Path(directory) / "window.xml"
        _adb(serial, "shell", "uiautomator", "dump", remote)
        _adb(serial, "pull", remote, str(local))
        return [dict(node.attrib) for node in ET.parse(local).getroot().iter("node")]


def _find_clickable(serial: str, label: str) -> tuple[int, int] | None:
    for node in _nodes(serial):
        if node.get("clickable") != "true":
            continue
        if label not in {node.get("text", ""), node.get("content-desc", "")}:
            continue
        match = BOUNDS_RE.fullmatch(node.get("bounds", ""))
        if match:
            left, top, right, bottom = map(int, match.groups())
            return (left + right) // 2, (top + bottom) // 2
    return None


def _tap(serial: str, label: str, *, retries: int = 6) -> None:
    for _ in range(retries):
        point = _find_clickable(serial, label)
        if point is not None:
            _adb(serial, "shell", "input", "tap", str(point[0]), str(point[1]))
            return
        time.sleep(0.5)
    raise RuntimeError(f"clickable UI label not found: {label}")


def _visible(serial: str, label: str) -> bool:
    return any(
        label in {node.get("text", ""), node.get("content-desc", "")}
        for node in _nodes(serial)
    )


def _wait_visible(serial: str, labels: tuple[str, ...], timeout: float) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        nodes = _nodes(serial)
        for label in labels:
            if any(label in {node.get("text", ""), node.get("content-desc", "")} for node in nodes):
                return label
        time.sleep(0.35)
    raise RuntimeError(f"UI did not reach one of {labels!r}")


def _wait_parse_terminal(serial: str, timeout: float) -> str:
    """Wait for either a Draft or a user-visible parse outcome.

    Performance replays may intentionally use non-schedule speech.  Such a run
    must still preserve capture/first-text evidence instead of crashing the
    harness merely because validation correctly rejected the content.
    """
    labels = (
        "确认日程",
        "重新输入",
        "这段内容不是日程安排",
        "日程解析不可用",
        "没有识别到日程内容",
        "未识别到日程，请重试。",
    )
    return _wait_visible(serial, labels, timeout)


def _calendar(serial: str) -> None:
    _adb(
        serial,
        "shell",
        "monkey",
        "-p",
        "com.laoji.app",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
    )
    time.sleep(2)
    for _ in range(8):
        if _find_clickable(serial, "新建日程") is not None:
            return
        close = _find_clickable(serial, "关闭新建日程")
        if close is not None:
            _adb(serial, "shell", "input", "tap", str(close[0]), str(close[1]))
        else:
            _adb(serial, "shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.8)
    raise RuntimeError("calendar surface unavailable")


def _audit_events(serial: str) -> list[dict[str, object]]:
    output = _adb(serial, "logcat", "-d", "-v", "brief", timeout=60).stdout
    events = []
    for line in output.splitlines():
        match = AUDIT_RE.search(line)
        if not match:
            continue
        events.append({"event": match.group(1), **json.loads(match.group(2))})
    return events


def _percentile(values: list[int], quantile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("--serial", default="emulator-5562")
    parser.add_argument("--endpoint", default="127.0.0.1:8554")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be positive")

    _adb(args.serial, "get-state")
    _adb(args.serial, "logcat", "-c")
    _calendar(args.serial)
    runs: list[dict[str, object]] = []
    for ordinal in range(1, args.runs + 1):
        _tap(args.serial, "新建日程")
        _wait_visible(args.serial, ("语音输入",), 8)
        _tap(args.serial, "语音输入")
        _wait_visible(args.serial, ("开始语音输入",), 8)
        before = len(_audit_events(args.serial))
        _tap(args.serial, "开始语音输入")
        _wait_visible(args.serial, ("停止语音输入",), 8)
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("inject_emulator_audio.py")),
                "--endpoint",
                args.endpoint,
                str(args.wav),
            ],
            check=True,
            timeout=60,
        )
        time.sleep(3)
        _tap(args.serial, "停止语音输入")
        terminal = _wait_parse_terminal(args.serial, 20)
        new_events = _audit_events(args.serial)[before:]
        by_name = {str(event["event"]): event for event in new_events}
        runs.append({
            "run": ordinal,
            "terminal": "draft" if terminal == "确认日程" else "failure",
            "capture_start_ms": by_name.get("schedule_voice_capture_started", {}).get("latency_ms"),
            "first_text_ms": by_name.get("schedule_voice_first_text", {}).get("latency_ms"),
            "draft_ms": by_name.get("schedule_voice_draft_ready", {}).get("latency_ms"),
            "failure_ms": by_name.get("schedule_voice_draft_failed", {}).get("latency_ms"),
        })
        _tap(args.serial, "关闭新建日程")
        _wait_visible(args.serial, ("新建日程",), 8)

    capture = [int(row["capture_start_ms"]) for row in runs if isinstance(row["capture_start_ms"], int)]
    first = [int(row["first_text_ms"]) for row in runs if isinstance(row["first_text_ms"], int)]
    draft = [int(row["draft_ms"]) for row in runs if isinstance(row["draft_ms"], int)]
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "device": args.serial,
        "source_file": args.wav.name,
        "sample_reused": True,
        "runs": runs,
        "metrics": {
            "run_count": len(runs),
            "draft_success_count": sum(row["terminal"] == "draft" for row in runs),
            "capture_start_p50_ms": _percentile(capture, 0.50),
            "capture_start_p95_ms": _percentile(capture, 0.95),
            "first_text_p50_ms": _percentile(first, 0.50),
            "first_text_p95_ms": _percentile(first, 0.95),
            "draft_p50_ms": _percentile(draft, 0.50),
            "draft_p95_ms": _percentile(draft, 0.95),
        },
        "thresholds": {
            "capture_start_p95_ms": 100,
            "first_text_p95_ms": 1_500,
            "draft_p95_ms": 3_000,
        },
    }
    metrics = report["metrics"]
    report["passed"] = bool(
        metrics["draft_success_count"] == args.runs
        and metrics["capture_start_p95_ms"] is not None
        and metrics["capture_start_p95_ms"] <= 100
        and metrics["first_text_p95_ms"] is not None
        and metrics["first_text_p95_ms"] <= 1_500
        and metrics["draft_p95_ms"] is not None
        and metrics["draft_p95_ms"] <= 3_000
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["metrics"], ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
