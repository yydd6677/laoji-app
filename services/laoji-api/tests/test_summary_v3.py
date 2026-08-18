from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest

from app.config import settings
from app.schemas.meeting_facts_v3 import (
    MeetingFactsModelResponseV3,
    OverviewV3,
    model_response_json_schema,
)
from app.services import (
    device_identity,
    summary_task_store,
    summary_v3_evidence,
    summary_v3_generator,
    summary_v3_store,
)
from app.workers.summary_tasks import get_submitted_summary_status
from app.services.summary_v3_evidence import (
    SummaryEvidenceIncomplete,
    build_evidence_package,
    normalize_sources,
)


def digest(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def package():
    return build_evidence_package(
        [
            {
                "id": "segment-a",
                "speaker": "讲话人 1",
                "text": "确认由林清在明天下午提交界面复核清单。",
                "start": 1.0,
                "end": 4.0,
            },
            {
                "id": "segment-b",
                "speaker": "讲话人 2",
                "text": "刚才的截止时间不确定，需要会后再确认。",
                "start": 5.0,
                "end": 8.0,
            },
        ],
        {"revision": 2, "content": "笔记里记录了需要保留引用。"},
        [],
    )


def valid_response(active_package=None) -> dict:
    current = active_package or package()
    first = current.sources[0]
    second = current.sources[1]
    return {
        "schema_version": 3,
        "overview": {"text": "已确认界面复核清单的提交安排，期限仍需复核。", "fact_ids": ["f1", "f2"]},
        "facts": [
            {
                "fact_id": "f1",
                "fact_type": "action",
                "certainty": "confirmed",
                "content": "林清在明天下午提交界面复核清单",
                "sources": [
                    {
                        "source_id": first.source_id,
                        "source_type": first.source_type,
                        "quote": "由林清在明天下午提交界面复核清单",
                        "content_hash": first.content_hash,
                    }
                ],
            },
            {
                "fact_id": "f2",
                "fact_type": "timeline",
                "certainty": "uncertain",
                "content": "截止时间需要会后确认",
                "sources": [
                    {
                        "source_id": second.source_id,
                        "source_type": second.source_type,
                        "quote": "截止时间不确定，需要会后再确认",
                        "content_hash": second.content_hash,
                    }
                ],
            },
        ],
        "relations": [{"relation_type": "depends_on", "from_fact_id": "f1", "to_fact_id": "f2"}],
        "action_candidates": [
            {
                "action_id": "a1",
                "fact_id": "f1",
                "content": "提交界面复核清单",
                "owner": "林清",
                "due_text": "明天下午",
                "schedule_fit": "high",
            }
        ],
    }


def test_valid_document_backfills_timestamps_and_scores():
    active_package = package()
    response = MeetingFactsModelResponseV3.model_validate(valid_response(active_package))
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.schema_version == 3
    assert document.facts[0].sources[0].start_ms == 1000
    assert document.facts[0].sources[0].end_ms == 4000
    assert document.facts[0].evidence_score > 0
    assert document.action_candidates[0].owner == "林清"


def test_invalid_citation_drops_only_affected_fact():
    active_package = package()
    value = valid_response(active_package)
    value["facts"][1]["sources"][0]["quote"] = "来源中不存在的句子"
    value["overview"] = {"text": "已确认界面复核清单的提交安排。", "fact_ids": ["f1"]}
    value["relations"] = []
    response = MeetingFactsModelResponseV3.model_validate(value)
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert [fact.fact_id for fact in document.facts] == ["f1"]


def test_unsupported_action_owner_or_relative_time_drops_the_fact():
    active_package = package()
    value = valid_response(active_package)
    value["facts"][0]["content"] = "王强在今天下午提交界面复核清单"
    value["overview"] = {"text": "截止时间需要会后确认。", "fact_ids": ["f2"]}
    value["relations"] = []
    response = MeetingFactsModelResponseV3.model_validate(value)
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert [fact.fact_id for fact in document.facts] == ["f2"]
    assert document.action_candidates == []


def test_supported_action_owner_and_relative_time_remain_valid():
    active_package = package()
    response = MeetingFactsModelResponseV3.model_validate(valid_response(active_package))
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.facts[0].content == "林清在明天下午提交界面复核清单"
    assert document.action_candidates[0].owner == "林清"


def test_unadopted_proposal_remains_candidate_but_is_not_calendar_ready():
    active_package = build_evidence_package(
        [{
            "id": "proposal",
            "speaker": "主持人",
            "text": "我们提议开发智能宠物项圈，先作为方向讨论。",
            "start_ms": 0,
            "end_ms": 3_000,
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "会议讨论智能宠物项圈方向。", "fact_ids": ["f1"]},
        "facts": [{
            "fact_id": "f1",
            "fact_type": "action",
            "certainty": "confirmed",
            "content": "提议开发智能宠物项圈",
            "sources": [{
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.text,
                "content_hash": source.content_hash,
            }],
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "a1",
            "fact_id": "f1",
            "content": "开发智能宠物项圈",
            "owner": None,
            "due_text": None,
            "schedule_fit": "high",
        }],
    })

    document = summary_v3_generator.verify_model_response(response, active_package)

    assert document.facts[0].certainty == "proposed"
    assert document.action_candidates[0].schedule_fit == "low"


def test_proposal_with_explicit_adoption_stays_confirmed():
    active_package = build_evidence_package(
        [{
            "id": "adopted-proposal",
            "speaker": "主持人",
            "text": "先提议开发智能宠物项圈，最终确认采用这个方案。",
            "start_ms": 0,
            "end_ms": 3_000,
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "最终确认采用智能宠物项圈方案。", "fact_ids": ["f1"]},
        "facts": [{
            "fact_id": "f1",
            "fact_type": "action",
            "certainty": "confirmed",
            "content": "最终确认采用智能宠物项圈方案",
            "sources": [{
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.text,
                "content_hash": source.content_hash,
            }],
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "a1",
            "fact_id": "f1",
            "content": "采用智能宠物项圈方案",
            "owner": None,
            "due_text": None,
            "schedule_fit": "high",
        }],
    })

    document = summary_v3_generator.verify_model_response(response, active_package)

    assert document.facts[0].certainty == "confirmed"
    assert document.action_candidates[0].schedule_fit == "high"


def test_rejected_proposal_is_not_an_action_candidate():
    active_package = build_evidence_package(
        [{
            "id": "rejected-proposal",
            "speaker": "主持人",
            "text": "有人建议开发智能宠物项圈，但最终不采用。",
            "start_ms": 0,
            "end_ms": 3_000,
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "会议否决了智能宠物项圈建议。", "fact_ids": ["f1"]},
        "facts": [{
            "fact_id": "f1",
            "fact_type": "action",
            "certainty": "confirmed",
            "content": "建议开发智能宠物项圈，但最终不采用",
            "sources": [{
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.text,
                "content_hash": source.content_hash,
            }],
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "a1",
            "fact_id": "f1",
            "content": "开发智能宠物项圈",
            "owner": None,
            "due_text": None,
            "schedule_fit": "high",
        }],
    })

    document = summary_v3_generator.verify_model_response(response, active_package)

    assert document.facts[0].certainty == "negated"
    assert document.action_candidates == []


def test_speaker_self_reference_supports_the_action_owner():
    active_package = build_evidence_package(
        [{
            "id": "self-owner",
            "speaker": "李工",
            "text": "登录页崩溃我负责，2026 年 7 月 15 日前修复并提测。",
            "start_ms": 1_000,
            "end_ms": 4_000,
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "李工负责修复登录页崩溃。", "fact_ids": ["f1"]},
        "facts": [{
            "fact_id": "f1",
            "fact_type": "action",
            "certainty": "confirmed",
            "content": "李工负责修复登录页崩溃，并于 2026 年 7 月 15 日前修复并提测",
            "sources": [{
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.text,
                "content_hash": source.content_hash,
            }],
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "a1",
            "fact_id": "f1",
            "content": "修复并提测登录页崩溃",
            "owner": "我",
            "due_text": "2026 年 7 月 15 日前",
            "schedule_fit": "high",
        }],
    })
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.facts[0].content.startswith("李工负责")
    assert document.action_candidates[0].owner == "李工"


def test_speaker_name_before_plan_predicate_is_not_treated_as_part_of_owner():
    active_package = build_evidence_package(
        [{
            "id": "announcement",
            "speaker": "小林",
            "text": "发布公告由我明天下午发给全员。",
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "小林明天下午发布公告。", "fact_ids": ["f1"]},
            "facts": [{
                "fact_id": "f1",
                "fact_type": "action",
                "certainty": "confirmed",
                "content": "小林计划于明天下午向全员发布公告。",
                "sources": [{
                    "source_id": source.source_id,
                    "source_type": source.source_type,
                    "quote": source.text,
                    "content_hash": source.content_hash,
                }],
            }],
            "relations": [],
            "action_candidates": [{
                "action_id": "a1",
                "fact_id": "f1",
                "content": "发布公告",
                "owner": "小林",
                "due_text": "明天下午",
                "schedule_fit": "high",
            }],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.facts[0].fact_id == "f1"
    assert document.action_candidates[0].owner == "小林"


def test_cross_speaker_action_details_merge_without_losing_owner_or_due():
    active_package = build_evidence_package(
        [
            {
                "id": "weekly-plan",
                "speaker": "主持人",
                "text": "最终要求从下周开始，每周五提交一次运行周报。",
                "start_ms": 0,
                "end_ms": 7_000,
            },
            {
                "id": "weekly-owner",
                "speaker": "陈工",
                "text": "运行周报由我负责，每周五下班前发送。",
                "start_ms": 8_000,
                "end_ms": 15_000,
            },
        ],
        None,
        None,
    )
    first, second = active_package.sources
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {
                "text": "从下周起每周五提交运行周报，由陈工负责在下班前发送。",
                "fact_ids": ["f1", "f2"],
            },
            "facts": [
                {
                    "fact_id": "f1",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "从下周开始，每周五提交一次运行周报。",
                    "sources": [{
                        "source_id": first.source_id,
                        "source_type": first.source_type,
                        "quote": first.text,
                        "content_hash": first.content_hash,
                    }],
                },
                {
                    "fact_id": "f2",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "运行周报由陈工负责，每周五下班前发送。",
                    "sources": [{
                        "source_id": second.source_id,
                        "source_type": second.source_type,
                        "quote": second.text,
                        "content_hash": second.content_hash,
                    }],
                },
            ],
            "relations": [],
            "action_candidates": [
                {
                    "action_id": "a1",
                    "fact_id": "f1",
                    "content": "从下周开始，每周五提交一次运行周报。",
                    "owner": None,
                    "due_text": "每周五",
                    "schedule_fit": "high",
                },
                {
                    "action_id": "a2",
                    "fact_id": "f2",
                    "content": "运行周报由陈工负责，每周五下班前发送。",
                    "owner": None,
                    "due_text": "每周五下班前",
                    "schedule_fit": "high",
                },
            ],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert len(document.facts) == 1
    assert len(document.facts[0].sources) == 2
    assert len(document.action_candidates) == 1
    assert document.action_candidates[0].owner == "陈工"
    assert document.action_candidates[0].due_text == "每周五下班前"


def test_parallel_actions_with_distinct_owners_are_not_merged():
    active_package = build_evidence_package(
        [
            {"id": "first", "text": "王芳在 2026 年 7 月 18 日前整理用户反馈。"},
            {"id": "second", "text": "陈工在 2026 年 7 月 19 日前修复支付页闪退。"},
        ],
        None,
        None,
    )
    first, second = active_package.sources
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "会议形成两项独立行动。", "fact_ids": ["f1", "f2"]},
            "facts": [
                {
                    "fact_id": "f1",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": first.text,
                    "sources": [{
                        "source_id": first.source_id,
                        "source_type": first.source_type,
                        "quote": first.text,
                        "content_hash": first.content_hash,
                    }],
                },
                {
                    "fact_id": "f2",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": second.text,
                    "sources": [{
                        "source_id": second.source_id,
                        "source_type": second.source_type,
                        "quote": second.text,
                        "content_hash": second.content_hash,
                    }],
                },
            ],
            "relations": [],
            "action_candidates": [],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert [fact.fact_id for fact in document.facts] == ["f1", "f2"]
    assert {candidate.fact_id for candidate in document.action_candidates} == {"f1", "f2"}
    assert {candidate.owner for candidate in document.action_candidates} == {"王芳", "陈工"}


def test_candidate_references_rejected_duplicate_remap_to_verified_fact():
    active_package = build_evidence_package(
        [{
            "id": "notice",
            "speaker": "小陈",
            "text": "我今天下班前发培训通知给全员。",
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    source_reference = {
        "source_id": source.source_id,
        "source_type": source.source_type,
        "quote": source.text,
        "content_hash": source.content_hash,
    }
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "小陈发送培训通知。", "fact_ids": ["bad", "good"]},
            "facts": [
                {
                    "fact_id": "bad",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "林经理将向全员发送培训通知。",
                    "sources": [source_reference],
                },
                {
                    "fact_id": "good",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "小陈将在今天下班前向全员发送培训通知。",
                    "sources": [source_reference],
                },
            ],
            "relations": [],
            "action_candidates": [{
                "action_id": "a1",
                "fact_id": "bad",
                "content": "向全员发送培训通知",
                "owner": "小陈",
                "due_text": "今天下班前",
                "schedule_fit": "high",
            }],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert [fact.fact_id for fact in document.facts] == ["good"]
    assert document.action_candidates[0].fact_id == "good"
    assert document.action_candidates[0].owner == "小陈"


def test_final_self_confirmation_can_support_a_corrected_action_candidate():
    active_package = build_evidence_package(
        [
            {
                "id": "correction",
                "speaker": "主持人",
                "text": "不对，前面的安排作废。改由李四负责，截止日期改成 2026 年 7 月 21 日。",
            },
            {
                "id": "confirmation",
                "speaker": "李四",
                "text": "确认，最终由我在 7 月 21 日前提交报价单。",
            },
        ],
        None,
        None,
    )
    correction, confirmation = active_package.sources
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "改由李四提交报价单。", "fact_ids": ["f2", "f3"]},
            "facts": [
                {
                    "fact_id": "f2",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "安排作废，改由李四负责，截止日期改为 2026 年 7 月 21 日。",
                    "sources": [{
                        "source_id": correction.source_id,
                        "source_type": correction.source_type,
                        "quote": correction.text,
                        "content_hash": correction.content_hash,
                    }],
                },
                {
                    "fact_id": "f3",
                    "fact_type": "action",
                    "certainty": "confirmed",
                    "content": "李四确认最终由他在 7 月 21 日前提交报价单。",
                    "sources": [{
                        "source_id": confirmation.source_id,
                        "source_type": confirmation.source_type,
                        "quote": confirmation.text,
                        "content_hash": confirmation.content_hash,
                    }],
                },
            ],
            "relations": [{
                "relation_type": "supports",
                "from_fact_id": "f2",
                "to_fact_id": "f3",
            }],
            "action_candidates": [{
                "action_id": "a1",
                "fact_id": "f3",
                "content": "提交报价单",
                "owner": "李四",
                "due_text": "2026 年 7 月 21 日前",
                "schedule_fit": "high",
            }],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert len(document.facts) == 1
    assert len(document.facts[0].sources) == 2
    assert document.action_candidates[0].fact_id == "f2"
    assert document.action_candidates[0].due_text == "2026 年 7 月 21 日前"


def test_explicit_cancellation_is_not_marked_as_an_unresolved_conflict():
    active_package = build_evidence_package(
        [
            {"id": "old", "text": "原定 2026 年 7 月 15 日发布测试版。"},
            {"id": "cancel", "text": "最终决定取消这次发布，原计划作废。"},
        ],
        None,
        None,
    )
    old, cancel = active_package.sources
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "最终决定取消发布。", "fact_ids": ["old", "cancel"]},
            "facts": [
                {
                    "fact_id": "old",
                    "fact_type": "timeline",
                    "certainty": "confirmed",
                    "content": "原定 2026 年 7 月 15 日发布测试版。",
                    "sources": [{
                        "source_id": old.source_id,
                        "source_type": old.source_type,
                        "quote": old.text,
                        "content_hash": old.content_hash,
                    }],
                },
                {
                    "fact_id": "cancel",
                    "fact_type": "conclusion",
                    "certainty": "confirmed",
                    "content": "最终决定取消这次发布，原计划作废。",
                    "sources": [{
                        "source_id": cancel.source_id,
                        "source_type": cancel.source_type,
                        "quote": cancel.text,
                        "content_hash": cancel.content_hash,
                    }],
                },
            ],
            "relations": [{
                "relation_type": "contradicts",
                "from_fact_id": "old",
                "to_fact_id": "cancel",
            }],
            "action_candidates": [],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.relations == []
    assert {fact.fact_id: fact.certainty for fact in document.facts} == {
        "old": "negated",
        "cancel": "confirmed",
    }
    assert all(fact.conflict_group_id is None for fact in document.facts)


def test_cross_source_conflict_remains_unresolved():
    active_package = build_evidence_package(
        [{"id": "spoken", "text": "确认使用甲方案。"}],
        {"revision": 1, "content": "确认使用乙方案。"},
        None,
    )
    spoken, note = active_package.sources
    response = MeetingFactsModelResponseV3.model_validate(
        {
            "schema_version": 3,
            "overview": {"text": "方案存在冲突。", "fact_ids": ["f1", "f2"]},
            "facts": [
                {
                    "fact_id": "f1",
                    "fact_type": "conclusion",
                    "certainty": "confirmed",
                    "content": "确认使用甲方案。",
                    "sources": [{
                        "source_id": spoken.source_id,
                        "source_type": spoken.source_type,
                        "quote": spoken.text,
                        "content_hash": spoken.content_hash,
                    }],
                },
                {
                    "fact_id": "f2",
                    "fact_type": "conclusion",
                    "certainty": "confirmed",
                    "content": "确认使用乙方案。",
                    "sources": [{
                        "source_id": note.source_id,
                        "source_type": note.source_type,
                        "quote": note.text,
                        "content_hash": note.content_hash,
                    }],
                },
            ],
            "relations": [{
                "relation_type": "contradicts",
                "from_fact_id": "f1",
                "to_fact_id": "f2",
            }],
            "action_candidates": [],
        }
    )
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert len(document.relations) == 1
    assert {fact.certainty for fact in document.facts} == {"uncertain"}
    assert len({fact.conflict_group_id for fact in document.facts}) == 1


def test_model_is_called_once_and_only_repairs_structural_failure(monkeypatch):
    active_package = package()
    responses = ["not-json", json.dumps(valid_response(active_package), ensure_ascii=False)]
    operations: list[str] = []

    def fake_call_llm(*_args, **kwargs):
        operations.append(kwargs["telemetry_operation"])
        return responses.pop(0)

    monkeypatch.setattr(summary_v3_generator, "call_llm", fake_call_llm)
    response, calls = summary_v3_generator.generate_model_response(active_package)
    assert response.schema_version == 3
    assert calls == 2
    assert operations == ["summary.facts.v3", "summary.facts.v3.repair"]


def test_missing_root_facts_array_delimiter_is_repaired_without_second_call(monkeypatch):
    active_package = package()
    value = json.dumps(valid_response(active_package), ensure_ascii=False, separators=(",", ":"))
    malformed = value.replace('],"relations"', ',"relations"', 1)
    operations: list[str] = []

    def fake_call_llm(*_args, **kwargs):
        operations.append(kwargs["telemetry_operation"])
        return malformed

    monkeypatch.setattr(summary_v3_generator, "call_llm", fake_call_llm)
    response, calls = summary_v3_generator.generate_model_response(active_package)

    assert response.schema_version == 3
    assert calls == 1
    assert operations == ["summary.facts.v3"]


def test_failed_repair_exposes_only_sanitized_field_errors(monkeypatch):
    active_package = package()
    monkeypatch.setattr(summary_v3_generator, "call_llm", lambda *_args, **_kwargs: "not-json")
    with pytest.raises(summary_v3_generator.SummaryV3GenerationError) as captured:
        summary_v3_generator.generate_model_response(active_package)
    assert captured.value.code == "SUMMARY_V3_FORMAT_INVALID"
    assert captured.value.details == {
        "initial_errors": [{"path": "$", "type": "json_invalid"}],
        "repair_errors": [{"path": "$", "type": "json_invalid"}],
    }


def test_valid_model_response_uses_exactly_one_call(monkeypatch):
    active_package = package()
    operations: list[str] = []

    def fake_call_llm(*_args, **kwargs):
        operations.append(kwargs["telemetry_operation"])
        return json.dumps(valid_response(active_package), ensure_ascii=False)

    monkeypatch.setattr(summary_v3_generator, "call_llm", fake_call_llm)
    response, calls = summary_v3_generator.generate_model_response(active_package)
    assert response.schema_version == 3
    assert calls == 1
    assert operations == ["summary.facts.v3"]


def test_self_relation_is_dropped_without_consuming_repair(monkeypatch):
    active_package = package()
    value = valid_response(active_package)
    value["relations"] = [{"relation_type": "supports", "from_fact_id": "f1", "to_fact_id": "f1"}]
    operations: list[str] = []

    def fake_call_llm(*_args, **kwargs):
        operations.append(kwargs["telemetry_operation"])
        return json.dumps(value, ensure_ascii=False)

    monkeypatch.setattr(summary_v3_generator, "call_llm", fake_call_llm)
    response, calls = summary_v3_generator.generate_model_response(active_package)
    assert response.relations == []
    assert calls == 1
    assert operations == ["summary.facts.v3"]


def test_explicit_deferment_is_a_resolved_decision_not_a_proposal():
    active_package = build_evidence_package(
        [{
            "id": "deferment",
            "speaker": "主持人",
            "text": "不是不做数据迁移，而是延期到 2026 年 8 月 3 日执行。",
            "start_ms": 0,
            "end_ms": 3_000,
        }],
        None,
        None,
    )
    source = active_package.sources[0]
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "数据迁移延期到 2026 年 8 月 3 日执行。", "fact_ids": ["f1"]},
        "facts": [{
            "fact_id": "f1",
            "fact_type": "action",
            "certainty": "proposed",
            "content": "将数据迁移延期至 2026 年 8 月 3 日执行",
            "sources": [{
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.text,
                "content_hash": source.content_hash,
            }],
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "a1",
            "fact_id": "f1",
            "content": "延期数据迁移",
            "owner": None,
            "due_text": "2026 年 8 月 3 日",
            "schedule_fit": "medium",
        }],
    })
    document = summary_v3_generator.verify_model_response(response, active_package)
    assert document.facts[0].certainty == "confirmed"
    assert document.action_candidates[0].schedule_fit == "medium"


