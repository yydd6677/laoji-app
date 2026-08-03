#!/usr/bin/env python3
"""Verify that a real-HTTP run contains one complete record per corpus case."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    corpus = load_lines(Path(args.corpus))
    results = load_lines(Path(args.results))
    expected_by_id = {item["case_id"]: item for item in corpus}
    errors: list[dict[str, Any]] = []
    seen: set[str] = set()
    status_counts: Counter[str] = Counter()
    pass_count = 0
    for row in results:
        case_id = str(row.get("case_id", ""))
        if case_id in seen:
            errors.append({"kind": "duplicate_case", "case_id": case_id})
        seen.add(case_id)
        case = expected_by_id.get(case_id)
        if case is None:
            errors.append({"kind": "unknown_case", "case_id": case_id})
            continue
        http = row.get("http") or {}
        labels = row.get("labels") or {}
        input_data = row.get("input") or {}
        if http.get("endpoint", "").rstrip("/").endswith("/diagnostics/parse-quality"):
            errors.append({"kind": "batch_endpoint_used", "case_id": case_id})
        if http.get("method") != "POST" or not http.get("endpoint", "").endswith("/api/laoji/parse"):
            errors.append({"kind": "wrong_http_boundary", "case_id": case_id, "endpoint": http.get("endpoint"), "method": http.get("method")})
        if not isinstance(http.get("request"), dict) or not isinstance(http.get("response_raw"), str):
            errors.append({"kind": "missing_raw_http_evidence", "case_id": case_id})
        if input_data.get("input_sha256") != case.get("input_sha256"):
            errors.append({"kind": "input_hash_mismatch", "case_id": case_id})
        if labels.get("expected") != case.get("expected") or labels.get("label_source") != "authored_metadata_v1":
            errors.append({"kind": "label_mismatch_or_non_independent", "case_id": case_id})
        if not isinstance(row.get("evaluation"), dict):
            errors.append({"kind": "missing_evaluation", "case_id": case_id})
        if row.get("evaluation", {}).get("passed"):
            pass_count += 1
        status_counts[str(http.get("status"))] += 1

    missing = sorted(set(expected_by_id) - seen)
    for case_id in missing:
        errors.append({"kind": "missing_case", "case_id": case_id})
    report = {
        "corpus_total": len(corpus),
        "result_total": len(results),
        "unique_result_cases": len(seen),
        "missing_count": len(missing),
        "status_counts": dict(sorted(status_counts.items())),
        "passed_count": pass_count,
        "failed_count": len(results) - pass_count,
        "errors": errors,
        "passed": len(corpus) == 10_000 and len(results) == 10_000 and not errors,
        "evidence_type": "real_http_per_case_verified",
    }
    text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
