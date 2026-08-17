import pytest

from app.workers.summary_tasks import (
    SUMMARY_TEMPLATES,
    _append_authorized_history_context,
    _parse_final_summary_json,
    _remove_ungrounded_placeholder_actions,
    _remove_unconfirmed_history_outcomes,
    _summary_input_text,
    _summary_template_prompt,
    _template_section_contents,
    build_structured_summary_payload,
    get_summary_template,
    structured_summary_from_raw_json,
)


def test_action_content_removes_disfluency_owner_and_deadline_metadata():
    transcript = _summary_input_text([
        {
            "id": "seg-clean-action",
            "speaker": "小王",
            "speaker_id": "wang",
            "text": "呃，小王负责整理一下那个验收清单，截止时间是周五。",
            "start": 0,
            "end": 4,
        },
    ])
    _overview, _decisions, actions = _parse_final_summary_json(
        {
            "overview": "确认验收准备。",
            "action_items": [{
                "content": "呃，小王负责整理一下那个验收清单，截止时间是周五",
                "assignee": "小王",
                "due_date": "周五",
            }],
        },
        transcript,
    )

    assert len(actions) == 1
    assert actions[0]["content"] == "整理验收清单"
    assert actions[0]["assignee"] == "小王"
    assert actions[0]["due_date"] == "周五"


def test_primary_summary_due_field_is_preserved_for_app_clients():
    overview, decisions, actions = _parse_final_summary_json({
        "meeting": {"summary": "确认 Android 先发布。"},
        "decisions": [{"description": "Android 先发布"}],
        "action_items": [
            {"task": "修复登录崩溃", "assignee": "李工", "due": "2026-07-15"},
            {"task": "整理测试清单", "assignee": "王芳", "deadline": "2026-07-16"},
            {"task": "更新说明", "assignee": "张敏", "due_date": "2026-07-17"},
        ],
    })

    assert overview == "确认 Android 先发布。"
    assert decisions == ["Android 先发布"]
    assert [item["due_date"] for item in actions] == [
        "2026-07-15",
        "2026-07-16",
        "2026-07-17",
    ]


def _model_candidate(
    *,
    content: str,
    source_segment_id: str,
    source_quote: str,
    candidate_type: str = "short_term_task",
    calendar_fitness: str = "needs_confirmation",
    time_scope: str = "unspecified",
) -> dict:
    return {
        "content": content,
        "candidate_type": candidate_type,
        "calendar_fitness": calendar_fitness,
        "time_scope": time_scope,
        "assignee": None,
        "due_date": None,
        "source_segment_id": source_segment_id,
        "source_quote": source_quote,
        "confidence": 0.82,
        "reason": "根据完整语义评估",
    }


def test_model_candidate_semantics_replace_keyword_vetoes():
    source = "我们可以先整理现有监测点清单，下周拿出来讨论。"
    transcript = _summary_input_text([{
        "id": "seg-proposal-word",
        "speaker": "主持人",
        "speaker_id": "host",
        "text": source,
        "start": 0,
        "end": 4,
    }])
    _overview, _decisions, actions = _parse_final_summary_json({
        "candidate_contract_version": 2,
        "overview": "讨论监测点整理。",
        "key_decisions": [],
        "action_items": [_model_candidate(
            content="整理现有监测点清单",
            source_segment_id="seg-proposal-word",
            source_quote=source,
        )],
    }, transcript)

    assert [item["content"] for item in actions] == ["整理现有监测点清单"]
    assert actions[0]["calendar_fitness"] == "needs_confirmation"


def test_model_rejects_macro_goal_by_semantic_class_not_text_keywords():
    source = "我们要建立全球核污染监测网络，提升全球治理能力。"
    transcript = _summary_input_text([{
        "id": "seg-global-goal",
        "speaker": "发言人",
        "speaker_id": "speaker-1",
        "text": source,
        "start": 0,
        "end": 5,
    }])
    _overview, _decisions, actions = _parse_final_summary_json({
        "candidate_contract_version": 2,
        "overview": "发言人倡议建立全球核污染监测网络。",
        "key_decisions": [],
        "action_items": [_model_candidate(
            content="建立全球核污染监测网络",
            source_segment_id="seg-global-goal",
            source_quote=source,
            candidate_type="long_term_goal",
            calendar_fitness="not_calendar",
            time_scope="long_term",
        )],
    }, transcript)

    assert actions == []