def test_long_evidence_uses_embeddings_without_intermediate_summary(monkeypatch):
    background = "背景信息持续用于讨论范围说明但尚未形成新的结论。" * 28
    transcript = [
        {
            "id": f"long-{index}",
            "speaker": "讲话人",
            "text": background,
            "start_ms": index * 10_000,
            "end_ms": index * 10_000 + 8_000,
        }
        for index in range(18)
    ]
    operations: list[str] = []

    def fake_embed_texts(texts, *, operation, **_kwargs):
        operations.append(operation)
        return [(1.0, 0.0) for _ in texts]

    monkeypatch.setattr(summary_v3_evidence, "embed_texts", fake_embed_texts)
    active_package = build_evidence_package(
        transcript,
        {"revision": 1, "content": "我的笔记补充了验证范围。" * 25},
        [{"attachment_id": "a", "revision": 1, "content": "附件记录了背景依据。" * 30}],
    )
    assert active_package.coverage["used_embeddings"] is True
    assert active_package.coverage["included_segments"] < active_package.coverage["total_segments"]
    assert active_package.coverage["topic_groups"] == active_package.coverage["covered_topic_groups"]
    assert active_package.coverage["source_types"] == ["attachment", "manual_note", "transcript"]
    assert set(operations) == {"summary.v3.evidence.embedding"}


