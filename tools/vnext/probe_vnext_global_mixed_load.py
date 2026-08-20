#!/usr/bin/env python3
"""Run the selected vNext 10-minute mixed-load contract.

The workload is candidate-only: one source-clock realtime stream, one paced
R2 upload, one serial import-ASR lane, schedule Graph once per minute, Q2 once
per two minutes and Summary once per five minutes.  The aggregate report keeps
only hashes, timings, counts, revisions and resource measurements.  Source,
answers, citations, credentials, opaque identifiers and file names are never
persisted.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable
from urllib import error, request
import uuid

from probe_device_v2_realtime import configure_source_ip, purge_epoch
from probe_device_v2_upload import execute_purge_and_wait, json_request
from probe_stage3_mixed_load import safe_error_digest, safe_failure_details
from probe_stage3_vertical import digest_bytes, persistent_device


ROOT = Path(__file__).resolve().parents[2]
REALTIME_PROBE = ROOT / "tools" / "vnext" / "probe_device_v2_realtime.py"
UPLOAD_PROBE = ROOT / "tools" / "vnext" / "probe_device_v2_upload.py"
SUMMARY_PROBE = ROOT / "tools" / "vnext" / "probe_stage3_vertical.py"
Q2_PROBE = ROOT / "tools" / "vnext" / "probe_stage3_q2_only.py"

DEFAULT_SCHEDULE_UTTERANCES = (
    "明天下午三点半到五点开项目复盘会",
    "周五上午十点提醒我提交报销材料",
    "下周二晚上七点和朋友在体育馆打羽毛球",
    "后天下午两点参加产品方案评审",
)


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return float(ordered[low])
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def distribution(values: list[float], *, digits: int = 1) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "p50": round(percentile(values, 0.50) or 0, digits) if values else None,
        "p95": round(percentile(values, 0.95) or 0, digits) if values else None,
        "max": round(max(values), digits) if values else None,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def due_offsets(
    duration_seconds: float,
    interval_seconds: float,
    initial_delay_seconds: float = 0,
) -> list[float]:
    if duration_seconds <= 0 or interval_seconds <= 0 or initial_delay_seconds < 0:
        raise ValueError("duration and interval must be positive; delay cannot be negative")
    values: list[float] = []
    current = float(initial_delay_seconds)
    while current < duration_seconds:
        values.append(current)
        current += interval_seconds
    return values


def wait_until(started: float, offset_seconds: float) -> None:
    while True:
        remaining = started + offset_seconds - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.25, remaining))


def run_probe_command(
    command: list[str],
    output: Path,
    *,
    timeout_seconds: int,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    started_at = round(time.time() * 1000)
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env={**os.environ, "NO_PROXY": "*", "no_proxy": "*"},
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stderr = str(exc.stderr or "")
        return None, {
            "started_at_epoch_ms": started_at,
            "completed_at_epoch_ms": round(time.time() * 1000),
            "kind": "timeout",
            "stdout": safe_error_digest(str(exc.stdout or "")),
            "stderr": safe_error_digest(stderr),
            "failure": safe_failure_details(stderr),
        }
    if completed.returncode != 0 or not output.is_file():
        return None, {
            "started_at_epoch_ms": started_at,
            "completed_at_epoch_ms": round(time.time() * 1000),
            "kind": "process_failure",
            "return_code": completed.returncode,
            "stdout": safe_error_digest(completed.stdout),
            "stderr": safe_error_digest(completed.stderr),
            "failure": safe_failure_details(completed.stderr),
        }
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, {
            "started_at_epoch_ms": started_at,
            "completed_at_epoch_ms": round(time.time() * 1000),
            "kind": type(exc).__name__,
        }
    return payload, None


def purge_auth_state(api: str, path: Path) -> str:
    if not path.is_file():
        return "not_created"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        purge = dict(payload["purge"])
        result = execute_purge_and_wait(
            api,
            str(purge["purge_id"]),
            str(purge["purge_secret"]),
            request_prefix="global-mixed-purge",
        )
        return str(result.get("state") or "unknown")
    finally:
        path.unlink(missing_ok=True)


def sanitize_realtime(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "source_sha256", "source_bytes", "chunk_count", "interrupted_after_chunk",
            "resumed_from_chunk", "event_count", "stable_event_count", "final_outcome",
            "final_event_sequence", "paced_realtime", "stable_lag_ms", "model_revision",
            "purge_state", "epoch_purge_state", "wall_ms",
        )
    }


def sanitize_upload(payload: dict[str, Any], *, held: bool) -> dict[str, Any]:
    keys = (
        "started_at_epoch_ms", "upload_completed_at_epoch_ms", "upload_committed_at_epoch_ms",
        "first_stable_at_epoch_ms", "transcription_completed_at_epoch_ms", "source_sha256",
        "source_bytes", "upload_mode", "upload_parts", "held_upload_seconds", "task_state",
        "event_count", "stable_event_count", "first_stable_ms", "first_stable_source_end_ms",
        "transcription_wall_ms", "source_duration_ms", "transcription_rtf",
        "final_event_sequence", "model_revision", "acked", "purge_state",
        "epoch_purge_state", "wall_ms",
    )
    result = {key: payload.get(key) for key in keys if key in payload}
    result["lane"] = "held_upload" if held else "import_asr"
    return result


def sanitize_summary(payload: dict[str, Any]) -> dict[str, Any]:
    summary = dict(payload.get("summary") or {})
    cleanup = dict(payload.get("cleanup") or {})
    return {
        "sample_sha256": payload.get("sample_sha256"),
        "source_fingerprint": payload.get("source_fingerprint"),
        "duration_ms": (payload.get("input") or {}).get("duration_ms"),
        "chapter_count": (payload.get("input") or {}).get("chapter_count"),
        "state": summary.get("state"),
        "started_at_epoch_ms": summary.get("started_at_epoch_ms"),
        "completed_at_epoch_ms": summary.get("completed_at_epoch_ms"),
        "elapsed_ms": summary.get("end_to_end_elapsed_ms"),
        "attempt": summary.get("final_attempt_number"),
        "facts": summary.get("facts_count"),
        "actions": summary.get("action_candidate_count"),
        "citations": summary.get("citation_count"),
        "citations_exact": summary.get("citation_exact_match_count"),
        "runtime_revisions": payload.get("capabilities"),
        "cleanup_state": cleanup.get("state"),
    }


def sanitize_q2(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "sample_sha256", "source_fingerprint", "question_sha256", "started_at_epoch_ms",
            "completed_at_epoch_ms", "elapsed_ms", "replay_elapsed_ms", "replay_identical",
            "answer_kind", "answer_sha256", "clause_count", "citation_count",
            "citation_exact_match_count", "contract_revision", "provider_revision",
            "model_revision", "cleanup_state",
        )
    }


def read_ready(url: str) -> dict[str, Any] | None:
    try:
        req = request.Request(url, headers={"Accept": "application/json"})
        with request.urlopen(req, timeout=3) as response:
            if not 200 <= response.status < 300:
                return None
            return json.loads(response.read().decode("utf-8"))
    except (error.URLError, OSError, json.JSONDecodeError):
        return None


def directory_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return total
    for root, _directories, files in os.walk(path, followlinks=False):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


def resource_lane(
    *,
    started: float,
    duration_seconds: float,
    interval_seconds: float,
    root_pids: list[int],
    gpu_index: int,
    temp_paths: list[Path],
    ready_url: str,
) -> dict[str, Any]:
    try:
        import psutil
    except ImportError:
        return {"available": False, "reason": "psutil_missing"}
    processes: dict[int, Any] = {}
    samples: list[dict[str, float | int | None]] = []
    temp_peak = 0
    temp_sampled_at = 0.0
    next_offset = 0.0
    while next_offset < duration_seconds:
        wait_until(started, next_offset)
        tracked: dict[int, Any] = {}
        for root_pid in root_pids:
            try:
                root_process = psutil.Process(root_pid)
                tracked[root_pid] = root_process
                tracked.update({child.pid: child for child in root_process.children(recursive=True)})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        cpu_cores = 0.0
        rss_bytes = 0
        for pid, process in tracked.items():
            try:
                if pid not in processes:
                    process.cpu_percent(None)
                    processes[pid] = process
                else:
                    process = processes[pid]
                cpu_cores += max(0.0, float(process.cpu_percent(None))) / 100.0
                rss_bytes += int(process.memory_info().rss)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        gpu_mib = 0
        gpu_free_mib: int | None = None
        try:
            app_rows = subprocess.run(
                [
                    "nvidia-smi", "--query-compute-apps=pid,used_memory",
                    "--format=csv,noheader,nounits", "--id=" + str(gpu_index),
                ],
                capture_output=True, text=True, timeout=3, check=False,
            )
            for line in app_rows.stdout.splitlines():
                fields = [field.strip() for field in line.split(",")]
                if len(fields) == 2 and fields[0].isdigit() and int(fields[0]) in tracked:
                    try:
                        gpu_mib += int(fields[1])
                    except ValueError:
                        pass
            gpu_row = subprocess.run(
                [
                    "nvidia-smi", "--query-gpu=memory.free",
                    "--format=csv,noheader,nounits", "--id=" + str(gpu_index),
                ],
                capture_output=True, text=True, timeout=3, check=False,
            ).stdout.strip().splitlines()
            if gpu_row:
                gpu_free_mib = int(gpu_row[0].strip())
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        now = time.monotonic()
        if now - temp_sampled_at >= 10 or not samples:
            temp_peak = max(temp_peak, sum(directory_bytes(path) for path in temp_paths))
            temp_sampled_at = now
        ready = read_ready(ready_url) or {}
        asr = dict(ready.get("asr") or {})
        worker = dict(ready.get("task_worker") or {})
        samples.append({
            "cpu_cores": cpu_cores,
            "rss_bytes": rss_bytes,
            "gpu_mib": gpu_mib,
            "gpu_free_mib": gpu_free_mib,
            "asr_queue_depth": int(asr.get("queue_depth") or 0),
            "task_queue_depth": int(worker.get("queue_depth") or 0),
        })
        next_offset += interval_seconds
    return {
        "available": True,
        "sample_count": len(samples),
        "cpu_cores": distribution([float(item["cpu_cores"] or 0) for item in samples], digits=3),
        "rss_gib": distribution([
            float(item["rss_bytes"] or 0) / (1024 ** 3) for item in samples
        ], digits=3),
        "gpu_mib": distribution([float(item["gpu_mib"] or 0) for item in samples]),
        "gpu_free_mib_min": min(
            (int(item["gpu_free_mib"]) for item in samples if item["gpu_free_mib"] is not None),
            default=None,
        ),
        "asr_queue_depth_max": max((int(item["asr_queue_depth"] or 0) for item in samples), default=0),
        "task_queue_depth_max": max((int(item["task_queue_depth"] or 0) for item in samples), default=0),
        "temp_peak_gib": round(temp_peak / (1024 ** 3), 3),
    }


def scheduled_lane(
    *,
    kind: str,
    offsets: list[float],
    started: float,
    run: Callable[[int], tuple[dict[str, Any] | None, dict[str, Any] | None]],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for ordinal, offset in enumerate(offsets):
        wait_until(started, offset)
        result, failure = run(ordinal)
        if result is not None:
            result["scheduled_offset_ms"] = round(offset * 1000)
            results.append(result)
        if failure is not None:
            failure["scheduled_offset_ms"] = round(offset * 1000)
            failures.append(failure)
    return {
        "kind": kind,
        "scheduled": len(offsets),
        "completed": len(results),
        "failed": len(failures),
        "results": results,
        "failures": failures,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:18023/api/device/v2")
    parser.add_argument("--ready-url", default="http://127.0.0.1:18023/api/ready")
    parser.add_argument("--pcm", type=Path, required=True)
    parser.add_argument("--upload-media", type=Path, required=True)
    parser.add_argument("--import-media", type=Path, required=True)
    parser.add_argument("--transcript", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration-seconds", type=float, default=600)
    parser.add_argument("--schedule-every-seconds", type=float, default=60)
    parser.add_argument("--q2-every-seconds", type=float, default=120)
    parser.add_argument("--summary-every-seconds", type=float, default=300)
    parser.add_argument("--summary-initial-delay-seconds", type=float, default=30)
    parser.add_argument("--import-timeout-seconds", type=int, default=900)
    parser.add_argument("--model-timeout-seconds", type=int, default=900)
    parser.add_argument("--resource-sample-seconds", type=float, default=2)
    parser.add_argument("--resource-pid", type=int, action="append", default=[])
    parser.add_argument("--temp-path", type=Path, action="append", default=[])
    parser.add_argument("--gpu-index", type=int, default=0)
    parser.add_argument("--schedule-text", action="append", default=[])
    parser.add_argument("--traffic-class", default="isolated-evaluation")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.duration_seconds < 10:
        raise SystemExit("duration-seconds must be at least 10")
    paths = (args.pcm, args.upload_media, args.import_media, args.transcript)
    if any(not path.is_file() for path in paths):
        raise SystemExit("all input assets must exist")
    input_hashes = {
        "pcm": sha256_file(args.pcm),
        "upload_media": sha256_file(args.upload_media),
        "import_media": sha256_file(args.import_media),
        "transcript": sha256_file(args.transcript),
    }
    utterances = tuple(args.schedule_text) or DEFAULT_SCHEDULE_UTTERANCES
    started = time.monotonic()
    started_at_epoch_ms = round(time.time() * 1000)
    schedule_offsets = due_offsets(args.duration_seconds, args.schedule_every_seconds)
    q2_offsets = due_offsets(args.duration_seconds, args.q2_every_seconds)
    summary_offsets = due_offsets(
        args.duration_seconds,
        args.summary_every_seconds,
        args.summary_initial_delay_seconds,
    )

    with tempfile.TemporaryDirectory(prefix="laoji-vnext-global-mixed-") as temporary:
        temp = Path(temporary)
        summary_auth = temp / "summary-auth.json"
        q2_auth = temp / "q2-auth.json"
        schedule_auth = temp / "schedule-auth.json"

        def realtime_run() -> dict[str, Any]:
            output = temp / "realtime.json"
            payload, failure = run_probe_command([
                sys.executable, str(REALTIME_PROBE), str(args.pcm),
                "--api", args.api, "--output", str(output), "--pace-realtime",
                "--source-ip", "127.0.0.51", "--traffic-class", args.traffic_class,
            ], output, timeout_seconds=round(args.duration_seconds + 300))
            return {
                "completed": 1 if payload else 0,
                "failed": 1 if failure else 0,
                "result": sanitize_realtime(payload) if payload else None,
                "failure": failure,
            }

        def held_upload_run() -> dict[str, Any]:
            output = temp / "held-upload.json"
            payload, failure = run_probe_command([
                sys.executable, str(UPLOAD_PROBE), str(args.upload_media),
                "--api", args.api, "--output", str(output),
                "--hold-upload-seconds", str(args.duration_seconds), "--purge-after-upload",
                "--source-ip", "127.0.0.52", "--traffic-class", args.traffic_class,
            ], output, timeout_seconds=round(args.duration_seconds + 300))
            return {
                "completed": 1 if payload else 0,
                "failed": 1 if failure else 0,
                "result": sanitize_upload(payload, held=True) if payload else None,
                "failure": failure,
            }

        def import_run(ordinal: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
            output = temp / f"import-{ordinal:03d}.json"
            payload, failure = run_probe_command([
                sys.executable, str(UPLOAD_PROBE), str(args.import_media),
                "--api", args.api, "--output", str(output),
                "--timeout-seconds", str(args.import_timeout_seconds),
                "--source-ip", f"127.0.0.{70 + ordinal}",
                "--traffic-class", args.traffic_class,
            ], output, timeout_seconds=args.import_timeout_seconds + 180)
            return (sanitize_upload(payload, held=False) if payload else None, failure)

        def import_lane() -> dict[str, Any]:
            results: list[dict[str, Any]] = []
            failures: list[dict[str, Any]] = []
            ordinal = 0
            consecutive_failures = 0
            while time.monotonic() < started + args.duration_seconds:
                result, failure = import_run(ordinal)
                if result:
                    results.append(result)
                    consecutive_failures = 0
                if failure:
                    failures.append(failure)
                    consecutive_failures += 1
                    time.sleep(min(30.0, 5.0 * consecutive_failures))
                ordinal += 1
            gaps = [
                max(0, int(results[index]["started_at_epoch_ms"]) - int(results[index - 1]["transcription_completed_at_epoch_ms"]))
                for index in range(1, len(results))
                if results[index].get("started_at_epoch_ms") is not None
                and results[index - 1].get("transcription_completed_at_epoch_ms") is not None
            ]
            return {
                "completed": len(results),
                "failed": len(failures),
                "max_restart_gap_ms": max(gaps, default=None),
                "results": results,
                "failures": failures,
            }

        def summary_run(ordinal: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
            output = temp / f"summary-{ordinal:03d}.json"
            payload, failure = run_probe_command([
                sys.executable, str(SUMMARY_PROBE), str(args.transcript),
                "--api", args.api, "--output", str(output), "--skip-question",
                "--timeout-seconds", str(args.model_timeout_seconds),
                "--auth-state", str(summary_auth), "--source-ip", "127.0.0.53",
                "--traffic-class", args.traffic_class,
            ], output, timeout_seconds=args.model_timeout_seconds * 2)
            return (sanitize_summary(payload) if payload else None, failure)

        def q2_run(ordinal: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
            output = temp / f"q2-{ordinal:03d}.json"
            payload, failure = run_probe_command([
                sys.executable, str(Q2_PROBE), str(args.transcript),
                "--api", args.api, "--output", str(output),
                "--timeout-seconds", str(args.model_timeout_seconds),
                "--auth-state", str(q2_auth), "--source-ip", "127.0.0.54",
                "--traffic-class", args.traffic_class,
            ], output, timeout_seconds=args.model_timeout_seconds * 2)
            return (sanitize_q2(payload) if payload else None, failure)

        def schedule_lane() -> dict[str, Any]:
            configure_source_ip("127.0.0.55")
            state = persistent_device(args.api, schedule_auth)
            state.auth["X-Laoji-Traffic-Class"] = args.traffic_class
            results: list[dict[str, Any]] = []
            failures: list[dict[str, Any]] = []
            try:
                for ordinal, offset in enumerate(schedule_offsets):
                    wait_until(started, offset)
                    text = utterances[ordinal % len(utterances)]
                    text_hash = digest_bytes(text.encode("utf-8"))
                    request_started = time.perf_counter()
                    status, graph = json_request(
                        f"{args.api}/schedule/graph",
                        method="POST",
                        headers=state.auth,
                        payload={
                            "schema_version": 1,
                            "text": text,
                            "reference_datetime": "2026-08-20T09:00:00+08:00",
                            "timezone": "Asia/Shanghai",
                            "client_intent": "create",
                            "client_request_id": "global-mixed-schedule-" + uuid.uuid4().hex,
                        },
                    )
                    elapsed_ms = round((time.perf_counter() - request_started) * 1000)
                    if not 200 <= status < 300:
                        failures.append({
                            "scheduled_offset_ms": round(offset * 1000),
                            "http_status": status,
                            "response": safe_error_digest(json.dumps(graph, ensure_ascii=False)),
                        })
                        continue
                    source = dict(graph.get("source") or {})
                    results.append({
                        "scheduled_offset_ms": round(offset * 1000),
                        "utterance_sha256": text_hash,
                        "source_hash_exact": source.get("content_sha256") == text_hash,
                        "elapsed_ms": elapsed_ms,
                        "state": graph.get("state"),
                        "route": graph.get("route"),
                        "engine": (graph.get("provenance") or {}).get("engine"),
                        "engine_revision": (graph.get("provenance") or {}).get("engine_revision"),
                    })
            finally:
                cleanup_state = purge_epoch(args.api, state).get("state")
                schedule_auth.unlink(missing_ok=True)
            return {
                "scheduled": len(schedule_offsets),
                "completed": len(results),
                "failed": len(failures),
                "latency_ms": distribution([float(item["elapsed_ms"]) for item in results]),
                "source_hash_exact": all(item["source_hash_exact"] for item in results),
                "cleanup_state": cleanup_state,
                "results": results,
                "failures": failures,
            }

        with ThreadPoolExecutor(max_workers=7) as executor:
            futures = {
                "realtime": executor.submit(realtime_run),
                "held_upload": executor.submit(held_upload_run),
                "import_asr": executor.submit(import_lane),
                "schedule": executor.submit(schedule_lane),
                "q2": executor.submit(
                    scheduled_lane,
                    kind="q2", offsets=q2_offsets, started=started, run=q2_run,
                ),
                "summary": executor.submit(
                    scheduled_lane,
                    kind="summary", offsets=summary_offsets, started=started, run=summary_run,
                ),
                "resources": executor.submit(
                    resource_lane,
                    started=started,
                    duration_seconds=args.duration_seconds,
                    interval_seconds=args.resource_sample_seconds,
                    root_pids=args.resource_pid,
                    gpu_index=args.gpu_index,
                    temp_paths=[path.resolve() for path in args.temp_path],
                    ready_url=args.ready_url,
                ),
            }
            lanes = {name: future.result() for name, future in futures.items()}

        epoch_cleanup = {
            "summary": purge_auth_state(args.api, summary_auth),
            "q2": purge_auth_state(args.api, q2_auth),
        }

    summary_results = list(lanes["summary"]["results"])
    q2_results = list(lanes["q2"]["results"])
    import_results = list(lanes["import_asr"]["results"])
    realtime_result = dict(lanes["realtime"].get("result") or {})
    resources = dict(lanes["resources"])
    summary_latencies = [
        float(item["elapsed_ms"])
        for item in summary_results if item.get("elapsed_ms") is not None
    ]
    q2_latencies = [
        float(item["elapsed_ms"])
        for item in q2_results if item.get("elapsed_ms") is not None
    ]
    schedule_latencies = [
        float(item["elapsed_ms"])
        for item in lanes["schedule"]["results"] if item.get("elapsed_ms") is not None
    ]
    import_first_stable = [
        float(item["first_stable_ms"])
        for item in import_results if item.get("first_stable_ms") is not None
    ]
    import_rtfs = [
        float(item["transcription_rtf"])
        for item in import_results if item.get("transcription_rtf") is not None
    ]
    realtime_stable_p95 = float(
        (realtime_result.get("stable_lag_ms") or {}).get("p95") or 0
    )
    gate = {
        "wall_clock_window": round((time.time() * 1000 - started_at_epoch_ms) / 1000, 3) >= args.duration_seconds,
        "realtime_complete": (
            lanes["realtime"]["failed"] == 0
            and realtime_result.get("paced_realtime") is True
            and realtime_result.get("final_outcome") in {"text", "no_speech"}
            and int(realtime_result.get("source_bytes") or 0) // 32
            >= round(args.duration_seconds * 1000) - 1
        ),
        "held_upload_complete": lanes["held_upload"]["failed"] == 0,
        "import_backlog_exercised": bool(import_results) and all(
            item.get("task_state") in {"succeeded", "no_content"} for item in import_results
        ),
        "realtime_stable_p95_le_2s": int(
            (realtime_result.get("stable_lag_ms") or {}).get("count") or 0
        ) > 0 and realtime_stable_p95 <= 2_000,
        "import_first_stable_p95_le_8s": bool(import_first_stable)
        and float(percentile(import_first_stable, 0.95) or 0) <= 8_000,
        "import_rtf_p95_le_0_5": bool(import_rtfs)
        and float(percentile(import_rtfs, 0.95) or 0) <= 0.5,
        "schedule_cadence_complete": lanes["schedule"]["completed"] == len(schedule_offsets),
        "schedule_p95_le_3s": bool(schedule_latencies)
        and float(percentile(schedule_latencies, 0.95) or 0) <= 3_000,
        "q2_cadence_complete": lanes["q2"]["completed"] == len(q2_offsets),
        "summary_cadence_complete": lanes["summary"]["completed"] == len(summary_offsets),
        "summary_p95_le_45s": bool(summary_latencies)
        and float(percentile(summary_latencies, 0.95) or 0) <= 45_000,
        "summary_grounding_exact": bool(summary_results) and all(
            item.get("citations") == item.get("citations_exact") for item in summary_results
        ),
        "q2_grounding_exact": bool(q2_results) and all(
            item.get("citation_count") == item.get("citation_exact_match_count")
            for item in q2_results
        ),
        "q2_warm_p95_le_15s": bool(q2_latencies)
        and float(percentile(q2_latencies, 0.95) or 0) <= 15_000,
        "gpu_le_16_gib": resources.get("available") is True
        and float((resources.get("gpu_mib") or {}).get("max") or 0) <= 16 * 1024,
        "rss_le_8_gib": resources.get("available") is True
        and float((resources.get("rss_gib") or {}).get("max") or 0) <= 8,
        "cpu_p95_le_16_cores": resources.get("available") is True
        and float((resources.get("cpu_cores") or {}).get("p95") or 0) <= 16,
        "temp_le_4_gib": resources.get("available") is True
        and float(resources.get("temp_peak_gib") or 0) <= 4,
        "cleanup_complete": all(
            state in {"completed", "confirmed", "not_created"}
            for state in (
                epoch_cleanup["summary"], epoch_cleanup["q2"],
                lanes["schedule"].get("cleanup_state"),
                realtime_result.get("purge_state"), realtime_result.get("epoch_purge_state"),
                (lanes["held_upload"].get("result") or {}).get("purge_state"),
                (lanes["held_upload"].get("result") or {}).get("epoch_purge_state"),
            )
        ),
    }
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "traffic_class": args.traffic_class,
        "requested_duration_seconds": args.duration_seconds,
        "started_at_epoch_ms": started_at_epoch_ms,
        "completed_at_epoch_ms": round(time.time() * 1000),
        "wall_ms": round((time.monotonic() - started) * 1000),
        "input_hashes": input_hashes,
        "cadence": {
            "schedule_seconds": args.schedule_every_seconds,
            "q2_seconds": args.q2_every_seconds,
            "summary_seconds": args.summary_every_seconds,
        },
        "lanes": lanes,
        "epoch_cleanup": epoch_cleanup,
        "summary_latency_ms": distribution(summary_latencies),
        "q2_latency_ms": distribution(q2_latencies),
        "schedule_latency_ms": distribution(schedule_latencies),
        "import_first_stable_ms": distribution(import_first_stable),
        "import_rtf": distribution(import_rtfs, digits=6),
        "gate": gate,
        "passed": all(gate.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({
        "passed": report["passed"],
        "wall_ms": report["wall_ms"],
        "realtime": gate["realtime_complete"],
        "imports": lanes["import_asr"]["completed"],
        "schedule": lanes["schedule"]["completed"],
        "q2": lanes["q2"]["completed"],
        "summary": lanes["summary"]["completed"],
        "failed_gates": [name for name, passed in gate.items() if not passed],
    }, ensure_ascii=False), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