def test_model_candidate_requires_verbatim_quote_from_declared_segment():
    transcript = _summary_input_text([{
        "id": "seg-real",
        "speaker": "小陈",
        "speaker_id": "chen",
        "text": "小陈周五前整理验收清单。",
        "start": 1,
        "end": 3,
    }])
    _overview, _decisions, actions = _parse_final_summary_json({
        "candidate_contract_version": 2,
        "overview": "确认验收准备。",
        "key_decisions": [],
        "action_items": [_model_candidate(
            content="整理验收清单",
            source_segment_id="seg-real",
            source_quote="小陈周五前完成验收清单",
            calendar_fitness="high",
            time_scope="short_term",
        )],
    }, transcript)

    assert actions == []


def test_structured_candidate_keeps_model_audit_metadata():
    source = "财务周五前确认付款条款。"
    transcript_lines = [{
        "id": "seg-payment-followup",
        "speaker": "主持人",
        "speaker_id": "host",
        "text": source,
        "start": 0,
        "end": 2,
    }]
    transcript = _summary_input_text(transcript_lines)
    raw = {
        "candidate_contract_version": 2,
        "overview": "安排付款条款确认。",
        "key_decisions": [],
        "action_items": [_model_candidate(
            content="确认付款条款",
            source_segment_id="seg-payment-followup",
            source_quote=source,
            candidate_type="follow_up",
            calendar_fitness="high",
            time_scope="short_term",
        )],
    }
    overview, decisions, actions = _parse_final_summary_json(raw, transcript)
    payload = build_structured_summary_payload(
        "meeting-semantic-candidate",
        overview,
        decisions,
        actions,
        raw_summary=raw,
        transcript_lines=transcript_lines,
    )

    candidate = payload["action_item_candidates"][0]
    assert candidate["candidate_type"] == "follow_up"
    assert candidate["calendar_fitness"] == "high"
    assert candidate["reason"] == "根据完整语义评估"
    assert candidate["citations"][0]["segment_id"] == "seg-payment-followup"


def test_unknown_decision_object_is_not_rendered_as_json_like_text():
    _overview, decisions, _actions = _parse_final_summary_json({
        "overview": "仅同步进度。",
        "decisions": [{"unexpected": {"nested": "value"}}],
        "action_items": [],
    })
    assert decisions == []


def test_summary_input_carries_absolute_meeting_date_for_relative_words():
    text = _summary_input_text(
        [{"speaker": "小陈", "text": "我今天下班前发培训通知"}],
        meeting_title="培训会",
        meeting_date="2026-07-10",
    )

    assert "会议标题：培训会" in text
    assert "会议日期：2026-07-10" in text
    assert "‘今天’‘明天’" in text
    assert "小陈：我今天下班前发培训通知" in text


def test_summary_input_keeps_segment_identity_without_prompt_only_metadata():
    text = _summary_input_text([
        {
            "id": "seg-123",
            "speaker": "小陈",
            "speaker_id": "speaker-1",
            "text": "确认移动端先行",
            "start": 12.5,
            "end": 18.0,
        }
    ])

    assert "[seg:seg-123] 小陈：确认移动端先行" in text
    assert "t=12.500-18.000" not in text
    assert "speaker=speaker-1" not in text


def test_citations_use_canonical_segment_time_and_hash_not_model_time():
    transcript = [{
        "id": "seg-1",
        "speaker": "小陈",
        "speaker_id": "speaker-1",
        "text": "最终确认移动端先行，小陈周五前整理验收清单。",
        "start": 12.5,
        "end": 18.0,
    }]
    raw = {
        "overview": "会议确认移动端先行。",
        "key_decisions": [{
            "description": "移动端先行",
            "source_segment_id": "seg-1",
            "source_quote": "最终确认移动端先行",
            "start_ms": 999999,
            "end_ms": 1,
        }],
        "action_items": [{
            "content": "整理验收清单",
            "assignee": "小陈",
            "due_date": "周五",
            "source_segment_id": "seg-1",
            "source_quote": "小陈周五前整理验收清单",
            "start_ms": 999999,
        }],
    }
    overview, decisions, actions = _parse_final_summary_json(raw)
    payload = build_structured_summary_payload(
        "meeting-1",
        overview,
        decisions,
        actions,
        raw_summary=raw,
        transcript_lines=transcript,
    )

    # Revision 2 no longer exposes a standalone “决定” section; decisions
    # are folded into the supported overview section.
    decision_section = next(section for section in payload["sections"] if section["key"] == "overview")
    decision_citation = decision_section["citations"][0]
    action_citation = payload["action_item_candidates"][0]["citations"][0]
    assert decision_citation["segment_id"] == "seg-1"
    assert decision_citation["start_ms"] == 12500
    assert decision_citation["end_ms"] == 18000
    assert decision_citation["quote_hash"].startswith("sha256:")
    assert action_citation["start_ms"] == 12500
    assert decision_citation["id"].startswith(f"{decision_section['id']}:citation:")
    assert action_citation["id"].startswith(
        f"{payload['action_item_candidates'][0]['id']}:citation:"
    )


