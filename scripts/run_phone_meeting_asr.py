#!/usr/bin/env python3
"""Run short acoustic realtime-meeting acceptance cases on a USB Android phone."""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

from run_phone_acoustic_asr import (
    PACKAGE,
    adb,
    dump_ui,
    ensure_ready,
    expected_text,
    find_node,
    normalize,
    play_file,
    score,
    tap_node,
    wait_for,
)


DEFAULT_CASES = {"AC001", "AC002", "AC013", "AC014", "AC016"}


def transcript_lines(root: Any) -> list[str]:
    lines: list[str] = []
    for node in root.iter("node"):
        resource_id = str(node.attrib.get("resource-id") or "")
        if "meeting-live-transcript-line" not in resource_id:
            continue
        value = str(node.attrib.get("text") or node.attrib.get("content-desc") or "").strip()
        if value:
            lines.append(value)
    if lines:
        return lines

    # Some Android builds expose React Native text without testID resource IDs.
    ignored = re.compile(r"^(实时会议|会议标题|实时转写|音频输入|实时转写中|\d+ 句)$")
    for node in root.iter("node"):
        value = str(node.attrib.get("text") or "").strip()
        if value and not ignored.match(value) and node.attrib.get("class") == "android.widget.TextView":
            if len(normalize(value)) >= 4:
                lines.append(value)
    return lines


def start_meeting_recording(serial: str) -> None:
    adb(serial, "shell", "am", "force-stop", PACKAGE)
    adb(serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1")
    _, meetings_tab = wait_for(serial, lambda ui: find_node(ui, test_id="bottom-tab-meetings"), 15)
    tap_node(serial, meetings_tab)
    _, meeting_mic = wait_for(serial, lambda ui: find_node(ui, test_id="bottom-microphone-meeting"), 10)
    tap_node(serial, meeting_mic)
    wait_for(serial, lambda ui: find_node(ui, test_id="meeting-live-title"), 10)
    _, start_mic = wait_for(serial, lambda ui: find_node(ui, test_id="bottom-microphone-meeting"), 8)
    tap_node(serial, start_mic)
    wait_for(
        serial,
        lambda ui: find_node(ui, test_id="meeting-live-status", text="实时转写中")
        or find_node(ui, text="实时转写中"),
        25,
    )


def run_case(serial: str, case: dict[str, Any], gap_ms: int, threshold: float) -> dict[str, Any]:
    started = time.perf_counter()
    actual = ""
    recording_saved = False
    try:
        start_meeting_recording(serial)
        for index, value in enumerate(case["parts"]):
            play_file(Path(value), float(case.get("volume_db", 0)))
            if index + 1 < len(case["parts"]):
                time.sleep(gap_ms / 1000)
        time.sleep(2.5)
        root = dump_ui(serial)
        actual_lines = transcript_lines(root)
        actual = "\n".join(actual_lines)
        expected = expected_text(case)
        similarity = round(score(expected, actual), 4)
        segment_matches = [normalize(segment) in normalize(actual) for segment in case.get("expected_segments", [])]

        _, stop_mic = wait_for(serial, lambda ui: find_node(ui, test_id="bottom-microphone-recording"), 5)
        tap_node(serial, stop_mic)
        _, audio_node = wait_for(serial, lambda ui: find_node(ui, test_id="meeting-audio-open"), 35)
        recording_saved = "打开会议录音" in str(audio_node.attrib.get("content-desc") or "")
        passed = similarity >= threshold and all(segment_matches) and recording_saved
        return {
            "id": case["id"],
            "group": case["group"],
            "expected": expected,
            "actual": actual,
            "score": similarity,
            "segment_matches": segment_matches,
            "recording_saved": recording_saved,
            "passed": passed,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - preserve acceptance evidence.
        return {
            "id": case["id"],
            "group": case["group"],
            "expected": expected_text(case),
            "actual": actual,
            "score": 0,
            "segment_matches": [],
            "recording_saved": recording_saved,
            "passed": False,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "error": repr(exc),
        }
    finally:
        adb(serial, "shell", "am", "force-stop", PACKAGE, check=False)
        time.sleep(0.5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--manifest", type=Path, default=Path("test-assets/phone-acoustic-asr/manifest.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--threshold", type=float, default=0.82)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    selected = set(args.case_ids) if args.case_ids else DEFAULT_CASES
    cases = [case for case in manifest["cases"] if case["id"] in selected]
    missing = [value for case in cases for value in case["parts"] if not Path(value).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing acoustic assets: {missing}")
    ensure_ready(args.serial)
    if args.dry_run:
        print(json.dumps({"serial": args.serial, "cases": len(cases), "assets_ok": True}, ensure_ascii=False))
        return 0

    rows = []
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']} {case['group']}", flush=True)
        row = run_case(
            args.serial,
            case,
            int(manifest.get("minimum_gap_ms_between_parts", 1400)),
            args.threshold,
        )
        print(json.dumps(row, ensure_ascii=False), flush=True)
        rows.append(row)

    report = {
        "serial": args.serial,
        "manifest": str(args.manifest),
        "total": len(rows),
        "passed": sum(row["passed"] for row in rows),
        "threshold": args.threshold,
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"total": report["total"], "passed": report["passed"]}, ensure_ascii=False))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
