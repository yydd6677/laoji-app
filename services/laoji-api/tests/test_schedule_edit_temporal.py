"""Source/value normalization contracts, not model quality or natural speech."""
import copy
import json

import pytest

from app.schemas.schedule_edit import ScheduleEditRequest, ScheduleEditModelObservation
from app.services import schedule_edit_service as service


def request(text, *, clock="09:23", end=None):
    return ScheduleEditRequest.model_validate({"schema_version": 1, "client_request_id": "temporal-source-probe",
        "draft_id": "draft-1", "base_revision": 3, "input_sequence": 2,
        "reference_datetime": "2026-10-28T23:59:59+08:00", "timezone": "Asia/Shanghai", "mode": "patch",
        "utterance": text, "draft": {"title": "读书讨论", "start_date": "2026-10-29", "end_date": None,
            "time": {"precision": "exact", "period": None, "start_time": clock, "end_time": end},
            "location": "图书馆", "notes": "带上借书证", "category": "学习",
            "recurrence": {"repeat": "once", "interval": 1, "weekdays": [], "until_date": None}, "reminder_minutes": 10}})


def observation(**groups):
    return ScheduleEditModelObservation.model_validate({"status": "patch", **{name: None for name in
        ("title", "location", "notes", "category", "recurrence", "reminder")}, "temporal": [], **groups})


def span(text, *, scope="start"):
    return {"op": "set", "scope": scope, "text": text}


def shift(duration, direction, text):
    return {"op": "shift", "duration": duration, "direction": direction, "text": text}


@pytest.mark.parametrize("mode", ["replace", "initial", "delete"])
def test_current_draft_edit_contract_does_not_admit_fresh_interpretations(mode):
    payload = request("这次输入").model_dump(mode="json")
    payload["mode"] = mode
    with pytest.raises(ValueError, match="mode"):
        ScheduleEditRequest.model_validate(payload)


@pytest.mark.parametrize("phrase,period", [("凌晨", "early_morning"), ("早上", "morning"),
    ("中午", "noon"), ("午后", "afternoon"), ("傍晚", "evening"), ("晚上", "night")])
def test_period_is_normalized_from_quote_never_a_model_clock(phrase, period):
    req = request("改到" + phrase)
    date, clock = service._compile_temporal(req, observation(temporal=[span(phrase)]))
    assert date is None
    assert clock.value.model_dump() == {"precision": "period", "period": period, "start_time": None, "end_time": None}


def test_date_and_period_are_independent_source_mentions_with_frozen_reference():
    req = request("🍜改到周六下午")
    obs = observation(temporal=[span("周六下午")])
    date, clock = service._compile_temporal(req, obs)
    proposal = obs.proposal(date_edit=date, time_edit=clock)
    spans = service._validate_result(req, proposal)
    assert date.value.start_date == "2026-10-31"
    assert clock.value.period == "afternoon" and clock.value.start_time is None
    assert spans["date"].model_dump() == {"text": "周六下午", "start": 4, "end": 8}
    assert req.draft.start_date == "2026-10-29"  # no in-place mutation


@pytest.mark.parametrize("duration,direction,expected", [("半小时", "later", "09:53"),
    ("一刻钟", "earlier", "09:08"), ("两小时", "later", "11:23"), ("二十分钟", "earlier", "09:03")])
def test_shift_uses_current_exact_clock_without_rounding(duration, direction, expected):
    req = request("时间移" + duration)
    _, clock = service._compile_temporal(req, observation(temporal=[shift(duration, direction, req.utterance)]))
    assert clock.value.start_time == expected


def test_midnight_shift_changes_date_and_time_atomically():
    req = request("往后挪两小时", clock="23:23")
    obs = observation(temporal=[shift("两小时", "later", req.utterance)])
    date, clock = service._compile_temporal(req, obs)
    assert date.value.start_date == "2026-10-30" and date.value.end_date is None
    assert clock.value.start_time == "01:23"
    assert set(service._validate_result(req, obs.proposal(date_edit=date, time_edit=clock))) == {"date", "time"}


def test_only_end_is_cleared_and_a_new_start_keeps_unmentioned_end():
    req = request("去掉结束时间", end="10:07")
    _, clock = service._compile_temporal(req, observation(temporal=[{"op": "clear_end", "text": req.utterance}]))
    assert clock.value.start_time == "09:23" and clock.value.end_time is None
    req = request("改成上午九点四十", end="10:07")
    _, clock = service._compile_temporal(req, observation(temporal=[span("上午九点四十")]))
    assert clock.value.start_time == "09:40" and clock.value.end_time == "10:07"


def test_omission_is_not_the_same_observation_as_an_explicitly_unresolved_date():
    omitted = observation(location={"op": "set", "value": "楼下", "evidence": "楼下"})
    req = request("楼下")
    date, _ = service._compile_temporal(req, omitted)
    assert date is None and req.draft.start_date == "2026-10-29"
    unresolved = observation(temporal=[{"op": "clear_date", "text": "日期还没定"}])
    date, _ = service._compile_temporal(request("日期还没定"), unresolved)
    assert date.op == "clear" and date.value is None