def test_unknown_or_mismatched_id_uses_only_unique_normalized_quote_match():
    raw = {
        "overview": "确认灰度。",
        "key_decisions": [{
            "description": "确认灰度",
            "source_segment_id": "wrong-id",
            "source_quote": "确认  灰度",
        }],
    }
    transcript = [
        {"id": "seg-1", "text": "确认 灰度", "start": 1, "end": 2},
        {"id": "seg-2", "text": "讨论其他事项", "start": 3, "end": 4},
    ]
    payload = build_structured_summary_payload(
        "meeting-1",
        "确认灰度。",
        ["确认灰度"],
        [],
        raw_summary=raw,
        transcript_lines=transcript,
    )
    decision_section = next(section for section in payload["sections"] if section["key"] == "overview")
    assert [citation["segment_id"] for citation in decision_section["citations"]] == ["seg-1"]

    ambiguous = build_structured_summary_payload(
        "meeting-1",
        "确认灰度。",
        ["确认灰度"],
        [],
        raw_summary=raw,
        transcript_lines=[
            *transcript,
            {"id": "seg-3", "text": "再次确认 灰度", "start": 5, "end": 6},
        ],
    )
    ambiguous_section = next(
        section for section in ambiguous["sections"] if section["key"] == "overview"
    )
    assert ambiguous_section["citations"] == []


def test_empty_quote_and_invalid_canonical_time_are_never_cited():
    raw = {
        "key_decisions": [
            {"description": "方案通过", "source_segment_id": "seg-1", "source_quote": ""},
            {"description": "时间通过", "source_segment_id": "seg-2", "source_quote": "时间通过"},
        ],
    }
    payload = build_structured_summary_payload(
        "meeting-1",
        "会议记录包含讨论内容。",
        ["方案通过", "时间通过"],
        [],
        raw_summary=raw,
        transcript_lines=[
            {"id": "seg-1", "text": "方案通过", "start": 1, "end": 2},
            {"id": "seg-2", "text": "时间通过", "start": 4, "end": 3},
        ],
    )
    assert payload["sections"][0]["key"] == "overview"
    assert payload["sections"][0]["citations"] == []


def test_action_identity_includes_sorted_source_segment_ids():
    action = [{
        "content": "整理验收清单",
        "source_quote": "整理验收清单",
    }]
    one = build_structured_summary_payload(
        "meeting-1", "", [], action,
        raw_summary={"action_items": action},
        transcript_lines=[{"id": "seg-1", "text": "整理验收清单", "start": 0, "end": 1}],
    )
    two = build_structured_summary_payload(
        "meeting-1", "", [], action,
        raw_summary={"action_items": action},
        transcript_lines=[{"id": "seg-2", "text": "整理验收清单", "start": 0, "end": 1}],
    )
    assert one["action_item_candidates"][0]["id"] != two["action_item_candidates"][0]["id"]


def test_action_identity_and_citations_ignore_model_source_order():
    citations = [
        {"source_segment_id": "seg-2", "source_quote": "确认截止周五"},
        {"source_segment_id": "seg-1", "source_quote": "整理验收清单"},
    ]
    transcript = [
        {"id": "seg-1", "text": "整理验收清单", "start": 0, "end": 1},
        {"id": "seg-2", "text": "确认截止周五", "start": 1, "end": 2},
    ]
    first_action = {"content": "整理验收清单", "citations": citations}
    second_action = {"content": "整理验收清单", "citations": list(reversed(citations))}
    first = build_structured_summary_payload(
        "meeting-1", "", [], [first_action],
        raw_summary={"action_items": [first_action]},
        transcript_lines=transcript,
    )
    second = build_structured_summary_payload(
        "meeting-1", "", [], [second_action],
        raw_summary={"action_items": [second_action]},
        transcript_lines=transcript,
    )
    first_candidate = first["action_item_candidates"][0]
    second_candidate = second["action_item_candidates"][0]
    assert first_candidate["id"] == second_candidate["id"]
    assert [citation["segment_id"] for citation in first_candidate["citations"]] == [
        "seg-1", "seg-2",
    ]


