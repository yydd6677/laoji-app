#!/usr/bin/env python3
"""Evaluate current Facts V3 against an external semantic manifest.

The manifest is evaluation data only.  Production prompts and validators never
read it.  The persisted report is content-free: it records case identifiers,
counts, hashes, latency and stable issue codes, but not transcript, expected
phrases, generated facts, actions, quotes or credentials.
"""

from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys
import time
from typing import Any

from app.services.summary_v3_evidence import EvidencePackage, build_evidence_package
from app.services.summary_v3_generator import (
    SummaryV3GenerationError,
    _system_prompt,
    generate_verified_document,
)


_TEMPORAL_TEXT = re.compile(
    r"(?:今天|明天|后天|本周|下周|本月|下月|月底|年底|"
    r"周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|凌晨|"
    r"\d{1,4}(?:年|月|日|号|点|时|分))",
)
_NON_DECISION_META = re.compile(
    r"(?:本次|今天|会议)?[^。；]{0,12}(?:没有|未形成|不作|无)(?:任何)?"
    r"(?:业务)?(?:决策|决定|结论)|"
    r"(?:暂不|尚未|未)[^。；]{0,12}(?:决定|决策|形成结论)|"
    r"(?:没有|未形成|未产生|无)(?:任何)?(?:新的?)?行动项|"
    r"不是[^。；]{0,20}(?:内部)?决策",
)
_SEMANTIC_EQUIVALENTS = (
    ("保持现有", "不变"),
    ("保持原有", "不变"),
    ("保留现有", "不变"),
    ("维持现状", "不变 保留现状"),
    ("维持当前状态", "不变 保留现状"),
    ("当前状态不变", "不变 保留现状"),
)


def _load_manifest(path: str) -> tuple[dict[str, Any], str]:
    raw = sys.stdin.buffer.read() if path == "-" else Path(path).read_bytes()
    return json.loads(raw.decode("utf-8")), "sha256:" + hashlib.sha256(raw).hexdigest()


