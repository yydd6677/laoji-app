from datetime import datetime

import pytest

from app.schemas.vnext_contracts import ScheduleMentionGraph
from app.services.schedule_graph_service import (
    graph_to_draft,
    merge_schedule_clarification,
    produce_schedule_graph,
    source_id_for,
    validate_schedule_graph,
)


REFERENCE = datetime(2026, 8, 18, 9, 0)


def _parsed(**overrides):
    value = {
        "title": "开会",
        "event_type": "once",
        "start_date": "2026-08-19",
        "start_time": "15:30",
        "end_time": "17:00",
        "time_period": None,
        "location": None,
        "needs_clarification": False,
        "parse_source": "rules",
    }
    value.update(overrides)
    return value


def test_graph_keeps_natural_source_spans_and_local_route():
    graph = produce_schedule_graph(
        "明天下午三点半开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(),
    )
    assert graph.route == "local_safe"
    assert graph.state == "complete"
    assert graph.slots.start_date == "2026-08-19"
    assert graph.spans["date"][0].text == "明天"
    assert graph.spans["time"][0].text == "下午三点半"
    assert graph.spans["title"][0].text == "开会"
    assert source_id_for(graph.source.text, REFERENCE, "Asia/Shanghai") == graph.source_id
    validate_schedule_graph(graph)


def test_model_route_is_explicit_and_not_mislabeled_as_local():
    graph = produce_schedule_graph(
        "明天和供应商确认合同时间",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(
            title="和供应商确认合同时间",
            parse_source="local_llm",
            route="model",
        ),
    )
    assert graph.route == "server_required"
    assert graph.provenance.engine == "server-model"


def test_draft_hash_and_revision_are_stable_until_clarification():
    graph = produce_schedule_graph(
        "明天开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(start_time=None, end_time=None),
    )
    draft = graph_to_draft(graph)
    assert draft.graph_revision == 1
    assert draft.graph_sha256.startswith("sha256:")
    assert graph_to_draft(graph).graph_sha256 == draft.graph_sha256


def test_clarification_merges_into_existing_source_and_increments_revision():
    graph = produce_schedule_graph(
        "明天开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(start_time=None, end_time=None, needs_clarification=True),
    )
    merged = merge_schedule_clarification(
        graph,
        "下午三点半",
        parsed=_parsed(start_time="15:30", end_time="17:00"),
    )
    assert merged.source_id == graph.source_id
    assert merged.provenance.draft_revision == 2
    assert merged.provenance.parent_revision == 1
    assert merged.source.text.endswith("补充：下午三点半")
    assert merged.slots.start_time == "15:30"


def test_clarification_uses_existing_draft_when_parser_is_not_injected():
    graph = produce_schedule_graph(
        "明天开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(start_time=None, end_time=None, needs_clarification=True),
    )
    merged = merge_schedule_clarification(graph, "下午三点半")
    assert merged.provenance.draft_revision == 2
    assert merged.slots.start_date == "2026-08-19"
    assert merged.slots.start_time == "15:30"


def test_validator_rejects_fabricated_span():
    graph = produce_schedule_graph(
        "明天开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(start_time=None, end_time=None),
    )
    payload = graph.model_dump(mode="json")
    payload["spans"]["title"][0]["text"] = "不存在的事项"
    with pytest.raises(ValueError, match="schedule_span_not_in_source:title"):
        validate_schedule_graph(payload)


def test_validator_rejects_complete_graph_without_date():
    graph = produce_schedule_graph(
        "下午三点开会",
        REFERENCE,
        "Asia/Shanghai",
        parsed=_parsed(start_date=None, start_time="15:00", end_time="16:00", needs_clarification=True),
    )
    payload = graph.model_dump(mode="json")
    payload["state"] = "complete"
    with pytest.raises(ValueError, match="schedule_complete_without_start_date"):
        validate_schedule_graph(payload)