def test_history_only_text_cannot_create_current_transcript_citation():
    raw = {
        "overview": "沿用上次决定。",
        "key_decisions": [{
            "description": "沿用上次决定",
            "source_segment_id": "old-segment",
            "source_quote": "Android 先发布",
        }],
    }
    payload = build_structured_summary_payload(
        "meeting-current",
        "沿用上次决定。",
        ["沿用上次决定"],
        [],
        raw_summary=raw,
        transcript_lines=[{
            "id": "current-segment",
            "text": "今天只同步进度",
            "start": 0,
            "end": 3,
        }],
    )
    assert all(section["citations"] == [] for section in payload["sections"])


def test_history_only_fragment_removes_a_borrowed_current_citation():
    carry = {
        "items": [{
            "kind": "decision",
            "content": "采用方案乙，不再继续评估方案甲",
        }],
    }
    discussion = {
        "summary": "沿用方案乙，不再继续评估方案甲",
        "source_segment_id": "current-segment",
        "source_quote": "沿用上次选定方案",
    }
    common = dict(
        meeting_id="meeting-current",
        overview="",
        key_decisions=[],
        action_items=[],
        section_contents={
            "key_discussion": "沿用方案乙，不再继续评估方案甲",
        },
        carry_forward=carry,
        raw_summary={"discussion_points": [discussion]},
    )
    history_only = build_structured_summary_payload(
        **common,
        transcript_lines=[{
            "id": "current-segment",
            "text": "沿用上次选定方案，不在本场重述名称。",
            "start": 0,
            "end": 3,
        }],
    )
    supported_here = build_structured_summary_payload(
        **common,
        transcript_lines=[{
            "id": "current-segment",
            "text": "沿用上次选定方案，采用方案乙，不再继续评估方案甲。",
            "start": 0,
            "end": 3,
        }],
    )

    assert history_only["sections"][0]["citations"] == []
    assert [
        citation["segment_id"]
        for citation in supported_here["sections"][0]["citations"]
    ] == ["current-segment"]


def test_history_background_cannot_become_unconfirmed_decisions_or_actions():
    carry = {
        "items": [
            {
                "kind": "decision",
                "content": "最终决定采用方案乙，不再继续评估方案甲",
            },
            {
                "kind": "action",
                "content": "王磊周三前完成安卓回归测试。",
            },
        ],
    }
    transcript = """
【会议转写】
主持人：历史方案只作背景，不在本场形成新的方案决策。
成员：安卓回归事项只同步进度，不新增任务。
主持人：本场唯一的新决定是演示改到周一上午十点。
主持人：周敏负责周日下班前准备演示清单。
""".strip()
    decisions, actions = _remove_unconfirmed_history_outcomes(
        [
            "演示改到周一上午十点",
            "沿用上次会议确定的方案乙，不再评估方案甲",
            "安卓回归事项进度过半，原负责人与期限不变",
        ],
        [
            {"content": "周敏准备演示清单", "assignee": "周敏"},
            {"content": "王磊完成安卓回归测试", "assignee": "王磊"},
        ],
        carry,
        transcript,
    )

    assert decisions == ["演示改到周一上午十点"]
    assert [action["content"] for action in actions] == ["周敏准备演示清单"]


def test_due_date_cannot_turn_a_decision_into_an_unassigned_action():
    actions = _remove_ungrounded_placeholder_actions(
        [
            {
                "content": "执行演示",
                "assignee": "待定",
                "due_date": "周一上午十点",
            },
            {
                "content": "准备验收清单",
                "assignee": "待定",
                "due_date": "周五",
            },
        ],
        """
主持人：本场唯一的新决定是演示改到周一上午十点。
主持人：验收前需要准备验收清单，负责人待定，周五前完成。
""".strip(),
    )

    assert [action["content"] for action in actions] == ["准备验收清单"]


