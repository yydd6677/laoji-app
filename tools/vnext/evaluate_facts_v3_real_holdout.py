"""Evaluate Facts V3 on real subtitle windows without promoting sample text.

This is an isolated quality probe. Subtitle content is used to build a bounded
EvidencePackage, while the report stores only hashes, counts and gate results.
Production prompts and source code never receive sample-specific instructions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from app.services.summary_v3_evidence import build_evidence_package
from app.services.summary_v3_generator import SummaryV3GenerationError, generate_verified_document


SRT_BLOCK = re.compile(
    r"(?ms)^\s*(\d+)\s*\n"
    r"(\d\d:\d\d:\d\d,\d{3})\s*-->\s*(\d\d:\d\d:\d\d,\d{3})\s*\n"
    r"(.*?)(?=\n\s*\n|\Z)"
)

CASES = (
    ("paper", "1300572695-1-192.srt", ("最小化成本", "任务卸载"), ("任务卸载",)),
    # Weak lexical references are deliberately allowed to be paraphrases of
    # the subtitle heading.  This case is an annual report where the model may
    # correctly render "年度工作、不足及计划" without copying both headings.
    ("report", "1436403866-1-192.srt", ("工作总结", "工作计划"), ("年度工作", "计划")),
    ("un", "500001564053724-1-192.srt", ("核污染", "水循环"), ("核污染", "水循环")),
    ("finance", "1437681208-1-192.srt", ("营收", "成本控制"), ("营收", "成本")),
    ("survey", "35166292748-1-192.srt", ("收集", "调查员"), ("收集", "数据")),
    ("negotiation", "911595290-1-208.srt", ("报价", "价格"), ("报价", "价格")),
    ("equity", "1377173065-1-160.srt", ("股权比例", "利润分配"), ("股权",)),
    ("tender", "870230340-1-208.srt", ("评标", "核酸"), ("评标",)),
)


def _ms(value: str) -> int:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(",")
    return (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000 + int(millis)


def _parse(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    values = []
    for match in SRT_BLOCK.finditer(text):
        body = " ".join(line.strip() for line in match.group(4).splitlines() if line.strip())
        if body:
            values.append({"index": int(match.group(1)), "start": _ms(match.group(2)), "end": _ms(match.group(3)), "text": body})
    return values


def _window(blocks: list[dict[str, Any]], anchors: tuple[str, ...]) -> list[dict[str, Any]]:
    hits = [i for i, block in enumerate(blocks) if any(anchor in block["text"] for anchor in anchors)]
    if not hits:
        raise ValueError(f"anchors not found: {anchors}")
    selected: set[int] = {0, len(blocks) - 1}
    for hit in hits:
        selected.update(range(max(0, hit - 5), min(len(blocks), hit + 6)))
    return [blocks[index] for index in sorted(selected)]


def _sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _build(case: tuple[str, str, tuple[str, ...], tuple[str, ...]], root: Path):
    case_id, sample, anchors, _ = case
    lines = [
        {
            "id": f"{sample}:{block['index']}",
            "start_ms": block["start"],
            "end_ms": block["end"],
            "speaker": None,
            "text": block["text"],
        }
        for block in _window(_parse(root / sample), anchors)
    ]
    return build_evidence_package(lines, None, None), lines


def _evaluate(case: tuple[str, str, tuple[str, ...], tuple[str, ...]], root: Path) -> dict[str, Any]:
    case_id, sample, _, expected = case
    started = time.perf_counter()
    try:
        package, lines = _build(case, root)
        output = generate_verified_document(package)
        document = output["document"]
        facts = document.get("facts", [])
        actions = document.get("action_candidates", [])
        fact_text = " ".join(str(item.get("content") or "") for item in facts)
        action_text = [str(item.get("content") or "") for item in actions]
        errors: list[str] = []
        if output.get("model_calls") not in {1, 2}:
            errors.append("model_calls_not_1_or_2")
        if not facts:
            errors.append("no_verified_facts")
        if expected and not any(token in fact_text for token in expected):
            errors.append("expected_topic_not_in_verified_facts")
        normalized_actions = {re.sub(r"[\s，。；;、]+", "", item) for item in action_text}
        if len(normalized_actions) != len(action_text):
            errors.append("duplicate_action_candidates")
        broad_action = re.compile(r"(?:加强|强化|提升|完善|推动|促进|持续推进|共同研发|鼓励和支持|加大(?:对|在)?|建立[^。！？；]{0,24}(?:体系|网络|机制|平台)|形成[^。！？；]{0,24}(?:体系|网络|机制))")
        finite_action = re.compile(r"(?:提交|发送|整理|修复|完成|确认|准备|安排|召开|测试|评估|发布|交付|申请|预约|提供|编写|补齐|跟进|处理)")
        if any(
            broad_action.search(str(item.get("content") or ""))
            and not finite_action.search(str(item.get("content") or ""))
            and str(item.get("schedule_fit") or "") != "low"
            for item in actions
        ):
            errors.append("macro_goal_presented_as_action")
        result = {
            "case_id": case_id,
            "sample": sample,
            "source_sha256": _sha("\n".join(line["text"] for line in lines)),
            "source_segments": len(lines),
            "estimated_input_tokens": package.estimated_tokens,
            "coverage": {
                "total_segments": package.coverage.get("total_segments"),
                "included_segments": package.coverage.get("included_segments"),
                "source_coverage": package.coverage.get("source_coverage"),
                "used_embeddings": package.coverage.get("used_embeddings"),
            },
            "model_calls": output.get("model_calls"),
            "facts": len(facts),
            "actions": len(actions),
            "passed": not errors,
            "errors": errors,
        }
    except (SummaryV3GenerationError, ValueError, OSError) as error:
        result = {
            "case_id": case_id,
            "sample": sample,
            "source_sha256": None,
            "source_segments": 0,
            "estimated_input_tokens": 0,
            "model_calls": None,
            "facts": 0,
            "actions": 0,
            "passed": False,
            "errors": [f"{type(error).__name__}:{getattr(error, 'code', str(error))}"],
        }
    result["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
    print(("PASS" if result["passed"] else "FAIL") + f" {case_id} {result['latency_ms']}ms", flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    cases = tuple(case for case in CASES if not args.id or case[0] in set(args.id))
    if args.limit:
        cases = cases[: args.limit]
    results = [_evaluate(case, args.samples) for case in cases]
    passed = sum(1 for result in results if result["passed"])
    report = {
        "candidate_only": True,
        "production_mutation": False,
        "source_policy": "real subtitle windows; weak reference only; no production prompt or rule input",
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "results": results,
        "remaining": [
            "full long-meeting source-stream quality",
            "human fact support and action usefulness review",
            "Android summary page and recovery replay",
            "Facts V3 capability barrier",
        ],
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("total", "passed", "failed")}, ensure_ascii=False))
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