def _build_lines(case: dict[str, Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    def append_line(speaker: str, text: str) -> None:
        cleaned = re.sub(rf"^{re.escape(speaker)}[：:]\s*", "", str(text).strip())
        index = len(lines)
        lines.append({
            "id": f"{case['id']}-segment-{index}",
            "speaker": speaker,
            "text": cleaned,
            "start_ms": index * 8_000,
            "end_ms": index * 8_000 + 7_000,
        })

    def append_generated(block: dict[str, Any]) -> None:
        start_index = int(block.get("start_index", 1))
        speaker_template = str(block.get("speaker_template", "成员{index}"))
        text_template = str(block.get("text_template", block.get("template", "")))
        for offset in range(int(block["count"])):
            index = start_index + offset
            append_line(
                speaker_template.format(index=index),
                text_template.format(index=index),
            )

    if case.get("timeline"):
        for entry in case["timeline"]:
            if "generated" in entry:
                append_generated(entry["generated"])
            else:
                append_line(str(entry["speaker"]), str(entry["text"]))
        return lines
    if case.get("generated_context"):
        append_generated(case["generated_context"])
    for line in case.get("transcript") or []:
        append_line(str(line["speaker"]), str(line["text"]))
    return lines


def _semantic_text(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False).lower()
    for source, target in _SEMANTIC_EQUIVALENTS:
        encoded = encoded.replace(source, target)
    return encoded


def _contains_all(value: Any, terms: list[str]) -> bool:
    encoded = _semantic_text(value)
    return all(str(term).lower() in encoded for term in terms)


def _contains_any(value: Any, terms: list[str]) -> bool:
    encoded = _semantic_text(value)
    return any(str(term).lower() in encoded for term in terms)


def _rows_contain_all(rows: list[dict[str, Any]], terms: list[str]) -> bool:
    return any(_contains_all(str(row.get("content") or ""), terms) for row in rows)


def _confirmed_business_facts(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        fact for fact in document.get("facts") or []
        if fact.get("certainty") == "confirmed"
        and not _NON_DECISION_META.search(str(fact.get("content") or ""))
    ]


def _decision_facts(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        fact for fact in document.get("facts") or []
        if fact.get("fact_type") in {"conclusion", "timeline"}
        and fact.get("certainty") == "confirmed"
        and not _NON_DECISION_META.search(str(fact.get("content") or ""))
    ]


def _action_rows(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [{
        "content": action.get("content") or "",
        "assignee": action.get("owner"),
        "due": action.get("due_text"),
        "schedule_fit": action.get("schedule_fit"),
        "fact_id": action.get("fact_id"),
    } for action in document.get("action_candidates") or []]


def _due_matches(
    action: dict[str, Any],
    requirement: dict[str, Any],
    document: dict[str, Any],
) -> bool:
    expected = requirement.get("due_any") or []
    if not expected:
        return True
    due = action.get("due")
    if due is None:
        return any(value in {"N/A", "待定", "TBD"} for value in expected)
    if _contains_any(due, expected):
        return True
    facts = {fact.get("fact_id"): fact for fact in document.get("facts") or []}
    fact = facts.get(action.get("fact_id")) or {}
    quotes = " ".join(str(source.get("quote") or "") for source in fact.get("sources") or [])
    return bool(_TEMPORAL_TEXT.search(str(due))) and re.sub(r"\s+", "", str(due)) in re.sub(
        r"\s+", "", quotes,
    )


def _evaluate_semantics(document: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    decisions = _decision_facts(document)
    facts = _confirmed_business_facts(document)
    actions = _action_rows(document)
    calendar_actions = [
        action for action in actions if action.get("schedule_fit") in {"high", "medium"}
    ]
    overview = (document.get("overview") or {}).get("text") or ""

    for index, group in enumerate(expected.get("overview_groups", []), start=1):
        if not _contains_all(overview, group):
            issues.append(f"overview_missing:{index}")
    for index, group in enumerate(expected.get("overview_forbidden_groups", []), start=1):
        if _contains_all(overview, group):
            issues.append(f"overview_forbidden:{index}")
    for index, group in enumerate(expected.get("decision_groups", []), start=1):
        if not _rows_contain_all(facts, group):
            issues.append(f"decision_missing:{index}")
    for index, group in enumerate(expected.get("decision_forbidden_groups", []), start=1):
        if _rows_contain_all(decisions, group):
            issues.append(f"decision_forbidden:{index}")

    if len(decisions) < int(expected.get("min_decisions", 0)):
        issues.append("too_few_decisions")
    if len(decisions) > int(expected.get("max_decisions", 10_000)):
        issues.append("too_many_decisions")
    if len(calendar_actions) < int(expected.get("min_actions", 0)):
        issues.append("too_few_actions")
    if len(calendar_actions) > int(expected.get("max_actions", 10_000)):
        issues.append("too_many_actions")
    for index, group in enumerate(expected.get("action_forbidden_groups", []), start=1):
        if _contains_all(actions, group):
            issues.append(f"action_forbidden:{index}")

    for index, requirement in enumerate(expected.get("actions", []), start=1):
        matches = [
            action for action in actions
            if _contains_all(action.get("content"), requirement.get("content_all", []))
        ]
        if not matches:
            issues.append(f"action_missing:{index}")
            continue
        owners = requirement.get("assignee_any") or []
        owner_matches = matches
        if owners:
            owner_matches = [
                action for action in matches
                if _contains_any(action.get("assignee"), owners)
                or (
                    action.get("assignee") is None
                    and any(value in {"待定", "N/A", "TBD"} for value in owners)
                )
            ]
            if not owner_matches:
                issues.append(f"action_assignee:{index}")
        candidate_pool = owner_matches or matches
        due_matches = [
            action for action in candidate_pool
            if _due_matches(action, requirement, document)
        ]
        match = (due_matches or candidate_pool)[0]
        if requirement.get("due_any") and not due_matches:
            issues.append(f"action_due:{index}")
        if requirement.get("assignee_forbidden") and any(
            _contains_any(action.get("assignee"), requirement["assignee_forbidden"])
            for action in matches
        ):
            issues.append(f"action_forbidden_assignee:{index}")
        if requirement.get("due_forbidden") and _contains_any(
            match.get("due"), requirement["due_forbidden"],
        ):
            issues.append(f"action_forbidden_due:{index}")
    return issues


def _duplicate_action_count(document: dict[str, Any]) -> int:
    actions = document.get("action_candidates") or []
    normalized = [
        re.sub(r"[^0-9A-Za-z\u3400-\u9fff]", "", str(action.get("content") or "")).lower()
        for action in actions
    ]
    return sum(
        1
        for left_index, left in enumerate(normalized)
        for right in normalized[left_index + 1:]
        if left and SequenceMatcher(None, left, right).ratio() >= 0.86
    )


def _citation_counts(document: dict[str, Any], package: EvidencePackage) -> tuple[int, int]:
    sources = package.source_map()
    checked = 0
    matched = 0
    for fact in document.get("facts") or []:
        for citation in fact.get("sources") or []:
            checked += 1
            source = sources.get(str(citation.get("source_id") or ""))
            quote = citation.get("quote")
            if source is None or not isinstance(quote, str):
                continue
            normalized_quote = re.sub(r"\s+", " ", quote).strip()
            normalized_source = re.sub(r"\s+", " ", source.text).strip()
            if (
                normalized_quote
                and normalized_quote in normalized_source
                and citation.get("source_type") == source.source_type
                and citation.get("content_hash") == source.content_hash
            ):
                matched += 1
    return checked, matched


def _prompt_pollution(manifest: dict[str, Any]) -> list[dict[str, str]]:
    prompt = _system_prompt()
    prompt_cjk = "".join(re.findall(r"[\u3400-\u9fff]", prompt))
    findings: list[dict[str, str]] = []
    for case in manifest.get("cases") or []:
        case_id = str(case.get("id") or "")
        title = str(case.get("title") or "").strip()
        if title and title in prompt:
            findings.append({"case_id": case_id, "kind": "title"})
        for line in _build_lines(case):
            source_cjk = "".join(re.findall(r"[\u3400-\u9fff]", str(line.get("text") or "")))
            if any(source_cjk[index:index + 16] in prompt_cjk for index in range(max(0, len(source_cjk) - 15))):
                findings.append({"case_id": case_id, "kind": "overlap16"})
                break
    return findings


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="JSON path or - for stdin")
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument(
        "--show-content",
        action="store_true",
        help="print transient source/expectation/document records to stderr for manual review",
    )
    args = parser.parse_args()
    manifest, manifest_sha256 = _load_manifest(args.manifest)
    selected_ids = set(args.id)
    cases = [
        case for case in manifest.get("cases") or []
        if not selected_ids or str(case.get("id") or "") in selected_ids
    ]
    results: list[dict[str, Any]] = []
    latencies: list[float] = []
    for ordinal, case in enumerate(cases, start=1):
        case_id = str(case.get("id") or "")
        started = time.perf_counter()
        try:
            lines = _build_lines(case)
            package = build_evidence_package(lines, None, None)
            generated = generate_verified_document(package)
            document = generated["document"]
            issues = _evaluate_semantics(document, case.get("expect") or {})
            duplicate_actions = _duplicate_action_count(document)
            if duplicate_actions:
                issues.append("duplicate_actions")
            citation_count, exact_citations = _citation_counts(document, package)
            if citation_count != exact_citations:
                issues.append("citation_not_exact")
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            latencies.append(elapsed_ms)
            result = {
                "case_id": case_id,
                "input_sha256": "sha256:" + hashlib.sha256(
                    "\n".join(str(line["text"]) for line in lines).encode("utf-8")
                ).hexdigest(),
                "input_segments": len(lines),
                "included_segments": int(package.coverage.get("included_segments") or 0),
                "used_embeddings": bool(package.coverage.get("used_embeddings")),
                "priority_sources": len(package.model_payload().get("priority_source_ids") or []),
                "estimated_input_tokens": package.estimated_tokens,
                "model_calls": generated.get("model_calls"),
                "facts": len(document.get("facts") or []),
                "relations": len(document.get("relations") or []),
                "actions": len(document.get("action_candidates") or []),
                "citations": citation_count,
                "exact_citations": exact_citations,
                "duplicate_actions": duplicate_actions,
                "elapsed_ms": elapsed_ms,
                "passed": not issues,
                "issues": issues,
            }
            if args.show_content:
                print("REVIEW " + json.dumps({
                    "case_id": case_id,
                    "sources": lines,
                    "expect": case.get("expect") or {},
                    "document": document,
                }, ensure_ascii=False, separators=(",", ":")), file=sys.stderr, flush=True)
        except (SummaryV3GenerationError, ValueError, OSError) as error:
            result = {
                "case_id": case_id,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "passed": False,
                "issues": [f"exception:{getattr(error, 'code', type(error).__name__)}"],
            }
        results.append(result)
        print(
            f"[{ordinal}/{len(cases)}] {'PASS' if result['passed'] else 'FAIL'} "
            f"{case_id} {result['elapsed_ms']}ms issues={len(result['issues'])}",
            flush=True,
        )

    pollution = _prompt_pollution(manifest)
    passed = sum(1 for result in results if result["passed"])
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "manifest_sha256": manifest_sha256,
        "manifest_policy": "external evaluation data only; content-free persisted report",
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "first_schema_valid": sum(result.get("model_calls") == 1 for result in results),
        "valid_after_repair": sum(result.get("model_calls") in {1, 2} for result in results),
        "all_exact_citations": all(
            result.get("citations") == result.get("exact_citations")
            for result in results if result.get("citations") is not None
        ),
        "duplicate_action_cases": sum(bool(result.get("duplicate_actions")) for result in results),
        "latency_ms": {
            "count": len(latencies),
            "p50": round(statistics.median(latencies), 1) if latencies else None,
            "p95": round(_percentile(latencies, 0.95) or 0, 1) if latencies else None,
            "max": round(max(latencies), 1) if latencies else None,
        },
        "few_shot_count": 0,
        "prompt_pollution_count": len(pollution),
        "prompt_pollution": pollution,
        "results": results,
        "remaining": [
            "independent blind fact support and action usefulness review",
            "complete real-meeting omission review",
            "capability barrier",
        ],
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        key: report[key] for key in (
            "total", "passed", "failed", "first_schema_valid",
            "all_exact_citations", "duplicate_action_cases", "latency_ms",
            "prompt_pollution_count",
        )
    }, ensure_ascii=False), flush=True)
    return 0 if not report["failed"] and not pollution else 1


if __name__ == "__main__":
    raise SystemExit(main())