def test_unknown_clock_and_partial_duration_cannot_acquire_a_fabricated_base():
    req = request("再往后半小时")
    req.draft.time.precision = "period"; req.draft.time.period = "night"; req.draft.time.start_time = None
    with pytest.raises(service._TemporalAmbiguous):
        service._compile_temporal(req, observation(temporal=[shift("半小时", "later", req.utterance)]))
    req = request("往后一个半小时")
    with pytest.raises(service._TemporalAmbiguous):
        service._compile_temporal(req, observation(temporal=[shift("一个半小时", "later", req.utterance)]))


def test_date_clearing_cannot_borrow_old_date_for_a_midnight_shift():
    req = request("日期清空，往后两小时", clock="23:23")
    obs = observation(temporal=[{"op": "clear_date", "text": "日期清空"}, shift("两小时", "later", "往后两小时")])
    with pytest.raises(service._TemporalAmbiguous): service._compile_temporal(req, obs)


def test_hallucinated_temporal_values_and_nonpatch_groups_fail_schema():
    raw = observation(temporal=[span("下午")]).model_dump()
    raw["temporal"][0]["value"] = {"precision": "exact", "start_time": "14:00"}
    with pytest.raises(ValueError): ScheduleEditModelObservation.model_validate(raw)
    raw = observation(temporal=[span("下午")]).model_dump(); raw["status"] = "no_change"
    with pytest.raises(ValueError): ScheduleEditModelObservation.model_validate(raw)


def test_quoted_phrase_must_belong_to_its_evidence_and_current_input():
    req = request("上午九点")
    for phrase in ("下午", "旧的原文上午九点", "九点"):
        with pytest.raises(service.ScheduleEditInvalid):
            service._compile_temporal(req, observation(temporal=[span(phrase)]))


def test_one_generation_projects_mentions_to_the_unchanged_public_patch(monkeypatch):
    req = request("改到下周二傍晚")
    raw = observation(temporal=[span("下周二傍晚")])
    calls = []
    def generate(*args, **kwargs): calls.append(kwargs); return raw.model_dump_json()
    monkeypatch.setattr(service.llm_provider, "call_llm", generate)
    before = copy.deepcopy(req.model_dump())
    result = service.edit_schedule(req)
    changes = {c.field: c.value.model_dump() for c in result.changes}
    assert changes["date"]["start_date"] == "2026-11-03"
    assert changes["time"]["period"] == "evening"
    assert len(calls) == 1 and req.model_dump() == before
    assert result.producer_revision.endswith("temporal-spans")


@pytest.mark.parametrize("text,date,start,end", [
    ("后天晚上十点到十一点半", "2026-10-30", "22:00", "23:30"),
    ("明晚七点二十三分", "2026-10-29", "19:23", None),
    ("下周五下午三点半开会到五点", "2026-11-06", "15:30", "17:00"),
])
def test_one_temporal_expression_preserves_date_period_minutes_and_range(text, date, start, end):
    d, t = service._compile_temporal(request(text), observation(temporal=[span(text)]))
    assert d.value.start_date == date
    assert t.value.start_time == start and t.value.end_time == end


def test_date_only_does_not_invent_a_clock_and_end_edit_keeps_start():
    d, t = service._compile_temporal(request("改到下周三"), observation(temporal=[span("下周三")]))
    assert d.value.start_date == "2026-11-04" and t is None
    d, t = service._compile_temporal(request("结束改成明天上午十点七分"),
        observation(temporal=[span("明天上午十点七分", scope="end")]))
    assert d.value.start_date == "2026-10-29" and d.value.end_date == "2026-10-29"
    assert t.value.start_time == "09:23" and t.value.end_time == "10:07"


def test_truncated_qualification_or_minute_suffix_is_not_grounded():
    for text, selected in [("明晚七点二十三分", "七点二十三分"),
        ("后天晚上十点到十一点半", "十点到十一点半"), ("上午九点四十", "上午九点")]:
        with pytest.raises(service.ScheduleEditInvalid, match="source_truncated"):
            service._compile_temporal(request(text), observation(temporal=[span(selected)]))


def test_all_minutes_share_the_existing_grammar_without_rounding():
    from app.services import schedule_parser_service as temporal
    digits = "零一二三四五六七八九"
    for minute in range(60):
        chinese = digits[minute] if minute < 10 else (digits[minute // 10] if minute >= 20 else "") + "十" + (digits[minute % 10] if minute % 10 else "")
        forms = {str(minute), chinese, digits[0] + digits[minute] if minute < 10 else chinese}
        for form in forms:
            for suffix in ("", "分"):
                text = "上午九点" + form + suffix
                expected = f"09:{minute:02d}"
                assert temporal._parse_time_token(text) == expected
                assert temporal._parse_authoritative_time(text) == expected
                assert temporal._parse_time(text) == expected
                _, clock = service._compile_temporal(request(text), observation(temporal=[span(text)]))
                assert clock.value.start_time == expected


def test_one_source_span_cannot_be_applied_twice_or_reordered():
    req = request("晚半小时")
    op = shift("半小时", "later", req.utterance)
    with pytest.raises(service.ScheduleEditInvalid, match="reused_or_unordered"):
        service._compile_temporal(req, observation(temporal=[op, op]))
    req = request("晚半小时，再晚半小时")
    _, clock = service._compile_temporal(req, observation(temporal=[op, op]))
    assert clock.value.start_time == "10:23"


def test_an_invalid_clock_is_not_silently_downgraded_to_its_period():
    text = "下午三点六十分"
    with pytest.raises(service._TemporalAmbiguous, match="clock_value_unresolved"):
        service._compile_temporal(request(text), observation(temporal=[span(text)]))