def test_only_authorized_history_is_appended_to_a_non_outcome_section():
    template = get_summary_template("general", SUMMARY_TEMPLATES["general"]["revision"])
    sections = _append_authorized_history_context(
        {"overview": "本场确认演示安排。", "key_discussion": ""},
        template,
        {
            "items": [
                {
                    "kind": "action",
                    "source_occurrence_date": "2026-07-27",
                    "source_title": "上次复盘",
                    "content": "完成安卓回归测试",
                    "assignee": "王磊",
                    "due_at": "2026-07-29T18:00:00+08:00",
                },
            ],
        },
    )

    assert sections["overview"] == "本场确认演示安排。"
    assert "decisions" not in sections
    assert "来自 2026-07-27 · 上次复盘" in sections["key_discussion"]
    assert "完成安卓回归测试" in sections["key_discussion"]
    assert "负责人：王磊" in sections["key_discussion"]
    assert "截止：2026-07-29 18:00:00+08:00" in sections["key_discussion"]


@pytest.mark.parametrize("segment_ids", [[None], ["dup", "dup"]])
def test_missing_or_duplicate_transcript_identity_never_emits_unmappable_citation(segment_ids):
    transcript = [
        {
            "id": segment_id,
            "text": "确认方案通过",
            "start": index,
            "end": index + 1,
        }
        for index, segment_id in enumerate(segment_ids)
    ]
    payload = build_structured_summary_payload(
        "meeting-1",
        "会议记录包含讨论内容。",
        ["确认方案通过"],
        [],
        raw_summary={"key_decisions": ["确认方案通过"]},
        transcript_lines=transcript,
    )
    assert payload["sections"][0]["key"] == "overview"
    assert payload["sections"][0]["citations"] == []


def test_persisted_structured_citation_shape_fails_closed():
    raw = {
        "key_decisions": [{
            "description": "确认方案通过",
            "source_segment_id": "seg-1",
            "source_quote": "确认方案通过",
        }],
    }
    payload = build_structured_summary_payload(
        "meeting-1",
        "确认方案通过。",
        ["确认方案通过"],
        [],
        raw_summary=raw,
        transcript_lines=[{
            "id": "seg-1",
            "text": "确认方案通过",
            "start": 0,
            "end": 1,
        }],
    )
    assert structured_summary_from_raw_json(payload, "meeting-1") is not None

    malformed = {**payload, "sections": [{**payload["sections"][0], "citations": [
        {**payload["sections"][0]["citations"][0], "start_ms": -1},
    ]}]}
    assert structured_summary_from_raw_json(malformed, "meeting-1") is None


def test_quote_hash_changes_when_canonical_segment_text_drifts():
    raw = {"key_decisions": [{
        "description": "确认方案通过",
        "source_segment_id": "seg-1",
        "source_quote": "确认方案通过",
    }]}
    hashes = []
    for text in ("确认方案通过", "确认方案通过，补充灰度范围"):
        payload = build_structured_summary_payload(
            "meeting-1", "确认方案通过。", ["确认方案通过"], [],
            raw_summary=raw,
            transcript_lines=[{"id": "seg-1", "text": text, "start": 0, "end": 1}],
        )
        hashes.append(payload["sections"][0]["citations"][0]["quote_hash"])
    assert hashes[0] != hashes[1]


def test_structured_summary_payload_is_additive_and_action_ids_are_stable():
    actions = [{
        "content": "整理验收清单",
        "assignee": "小陈",
        "due_date": "2026-07-25",
        "status": "pending",
    }]
    first = build_structured_summary_payload(
        "meeting-1",
        "确认移动端先行。",
        ["移动端先行"],
        actions,
        version_id="version-1",
        generated_at="2026-07-23T10:00:00Z",
    )
    second = build_structured_summary_payload(
        "meeting-1",
        "确认移动端先行。",
        ["移动端先行"],
        actions,
        version_id="version-1",
        generated_at="2026-07-23T10:00:00Z",
    )

    assert first["schema_version"] == 2
    assert first["generated_by"] == "laoji-compact"
    assert first["sections"][0]["key"] == "overview"
    assert first["action_item_candidates"][0]["id"] == second["action_item_candidates"][0]["id"]
    assert first["action_item_candidates"][0]["citations"] == []
    assert first["action_item_candidates"][0]["due_at"] == "2026-07-25"