def test_long_evidence_maps_embedding_provider_failure_to_stable_error(monkeypatch):
    transcript = [
        {
            "id": f"timeout-{index}",
            "text": "这是一段需要通过 embedding 选择代表片段的长会议内容。" * 60,
            "start_ms": index * 10_000,
            "end_ms": index * 10_000 + 8_000,
        }
        for index in range(18)
    ]

    def fail_embedding(*_args, **_kwargs):
        from app.services.llm_provider import LlmProviderError

        raise LlmProviderError("ollama_embedding_timeout")

    monkeypatch.setattr(summary_v3_evidence, "embed_texts", fail_embedding)
    with pytest.raises(SummaryEvidenceIncomplete) as captured:
        build_evidence_package(transcript, None, None)
    assert str(captured.value) == "embedding_unavailable"


def test_long_evidence_fails_closed_when_required_segments_exceed_budget(monkeypatch):
    forced = "负责人需要核对这一段背景信息。" * 60
    transcript = [
        {"id": f"forced-{index}", "text": forced, "start_ms": index * 10_000}
        for index in range(16)
    ]
    monkeypatch.setattr(
        summary_v3_evidence,
        "embed_texts",
        lambda texts, **_kwargs: [(1.0, 0.0) for _ in texts],
    )
    with pytest.raises(SummaryEvidenceIncomplete):
        build_evidence_package(transcript, None, None)


