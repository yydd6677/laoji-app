import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meetings
from app.models import Base
from app.models.meeting import Meeting
from app.models.transcript import TranscriptLine
from app.workers import summary_tasks


@pytest.fixture(autouse=True)
def _hermetic_question_retrieval(monkeypatch):
    """Keep legacy Q0 contract tests independent from the live embedding daemon."""
    from app.services import app_meeting_question

    monkeypatch.setattr(
        app_meeting_question,
        "semantic_source_scores",
        lambda *_args, **_kwargs: {},
    )


@pytest.mark.asyncio
async def test_empty_title_root_contract_is_idempotent_and_nullable_fields_can_be_cleared(monkeypatch):
    monkeypatch.setattr(app_meetings, "_assert_user_meeting_writable", lambda _user_id: None)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with session_factory() as db:
            request = app_meetings.AppMeetingCreate(
                title="",
                description="会前说明",
                location="会议室 A",
                recorded_at=datetime(2026, 7, 24, 6, 30, tzinfo=timezone.utc),
                client_request_id="meeting:empty-title:abcdefghij",
            )
            first = await app_meetings.create_app_meeting(request, {"id": 7}, db)
            await db.commit()
            replay = await app_meetings.create_app_meeting(request, {"id": 7}, db)

            assert first["id"] == replay["id"]
            assert first["title"] == ""
            assert first["location"] == "会议室 A"
            assert first["recorded_at"] == "2026-07-24T06:30:00"
            assert await db.scalar(
                select(func.count(Meeting.id)).where(Meeting.user_id == 7)
            ) == 1

            update = app_meetings.AppMeetingUpdate(
                title="",
                description=None,
                location=None,
            )
            assert {"title", "description", "location"} <= update.model_fields_set
            changed = await app_meetings.update_app_meeting(
                first["id"],
                update,
                {"id": 7},
                db,
            )
            assert changed["title"] == ""
            assert changed["description"] is None
            assert changed["location"] is None
    finally:
        await engine.dispose()


def test_template_identity_participates_in_fingerprint_and_rejects_unknown_revision():
    lines = [{"id": "seg-1", "speaker": "甲", "text": "确认周五发布"}]
    general = summary_tasks.summary_payload_fingerprint(
        lines,
        "发布会",
        "2026-07-24",
        "general",
        summary_tasks.SUMMARY_TEMPLATES["general"]["revision"],
    )
    project = summary_tasks.summary_payload_fingerprint(
        lines,
        "发布会",
        "2026-07-24",
        "project_sync",
        summary_tasks.SUMMARY_TEMPLATES["project_sync"]["revision"],
    )
    assert general != project
    with pytest.raises(ValueError, match="版本"):
        summary_tasks.get_summary_template(
            "project_sync", summary_tasks.SUMMARY_TEMPLATES["project_sync"]["revision"] + 1
        )


def test_structured_sections_keep_quality_guarded_decisions_and_actions():
    template = summary_tasks.get_summary_template(
        "project_sync", summary_tasks.SUMMARY_TEMPLATES["project_sync"]["revision"]
    )
    contents = summary_tasks._template_section_contents(
        {
            "template_sections": {
                "progress": ["完成接口联调"],
                "decisions": ["模型臆造的决定"],
                "action_items": ["模型臆造的行动"],
            },
        },
        template,
        "确认发布范围。",
        ["Android 先发布"],
        [{"content": "小陈周五前完成灰度", "assignee": "小陈", "due_date": "周五"}],
    )
    assert contents["progress"] == "完成接口联调"
    assert "decisions" not in contents
    assert "action_items" not in contents


def test_structured_action_identity_is_stable_and_wrong_meeting_payload_is_rejected():
    actions = [{"content": "完成灰度", "assignee": "小陈", "due_date": "周五"}]
    first = summary_tasks.build_structured_summary_payload(
        "meeting-1",
        "概述",
        [],
        actions,
    )
    second = summary_tasks.build_structured_summary_payload(
        "meeting-1",
        "概述",
        [],
        actions,
    )
    assert first["action_item_candidates"][0]["id"] == second["action_item_candidates"][0]["id"]
    assert summary_tasks.structured_summary_from_raw_json(
        {"_laoji_structured_summary": first},
        "meeting-2",
    ) is None


