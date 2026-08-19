from __future__ import annotations

from app.schemas.meeting_facts_v3 import MeetingFactsDocumentV3
from app.services.summary_v3_chapter_merge import (
    FactsV3ChapterCheckpoint,
    merge_verified_chapter,
)


def _source(index: int, quote: str | None = None) -> dict:
    return {
        "source_id": f"transcript:segment-{index}",
        "source_type": "transcript",
        "quote": quote or f"第{index}条来源原文",
        "content_hash": "sha256:" + f"{index % 16:x}" * 64,
        "start_ms": index * 1_000,
        "end_ms": index * 1_000 + 800,
        "speaker": None,
    }


def _fact(
    fact_id: str,
    index: int,
    *,
    fact_type: str = "topic",
    certainty: str = "confirmed",
    content: str | None = None,
    source: dict | None = None,
) -> dict:
    return {
        "fact_id": fact_id,
        "fact_type": fact_type,
        "certainty": certainty,
        "content": content or f"第{index}条会议事实",
        "sources": [source or _source(index)],
        "evidence_score": 0.9,
        "conflict_group_id": None,
    }


def _document(
    facts: list[dict],
    *,
    relations: list[dict] | None = None,
    actions: list[dict] | None = None,
) -> MeetingFactsDocumentV3:
    return MeetingFactsDocumentV3.model_validate({
        "schema_version": 3,
        "overview": {
            "text": "本章概述",
            "fact_ids": [facts[0]["fact_id"]],
        },
        "facts": facts,
        "relations": relations or [],
        "action_candidates": actions or [],
    })


def test_merge_remaps_ids_deduplicates_provenance_and_is_replay_stable() -> None:
    shared_source = _source(1, "确认在周五前交付接口文档")
    first = _document(
        [
            _fact(
                "chapterOneAction",
                1,
                fact_type="action",
                content="周五前交付接口文档",
                source=shared_source,
            ),
            _fact("chapterOneRisk", 2, fact_type="risk", content="联调环境可能延期"),
        ],
        relations=[{
            "relation_type": "depends_on",
            "from_fact_id": "chapterOneAction",
            "to_fact_id": "chapterOneRisk",
        }],
        actions=[{
            "action_id": "chapterOneCandidate",
            "fact_id": "chapterOneAction",
            "content": "整理并交付接口文档",
            "owner": "张敏",
            "due_text": "周五前",
            "schedule_fit": "high",
            "evidence_score": 0.9,
        }],
    )
    second = _document([
        _fact(
            "differentModelId",
            1,
            fact_type="action",
            certainty="proposed",
            content="周五前交付接口文档",
            source=shared_source,
        ),
        _fact("chapterTwoConclusion", 3, fact_type="conclusion", content="采用统一鉴权入口"),
    ])
    checkpoint = merge_verified_chapter(None, first, chapter_ordinal=0)
    merged = merge_verified_chapter(checkpoint, second, chapter_ordinal=1)
    replayed = merge_verified_chapter(
        checkpoint.model_dump(mode="json"),
        second.model_dump(mode="json"),
        chapter_ordinal=1,
    )
    assert merged.model_dump(mode="json") == replayed.model_dump(mode="json")
    assert len(merged.facts_document.facts) == 3
    assert all(fact.fact_id.startswith("f_") for fact in merged.facts_document.facts)
    assert len({fact.fact_id for fact in merged.facts_document.facts}) == 3
    action = merged.facts_document.action_candidates[0]
    assert action.action_id.startswith("a_")
    assert action.fact_id in merged.fact_first_chapter
    assert merged.facts_document.relations[0].from_fact_id in merged.fact_first_chapter
    FactsV3ChapterCheckpoint.model_validate(merged.model_dump(mode="json"))


def test_merge_is_bounded_and_drops_only_invalid_action_states() -> None:
    first_facts = [
        _fact(
            f"firstFact{index}",
            index,
            fact_type="action" if index < 8 else "context",
            certainty="completed" if index == 0 else "confirmed",
        )
        for index in range(30)
    ]
    first_actions = [
        {
            "action_id": f"firstAction{index}",
            "fact_id": first_facts[index]["fact_id"],
            "content": f"执行第{index}项任务",
            "owner": None,
            "due_text": None,
            "schedule_fit": "high" if index % 2 == 0 else "medium",
            "evidence_score": 0.8,
        }
        for index in range(10)
    ]
    first = _document(first_facts, actions=first_actions)
    second_facts = [
        _fact(
            f"secondFact{index}",
            index + 100,
            fact_type="risk" if index < 8 else "topic",
            certainty="negated" if index == 0 else "confirmed",
        )
        for index in range(30)
    ]
    second_actions = [
        {
            "action_id": f"secondAction{index}",
            "fact_id": second_facts[index]["fact_id"],
            "content": f"推进第{index}项后续工作",
            "owner": None,
            "due_text": None,
            "schedule_fit": "low",
            "evidence_score": 0.7,
        }
        for index in range(10)
    ]
    second = _document(second_facts, actions=second_actions)
    merged = merge_verified_chapter(
        merge_verified_chapter(None, first, chapter_ordinal=0),
        second,
        chapter_ordinal=1,
    )
    document = merged.facts_document
    assert len(document.facts) == 40
    assert len(document.relations) <= 48
    assert len(document.action_candidates) == 10
    fact_by_id = {fact.fact_id: fact for fact in document.facts}
    assert all(fact_by_id[action.fact_id].certainty not in {"negated", "completed"} for action in document.action_candidates)
    assert len(document.overview.text) <= 160
    assert set(document.overview.fact_ids).issubset(fact_by_id)


def test_overview_does_not_partially_append_the_next_fact() -> None:
    first_text = "甲" * 100
    second_text = "乙" * 100
    document = _document([
        _fact("firstLongFact", 1, fact_type="conclusion", content=first_text),
        _fact("secondLongFact", 2, fact_type="conclusion", content=second_text),
    ])
    merged = merge_verified_chapter(None, document, chapter_ordinal=0)
    overview = merged.facts_document.overview

    assert overview.text in {first_text + "。", second_text + "。"}
    assert len(overview.fact_ids) == 1


def test_overview_marks_an_unavoidable_single_fact_truncation() -> None:
    document = _document([
        _fact("veryLongFact", 1, fact_type="conclusion", content="长" * 300),
    ])
    merged = merge_verified_chapter(None, document, chapter_ordinal=0)
    overview = merged.facts_document.overview

    assert len(overview.text) == 160
    assert overview.text.endswith("…。")


def test_contradiction_relation_gets_deterministic_conflict_group() -> None:
    document = _document(
        [
            _fact("keepOldPlan", 1, fact_type="conclusion", content="继续使用旧接口"),
            _fact("useNewPlan", 2, fact_type="conclusion", content="改用统一新接口"),
        ],
        relations=[{
            "relation_type": "contradicts",
            "from_fact_id": "keepOldPlan",
            "to_fact_id": "useNewPlan",
        }],
    )
    checkpoint = merge_verified_chapter(None, document, chapter_ordinal=0)
    groups = {fact.conflict_group_id for fact in checkpoint.facts_document.facts}
    assert len(groups) == 1
    assert next(iter(groups)).startswith("conflict:")
