"""Compare real evidence reviewers with fixed claims, not regenerated answers.

Prepared cases are private diagnostic data. Captured review inputs may also be
loaded without replaying or counting their reader calls. This does not measure
reader completeness, end-to-end latency or natural-language acceptance rates.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time


def captured_cases(path):
    cases = []
    for line in path.read_text().splitlines():
        row = json.loads(line)
        for call in row.get("calls", []):
            if call.get("phase") == "review":
                if not isinstance(call.get("input"), dict):
                    raise ValueError("captured_review_input_required")
                value = call["input"]
                cases.append({"kind": "captured_generation_fixed_claims",
                    "question": value["question"],
                    "claims": [{"text": claim["text"], "citations": list(claim["evidence"].values())}
                               for claim in value["claims"]],
                    "context": value["context_in_source_order"]})
    return cases


def main(args):
    if args.runtime_pid:
        environment = Path(f"/proc/{args.runtime_pid}/environ").read_bytes().split(b"\0")
        os.environ.update({k.decode(): v.decode() for row in environment
            if (kv := row.partition(b"="))[1] for k, v in [(kv[0], kv[2])]})
    from app.services import question_evidence_verifier as baseline
    spec = importlib.util.spec_from_file_location("app.services._candidate_evidence_review", args.candidate)
    candidate = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = candidate
    spec.loader.exec_module(candidate)
    cases = json.loads(args.cases.read_text()) if args.cases else []
    for path in args.captured:
        cases.extend(captured_cases(path))
    if not cases:
        raise ValueError("private_comparison_cases_required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        for index, case in enumerate(cases):
            # Alternate order to avoid always giving one variant a warm runner.
            variants = [("baseline", baseline), ("candidate", candidate)]
            if index % 2:
                variants.reverse()
            for name, owner in variants:
                captures = []
                original = owner.call_llm

                def observe(*a, **kw):
                    start = time.monotonic()
                    capture = {"operation": kw.get("telemetry_operation")}
                    try:
                        raw = original(*a, **kw)
                        capture["raw"] = raw
                        return raw
                    except Exception as error:
                        capture["error_type"] = type(error).__name__
                        raise
                    finally:
                        capture["wall_ms"] = round((time.monotonic() - start) * 1000)
                        captures.append(capture)

                owner.call_llm = observe
                row = {"ordinal": index + 1, "variant": name, "kind": case.get("kind"),
                       "question": case["question"], "claims": case["claims"], "context": case["context"]}
                start = time.monotonic()
                try:
                    row["retained"] = owner.verify_claims(case["question"], case["claims"], case["context"])
                except Exception as error:
                    row["error"] = type(error).__name__
                finally:
                    owner.call_llm = original
                row.update(calls=captures, wall_ms=round((time.monotonic() - start) * 1000))
                if "expected_retained" in case:
                    row["controlled_oracle_matches"] = (not row.get("error") and
                        [claim["text"] for claim in row["retained"]] == case["expected_retained"])
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(json.dumps({key: row[key] for key in
                    ("ordinal", "variant", "wall_ms", "error", "controlled_oracle_matches") if key in row}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--cases", type=Path)
    parser.add_argument("--captured", type=Path, action="append", default=[])
    parser.add_argument("--runtime-pid", type=int)
    parser.add_argument("--output", required=True, type=Path)
    main(parser.parse_args())
