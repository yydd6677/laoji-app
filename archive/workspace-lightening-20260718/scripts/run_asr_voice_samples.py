#!/usr/bin/env python3
"""Measure one-shot ASR transcript quality and latency without schedule-field scoring."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def normalize_text(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", value).lower()


def edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def transcript_score(expected: str, actual: str) -> float:
    expected_normalized = normalize_text(expected)
    actual_normalized = normalize_text(actual)
    if not expected_normalized:
        return 1.0 if not actual_normalized else 0.0
    distance = edit_distance(expected_normalized, actual_normalized)
    return max(0.0, 1.0 - distance / max(len(expected_normalized), len(actual_normalized), 1))


def resolve_audio_path(manifest_path: Path, value: str) -> Path:
    candidate = Path(value)
    if candidate.is_file():
        return candidate
    relative = manifest_path.parent / candidate
    if relative.is_file():
        return relative
    raise FileNotFoundError(value)


def transcribe(endpoint: str, sample: dict[str, Any], audio_path: Path, timeout: float, threshold: float) -> dict[str, Any]:
    body = json.dumps({
        "audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
        "filename": audio_path.name,
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    status = 0
    payload: dict[str, Any] = {}
    error = None
    try:
        with DIRECT_OPENER.open(request, timeout=timeout) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        status = exc.code
        error = exc.read().decode("utf-8", errors="replace")[:500]
    except Exception as exc:  # noqa: BLE001 - benchmark must preserve every result.
        error = repr(exc)
    duration_ms = round((time.perf_counter() - started) * 1000)
    actual = str(payload.get("text") or "")
    expected = str(sample.get("expected_text") or sample.get("text") or "")
    score = round(transcript_score(expected, actual), 4)
    return {
        "id": sample.get("id"),
        "audio": str(audio_path),
        "expected": expected,
        "actual": actual,
        "score": score,
        "passed": status == 200 and score >= threshold,
        "status": status,
        "duration_ms": duration_ms,
        "audio_duration_sec": payload.get("duration_sec"),
        "provider": payload.get("provider"),
        "error": error,
    }


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    return sorted(values)[max(0, min(len(values) - 1, round((len(values) - 1) * fraction)))]


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# LaoJi One-Shot ASR Quality",
        "",
        f"- Endpoint: `{report['endpoint']}`",
        f"- Format: `{report['format']}`",
        f"- Passed: {report['passed']}/{report['total']} ({report['pass_rate']:.1%})",
        f"- Mean transcript score: {report['mean_score']:.4f}",
        f"- Latency ms: `{report['latency_ms']}`",
        "",
        "## Failed Samples",
    ]
    failures = [item for item in report["items"] if not item["passed"]]
    if not failures:
        lines.append("- None")
    for item in failures:
        lines.extend([
            f"### {item['id']}",
            f"- Expected: {item['expected']}",
            f"- Actual: {item['actual'] or '(empty)'}",
            f"- Score/status/latency: `{item['score']} / {item['status']} / {item['duration_ms']} ms`",
            f"- Error: `{item['error']}`" if item["error"] else "",
        ])
    path.write_text("\n".join(line for line in lines if line != "") + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("test-assets/asr-voice-samples/manifest.json"))
    parser.add_argument("--format", choices=("mp3", "wav", "aac", "m4a"), default="mp3")
    parser.add_argument("--endpoint", default="http://127.0.0.1:18020/api/laoji/asr/transcribe")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.85)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    samples = list(manifest["samples"])
    if args.limit is not None:
        samples = samples[:max(0, args.limit)]
    work = [
        (sample, resolve_audio_path(args.manifest, sample["files"][args.format]))
        for sample in samples
    ]
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = [
            executor.submit(transcribe, args.endpoint, sample, path, args.timeout, args.threshold)
            for sample, path in work
        ]
        items = [future.result() for future in concurrent.futures.as_completed(futures)]
    items.sort(key=lambda item: str(item["id"]))
    latencies = [int(item["duration_ms"]) for item in items]
    scores = [float(item["score"]) for item in items]
    passed = sum(bool(item["passed"]) for item in items)
    report = {
        "manifest": str(args.manifest),
        "endpoint": args.endpoint,
        "format": args.format,
        "threshold": args.threshold,
        "total": len(items),
        "passed": passed,
        "pass_rate": passed / len(items) if items else 0,
        "mean_score": round(statistics.mean(scores), 4) if scores else 0,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "latency_ms": {
            "min": min(latencies) if latencies else 0,
            "median": statistics.median(latencies) if latencies else 0,
            "p90": percentile(latencies, 0.90),
            "p95": percentile(latencies, 0.95),
            "max": max(latencies) if latencies else 0,
        },
        "items": items,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, args.output.with_suffix(".md"))
    print(json.dumps({key: report[key] for key in (
        "total", "passed", "pass_rate", "mean_score", "elapsed_ms", "latency_ms"
    )}, ensure_ascii=False, indent=2))
    return 0 if passed == len(items) else 1


if __name__ == "__main__":
    raise SystemExit(main())