def carry_forward_authorization(source_meeting_id: str, request_id: str = "carry:test:abcdefghij"):
    return app_meetings.SummaryCarryForwardAuthorization(
        request_id=request_id,
        items=[{
            "kind": "decision",
            "source_meeting_id": source_meeting_id,
            "source_item_id": "decision:1",
            "source_title": "上次例会",
            "source_occurrence_date": "2026-07-17",
            "content": "Android 先发布",
        }],
    )


@pytest.mark.asyncio
async def test_account_summary_carry_forward_requires_owned_source_and_reaches_task(monkeypatch):
    monkeypatch.setattr(app_meetings, "_assert_user_meeting_writable", lambda _user_id: None)
    captured = {}

    def fake_submit(*_args, **kwargs):
        captured.update(kwargs)
        return type("Task", (), {"id": "task-1", "reused": False})()

    monkeypatch.setattr(app_meetings, "submit_final_summary", fake_submit)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with session_factory() as db:
            source = Meeting(id="source-meeting", user_id=7, app_owned=1, title="上次例会")
            current = Meeting(id="current-meeting", user_id=7, app_owned=1, title="本次例会")
            db.add_all([source, current, TranscriptLine(
                id="transcript-line",
                meeting_id=current.id,
                speaker_id="speaker-1",
                speaker_label="甲",
                text="确认灰度安排",
                start_time=0,
                end_time=2,
                confidence=1,
            )])
            await db.flush()
            request = app_meetings.AppSummaryGenerateRequest(
                carry_forward=carry_forward_authorization(source.id),
            )
            response = await app_meetings.generate_app_meeting_summary(
                current.id,
                request=request,
                current_user={"id": 7},
                db=db,
            )
            assert response["carry_forward_request_id"] == "carry:test:abcdefghij"
            assert captured["carry_forward"]["items"][0]["content"] == "Android 先发布"

            foreign = Meeting(id="foreign-meeting", user_id=8, app_owned=1, title="其他账号")
            db.add(foreign)
            await db.flush()
            with pytest.raises(app_meetings.HTTPException) as error:
                await app_meetings.generate_app_meeting_summary(
                    current.id,
                    request=app_meetings.AppSummaryGenerateRequest(
                        carry_forward=carry_forward_authorization(foreign.id, "carry:test:foreign123"),
                    ),
                    current_user={"id": 7},
                    db=db,
                )
            assert error.value.status_code == 409
    finally:
        await engine.dispose()


def test_carry_forward_identity_changes_fingerprint_and_round_trips_in_v2():
    lines = [{"id": "seg-1", "speaker": "甲", "text": "确认灰度"}]
    carry = carry_forward_authorization("source-meeting").model_dump(mode="json")
    plain = summary_tasks.summary_payload_fingerprint(lines)
    authorized = summary_tasks.summary_payload_fingerprint(lines, carry_forward=carry)
    assert plain != authorized
    prompt = summary_tasks._summary_prompt_suffix(
        summary_tasks.get_summary_template(
            "general", summary_tasks.SUMMARY_TEMPLATES["general"]["revision"]
        ),
        carry,
    )
    assert "不是本场转写证据" in prompt
    payload = summary_tasks.build_structured_summary_payload(
        "meeting-1",
        "概述",
        [],
        [],
        carry_forward_request_id=carry["request_id"],
    )
    restored = summary_tasks.structured_summary_from_raw_json(payload, "meeting-1")
    assert restored is not None
    assert restored["carry_forward_request_id"] == carry["request_id"]


