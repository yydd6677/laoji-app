#!/usr/bin/env python3
"""Replay public calendar source supervision through the isolated Graph API.

MASSIVE supplies intent and source spans, not LaoJi field truth. This probe
therefore verifies owner routing, model provenance, structural safety and
surface-span recall only. It never writes utterance or model content.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import statistics
import time
from typing import Any
from urllib import error, request


INTENTS = {
    "calendar_set": "create",
    "calendar_query": "query",
    "calendar_remove": "delete",
}
SCORED_SOURCE_SLOTS = {
    "date": "date",
    "time": "time",
    "event_name": "title",
    "location": "location",
}


def _sha256(value: bytes | str) -> str:
    payload = value.encode("utf-8") if isinstance(value, str) else value
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(len(ordered) * quantile) - 1))
    return round(ordered[index], 1)


def _post_json(url: str, payload: dict[str, Any], timeout: float) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=timeout) as response:
        value = json.loads(response.read().decode("utf-8"))
    return value, round((time.perf_counter() - started) * 1000, 1)


def _span_values(graph: dict[str, Any], field: str, text: str) -> tuple[list[str], bool]:
    values: list[str] = []
    exact = True
    for span in (graph.get("spans") or {}).get(field) or []:
        start = span.get("start")
        end = span.get("end")
        surface = span.get("text")
        if not isinstance(start, int) or not isinstance(end, int) or not isinstance(surface, str):
            exact = False
            continue
        if start < 0 or end < start or text[start:end] != surface:
            exact = False
            continue
        values.append(surface)
    return values, exact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--api-base", default="http://127.0.0.1:28023")
    parser.add_argument("--reference-datetime", default="2026-08-16T10:00:00+08:00")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    input_bytes = args.input.read_bytes()
    rows = [json.loads(line) for line in input_bytes.decode("utf-8").splitlines() if line.strip()]
    if args.limit > 0:
        rows = rows[: args.limit]
    results: list[dict[str, Any]] = []
    latency: list[float] = []
    intent_counts: Counter[str] = Counter()
    state_counts: Counter[str] = Counter()
    slot_total: Counter[str] = Counter()
    slot_covered: Counter[str] = Counter()
    failures: Counter[str] = Counter()

    for ordinal, row in enumerate(rows):
        text = str(row.get("text") or "").strip()
        source_intent = str((row.get("expected") or {}).get("source_intent") or "")
        intent = INTENTS.get(source_intent)
        if not text or intent is None or (row.get("source") or {}).get("dataset") != "AmazonScience/massive":
            raise ValueError("source_row_invalid")
        digest = _sha256(text)
        payload = {
            "schema_version": 1,
            "text": text,
            "reference_datetime": args.reference_datetime,
            "timezone": args.timezone,
            "client_intent": intent,
            "client_request_id": f"stage4-source-{ordinal:04d}-{digest[-12:]}",
        }
        started = time.perf_counter()
        try:
            graph, elapsed = _post_json(
                args.api_base.rstrip("/") + "/api/laoji/v2/schedule/graph",
                payload,
                args.timeout,
            )
            error_code = None
        except error.HTTPError as exc:
            graph = {}
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            error_code = f"http_{exc.code}"
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            graph = {}
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            error_code = type(exc).__name__
        if error_code:
            failures[error_code] += 1
            results.append({
                "ordinal": ordinal,
                "source_id": str(row.get("id") or ""),
                "utterance_sha256": digest,
                "expected_intent": intent,
                "error": error_code,
            })
            if (ordinal + 1) % 10 == 0 or ordinal + 1 == len(rows):
                print(json.dumps({
                    "progress": ordinal + 1,
                    "total": len(rows),
                    "failures": sum(failures.values()),
                }, ensure_ascii=False), flush=True)
            continue

        latency.append(elapsed)
        observed_intent = str(graph.get("intent") or "")
        intent_counts[f"{intent}->{observed_intent}"] += 1
        state_counts[str(graph.get("state") or "unknown")] += 1
        source = graph.get("source") or {}
        all_spans_exact = True
        span_cache: dict[str, list[str]] = {}
        for graph_field in set(SCORED_SOURCE_SLOTS.values()):
            surfaces, exact = _span_values(graph, graph_field, text)
            span_cache[graph_field] = surfaces
            all_spans_exact = all_spans_exact and exact
        row_annotation = row.get("source_annotation") or {}
        source_slots = row_annotation.get("slots") or {}
        row_total = 0
        row_covered = 0
        if intent == "create":
            for source_field, graph_field in SCORED_SOURCE_SLOTS.items():
                for raw_surface in source_slots.get(source_field) or []:
                    surface = str(raw_surface).strip()
                    if not surface or surface not in text:
                        continue
                    slot_total[source_field] += 1
                    row_total += 1
                    covered = any(surface in value or value in surface for value in span_cache[graph_field])
                    if covered:
                        slot_covered[source_field] += 1
                        row_covered += 1
        slots = graph.get("slots") or {}
        results.append({
            "ordinal": ordinal,
            "source_id": str(row.get("id") or ""),
            "utterance_sha256": digest,
            "expected_intent": intent,
            "observed_intent": observed_intent,
            "route": graph.get("route"),
            "state": graph.get("state"),
            "engine": (graph.get("provenance") or {}).get("engine"),
            "engine_revision": (graph.get("provenance") or {}).get("engine_revision"),
            "source_hash_exact": source.get("content_sha256") == digest,
            "all_returned_spans_exact": all_spans_exact,
            "scored_source_spans": row_total,
            "covered_source_spans": row_covered,
            "complete_without_start_date": graph.get("state") == "complete" and not slots.get("start_date"),
            "latency_ms": elapsed,
            "error": None,
        })
        if (ordinal + 1) % 10 == 0 or ordinal + 1 == len(rows):
            print(json.dumps({
                "progress": ordinal + 1,
                "total": len(rows),
                "failures": sum(failures.values()),
            }, ensure_ascii=False), flush=True)

    successful = [item for item in results if item.get("error") is None]
    create_results = [item for item in successful if item.get("expected_intent") == "create"]
    total_source_spans = sum(slot_total.values())
    total_covered_spans = sum(slot_covered.values())
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "source_policy": "MASSIVE zh-CN source intent/span supervision only; no LaoJi field or human-adjudication claim",
        "source_sha256": _sha256(input_bytes),
        "api_base_kind": "isolated-loopback",
        "reference_datetime": args.reference_datetime,
        "timezone": args.timezone,
        "total": len(results),
        "success": len(successful),
        "failures": dict(failures),
        "intent_matrix": dict(intent_counts),
        "state_counts": dict(state_counts),
        "create_model_engine_count": sum(item.get("engine") == "server-model" for item in create_results),
        "source_hash_exact_count": sum(item.get("source_hash_exact") is True for item in successful),
        "returned_span_exact_count": sum(item.get("all_returned_spans_exact") is True for item in successful),
        "complete_without_start_date_count": sum(item.get("complete_without_start_date") is True for item in successful),
        "source_span_recall": (
            round(total_covered_spans / total_source_spans, 6) if total_source_spans else None
        ),
        "source_span_counts": {
            key: {"covered": slot_covered[key], "total": slot_total[key]}
            for key in sorted(slot_total)
        },
        "latency_ms": {
            "p50": round(statistics.median(latency), 1) if latency else None,
            "p95": _percentile(latency, 0.95),
            "max": round(max(latency), 1) if latency else None,
        },
        "results": results,
        "field_promotion_eligible": False,
        "remaining": [
            "independent human LaoJi field adjudication",
            "speaker-held-out natural quality metrics",
            "Android save and clarification replay",
        ],
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "total": report["total"],
        "success": report["success"],
        "create_model_engine_count": report["create_model_engine_count"],
        "source_span_recall": report["source_span_recall"],
        "p95_ms": report["latency_ms"]["p95"],
    }, ensure_ascii=False))
    return 0 if len(successful) == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
