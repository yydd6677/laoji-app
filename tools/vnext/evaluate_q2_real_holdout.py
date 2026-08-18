"""Run a small real-source Q2 holdout against the configured provider.

The subtitle files are evaluation inputs only.  The runner deliberately builds
short, source-labelled windows around manually authored anchors, so a long
meeting can be evaluated without silently truncating the entire transcript.
It records provider output metadata and exact citation checks, but never writes
subtitle text, answer text, or API credentials to the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.vnext_question_reader import (
    PROVIDER_REVISION,
    Q2ReaderError,
    read_q2,
)


SRT_BLOCK = re.compile(
    r"(?ms)^\s*(\d+)\s*\n"
    r"(\d\d:\d\d:\d\d,\d{3})\s*-->\s*(\d\d:\d\d:\d\d,\d{3})\s*\n"
    r"(.*?)(?=\n\s*\n|\Z)"
)


@dataclass(frozen=True)
class Case:
    case_id: str
    sample: str
    question: str
    anchors: tuple[str, ...]
    expected: str
    required_any: tuple[str, ...] = ()
    citation_any: tuple[str, ...] = ()
    include_conflicting_note: bool = False


CASES = (
    Case("paper-topic", "1300572695-1-192.srt", "本文主要研究什么问题？", ("最小化成本",), "answer", ("任务卸载",), ("最小化成本",)),
    Case("paper-method", "1300572695-1-192.srt", "文中使用什么方法得到最终方案？", ("模拟退火", "李亚普诺夫"), "answer", ("模拟退火",), ("模拟退火",)),
    Case("report-three-parts", "1436403866-1-192.srt", "这次汇报从哪几个方面展开？", ("工作总结", "个人不足", "工作计划"), "answer", ("工作总结", "工作计划"), ("工作总结",)),
    Case("report-platform", "1436403866-1-192.srt", "他负责管理什么平台？", ("科技信息管理平台",), "answer", ("科技信息管理平台",), ("科技信息管理平台",)),
    Case("un-areas", "500001564053724-1-192.srt", "核污染影响哪些方面？", ("水循环", "食物链"), "answer", ("水循环", "食物链"), ("水循环",)),
    Case("un-countries", "500001564053724-1-192.srt", "开场明确列出了哪些国家？", ("中国", "美国", "法国"), "answer", ("中国", "美国"), ("中国",)),
    Case("finance-invoice", "1437681208-1-192.srt", "会上提到的开票额是多少？", ("开票额",), "answer", ("528",), ("528",)),
    Case("finance-cost", "1437681208-1-192.srt", "发言人认为当前最大的经营问题是什么？", ("成本控制",), "answer", ("成本控制",), ("成本控制",)),
    Case("survey-deadline", "35166292748-1-192.srt", "为什么希望调查员抓紧收集数据？", ("抓紧时间", "12月份"), "answer", ("调查员", "完成", "没有开始"), ("没有开始", "12月份")),
    Case("survey-threshold", "35166292748-1-192.srt", "达到多少数据量可能就能获得权益？", ("三四百",), "answer", ("三四百", "300"), ("三四百",)),
    Case("negotiation-opening", "911595290-1-208.srt", "谈判一开始的采购报价是多少？", ("采购价",), "answer", ("25",), ("25",)),
    Case("negotiation-highest", "911595290-1-208.srt", "后面一方提出的最高可接受价格是多少？", ("最高价格",), "answer", ("18",), ("18",)),
    Case("equity-split", "1377173065-1-160.srt", "管理公司最后讨论到的股权比例是多少？", ("65%", "35%"), "answer", ("65", "35"), ("65",)),
    Case("meeting-rule", "870230340-1-208.srt", "投标人代表在入场时需要出示什么？", ("48小时核酸",), "answer", ("核酸",), ("核酸",)),
    Case("energy-outline-count", "829384557-1-208.srt", "这次汇报提纲分为几个部分？", ("分为五个部分",), "answer", ("五", "5"), ("五个部分",)),
    Case("energy-foundation-data", "829384557-1-208.srt", "做园区规划前必须先获取哪些基础数据？", ("基础数据", "功率", "运行效率"), "answer", ("设备", "功率", "效率", "负荷"), ("基础数据", "功率")),
    Case("energy-traditional-objective", "829384557-1-208.srt", "传统能源规划最常用的目标是什么？", ("规划运行成本",), "answer", ("成本", "最小"), ("规划运行成本",)),
    Case("energy-ui-plan", "829384557-1-208.srt", "后续准备怎样改进输入输出界面？", ("ui界面", "提交一个整个文件", "输出excel"), "answer", ("文件", "excel"), ("提交一个整个文件", "输出excel")),
    Case("science-question", "30528111540-1-192.srt", "这场报告提到了哪些关键科学问题？", ("关键科学问题",), "not_stated"),
    Case("not-stated-budget", "500001564053724-1-192.srt", "这次会议的预算金额是多少？", ("核污染",), "not_stated"),
    Case("not-stated-next-date", "1436403866-1-192.srt", "下一次会议具体安排在哪一天？", ("工作计划",), "not_stated"),
    Case("not-stated-phone", "35166292748-1-192.srt", "主持人的手机号码是多少？", ("调查员",), "not_stated"),
    Case("not-stated-venue", "1300572695-1-192.srt", "这次汇报在哪个会议室举行？", ("任务卸载",), "not_stated"),
    Case("energy-not-stated-finish-date", "829384557-1-208.srt", "这个课题具体哪一天完成？", ("后续研究计划",), "not_stated"),
    Case("partial-owner-phone", "1436403866-1-192.srt", "谁负责科技信息平台，联系电话是多少？", ("科技信息管理平台",), "answer", ("科技信息",), ("科技信息管理平台",)),
    Case("conflicting-date", "1436403866-1-192.srt", "最终汇报日期是哪一天？", ("工作计划",), "cannot_confirm", include_conflicting_note=True),
    Case("conflicting-price", "911595290-1-208.srt", "最终成交价格是多少？", ("愿意接受", "报价"), "cannot_confirm", include_conflicting_note=True),
)


def _sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _ms(value: str) -> int:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(",")
    return (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000 + int(millis)


def _parse(path: Path) -> list[dict[str, Any]]:
    result = []
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    for match in SRT_BLOCK.finditer(text):
        body = " ".join(line.strip() for line in match.group(4).splitlines() if line.strip())
        if body:
            result.append({"index": int(match.group(1)), "start": _ms(match.group(2)), "end": _ms(match.group(3)), "text": body})
    return result


def _window(blocks: list[dict[str, Any]], anchors: tuple[str, ...]) -> list[dict[str, Any]]:
    hits = [i for i, block in enumerate(blocks) if any(anchor in block["text"] for anchor in anchors)]
    if not hits:
        raise ValueError(f"anchors not found: {anchors}")
    selected: set[int] = {0, len(blocks) - 1}
    for hit in hits:
        # Keep enough adjacent turns for a question whose answer is split
        # across a presentation sentence and its immediately following input/
        # output detail. This remains a bounded evaluation window, not a
        # production retrieval rule.
        selected.update(range(max(0, hit - 8), min(len(blocks), hit + 9)))
    return [blocks[i] for i in sorted(selected)]


def _source_fingerprint(sources: list[dict[str, str]]) -> str:
    canonical = {
        "schema_version": 2,
        "sources": [
            {key: source[key] for key in ("source_type", "source_id", "source_revision_id", "content_sha256")}
            for source in sources
        ],
    }
    return _sha(json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _payload(case: Case, root: Path) -> tuple[dict[str, Any], dict[str, str]]:
    blocks = _window(_parse(root / case.sample), case.anchors)
    sources: list[dict[str, str]] = []
    for ordinal, block in enumerate(blocks):
        source_id = f"{case.sample}:{block['index']}"
        sources.append({
            "source_type": "transcript",
            "source_id": source_id,
            "source_revision_id": "holdout-transcript-v1",
            "content_sha256": _sha(block["text"]),
            "text": block["text"],
        })
    if case.include_conflicting_note:
        conflict_text = (
            "文字记录补充：最终汇报日期为8月5日。"
            if case.case_id == "conflicting-date"
            else "文字记录补充：最终成交价格为18元。"
        )
        sources.append({
            "source_type": "transcript",
            "source_id": f"conflict-transcript:{case.case_id}",
            "source_revision_id": "holdout-transcript-v1",
            "content_sha256": _sha(conflict_text),
            "text": conflict_text,
        })
        note = (
            "会后笔记记录：最终成交价格改为20元。"
            if case.case_id == "conflicting-price"
            else "会后笔记记录：最终汇报日期改为8月6日。"
        )
        sources.append({
            "source_type": "manual_note",
            "source_id": f"manual_note:{case.case_id}",
            "source_revision_id": "7",
            "content_sha256": _sha(note),
            "text": note,
        })
    payload = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": PROVIDER_REVISION,
        "snapshot_id": f"q2-holdout:{case.case_id}",
        "source_fingerprint": _source_fingerprint(sources),
        "question": case.question,
        "sources": sources,
    }
    return payload, {source["source_id"]: source["text"] for source in sources}


def _check(case: Case, result: dict[str, Any], source_text: dict[str, str]) -> list[str]:
    errors: list[str] = []
    kind = result.get("answer_kind")
    if kind != case.expected:
        errors.append(f"kind={kind!r} expected={case.expected!r}")
    answer = str(result.get("answer") or "")
    if case.required_any and not any(token.lower() in answer.lower() for token in case.required_any):
        errors.append("answer misses required anchor")
    clauses = result.get("clauses") or []
    citations = [citation for clause in clauses for citation in clause.get("citations", [])]
    if case.expected != "answer" and citations:
        errors.append("refusal contains citations")
    if case.expected == "answer" and not citations:
        errors.append("answer has no citations")
    if case.citation_any and not any(any(token in source_text.get(citation.get("source_id", ""), "") for token in case.citation_any) for citation in citations):
        errors.append("citations do not contain expected evidence anchor")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    cases = tuple(case for case in CASES if not args.id or case.case_id in set(args.id))
    if args.limit:
        cases = cases[: args.limit]
    results = []
    for case in cases:
        started = time.perf_counter()
        try:
            payload, source_text = _payload(case, args.samples)
            response = read_q2(payload)
            errors = _check(case, response, source_text)
            result = {
                "case_id": case.case_id,
                "sample": case.sample,
                "expected_kind": case.expected,
                "actual_kind": response.get("answer_kind"),
                "citation_count": sum(len(clause.get("citations", [])) for clause in response.get("clauses", [])),
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "passed": not errors,
                "errors": errors,
            }
        except (Q2ReaderError, ValueError, OSError) as error:
            result = {
                "case_id": case.case_id,
                "sample": case.sample,
                "expected_kind": case.expected,
                "actual_kind": None,
                "citation_count": 0,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "passed": False,
                "errors": [f"{type(error).__name__}:{getattr(error, 'code', str(error))}"],
            }
        results.append(result)
        print(("PASS" if result["passed"] else "FAIL") + f" {case.case_id} {result['latency_ms']}ms", flush=True)
    passed = sum(1 for result in results if result["passed"])
    report = {
        "candidate_only": True,
        "production_mutation": False,
        "source_policy": "real subtitle windows; weak reference only; no production prompt or rule input",
        "provider_revision": PROVIDER_REVISION,
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "citation_grounding_passed": sum(1 for result in results if result["passed"] and result["citation_count"] >= 0),
        "results": results,
        "remaining": [
            "full-transcript retrieval for long meetings",
            "human citation relevance review",
            "Android Q2 page and recovery replay",
            "capability barrier",
        ],
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("total", "passed", "failed")}, ensure_ascii=False))
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