def test_carry_forward_uses_context_aware_compact_path_and_preserves_durable_identity():
    template = summary_tasks.get_summary_template(
        "general", summary_tasks.SUMMARY_TEMPLATES["general"]["revision"]
    )
    one_on_one = summary_tasks.get_summary_template(
        "one_on_one", summary_tasks.SUMMARY_TEMPLATES["one_on_one"]["revision"]
    )
    carry = carry_forward_authorization("source-meeting").model_dump(mode="json")
    assert summary_tasks._can_use_compact_summary(template, None) is True
    assert summary_tasks._can_use_compact_summary(one_on_one, None) is True
    assert summary_tasks._can_use_compact_summary(template, carry) is True
    assert summary_tasks._can_use_compact_summary(one_on_one, carry) is True
    assert summary_tasks._can_use_compact_summary(
        template,
        carry,
        {"request_id": "attachment-request"},
    ) is True
    assert app_meetings._preserve_contextual_structured_summary({
        "template_id": "general",
        "template_revision": summary_tasks.SUMMARY_TEMPLATES["general"]["revision"],
        "carry_forward_request_id": carry["request_id"],
    }) is True
    assert app_meetings._preserve_contextual_structured_summary({
        "template_id": "general",
        "template_revision": summary_tasks.SUMMARY_TEMPLATES["general"]["revision"],
        "carry_forward_request_id": None,
    }) is False


def test_meeting_question_followup_accepts_and_preserves_model_punctuation():
    from app.services.app_meeting_question import (
        _normalize_answer,
        meeting_question_input_fingerprint,
    )

    payload = {
        "schema_version": 1,
        "client_meeting_id": "local-meeting-1",
        "client_thread_id": "question-thread-1",
        "client_request_id": "question-request-2",
        "expected_ordinal": 1,
        "input_fingerprint": "",
        "transcript_revision_id": "transcript-revision-1",
        "summary_version_id": None,
        "manual_note_revision": None,
        "include_manual_note": False,
        "question": "后续负责人是谁?",
        "transcript_segments": [{
            "segment_id": "segment-1",
            "source_segment_id": "remote-segment-1",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "王芳",
            "text": "王芳负责采购。",
        }],
        "summary_sections": [],
        "manual_note": None,
        "context": [{
            "ordinal": 0,
            "question": "预算和负责人是谁?",
            "answer_kind": "answer",
            "answer": "预算是五十万元，由王芳负责。",
            "citations": [{"kind": "transcript", "source_id": "segment-1"}],
        }],
    }
    payload["input_fingerprint"] = meeting_question_input_fingerprint(payload)
    normalized = app_meetings._meeting_question_payload(
        app_meetings.MeetingQuestionRequest(**payload)
    )
    assert normalized["context"][0]["answer"] == "预算是五十万元，由王芳负责。"

    answer = _normalize_answer({
        "answer_kind": "answer",
        "answer": "预算是五十万元，由王芳负责。",
        "citations": [{"kind": "transcript", "source_id": "segment-1"}],
    }, payload)
    assert answer["answer"] == "预算是五十万元，由王芳负责。"


def test_meeting_question_keeps_summary_inside_long_transcript_budget(monkeypatch):
    from app.services.app_meeting_question import (
        _MAX_PROMPT_CHARS,
        _prompt_source_line,
        _selected_sources,
    )
    from app.services import app_meeting_question as question_service

    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})

    payload = {
        "question": "这是一次什么会议",
        "transcript_segments": [
            {
                "segment_id": f"segment-{index}",
                "source_segment_id": f"remote-segment-{index}",
                "start_ms": index * 1000,
                "end_ms": (index + 1) * 1000,
                "speaker": "讲话人",
                "text": (f"第{index}段普通文字记录" * 500),
            }
            for index in range(48)
        ],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "这是一次关于青年成长与责任的主题讲座。",
        }],
        "include_manual_note": False,
        "manual_note": None,
    }

    sources = _selected_sources(payload)

    assert sources[0]["kind"] == "summary"
    assert sources[0]["source_id"] == "summary-overview"
    assert any(source["kind"] == "transcript" for source in sources)
    assert sum(len(_prompt_source_line(source)) for source in sources) <= _MAX_PROMPT_CHARS


