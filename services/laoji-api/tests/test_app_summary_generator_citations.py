import json

from app.services import app_summary_generator
from app.services.app_summary_generator import _normalize_compact_result


def test_compact_normalizer_preserves_decision_action_and_overview_sources():
    result = _normalize_compact_result({
        "candidate_contract_version": 2,
        "overview": "确认移动端先行。",
        "overview_citations": [{
            "source_segment_id": "seg-1",
            "source_quote": "确认移动端先行",
        }],
        "key_decisions": [{
            "description": "移动端先行",
            "source_segment_id": "seg-1",
            "source_quote": "确认移动端先行",
        }],
        "action_items": [{
            "content": "整理验收清单",
            "candidate_type": "short_term_task",
            "calendar_fitness": "high",
            "time_scope": "short_term",
            "assignee": "小陈",
            "due_date": "周五",
            "source_segment_id": "seg-2",
            "source_quote": "小陈周五前整理验收清单",
            "confidence": 0.94,
            "reason": "有具体交付物和期限",
        }],
    })

    assert result["overview_citations"][0]["source_segment_id"] == "seg-1"
    assert result["key_decisions"][0]["source_segment_id"] == "seg-1"
    assert result["key_decisions"][0]["description"] == "移动端先行"
    assert result["action_items"][0]["source_segment_id"] == "seg-2"
    assert result["action_items"][0]["source_quote"] == "小陈周五前整理验收清单"


def test_template_compact_generation_splits_core_and_template_fields(monkeypatch):
    captured = []

    def fake_call(*args, **kwargs):
        captured.append(kwargs)
        if len(captured) == 1:
            return json.dumps({
                "candidate_contract_version": 2,
                "overview": "讨论交付安排。",
                "discussion_points": [{
                    "content": "交付时间较紧",
                    "source_segment_id": "seg-2",
                    "source_quote": "时间比较紧",
                }],
                "key_decisions": ["按当前方案推进"],
                "action_items": [{
                    "content": "整理交付清单",
                    "candidate_type": "short_term_task",
                    "calendar_fitness": "high",
                    "time_scope": "short_term",
                    "assignee": "小陈",
                    "due_date": "周五",
                    "source_segment_id": "seg-1",
                    "source_quote": "周五前整理交付清单",
                    "confidence": 0.9,
                    "reason": "具体且有期限",
                }],
            }, ensure_ascii=False)
        return json.dumps({
            "items": [{
                "section_key": "topics",
                "content": "交付安排",
                "source_segment_id": "seg-1",
                "source_quote": "周五前整理交付清单",
            }, {
                "section_key": "feedback_concerns",
                "content": "交付时间较紧",
                "source_segment_id": "seg-2",
                "source_quote": "时间比较紧",
            }],
        }, ensure_ascii=False)

    monkeypatch.setattr(app_summary_generator, "call_ollama", fake_call)
    result = app_summary_generator.generate_compact_summary(
        "小陈：周五前整理交付清单。",
        template={
            "id": "one_on_one",
            "revision": 2,
            "title": "1:1",
            "sections": (
                {"key": "topics", "title": "讨论主题", "kind": "topics"},
                {"key": "feedback_concerns", "title": "反馈与关注", "kind": "bullets"},
                {"key": "commitments", "title": "双方约定", "kind": "decisions"},
                {"key": "follow_ups", "title": "后续事项", "kind": "action_items"},
            ),
        },
    )

    assert len(captured) == 2
    assert captured[0]["response_format"] == app_summary_generator._COMPACT_RESPONSE_SCHEMA
    assert captured[0]["max_tokens"] == 1536
    assert captured[0]["timeout"] == 150
    assert captured[0]["options"] == {"num_ctx": 12288, "temperature": 0}
    # The primary pass is template-invariant; the dedicated second pass
    # carries the selected presentation schema.
    assert "模板：1:1（one_on_one@2）" not in captured[0]["system_prompt"]

    schema = captured[1]["response_format"]
    item_schema = schema["properties"]["items"]["items"]
    assert item_schema["properties"]["section_key"]["enum"] == [
        "topics",
        "feedback_concerns",
    ]
    assert "commitments" not in item_schema["properties"]["section_key"]["enum"]
    assert "follow_ups" not in item_schema["properties"]["section_key"]["enum"]
    assert captured[1]["max_tokens"] == 768
    assert captured[1]["timeout"] == 120
    assert "本次模板：1:1（one_on_one@2）" in captured[1]["system_prompt"]
    topic = result["template_sections"]["topics"][0]
    assert topic["content"] == "交付安排"
    assert topic["source_segment_id"] == "seg-1"
    assert topic["source_quote"] == "周五前整理交付清单"


def test_template_field_failure_keeps_valid_core_summary(monkeypatch):
    calls = 0

    def fake_call(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return json.dumps({
                "overview": "讨论项目进展。",
                "key_decisions": [],
                "action_items": [],
            }, ensure_ascii=False)
        return "[]"

    monkeypatch.setattr(app_summary_generator, "call_ollama", fake_call)
    result = app_summary_generator.generate_compact_summary(
        "主持人：同步当前项目进展。",
        template={
            "id": "project_sync",
            "revision": 2,
            "title": "项目同步",
            "sections": (
                {"key": "progress", "title": "进展", "kind": "bullets"},
                {"key": "risks", "title": "风险与阻塞", "kind": "risks"},
                {"key": "decisions", "title": "决定", "kind": "decisions"},
                {"key": "action_items", "title": "行动项", "kind": "action_items"},
            ),
        },
    )

    assert calls == 2
    assert result["overview"] == "讨论项目进展。"
    assert "template_sections" not in result


def test_compact_generation_receives_only_explicit_authorized_context(monkeypatch):
    captured = {}

    def fake_call(*args, **kwargs):
        captured.update(kwargs)
        return json.dumps({
            "overview": "在上次方案基础上安排演示。",
            "key_decisions": ["演示改到周一上午十点"],
            "action_items": [],
        }, ensure_ascii=False)

    monkeypatch.setattr(app_summary_generator, "call_ollama", fake_call)
    app_summary_generator.generate_compact_summary(
        "主持人：演示改到周一上午十点。",
        authorized_context_prompt="【用户明确授权的历史参考】\n方案乙",
    )

    prompt = captured["system_prompt"]
    assert "方案乙" in prompt
    assert "未出现在授权上下文中的其他历史内容" in prompt
    assert "历史内容不得生成或借用本场 Transcript 引用" in prompt