def test_structured_action_identity_normalizes_display_only_variants():
    first = build_structured_summary_payload(
        "meeting-1",
        "",
        [],
        [{"content": "整理  验收清单", "assignee": "Ａ组", "due_date": "2026-07-25"}],
    )
    second = build_structured_summary_payload(
        "meeting-1",
        "",
        [],
        [{"content": "整理 验收清单", "assignee": "A组", "due_date": "2026-07-25"}],
    )

    assert first["action_item_candidates"][0]["id"] == second["action_item_candidates"][0]["id"]
    assert first["generated_at"].endswith("Z")


@pytest.mark.parametrize("template_id", tuple(SUMMARY_TEMPLATES))
def test_each_builtin_template_emits_its_fixed_section_schema(template_id):
    template = get_summary_template(template_id, SUMMARY_TEMPLATES[template_id]["revision"])
    guarded_keys = {"decisions", "commitments", "action_items", "follow_ups"}
    explicit = {
        section["key"]: [f"{section['title']}内容"]
        for section in template["sections"]
        if section["key"] not in guarded_keys
    }
    data = {"template_sections": explicit}
    decisions = ["已核验的决定"] if any(
        section["key"] in {"decisions", "commitments"}
        for section in template["sections"]
    ) else []
    actions = [{"content": "已核验的行动项"}] if any(
        section["key"] in {"action_items", "follow_ups"}
        for section in template["sections"]
    ) else []
    contents = _template_section_contents(data, template, "", decisions, actions)
    payload = build_structured_summary_payload(
        "meeting-template",
        "",
        decisions,
        actions,
        template_id=template_id,
        template_revision=SUMMARY_TEMPLATES[template_id]["revision"],
        section_contents=contents,
    )

    assert payload["template_id"] == template_id
    assert payload["template_revision"] == SUMMARY_TEMPLATES[template_id]["revision"]
    assert [section["key"] for section in payload["sections"]] == [
        section["key"] for section in template["sections"]
    ]
    assert template_id in _summary_template_prompt(template)


def test_raw_template_decisions_and_actions_cannot_bypass_quality_guards():
    template = get_summary_template(
        "project_sync", SUMMARY_TEMPLATES["project_sync"]["revision"]
    )
    contents = _template_section_contents(
        {
            "template_sections": {
                "decisions": ["未经核验的决定"],
                "action_items": ["未经核验的行动项"],
            },
        },
        template,
        "",
        [],
        [],
    )
    # The current templates do not expose standalone decisions/action_items
    # sections. Those model-invented keys are ignored rather than projected
    # into the structured result; decisions are folded into the supported
    # section schema by the caller.
    assert "decisions" not in contents
    assert "action_items" not in contents


def test_interview_fallback_does_not_repeat_overview_as_interviewee_view():
    template = get_summary_template("interview", SUMMARY_TEMPLATES["interview"]["revision"])
    contents = _template_section_contents(
        {},
        template,
        "会议讨论了产品方向。",
        [],
        [],
    )

    assert contents["topics"] == "会议讨论了产品方向。"
    assert contents["interviewee_views"] == ""
    assert contents["evidence_quotes"] == ""
    assert contents["follow_up_questions"] == ""


def test_template_revision_and_unknown_template_are_rejected():
    with pytest.raises(ValueError, match="版本"):
        get_summary_template(
            "general", SUMMARY_TEMPLATES["general"]["revision"] + 1
        )
    with pytest.raises(ValueError, match="不支持"):
        get_summary_template("free_prompt", 1)


def test_action_identity_includes_template_key():
    action = [{"content": "整理验收清单", "assignee": "小陈", "due_date": None}]
    general = build_structured_summary_payload("meeting-1", "", [], action)
    project = build_structured_summary_payload(
        "meeting-1",
        "",
        [],
        action,
        template_id="project_sync",
        template_revision=SUMMARY_TEMPLATES["project_sync"]["revision"],
    )
    assert general["action_item_candidates"][0]["id"] != project["action_item_candidates"][0]["id"]


def test_persisted_structured_template_round_trips_without_general_fallback():
    payload = build_structured_summary_payload(
        "meeting-1",
        "",
        [],
        [],
        template_id="interview",
        template_revision=SUMMARY_TEMPLATES["interview"]["revision"],
        section_contents={"topics": "产品使用习惯"},
    )
    raw = {"provider_output": {}, "_laoji_structured_summary": payload}
    restored = structured_summary_from_raw_json(raw, "meeting-1")
    assert restored is not None
    assert restored["template_id"] == "interview"
    assert restored["sections"][0]["key"] == "topics"