def test_long_evidence_budget_counts_serialized_source_metadata(monkeypatch):
    transcript = [
        {
            "id": f"status-{index}",
            "speaker": f"成员{index}",
            "text": f"第{index}项只是常规状态同步，资料仍在整理，没有新增决策或行动项。",
            "start_ms": index * 8_000,
            "end_ms": index * 8_000 + 7_000,
        }
        for index in range(180)
    ]
    monkeypatch.setattr(
        summary_v3_evidence,
        "embed_texts",
        lambda texts, **_kwargs: [(1.0, 0.0) for _ in texts],
    )
    active_package = build_evidence_package(transcript, None, None)
    encoded = json.dumps(
        active_package.model_payload(),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    assert active_package.coverage["used_embeddings"] is True
    assert active_package.coverage["included_segments"] < len(transcript)
    assert summary_v3_evidence.estimate_tokens(encoded) <= summary_v3_evidence.INPUT_TOKEN_BUDGET
    assert active_package.estimated_tokens == active_package.coverage["estimated_input_tokens"]


def test_highly_repetitive_long_evidence_is_grouped_for_output_budget(monkeypatch):
    transcript = [
        {
            "id": f"repeat-{index}",
            "speaker": f"成员{index}",
            "text": f"第{index}项只是常规状态同步，资料仍在整理，没有新增决策或行动项。",
            "start_ms": index * 8_000,
            "end_ms": index * 8_000 + 7_000,
        }
        for index in range(160)
    ]
    monkeypatch.setattr(
        summary_v3_evidence,
        "embed_texts",
        lambda texts, **_kwargs: [(1.0, 0.0) for _ in texts],
    )
    active_package = build_evidence_package(transcript, None, None)
    assert active_package.coverage["used_embeddings"] is True
    assert active_package.coverage["included_segments"] <= 4
    assert active_package.coverage["topic_groups"] == 1


def test_plaintext_is_not_stored_in_source_payload(tmp_path, monkeypatch):
    database = tmp_path / "summary.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setenv("LAOJI_SUMMARY_V3_PAYLOAD_KEY", "00" * 32)
    summary_v3_store.reset_store_for_tests()
    secret = "这段我的笔记不应以明文进入数据库"
    payload_id = summary_v3_store.save_source_payload(
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        payload={"manual_note": {"content": secret}},
    )
    assert summary_v3_store.load_source_payload(
        payload_id,
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
    )["manual_note"]["content"] == secret
    assert secret.encode("utf-8") not in database.read_bytes()
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT content_bytes, length(ciphertext) FROM summary_v3_source_payloads WHERE id = ?",
            (payload_id,),
        ).fetchone()
    assert row is not None and row[0] > 0 and row[1] > row[0]


