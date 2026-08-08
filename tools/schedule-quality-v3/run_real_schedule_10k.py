#!/usr/bin/env python3
"""Run the real schedule corpus one HTTP request at a time.

Every case is posted independently, evaluated against its authored oracle, and
appended to an evidence JSONL file before the next case starts.  This runner
does not call the diagnostics batch endpoint, import parser code, use a thread
pool, or infer labels from server responses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
CORPUS_PATH = ROOT / "schedule-real-10k.jsonl"
MANIFEST_PATH = ROOT / "schedule-real-10k-manifest.json"
RESULTS_PATH = ROOT / "schedule-real-10k-results.jsonl"
SUMMARY_PATH = ROOT / "reports" / "schedule-real-10k-report.json"
DEFAULT_ENDPOINT = "http://183.36.243.124:18035/api/laoji/parse"
MAX_RESPONSE_BYTES = 2_000_000


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def request_json(
    endpoint: str,
    payload: dict[str, Any],
    timeout: float,
    *,
    method: str = "POST",
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body if method != "GET" else None,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method=method,
    )
    started = time.perf_counter()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    status: int | None = None
    headers: dict[str, str] = {}
    raw = b""
    error: dict[str, Any] | None = None
    try:
        with opener.open(request, timeout=timeout) as response:
            status = int(response.status)
            headers = {
                key.lower(): value
                for key, value in response.headers.items()
                if key.lower() in {"content-type", "server", "date", "x-request-id", "content-length"}
            }
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        headers = {
            key.lower(): value
            for key, value in exc.headers.items()
            if key.lower() in {"content-type", "server", "date", "x-request-id", "content-length"}
        }
        raw = exc.read(MAX_RESPONSE_BYTES + 1)
        error = {"kind": "http_error", "type": type(exc).__name__, "message": str(exc)[:500]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        error = {"kind": "transport_error", "type": type(exc).__name__, "message": str(exc)[:500]}

    truncated = len(raw) > MAX_RESPONSE_BYTES
    bounded = raw[:MAX_RESPONSE_BYTES]
    raw_text = bounded.decode("utf-8", "replace")
    try:
        parsed: Any = json.loads(raw_text) if raw_text else None
    except json.JSONDecodeError:
        parsed = None
        error = error or {"kind": "invalid_json", "type": "JSONDecodeError", "message": "response is not JSON"}
    return {
        "endpoint": endpoint,
        "method": method,
        "request_sha256": sha256_bytes(body),
        "request": payload,
        "status": status,
        "headers": headers,
        "response_raw": raw_text,
        "response": parsed,
        "response_sha256": sha256_bytes(bounded),
        "response_truncated": truncated,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        "error": error,
    }


def snapshot_server(endpoint: str, timeout: float) -> dict[str, Any]:
    base = endpoint.split("/api/", 1)[0].rstrip("/")
    health = request_json(base + "/health", {}, timeout, method="GET")
    openapi = request_json(base + "/openapi.json", {}, timeout, method="GET")
    return {
        "base_url": base,
        "health": health,
        "openapi": openapi,
        "identity": {
            "health_response_sha256": health["response_sha256"],
            "openapi_response_sha256": openapi["response_sha256"],
            "server_header": health.get("headers", {}).get("server"),
            "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "identity_provenance": "http_response_hash_only; server exposes no source/model digest",
        },
    }


def iso_date(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def compare_expected(expected: dict[str, Any], actual: Any) -> tuple[bool, list[str], dict[str, Any]]:
    if not isinstance(actual, dict):
        return False, ["actual_not_object"], {"actual": actual}
    mismatches: dict[str, Any] = {}
    for key, expected_value in expected.items():
        actual_value = actual.get(key)
        if key in {"start_date", "end_date"}:
            expected_value = iso_date(expected_value)
            actual_value = iso_date(actual_value)
        if actual_value != expected_value:
            mismatches[key] = {"expected": expected_value, "actual": actual_value}
    # Saving an incomplete draft without an explicit clarification is unsafe.
    if expected.get("needs_clarification") is False and actual.get("needs_clarification") is True:
        mismatches["unexpected_clarification"] = {"expected": False, "actual": True}
    return not mismatches, [f"field:{key}" for key in sorted(mismatches)], mismatches


def evaluate(case: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    expected = case.get("expected")
    status = response.get("status")
    actual = response.get("response")
    if expected is None:
        # A negative control must be rejected by the API.  A normal parsed event
        # is a quality failure even if the HTTP transport itself returned 200.
        if status in {400, 422} and isinstance(actual, dict) and actual.get("code") in {"not_schedule", "invalid_schedule"}:
            return {"passed": True, "failure_codes": [], "mismatches": {}}
        return {
            "passed": False,
            "failure_codes": ["negative_control_accepted" if status == 200 else "negative_control_wrong_error"],
            "mismatches": {"status": status, "response": actual},
        }
    if status != 200:
        return {"passed": False, "failure_codes": ["http_status", f"http_status:{status}"], "mismatches": {"status": status, "response": actual}}
    passed, failure_codes, mismatches = compare_expected(expected, actual)
    return {"passed": passed, "failure_codes": failure_codes, "mismatches": mismatches}


def read_completed(path: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return completed
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        case_id = row.get("case_id")
        if case_id:
            completed[str(case_id)] = row
    return completed


def run(args: argparse.Namespace) -> int:
    corpus = load_json_lines(Path(args.corpus))
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    audit = manifest.get("audit", {})
    expected_total = int(manifest.get("total") or len(corpus))
    if len(corpus) != expected_total or not audit.get("passed") or not manifest.get("independent_oracle"):
        raise SystemExit("corpus manifest is not a passed independent authored corpus")
    server = snapshot_server(args.endpoint, args.timeout)
    completed = read_completed(Path(args.output)) if args.resume else {}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    selected = corpus[args.start : args.start + args.limit if args.limit else None]
    if args.end is not None:
        selected = corpus[args.start : args.end]
    total_new = 0
    passed = 0
    failed = 0
    failure_counts: Counter[str] = Counter()
    with output.open("a", encoding="utf-8") as stream:
        for position, case in enumerate(selected, start=args.start + 1):
            if args.resume and case["case_id"] in completed:
                prior = completed[case["case_id"]]
                if prior.get("evaluation", {}).get("passed"):
                    passed += 1
                else:
                    failed += 1
                    failure_counts.update(prior.get("evaluation", {}).get("failure_codes", []))
                continue
            request_payload = {
                "text": case["text"],
                "reference_datetime": case["reference_datetime"],
                "timezone": case["timezone"],
            }
            http_result = request_json(args.endpoint, request_payload, args.timeout)
            evaluation = evaluate(case, http_result)
            evidence = {
                "schema_version": 1,
                "case_id": case["case_id"],
                "ordinal": position,
                "input": {
                    "text": case["text"],
                    "reference_datetime": case["reference_datetime"],
                    "timezone": case["timezone"],
                    "input_sha256": case["input_sha256"],
                },
                "labels": {
                    "family": case["family"],
                    "expected_outcome": case["expected_outcome"],
                    "expected": case["expected"],
                    "label_source": case["label_source"],
                    "event_concept_key": case["event_concept_key"],
                    "oral_style_key": case["oral_style_key"],
                    "connector_key": case["connector_key"],
                    "date_expression_key": case["date_expression_key"],
                    "time_expression_key": case["time_expression_key"],
                    "location_key": case["location_key"],
                    "reminder_expression_key": case["reminder_expression_key"],
                    "correction_intent_key": case["correction_intent_key"],
                    "template_signature": case["template_signature"],
                    "semantic_signature": case["semantic_signature"],
                },
                "server_identity": server["identity"],
                "http": http_result,
                "route_observation": {
                    "route": (http_result.get("response") or {}).get("route") if isinstance(http_result.get("response"), dict) else None,
                    "parse_source": (http_result.get("response") or {}).get("parse_source") if isinstance(http_result.get("response"), dict) else None,
                    "model_attempted": (http_result.get("response") or {}).get("model_attempted") if isinstance(http_result.get("response"), dict) else None,
                    "model_success": (http_result.get("response") or {}).get("model_success") if isinstance(http_result.get("response"), dict) else None,
                    "fallback_used": (http_result.get("response") or {}).get("fallback_used") if isinstance(http_result.get("response"), dict) else None,
                    "model_id": (http_result.get("response") or {}).get("model_id") if isinstance(http_result.get("response"), dict) else None,
                    "request_id": http_result.get("headers", {}).get("x-request-id"),
                    "observability_status": "response_fields_or_headers_only; null means server did not expose it",
                },
                "evaluation": evaluation,
                "recorded_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            }
            stream.write(json.dumps(evidence, ensure_ascii=False, sort_keys=True) + "\n")
            stream.flush()
            if not args.no_fsync:
                os.fsync(stream.fileno())
            total_new += 1
            if evaluation["passed"]:
                passed += 1
            else:
                failed += 1
                failure_counts.update(evaluation["failure_codes"])
            print(json.dumps({"case_id": case["case_id"], "ordinal": position, "passed": evaluation["passed"], "status": http_result.get("status"), "elapsed_ms": http_result.get("elapsed_ms"), "failure_codes": evaluation["failure_codes"]}, ensure_ascii=False, sort_keys=True), flush=True)
    summary = {
        "schema_version": 1,
        "evidence_type": "real_http_per_case",
        "remote_service": urlparse(args.endpoint).hostname not in {"127.0.0.1", "localhost", "::1"},
        "emulator_input": False,
        "real_asr": False,
        "independent_oracle": True,
        "endpoint": args.endpoint,
        "corpus_total": len(corpus),
        "requested": len(selected),
        "new_cases_written": total_new,
        "passed": passed,
        "failed": failed,
        "pass_rate": passed / len(selected) if selected else 1.0,
        "failure_code_counts": dict(sorted(failure_counts.items())),
        "per_case_evidence_path": str(output),
        "server_snapshot": server,
        "corpus_manifest": str(args.manifest),
        "promotion_eligible": False,
        "promotion_reason": "A real HTTP run is evidence only; promotion requires reviewing every per-case oracle result and resolving failures.",
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    summary_path = Path(args.summary)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(summary_path), "requested": len(selected), "new_cases_written": total_new, "passed": passed, "failed": failed, "failure_code_counts": dict(sorted(failure_counts.items()))}, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default=str(CORPUS_PATH))
    parser.add_argument("--manifest", default=str(MANIFEST_PATH))
    parser.add_argument("--output", default=str(RESULTS_PATH))
    parser.add_argument("--summary", default=str(SUMMARY_PATH))
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--no-fsync", action="store_true")
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
