#!/usr/bin/env python3
"""Play reference speech near a USB Android phone and read realtime ASR text from LaoJi."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable


PACKAGE = "com.laoji.app"
INPUT_PLACEHOLDERS = {"输入或说出日程内容…", "输入或说出日程内容..."}


def run(command: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=check, capture_output=capture, text=True)


def adb(serial: str, *args: str, check: bool = True) -> str:
    result = run(["adb", "-s", serial, *args], check=check)
    return result.stdout


def dump_ui(serial: str) -> ET.Element:
    adb(serial, "shell", "uiautomator", "dump", "/sdcard/laoji-window.xml")
    raw = adb(serial, "exec-out", "cat", "/sdcard/laoji-window.xml")
    return ET.fromstring(raw)


def node_text(node: ET.Element) -> str:
    return str(node.attrib.get("text") or node.attrib.get("content-desc") or "")


def find_node(root: ET.Element, *, test_id: str | None = None, text: str | None = None) -> ET.Element | None:
    for node in root.iter("node"):
        resource_id = str(node.attrib.get("resource-id") or "")
        if test_id and (resource_id == test_id or resource_id.endswith(f":id/{test_id}") or test_id in resource_id):
            return node
        if text and (node.attrib.get("text") == text or node.attrib.get("content-desc") == text):
            return node
    return None


def first_node(*nodes: ET.Element | None) -> ET.Element | None:
    return next((node for node in nodes if node is not None), None)


def bounds_center(node: ET.Element) -> tuple[int, int]:
    values = [int(value) for value in re.findall(r"\d+", str(node.attrib.get("bounds") or ""))]
    if len(values) != 4:
        raise ValueError(f"node has invalid bounds: {node.attrib}")
    return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2


def tap_node(serial: str, node: ET.Element) -> None:
    x, y = bounds_center(node)
    adb(serial, "shell", "input", "tap", str(x), str(y))


def wait_for(serial: str, predicate: Callable[[ET.Element], Any], timeout: float) -> tuple[ET.Element, Any]:
    deadline = time.monotonic() + timeout
    last_root = None
    while time.monotonic() < deadline:
        try:
            last_root = dump_ui(serial)
            value = predicate(last_root)
            if value is not None and value is not False:
                return last_root, value
        except (ET.ParseError, subprocess.CalledProcessError):
            pass
        time.sleep(0.5)
    visible = [node_text(node) for node in (last_root.iter("node") if last_root is not None else []) if node_text(node)]
    raise TimeoutError(f"UI condition timed out; visible={visible[-20:]}")


def normalize(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", value).lower()


def edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for index, char in enumerate(left, 1):
        current = [index]
        for other_index, other in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[other_index] + 1,
                previous[other_index - 1] + (char != other),
            ))
        previous = current
    return previous[-1]


def score(expected: str, actual: str) -> float:
    left, right = normalize(expected), normalize(actual)
    if not left:
        return 1.0 if not right else 0.0
    return max(0.0, 1.0 - edit_distance(left, right) / max(len(left), len(right), 1))


def play_file(path: Path, volume_db: float) -> None:
    command = [
        "ffplay", "-nodisp", "-autoexit", "-loglevel", "error",
        "-af", f"volume={volume_db}dB", str(path),
    ]
    run(command, capture=False)


def expected_text(case: dict[str, Any]) -> str:
    if case.get("expected_segments"):
        return "\n".join(str(value) for value in case["expected_segments"])
    return str(case.get("expected") or "")


def extract_transcript(root: ET.Element) -> str:
    node = find_node(root, test_id="schedule-voice-input")
    if node is not None and node.attrib.get("text"):
        value = str(node.attrib["text"])
        return "" if value in INPUT_PLACEHOLDERS else value
    candidates = [
        str(item.attrib.get("text") or "")
        for item in root.iter("node")
        if item.attrib.get("class") == "android.widget.EditText"
    ]
    value = max(candidates, key=len, default="")
    return "" if value in INPUT_PLACEHOLDERS else value


def ensure_ready(serial: str) -> None:
    state = adb(serial, "get-state").strip()
    if state != "device":
        raise RuntimeError(f"ADB device is not ready: {state}")
    power = adb(serial, "shell", "dumpsys", "power")
    if "mWakefulness=Awake" not in power and "Wakefulness: Awake" not in power:
        raise RuntimeError("Phone screen is not awake; unlock it before acoustic acceptance")


def start_schedule_recording(serial: str) -> None:
    adb(serial, "shell", "am", "force-stop", PACKAGE)
    adb(serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1")
    root, mic = wait_for(
        serial,
        lambda ui: first_node(
            find_node(ui, test_id="bottom-microphone-schedule"),
            find_node(ui, text="说出日程"),
        ),
        15,
    )
    del root
    tap_node(serial, mic)
    root, start = wait_for(
        serial,
        lambda ui: find_node(ui, test_id="schedule-voice-start"),
        8,
    )
    del root
    tap_node(serial, start)
    wait_for(serial, lambda ui: find_node(ui, text="实时识别中，点击停止"), 20)


def run_case(serial: str, case: dict[str, Any], gap_ms: int, threshold: float) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        start_schedule_recording(serial)
        for index, value in enumerate(case["parts"]):
            play_file(Path(value), float(case.get("volume_db", 0)))
            if index + 1 < len(case["parts"]):
                time.sleep(gap_ms / 1000)
        time.sleep(float(case.get("listen_after_sec", 2.2)))
        root = dump_ui(serial)
        actual = extract_transcript(root)
        expected = expected_text(case)
        similarity = round(score(expected, actual), 4)
        segment_matches = [
            normalize(segment) in normalize(actual)
            for segment in case.get("expected_segments", [])
        ]
        passed = similarity >= threshold and all(segment_matches)
        return {
            "id": case["id"],
            "group": case["group"],
            "expected": expected,
            "actual": actual,
            "score": similarity,
            "segment_matches": segment_matches,
            "passed": passed,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - preserve the acceptance failure.
        return {
            "id": case["id"],
            "group": case["group"],
            "expected": expected_text(case),
            "actual": "",
            "score": 0,
            "segment_matches": [],
            "passed": False,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "error": repr(exc),
        }
    finally:
        adb(serial, "shell", "input", "keyevent", "4", check=False)
        time.sleep(0.5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--manifest", type=Path, default=Path("test-assets/phone-acoustic-asr/manifest.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--threshold", type=float, default=0.85)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    cases = list(manifest["cases"])
    if args.case_ids:
        selected = set(args.case_ids)
        cases = [case for case in cases if case["id"] in selected]
    missing = [value for case in cases for value in case["parts"] if not Path(value).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing acoustic assets: {missing}")
    ensure_ready(args.serial)
    if args.dry_run:
        print(json.dumps({"serial": args.serial, "cases": len(cases), "assets_ok": True}, ensure_ascii=False))
        return 0

    items = []
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']} {case['group']}", flush=True)
        result = run_case(
            args.serial,
            case,
            int(manifest.get("minimum_gap_ms_between_parts", 1400)),
            args.threshold,
        )
        print(json.dumps(result, ensure_ascii=False), flush=True)
        items.append(result)
    report = {
        "serial": args.serial,
        "manifest": str(args.manifest),
        "total": len(items),
        "passed": sum(item["passed"] for item in items),
        "threshold": args.threshold,
        "items": items,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("total", "passed")}, ensure_ascii=False))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