def test_document_identity_is_immutable_and_idempotent(tmp_path, monkeypatch):
    database = tmp_path / "summary.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    summary_v3_store.reset_store_for_tests()
    active_package = package()
    document = summary_v3_generator.verify_model_response(
        MeetingFactsModelResponseV3.model_validate(valid_response(active_package)),
        active_package,
    ).model_dump(mode="json")
    first = summary_v3_store.persist_document(
        task_id="task-one",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        source_fingerprint=active_package.source_fingerprint,
        transcript_revision=active_package.transcript_revision,
        model_revision="ollama:qwen3.5:9b",
        prompt_revision="facts-v3-r1",
        document=document,
        coverage=active_package.coverage,
    )
    second = summary_v3_store.persist_document(
        task_id="task-two",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        source_fingerprint=active_package.source_fingerprint,
        transcript_revision=active_package.transcript_revision,
        model_revision="ollama:qwen3.5:9b",
        prompt_revision="facts-v3-r1",
        document=document,
        coverage=active_package.coverage,
    )
    assert second["id"] == first["id"]
    assert second["task_id"] == "task-one"
    with sqlite3.connect(database) as connection:
        count = connection.execute("SELECT COUNT(*) FROM summary_v3_documents").fetchone()[0]
    assert count == 1


def test_document_and_task_success_commit_together(tmp_path, monkeypatch):
    database = tmp_path / "summary-atomic.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    summary_task_store.reset_store_for_tests()
    summary_v3_store.reset_store_for_tests()
    active_package = package()
    document = summary_v3_generator.verify_model_response(
        MeetingFactsModelResponseV3.model_validate(valid_response(active_package)),
        active_package,
    ).model_dump(mode="json")
    summary_task_store.create_task(
        task_id="task-v3-atomic",
        task_kind="device-summary-v3",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        dedupe_key="atomic-a",
        request={"worker_args": ["meeting-a", "device:1:epoch", "payload-a", active_package.source_fingerprint, "ollama:test"]},
        force=False,
        retain_generated_result=True,
    )
    assert summary_task_store.claim_task("task-v3-atomic", "worker:atomic")
    persisted = summary_v3_store.persist_document_and_mark_task_success(
        task_id="task-v3-atomic",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        source_fingerprint=active_package.source_fingerprint,
        transcript_revision=active_package.transcript_revision,
        model_revision="ollama:test",
        prompt_revision="facts-v3-r5",
        document=document,
        coverage=active_package.coverage,
        task_result={"schema_version": 3, "meeting_id": "meeting-a", "facts_document": document},
        lease_owner="worker:atomic",
    )
    task = summary_task_store.get_task("task-v3-atomic")
    assert persisted["id"]
    assert task is not None and task["status"] == "success"
    assert task["result"]["document_id"] == persisted["id"]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM summary_v3_documents").fetchone()[0] == 1

    summary_task_store.create_task(
        task_id="task-v3-atomic-rollback",
        task_kind="device-summary-v3",
        task_scope="device:1:epoch",
        meeting_id="meeting-b",
        dedupe_key="atomic-b",
        request={"worker_args": ["meeting-b", "device:1:epoch", "payload-b", active_package.source_fingerprint, "ollama:test"]},
        force=False,
        retain_generated_result=True,
    )
    assert summary_task_store.claim_task("task-v3-atomic-rollback", "worker:rollback")
    with pytest.raises(summary_v3_store.SummaryV3StoreError, match="summary_task_lease_lost"):
        summary_v3_store.persist_document_and_mark_task_success(
            task_id="task-v3-atomic-rollback",
            task_scope="device:1:epoch",
            meeting_id="meeting-b",
            source_fingerprint=active_package.source_fingerprint,
            transcript_revision=active_package.transcript_revision,
            model_revision="ollama:test",
            prompt_revision="facts-v3-r5",
            document=document,
            coverage=active_package.coverage,
            task_result={"schema_version": 3},
            lease_owner="wrong-owner",
        )
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM summary_v3_documents WHERE meeting_id = 'meeting-b'").fetchone()[0] == 0
    assert summary_task_store.get_task("task-v3-atomic-rollback")["status"] == "running"