def test_meeting_question_aliases_long_mobile_source_ids_without_dropping_late_evidence(
    monkeypatch,
):
    from app.services import app_meeting_question as question_service

    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})
    transcript = [
        {
            "segment_id": f"meeting:revision:{'x' * 220}:segment:{index}",
            "source_segment_id": f"remote-segment-{index}",
            "start_ms": index * 1000,
            "end_ms": (index + 1) * 1000,
            "speaker": "讲话人",
            "text": f"第{index + 1}种方向是样本方案{index + 1}。",
        }
        for index in range(24)
    ]
    payload = {
        "question": "二十四种方向都是什么？",
        "transcript_segments": transcript,
        "summary_sections": [],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    selected = question_service._selected_sources(payload)
    model_input = json.loads(question_service._model_input(payload))

    assert len(selected) == len(transcript)
    assert selected[-1]["source_id"] == transcript[-1]["segment_id"]
    # Prompt transport groups adjacent transcript segments to avoid spending
    # the context budget on long mobile IDs. The group is only a transport
    # alias; citations are expanded back to direct stable segment IDs below.
    assert 1 < len(model_input["sources"]) < len(transcript)
    assert all(source.startswith("[@tgrp:") for source in model_input["sources"])
    prompt_source_ids = [source[1:].split("|", 1)[0] for source in model_input["sources"]]
    assert all(len(source_id) < 32 for source_id in prompt_source_ids)

    normalized = question_service._normalize_answer({
        "answer_kind": "answer",
        "answer": "第24种方向是样本方案24。",
        "citations": [{
            "kind": "transcript",
            "source_id": prompt_source_ids[-1],
        }],
    }, payload)
    assert normalized["citations"] == [{
        "kind": "transcript",
        "source_id": transcript[-1]["segment_id"],
    }]


def test_meeting_question_specific_sources_put_transcript_before_overview_summary(monkeypatch):
    from app.services import app_meeting_question as question_service

    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})

    payload = {
        "question": "宠物智能项圈智能在哪",
        "transcript_segments": [{
            "segment_id": "segment-collar",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "讲话人",
            "text": "项圈能定位宠物，记录疫苗和生理信息，并连接手机终端。",
        }],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "会议讨论了五种创业方向，最终聚焦宠物智能项圈。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    sources = question_service._selected_sources(payload)

    assert sources[0]["kind"] == "transcript"
    assert sources[-1]["source_id"] == "summary-overview"


def test_meeting_question_reviews_broad_summary_answer_against_transcript(monkeypatch):
    from app.services import app_meeting_question as question_service

    payload = {
        "question": "宠物智能项圈智能在哪",
        "transcript_segments": [{
            "segment_id": "segment-collar",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "讲话人",
            "text": "项圈能定位宠物，记录疫苗和生理信息，并连接手机终端。",
        }],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "会议讨论了五种创业方向，最终聚焦宠物智能项圈。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }
    calls = []

    class Config:
        provider = "ollama"

    def fake_call(_config, system_prompt, model_input, **_kwargs):
        calls.append((system_prompt, json.loads(model_input)))
        if len(calls) == 1:
            return json.dumps({
                "answer_scope": "meeting",
                "answer_kind": "answer",
                "answer": "会议讨论了五种创业方向，最终聚焦宠物智能项圈。",
                "citations": [{"kind": "summary", "source_id": "summary-overview"}],
            }, ensure_ascii=False)
        return json.dumps({
            "answer_kind": "answer",
            "answer": "项圈可定位宠物、记录疫苗和生理信息，并连接手机终端。",
            "citations": [{"kind": "transcript", "source_id": "segment-collar"}],
        }, ensure_ascii=False)

    monkeypatch.setattr(question_service, "_question_model_config", lambda: Config())
    monkeypatch.setattr(question_service, "call_ollama", fake_call)
    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})

    answer = question_service.generate_meeting_question_answer(payload)

    assert answer["answer_kind"] == "answer"
    assert "定位宠物" in answer["answer"]
    assert answer["citations"] == [{"kind": "transcript", "source_id": "segment-collar"}]
    assert len(calls) >= 2
    assert any(
        call_input.get("sources")
        and all("summary" not in source for source in call_input["sources"])
        for _prompt, call_input in calls[1:]
    )


