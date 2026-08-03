#!/usr/bin/env python3
"""Independent structural and semantic-atom audit for the real 10k corpus."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


CONTROLLED_KEYS = (
    "event_concept_key", "oral_style_key", "connector_key", "date_expression_key",
    "time_expression_key", "location_key", "reminder_expression_key", "correction_intent_key",
    "template_signature", "semantic_signature",
)
CASE_ID_RE = re.compile(r"REAL10K-\d{5}")


def load(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def audit(cases: list[dict[str, Any]], maximum: int) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    counters: dict[str, Counter[str]] = {}
    for key in CONTROLLED_KEYS:
        counter = Counter(str(case.get(key)) for case in cases if case.get(key) not in (None, ""))
        counters[key] = counter
        for value, count in counter.items():
            if count > maximum:
                errors.append({"kind": "atom_over_budget", "key": key, "value": value, "count": count})

    texts = [case.get("text") for case in cases]
    signatures = [case.get("semantic_signature") for case in cases]
    if len(set(texts)) != len(texts):
        errors.append({"kind": "duplicate_text", "duplicate_count": len(texts) - len(set(texts))})
    if len(set(signatures)) != len(signatures):
        errors.append({"kind": "duplicate_semantic_signature", "duplicate_count": len(signatures) - len(set(signatures))})
    for case in cases:
        case_id = str(case.get("case_id", ""))
        if not CASE_ID_RE.fullmatch(case_id):
            errors.append({"kind": "invalid_case_id", "case_id": case_id})
        if CASE_ID_RE.search(str(case.get("text", ""))):
            errors.append({"kind": "tracking_id_in_text", "case_id": case_id})
        if case.get("label_source") != "authored_metadata_v1":
            errors.append({"kind": "non_authored_label", "case_id": case_id})
        expected = case.get("expected")
        if expected is not None and not isinstance(expected, dict):
            errors.append({"kind": "invalid_expected_shape", "case_id": case_id})
        if case.get("expected_outcome") == "not_schedule" and expected is not None:
            errors.append({"kind": "negative_has_expected_event", "case_id": case_id})

    family_counts = Counter(str(case.get("family")) for case in cases)
    return {
        "total": len(cases),
        "text_unique": len(set(texts)) == len(texts),
        "semantic_unique": len(set(signatures)) == len(signatures),
        "family_counts": dict(sorted(family_counts.items())),
        "distinct_atom_counts": {key: len(counter) for key, counter in counters.items()},
        "max_atom_counts": {key: max(counter.values(), default=0) for key, counter in counters.items()},
        "errors": errors,
        "passed": len(cases) == 10_000 and not errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--maximum", type=int, default=10)
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    report = audit(load(Path(args.corpus)), args.maximum)
    text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