def test_closing_device_epoch_removes_v3_payloads_documents_and_tasks(tmp_path, monkeypatch):
    database = tmp_path / "device-summary.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setenv("LAOJI_SUMMARY_V3_PAYLOAD_KEY", "11" * 32)
    monkeypatch.setattr(device_identity, "drain_speaker_cleanup_outbox", lambda limit=8: (0, 0))
    device_identity._SCHEMA_READY.clear()
    summary_task_store.reset_store_for_tests()
    summary_v3_store.reset_store_for_tests()
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TABLE meetings (
                 id TEXT PRIMARY KEY, user_id INTEGER, data_epoch_id TEXT,
                 updated_at TEXT
               )"""
        )
        connection.commit()

    device_id = "10000000-0000-4000-8000-000000000001"
    epoch_id = "20000000-0000-4000-8000-000000000002"
    meeting_id = "30000000-0000-4000-8000-000000000003"
    secret = "A" * 43
    device_identity.register_device(device_id, secret, epoch_id)
    context = device_identity.authenticate(device_id, secret, epoch_id)
    task_scope = f"device:{context.principal_id}:{epoch_id}"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO meetings(id, user_id, data_epoch_id, updated_at) VALUES (?, ?, ?, ?)",
            (meeting_id, context.principal_id, epoch_id, "2026-08-15T00:00:00+00:00"),
        )
        connection.commit()
    summary_task_store.create_task(
        task_id="summary-task-v3-close",
        task_kind="device-summary-v3",
        task_scope=task_scope,
        meeting_id=meeting_id,
        dedupe_key="close-epoch",
        request={"worker_args": [meeting_id]},
        force=False,
        retain_generated_result=True,
    )
    summary_v3_store.save_source_payload(
        task_scope=task_scope,
        meeting_id=meeting_id,
        payload={"manual_note": {"content": "待删除"}},
    )
    summary_v3_store.persist_document(
        task_id="summary-task-v3-close",
        task_scope=task_scope,
        meeting_id=meeting_id,
        source_fingerprint="sha256:" + "1" * 64,
        transcript_revision="sha256:" + "2" * 64,
        model_revision="ollama:qwen3.5:9b",
        prompt_revision="facts-v3-r4",
        document={"schema_version": 3},
        coverage={},
    )

    result = device_identity.close_epoch(context, epoch_id)

    assert result["summary_tasks_deleted"] == 1
    assert result["summary_v3_payloads_deleted"] == 1
    assert result["summary_v3_documents_deleted"] == 1
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM summary_tasks_v2").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM summary_v3_source_payloads").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM summary_v3_documents").fetchone()[0] == 0


def test_prompt_has_no_known_sample_pollution():
    prompt = summary_v3_generator._system_prompt()
    forbidden = [
        "全球核污染监测网络",
        "VR 行业",
        "宠物项圈",
        "小区车位市场",
        "五个创业方向",
        "产业大厦",
        "筹建办",
        "few-shot",
    ]
    assert not any(value in prompt for value in forbidden)


def test_ollama_schema_is_complete_and_has_no_unresolved_references():
    schema = model_response_json_schema()
    encoded = json.dumps(schema, ensure_ascii=False)
    assert '"$ref"' not in encoded
    assert '"$defs"' not in encoded
    assert '"title"' not in encoded
    assert '"description"' not in encoded
    assert '"default"' not in encoded
    facts = schema["properties"]["facts"]
    assert facts["maxItems"] == 40
    assert facts["items"]["properties"]["fact_type"]["enum"] == [
        "topic", "context", "conclusion", "action", "risk", "question", "quote", "timeline",
    ]


def test_generation_schema_caps_single_call_output_without_changing_document_contract():
    schema = summary_v3_generator._generation_response_schema()
    assert schema["properties"]["facts"]["maxItems"] == 12
    assert schema["properties"]["relations"]["maxItems"] == 16
    assert schema["properties"]["action_candidates"]["maxItems"] == 6
    assert model_response_json_schema()["properties"]["facts"]["maxItems"] == 40


def test_truncated_root_array_repair_discards_only_incomplete_relation():
    raw = (
        '{"schema_version":3,"overview":{"text":"概述","fact_ids":["f1"]},'
        '"facts":[{"fact_id":"f1","fact_type":"context","certainty":"confirmed",'
        '"content":"事实","sources":[{"source_id":"transcript:a","source_type":"transcript",'
        '"quote":"事实"}]}],'
        '"relations":[{"relation_type":"supports","from_fact_id":"f1","to_fact_id":"f1"},'
        '{"relation_type":"supports","from_fact_id":"f1","to_fact_id":"f'
    )
    repaired = summary_v3_generator._repair_truncated_root_arrays(raw)
    parsed = json.loads(repaired)
    assert parsed["facts"][0]["fact_id"] == "f1"
    assert parsed["relations"] == [
        {"relation_type": "supports", "from_fact_id": "f1", "to_fact_id": "f1"},
    ]
    assert parsed["action_candidates"] == []


def test_model_sanitizer_drops_misplaced_root_containers_inside_fact():
    value = {
        "facts": [{
            "fact_id": "f1",
            "sources": [],
            "action_candidates": [],
        }],
    }
    summary_v3_generator._sanitize_model_value(value)
    assert "action_candidates" not in value["facts"][0]


def test_speaker_correction_changes_source_and_transcript_fingerprints():
    transcript = [{"id": "same", "speaker": "讲话人 1", "text": "界面颜色需要调整。"}]
    _sources, before, before_transcript = normalize_sources(transcript, None, None)
    transcript[0]["speaker"] = "林清"
    _sources, after, after_transcript = normalize_sources(transcript, None, None)
    assert before != after
    assert before_transcript != after_transcript


def test_long_transcript_packs_adjacent_rows_without_losing_time_bounds():
    transcript = [
        {
            "id": f"line-{index}",
            "speaker": "讲话人 1",
            "text": f"第{index}句关于项目进展的连续发言。",
            "start_ms": index * 1_000,
            "end_ms": index * 1_000 + 800,
        }
        for index in range(40)
    ]
    sources, _fingerprint, _revision = normalize_sources(transcript, None, None)

    assert len(sources) < len(transcript)
    assert sources[0].source_id.startswith("transcript:line-0--line-")
    assert sources[0].start_ms == 0
    assert sources[0].end_ms > sources[0].start_ms
    assert "第0句" in sources[0].text
    assert "第1句" in sources[0].text
    assert sources[0].content_hash == digest(sources[0].text)


def test_short_transcript_keeps_line_level_source_identity():
    transcript = [
        {"id": "segment-a", "speaker": "讲话人 1", "text": "第一句。", "start_ms": 0, "end_ms": 1_000},
        {"id": "segment-b", "speaker": "讲话人 1", "text": "第二句。", "start_ms": 1_000, "end_ms": 2_000},
    ]
    sources, _fingerprint, _revision = normalize_sources(transcript, None, None)

    assert [source.source_id for source in sources] == [
        "transcript:segment-a",
        "transcript:segment-b",
    ]
    assert [source.text for source in sources] == ["第一句。", "第二句。"]


@pytest.mark.parametrize(
    "value",
    [
        "## 标题\n正文",
        "- 列表项",
        "[链接](https://example.com)",
        "<div>正文</div>",
        '{"nodes": [{"x": 1, "y": 2}]}',
    ],
)
def test_protocol_rejects_rich_markup_and_presentation_code(value):
    with pytest.raises(ValueError):
        OverviewV3(text=value, fact_ids=["f1"])


def test_protocol_allows_a_meeting_fact_about_visual_design():
    value = OverviewV3(text="客户要求将按钮颜色改成蓝色。", fact_ids=["f1"])
    assert value.text == "客户要求将按钮颜色改成蓝色。"


def test_persistent_task_stage_is_monotonic(tmp_path, monkeypatch):
    database = tmp_path / "tasks.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    summary_task_store.reset_store_for_tests()
    record, reused = summary_task_store.create_task(
        task_id="task-v3",
        task_kind="device-summary-v3",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        dedupe_key="identity-a",
        request={"worker_args": ["payload-a"]},
        force=False,
        retain_generated_result=True,
    )
    assert not reused and record["stage"] == "queued"
    assert summary_task_store.claim_task("task-v3", "host:1:worker")
    assert summary_task_store.get_task("task-v3")["stage"] == "preparing"
    for stage in ("generating", "verifying", "persisting"):
        assert summary_task_store.update_stage("task-v3", stage, lease_owner="host:1:worker")
        assert summary_task_store.get_task("task-v3")["stage"] == stage
    assert summary_task_store.mark_success(
        "task-v3",
        {"schema_version": 3},
        lease_owner="host:1:worker",
    )
    assert summary_task_store.get_task("task-v3")["stage"] == "success"


def test_v3_task_status_exposes_matching_identity(tmp_path, monkeypatch):
    database = tmp_path / "task-identity.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    summary_task_store.reset_store_for_tests()
    source_fingerprint = "sha256:" + "a" * 64
    record, reused = summary_task_store.create_task(
        task_id="task-v3-identity",
        task_kind="device-summary-v3",
        task_scope="device:1:epoch",
        meeting_id="meeting-a",
        dedupe_key="identity-a",
        request={
            "worker_args": [
                "meeting-a",
                "device:1:epoch",
                "payload-a",
                source_fingerprint,
                "ollama:qwen3.5:9b",
            ],
        },
        force=False,
        retain_generated_result=True,
    )
    assert not reused and record["status"] == "queued"
    status = get_submitted_summary_status(
        "task-v3-identity",
        expected_scope="device:1:epoch",
        expected_meeting_id="meeting-a",
    )
    assert status is not None
    assert status["source_fingerprint"] == source_fingerprint
    assert status["model_revision"] == "ollama:qwen3.5:9b"
    assert status["prompt_revision"].startswith("facts-v3-")
