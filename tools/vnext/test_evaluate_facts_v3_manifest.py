from evaluate_facts_v3_manifest import (
    _citation_counts,
    _duplicate_action_count,
    _evaluate_semantics,
)
from app.services.summary_v3_evidence import build_evidence_package


def _document() -> dict:
    return {
        "overview": {"text": "确认发布范围并安排测试。"},
        "facts": [
            {
                "fact_id": "fact-1",
                "fact_type": "conclusion",
                "certainty": "confirmed",
                "content": "确认发布范围。",
                "sources": [{
                    "source_id": "line-1",
                    "source_start_utf8": 0,
                    "source_end_utf8": 12,
                    "quote": "确认发布",
                }],
            },
            {
                "fact_id": "fact-2",
                "fact_type": "action",
                "certainty": "confirmed",
                "content": "小王明天完成测试。",
                "sources": [],
            },
        ],
        "relations": [],
        "action_candidates": [{
            "action_id": "action-1",
            "fact_id": "fact-2",
            "content": "完成测试",
            "owner": "小王",
            "due_text": "明天",
            "schedule_fit": "high",
        }],
    }


def test_semantic_manifest_uses_content_free_issue_codes() -> None:
    document = _document()
    expected = {
        "overview_groups": [["发布", "范围"]],
        "decision_groups": [["发布", "范围"]],
        "actions": [{
            "content_all": ["完成", "测试"],
            "assignee_any": ["小王"],
            "due_any": ["明天"],
        }],
    }

    assert _evaluate_semantics(document, expected) == []
    issues = _evaluate_semantics(document, {"actions": [{"content_all": ["不存在"]}]})
    assert issues == ["action_missing:1"]
    assert "不存在" not in repr(issues)


def test_citation_and_duplicate_checks_are_deterministic() -> None:
    document = _document()
    package = build_evidence_package(
        [{"id": "line-1", "text": "确认发布"}],
        None,
        None,
    )
    source = package.sources[0]
    document["facts"][0]["sources"] = [{
        "source_id": source.source_id,
        "source_type": source.source_type,
        "content_hash": source.content_hash,
        "quote": "确认发布",
    }]
    assert _citation_counts(document, package) == (1, 1)

    document["action_candidates"].append({
        **document["action_candidates"][0],
        "action_id": "action-2",
        "content": "完成测试。",
    })
    assert _duplicate_action_count(document) == 1