def test_meeting_question_reviews_incomplete_exhaustive_enumeration(monkeypatch):
    from app.services import app_meeting_question as question_service

    payload = {
        "question": "五种创业方向都是什么？",
        "transcript_segments": [
            {
                "segment_id": "segment-parking",
                "start_ms": 0,
                "end_ms": 1000,
                "speaker": "讲话人",
                "text": "第一个方向是小区车位信息化。",
            },
            {
                "segment_id": "segment-collar",
                "start_ms": 1000,
                "end_ms": 2000,
                "speaker": "讲话人",
                "text": "另一个方向是宠物智能项圈。",
            },
        ],
        "summary_sections": [],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }
    calls = []

    class Config:
        provider = "ollama"

    def fake_call(_config, system_prompt, model_input, **_kwargs):
        calls.append((system_prompt, json.loads(model_input)))
        if len(calls) == 1:
            return json.dumps({
                "answer_scope": "meeting",
                "answer_kind": "answer",
                "answer": "会议提到了五种创业方向。",
                "citations": [{"kind": "transcript", "source_id": "segment-parking"}],
            }, ensure_ascii=False)
        return json.dumps({
            "answer_kind": "answer",
            "answer": (
                "1. 小区车位信息化；2. 高考志愿填报系统；"
                "3. 景区信息化；4. VR 非遗保护；5. 宠物智能项圈。"
            ),
            "citations": [
                {"kind": "transcript", "source_id": "segment-parking"},
                {"kind": "transcript", "source_id": "segment-collar"},
            ],
        }, ensure_ascii=False)

    monkeypatch.setattr(question_service, "_question_model_config", lambda: Config())
    monkeypatch.setattr(question_service, "call_ollama", fake_call)
    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})

    answer = question_service.generate_meeting_question_answer(payload)

    assert answer["answer_kind"] == "answer"
    assert "车位信息化" in answer["answer"]
    assert "宠物智能项圈" in answer["answer"]
    assert len(answer["citations"]) == 2
    assert len(calls) >= 3
    assert any(
        call_input.get("candidate_answer", {}).get("answer_kind") == "answer"
        for _prompt, call_input in calls
    )
    assert question_service._is_exhaustive_enumeration_question("五种创业方向是哪五种？")
    assert question_service._canonical_exhaustive_enumeration_question(
        "五种创业方向都是什么？",
    ) == question_service._canonical_exhaustive_enumeration_question(
        "五种创业方向是哪五种？",
    )


def test_meeting_question_overview_uses_grounded_summary_when_model_refuses():
    from app.services.app_meeting_question import _normalize_answer

    payload = {
        "question": "这是什么会议",
        "transcript_segments": [{
            "segment_id": "segment-1",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "王芳",
            "text": "今天讨论青年成长与责任。",
        }],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "这是一次关于青年成长与责任的主题讲座。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    answer = _normalize_answer({
        "answer_kind": "insufficient",
        "answer": "当前会议记录中没有足够信息",
        "citations": [],
    }, payload)

    assert answer == {
        "answer_kind": "answer",
        "answer": "这是一次关于青年成长与责任的主题讲座。",
        "citations": [{"kind": "summary", "source_id": "summary-overview"}],
    }


