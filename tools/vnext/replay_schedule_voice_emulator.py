#!/usr/bin/env python3
"""Run repeatable real-audio schedule voice replays on the LaoJi emulator."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

from inject_emulator_audio import EmulatorMicrophoneInjector, _load_stubs


AUDIT_RE = re.compile(r"\[laoji-audit\] (schedule_voice_[a-z_]+) (\{.*\})")
BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
CLICKABLE_CACHE: dict[tuple[str, str], tuple[int, int]] = {}
CACHEABLE_LABELS = frozenset({
    "新建日程",
    "语音输入",
    "开始语音输入",
    "停止语音输入",
    "日程",
})


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
        nodes = [dict(node.attrib) for node in ET.parse(local).getroot().iter("node")]
        for node in nodes:
            if node.get("clickable") != "true":
                continue
            match = BOUNDS_RE.fullmatch(node.get("bounds", ""))
            if match is None:
                continue
            left, top, right, bottom = map(int, match.groups())
            point = ((left + right) // 2, (top + bottom) // 2)
            for label in {node.get("text", ""), node.get("content-desc", "")} - {""}:
                # Labels such as "取消" and "保存" appear on multiple native
                # surfaces.  Reusing their coordinates after navigation can
                # turn a cleanup action into an edit or a real save.  Cache
                # only controls whose ownership and position are invariant
                # throughout this replay.
                if label in CACHEABLE_LABELS:
                    CLICKABLE_CACHE[(serial, label)] = point
        return nodes


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
    cached = CLICKABLE_CACHE.get((serial, label))
    if cached is not None:
        _adb(serial, "shell", "input", "tap", str(cached[0]), str(cached[1]))
        return
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


def _wait_audit_terminal(serial: str, start_index: int, timeout: float) -> str:
    """Wait for the product's terminal audit instead of exporting the UI tree."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = _audit_events(serial)[start_index:]
        names = {str(event.get("event")) for event in events}
        if "schedule_voice_draft_ready" in names:
            return "确认日程"
        if "schedule_voice_draft_failed" in names:
            return "failure"
        time.sleep(0.15)
    raise RuntimeError("schedule voice did not reach an audited terminal state")


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
        close = _find_clickable(serial, "关闭新建日程")
        if close is not None:
            _adb(serial, "shell", "input", "tap", str(close[0]), str(close[1]))
        elif (cancel := _find_clickable(serial, "取消")) is not None:
            _adb(serial, "shell", "input", "tap", str(cancel[0]), str(cancel[1]))
        elif _find_clickable(serial, "新建日程") is not None:
            return
        elif (schedule := _find_clickable(serial, "日程")) is not None:
            _adb(serial, "shell", "input", "tap", str(schedule[0]), str(schedule[1]))
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
    sdk_root = Path(
        os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or "~/Android/Sdk",
    ).expanduser()
    stubs = _load_stubs(sdk_root)
    runs: list[dict[str, object]] = []
    injector = None
    try:
        injector = EmulatorMicrophoneInjector(args.endpoint, stubs)
        for ordinal in range(1, args.runs + 1):
            _tap(args.serial, "新建日程")
            if ordinal == 1:
                _wait_visible(args.serial, ("语音输入",), 8)
            else:
                time.sleep(0.35)
            _tap(args.serial, "语音输入")
            if ordinal == 1:
                _wait_visible(args.serial, ("开始语音输入",), 8)
            else:
                time.sleep(0.35)
            injector.prepare()
            before = len(_audit_events(args.serial))
            _tap(args.serial, "开始语音输入")
            # UIAutomator dumps take multiple seconds on this emulator and
            # would delay the synthetic speaker after capture has begun.
            # Native capture starts well below 100 ms; a short fixed guard
            # models a person beginning to speak immediately after the tap.
            time.sleep(0.15)
            injector.inject(
                args.wav,
                # A persistent gRPC stream may accept several seconds of PCM
                # into transport buffers after its first job.  Pace every WAV
                # explicitly so Stop cannot race audio that the emulator has
                # accepted but not yet delivered to AudioRecord.
                realtime=True,
            )
            time.sleep(0.4)
            _tap(args.serial, "停止语音输入")
            terminal = _wait_audit_terminal(args.serial, before, 20)
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
            if terminal == "确认日程":
                if ordinal == 1:
                    _wait_visible(args.serial, ("保存",), 8)
                # Close the activity-owned voice overlay directly.  Do not
                # enter AddEvent or press a generic Cancel button: both make
                # the performance harness capable of mutating calendar data.
                _tap(args.serial, "关闭新建日程")
            else:
                _tap(args.serial, "关闭新建日程")
            if ordinal == 1:
                _wait_visible(args.serial, ("新建日程",), 8)
            else:
                time.sleep(0.35)
    finally:
        if injector is not None:
            injector.close()
        stubs[3].cleanup()

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
