"""Route-trace smoke for the forced schedule model path.

The bundled MASSIVE rows are public style references, not LaoJi field truth.
This probe therefore reports only route/model/latency metadata and hashes the
utterance; it must not be presented as schedule accuracy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import Counter
from pathlib import Path

from app.services.schedule_parser_service import parse_schedule_text_sync


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    # Keep the first rows from each public intent so route counts are not
    # dominated by one partition. No row text or source annotation is emitted.
    selected = []
    per_intent: Counter[str] = Counter()
    for row in rows:
        intent = str(row.get("intent") or row.get("scenario") or "unknown")
        if per_intent[intent] >= max(1, args.limit // 3):
            continue
        selected.append(row)
        per_intent[intent] += 1
        if len(selected) >= args.limit:
            break
    os.environ["SCHEDULE_FORCE_LLM"] = "1"
    results = []
    for ordinal, row in enumerate(selected):
        text = str(row.get("utt") or row.get("text") or "").strip()
        if not text:
            continue
        started = time.perf_counter()
        try:
            output = parse_schedule_text_sync(
                text,
                reference_datetime="2026-08-18T09:00:00+08:00",
                timezone_name="Asia/Shanghai",
                model_only=True,
            )
            error = None
        except Exception as exc:  # keep per-row evidence without leaking text
            output = None
            error = type(exc).__name__
        latency = round((time.perf_counter() - started) * 1000, 1)
        results.append({
            "ordinal": ordinal,
            "source_row_sha256": "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "intent": str(row.get("intent") or "unknown"),
            "route": output.get("route") if isinstance(output, dict) else None,
            "result_kind": "object" if isinstance(output, dict) else "null" if error is None else "error",
            "model_attempted": bool(output.get("model_attempted")) if isinstance(output, dict) else None,
            "model_success": bool(output.get("model_success")) if isinstance(output, dict) else None,
            "fallback_used": bool(output.get("fallback_used")) if isinstance(output, dict) else None,
            "parse_source": output.get("parse_source") if isinstance(output, dict) else None,
            "model_id": output.get("model_id") if isinstance(output, dict) else None,
            "latency_ms": latency,
            "error": error,
        })
    route_counts = Counter(
        (
            item.get("route") or "model_null"
            if item.get("result_kind") in {"object", "null"}
            else "error"
        )
        for item in results
    )
    report = {
        "candidate_only": True,
        "production_mutation": False,
        "source_policy": "MASSIVE zh-CN public style reference; route smoke only, no field accuracy claim",
        "forced_model": True,
        "total": len(results),
        "route_counts": dict(route_counts),
        "model_success": sum(1 for item in results if item.get("model_success")),
        "model_failures": sum(1 for item in results if item.get("model_attempted") and not item.get("model_success")),
        "p95_latency_ms": sorted(item["latency_ms"] for item in results)[max(0, int(len(results) * 0.95) - 1)] if results else 0,
        "results": results,
        "remaining": [
            "independent LaoJi field annotations",
            "speaker-held-out natural quality metrics",
            "schedule Graph capability barrier and device replay",
        ],
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("total", "route_counts", "model_success", "model_failures", "p95_latency_ms")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