def test_meeting_question_invalid_citation_does_not_substitute_a_source_excerpt():
    from app.services.app_meeting_question import _normalize_answer

    payload = {
        "question": "后续负责人是谁",
        "transcript_segments": [{
            "segment_id": "segment-owner",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "陈明",
            "text": "王芳负责采购，周五前完成。",
        }],
        "summary_sections": [],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    answer = _normalize_answer({
        "answer_kind": "answer",
        "answer": "王芳负责。",
        "citations": [{"kind": "transcript", "source_id": "invented"}],
    }, payload)

    assert answer == {
        "answer_kind": "insufficient",
        "answer": "当前会议记录中没有足够信息",
        "citations": [],
    }


def test_meeting_question_keeps_insufficient_for_unrelated_sources():
    from app.services.app_meeting_question import _normalize_answer

    payload = {
        "question": "午餐地点在哪里",
        "transcript_segments": [{
            "segment_id": "segment-release",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "陈明",
            "text": "Android 版本将在周五发布。",
        }],
        "summary_sections": [{
            "section_id": "summary-release",
            "title": "发布计划",
            "text": "团队确认周五发布 Android 版本。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    answer = _normalize_answer({
        "answer_kind": "insufficient",
        "answer": "当前会议记录中没有足够信息",
        "citations": [],
    }, payload)

    assert answer == {
        "answer_kind": "insufficient",
        "answer": "当前会议记录中没有足够信息",
        "citations": [],
    }


def test_meeting_question_routes_clearly_unrelated_prompt_without_meeting_sources(monkeypatch):
    from app.services import app_meeting_question as question_service

    payload = {
        "question": "太阳系有几颗行星？",
        "transcript_segments": [{
            "segment_id": "segment-release",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "陈明",
            "text": "团队确认周五发布 Android 版本。",
        }],
        "summary_sections": [{
            "section_id": "summary-release",
            "title": "发布计划",
            "text": "团队确认周五发布 Android 版本。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }
    calls = []

    class Config:
        provider = "ollama"

    def fake_call(_config, system_prompt, model_input, **_kwargs):
        calls.append((system_prompt, model_input))
        if "范围路由器" in system_prompt:
            return json.dumps({"scope": "general"}, ensure_ascii=False)
        return json.dumps({"answer": "太阳系有八颗行星。"}, ensure_ascii=False)

    monkeypatch.setattr(question_service, "_question_model_config", lambda: Config())
    monkeypatch.setattr(question_service, "call_ollama", fake_call)

    answer = question_service.generate_meeting_question_answer(payload)

    assert answer == {
        "answer_scope": "general",
        "answer_kind": "answer",
        "answer": "太阳系有八颗行星。",
        "citations": [],
    }
    assert calls
    assert sum("范围路由器" in prompt for prompt, _model_input in calls) == 1
    # The unified reader may inspect the current meeting before the scope
    # router resolves `general`; the final general-answer call must not carry
    # meeting evidence forward.
    assert "周五发布" not in calls[-1][1]
    assert "transcript" not in calls[-1][1]
    assert question_service._question_answer_scope({
        **payload,
        "question": "会议决定哪天发布？",
    }) == "meeting"


def test_meeting_question_fallback_does_not_match_generic_meeting_words():
    from app.services.app_meeting_question import _normalize_answer

    payload = {
        "question": "会议是否决定明天发布一款新产品",
        "transcript_segments": [{
            "segment_id": "segment-youth",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "陈明",
            "text": "青年应将个人理想融入国家发展。",
        }],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "会议回顾了青年成长与责任。",
        }],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    answer = _normalize_answer({
        "answer_kind": "insufficient",
        "answer": "当前会议记录中没有足够信息",
        "citations": [],
    }, payload)

    assert answer["answer_kind"] == "insufficient"


def test_meeting_question_my_note_scope_never_substitutes_transcript():
    from app.services.app_meeting_question import _normalize_answer, _selected_sources

    base = {
        "question": "我的笔记提醒了谁做什么",
        "transcript_segments": [{
            "segment_id": "segment-owner",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "陈明",
            "text": "王芳负责提交采购清单。",
        }],
        "summary_sections": [],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }

    assert _selected_sources(base) == []
    without_note = _normalize_answer({
        "answer_kind": "answer",
        "answer": "王芳负责提交采购清单。",
        "citations": [{"kind": "transcript", "source_id": "segment-owner"}],
    }, base)
    assert without_note["answer_kind"] == "insufficient"

    with_note = {
        **base,
        "include_manual_note": True,
        "manual_note": {"revision": 3, "content": "会后提醒王芳补充三家供应商报价。"},
    }
    assert _selected_sources(with_note) == [{
        "kind": "manual_note",
        "source_id": "manual-note:3",
        "text": "会后提醒王芳补充三家供应商报价。",
    }]


def test_meeting_question_prioritizes_relevant_note_without_displacing_unrelated_transcript(
    monkeypatch,
):
    from app.services import app_meeting_question as question_service

    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})
    base = {
        "transcript_segments": [{
            "segment_id": "segment-owner",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "主持人",
            "text": "王芳负责在周五前提交采购清单。",
        }],
        "summary_sections": [],
        "include_manual_note": True,
        "manual_note": {"revision": 4, "content": "采购预算上限是三万一千四百一十五元。"},
        "context": [],
    }

    budget_sources = question_service._selected_sources({
        **base,
        "question": "采购预算上限是多少？",
    })
    owner_sources = question_service._selected_sources({
        **base,
        "question": "谁负责提交清单？",
    })

    assert budget_sources[0]["kind"] == "manual_note"
    assert budget_sources[0]["source_id"] == "manual-note:4"
    assert owner_sources[0]["kind"] == "transcript"
    assert owner_sources[0]["source_id"] == "segment-owner"


def test_meeting_question_strict_review_keeps_current_manual_note(monkeypatch):
    from app.services import app_meeting_question as question_service

    monkeypatch.setattr(question_service, "semantic_source_scores", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(question_service, "_select_evidence_focus", lambda *_args, **_kwargs: [])

    class Config:
        provider = "ollama"

    payload = {
        "question": "采购预算上限是多少？",
        "transcript_segments": [{
            "segment_id": "segment-owner",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "主持人",
            "text": "王芳负责在周五前提交采购清单。",
        }],
        "summary_sections": [{
            "section_id": "summary-overview",
            "title": "会议概述",
            "text": "会议讨论了采购工作。",
        }],
        "include_manual_note": True,
        "manual_note": {"revision": 4, "content": "采购预算上限是三万一千四百一十五元。"},
        "context": [],
    }

    review = json.loads(question_service._strict_verification_input(
        Config(),
        payload,
        {"answer_kind": "answer", "answer": "预算待确认。", "citations": []},
    ))

    assert any("manual-note:4" in source for source in review["sources"])
    assert all("summary-overview" not in source for source in review["sources"])


def test_meeting_question_marks_unresolved_standalone_pronoun():
    from app.services.app_meeting_question import _normalize_answer

    payload = {
        "question": "他负责什么",
        "transcript_segments": [{
            "segment_id": "segment-people",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "主持人",
            "text": "王芳负责采购,李强负责测试。",
        }],
        "summary_sections": [],
        "include_manual_note": False,
        "manual_note": None,
        "context": [],
    }
    answer = _normalize_answer({
        "answer_kind": "answer",
        "answer": "王芳负责采购,李强负责测试。",
        "citations": [{"kind": "transcript", "source_id": "segment-people"}],
    }, payload)

    assert answer["answer"].startswith("问题中的“他”指代不明确。")


def test_meeting_question_note_comparison_keeps_source_labels_separate():
    from app.services.app_meeting_question import _manual_note_comparison_answer

    payload = {
        "question": "我的笔记和文字记录分别要求王芳做什么",
        "transcript_segments": [{
            "segment_id": "segment-owner",
            "start_ms": 0,
            "end_ms": 1000,
            "speaker": "李强",
            "text": "王芳负责在周五前提交采购清单。",
        }],
        "summary_sections": [],
        "include_manual_note": True,
        "manual_note": {"revision": 3, "content": "会后提醒王芳补充三家供应商报价。"},
        "context": [],
    }

    answer = _manual_note_comparison_answer(payload)

    assert answer == {
        "answer_kind": "answer",
        "answer": (
            "文字记录：王芳负责在周五前提交采购清单；"
            "我的笔记：会后提醒王芳补充三家供应商报价。"
        ),
        "citations": [
            {"kind": "transcript", "source_id": "segment-owner"},
            {"kind": "manual_note", "source_id": "manual-note:3"},
        ],
    }
