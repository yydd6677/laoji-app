"""MentionGraph producer for current schedule drafts.

The device-v2 schedule route uses this module as the owner for intent, source
spans, graph state and clarification revisions. Parsing is injected in tests
and callers may supply an already observed parser result; the compatibility
parser is used only when no result is supplied.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any, Mapping

from app.schemas.vnext_contracts import (
    ScheduleDraft,
    ScheduleGraphProvenance,
    ScheduleGraphSlots,
    ScheduleGraphSource,
    ScheduleMentionGraph,
    ScheduleMentionSpan,
)


GRAPH_PRODUCER_REVISION = "mention-graph-vnext-r1"
GRAPH_SCHEMA_REVISION = "mention-graph-v1"

_DATE_SURFACE_RE = re.compile(
    r"(?:今天|今日|明天|后天|大后天|昨天|前天|本周[一二三四五六日天]|"
    r"下周[一二三四五六日天]|这周[一二三四五六日天]|周[一二三四五六日天]|"
    r"[0-9０-９一二两三四五六七八九十百]+月[0-9０-９一二两三四五六七八九十百]+[号日]?)"
)
_TIME_SURFACE_RE = re.compile(
    r"(?:凌晨|早上|清早|上午|中午|下午|傍晚|晚上|夜里)?\s*"
    r"(?:[0-9０-９]{1,2}(?::[0-9０-９]{2})?|[零〇一二两三四五六七八九十百]+)"
    r"(?:点|时)(?:半|[0-9０-９一二两三四五六七八九十百]+分)?"
)
_PERIOD_SURFACE_RE = re.compile(r"(?:凌晨|早上|清早|上午|中午|下午|傍晚|晚上|夜里)")
_LOCATION_SURFACE_RE = re.compile(
    r"(?:地点|地址|位置)\s*(?:在|是|改成|改为|换成)?\s*"
    r"([^，,。.!！?？；;]{1,80})"
)
_TITLE_PREFIX_RE = re.compile(
    r"(?:提醒我|记一下|记下|记到日历|安排|排个|定个|定在|设置|加个|添加|保存一下)"
)


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def source_id_for(text: str, reference_datetime: datetime, timezone: str) -> str:
    """Return a deterministic request source id without storing the utterance."""
    digest = hashlib.sha256(
        "|".join((text.strip(), reference_datetime.isoformat(), timezone.strip())).encode("utf-8")
    ).hexdigest()
    return "schedule-source:" + digest[:32]


def _span(text: str, value: str | None) -> ScheduleMentionSpan | None:
    if not value:
        return None
    candidate = str(value).strip()
    if not candidate:
        return None
    start = text.find(candidate)
    if start < 0:
        return None
    return ScheduleMentionSpan(text=candidate, start=start, end=start + len(candidate))


def _first_match(text: str, pattern: re.Pattern[str]) -> ScheduleMentionSpan | None:
    match = pattern.search(text)
    return (
        ScheduleMentionSpan(text=match.group(0).strip(), start=match.start(), end=match.end())
        if match
        else None
    )


def recognize_schedule_mentions(text: str, parsed: Mapping[str, Any] | None = None) -> dict[str, list[ScheduleMentionSpan]]:
    """Collect only source-backed spans; canonical values are never invented as spans."""
    result: dict[str, list[ScheduleMentionSpan]] = {}

    def add(name: str, item: ScheduleMentionSpan | None) -> None:
        if item is not None:
            result.setdefault(name, []).append(item)

    parsed = parsed or {}
    add("date", _first_match(text, _DATE_SURFACE_RE))
    add("time", _first_match(text, _TIME_SURFACE_RE))
    add("time_period", _first_match(text, _PERIOD_SURFACE_RE))
    location = _LOCATION_SURFACE_RE.search(text)
    if location:
        value = location.group(1).strip()
        if value:
            add("location", ScheduleMentionSpan(text=value, start=location.start(1), end=location.end(1)))

    title = str(parsed.get("title") or "").strip()
    title_span = _span(text, title)
    if title_span is not None:
        add("title", title_span)

    # Keep all explicit correction surfaces as evidence for a later validator.
    for match in re.finditer(r"(?:不是|不对|改成|改到|换成|最终|最后)[^，,。.!！?？；;]{0,40}", text):
        add("correction", ScheduleMentionSpan(text=match.group(0), start=match.start(), end=match.end()))
    return result


def _source_datetime(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _slots_from_result(result: Mapping[str, Any] | None) -> ScheduleGraphSlots:
    result = result or {}
    def text_value(key: str) -> str | None:
        value = result.get(key)
        if value is None:
            return None
        value = str(value).strip()
        return value or None

    recurrence = {
        key: result[key]
        for key in ("recurrence_interval", "recurrence_weekdays", "recurrence_until_date")
        if result.get(key) not in (None, "", [])
    } or None
    return ScheduleGraphSlots(
        title=text_value("title"),
        start_date=text_value("start_date"),
        end_date=text_value("end_date"),
        start_time=text_value("start_time"),
        end_time=text_value("end_time"),
        time_period=text_value("time_period"),
        event_type=str(result.get("event_type") or "once"),
        location=text_value("location"),
        recurrence=recurrence,
        reminder={"minutes": result["reminder_minutes"]} if result.get("reminder_minutes") is not None else None,
    )


def _intent_and_route(
    result: Mapping[str, Any] | None,
    requested_intent: str | None,
) -> tuple[str, str, str]:
    # Intent is an admission decision, not a second parse of the source text.
    # The mobile route supplies it; injected observations may carry it for
    # isolated replay.  Unknown values fail closed instead of guessing from
    # the legacy parser.
    intent = str(requested_intent or (result or {}).get("intent") or "create").strip()
    if intent not in {"create", "query", "delete", "clarify", "reject", "context_edit"}:
        intent = "reject"
    result = result or {}
    if intent in {"query", "delete", "context_edit"}:
        return intent, "operation", "operation"
    if intent == "reject":
        return intent, "reject", "reject"
    if intent == "clarify":
        return intent, "clarify", "needs_clarification"
    if bool(result.get("needs_clarification")):
        return "create", "clarify", "needs_clarification"
    if not result.get("start_date"):
        return "create", "clarify", "incomplete"
    server_route = result.get("route") in {"model", "fallback"} or result.get("parse_source") == "local_llm"
    return "create", "server_required" if server_route else "local_safe", "complete"


def produce_schedule_graph(
    text: str,
    reference_datetime: datetime | str,
    timezone: str,
    *,
    source_id: str | None = None,
    parsed: Mapping[str, Any] | None = None,
    intent: str | None = None,
    producer_revision: str = GRAPH_PRODUCER_REVISION,
    draft_revision: int = 1,
) -> ScheduleMentionGraph:
    """Produce one graph from one parser observation.

    ``parsed`` is an observation injection seam for shadow evaluation and
    tests.  The Graph producer never invokes the legacy parser itself; callers
    must provide exactly one parser/model observation.
    """
    text = str(text).strip()
    if not text:
        raise ValueError("schedule_source_empty")
    reference = _source_datetime(reference_datetime)
    if parsed is None:
        raise ValueError("schedule_parser_observation_required")
    parsed_result = dict(parsed)
    intent_value, route, state = _intent_and_route(parsed_result, intent)
    source_key = source_id or source_id_for(text, reference, timezone)
    engine = "server-model" if route == "server_required" else "recognizers"
    graph = ScheduleMentionGraph(
        source=ScheduleGraphSource(
            text=text,
            content_sha256="sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
            mode="audio_transcript" if parsed_result.get("source_mode") == "audio_transcript" else "text",
            reference_datetime=reference,
            timezone=timezone,
        ),
        source_id=source_key,
        intent=intent_value,
        route=route,
        slots=_slots_from_result(parsed_result),
        state=state,
        missing=["start_date"] if state in {"needs_clarification", "incomplete"} and not parsed_result.get("start_date") else [],
        spans=recognize_schedule_mentions(text, parsed_result),
        provenance=ScheduleGraphProvenance(
            engine=engine,
            engine_revision=str(parsed_result.get("model_id") or parsed_result.get("parse_source") or "rules-v4"),
            producer_revision=producer_revision,
            draft_revision=max(1, int(draft_revision)),
            parent_revision=max(1, int(draft_revision) - 1) if draft_revision > 1 else None,
        ),
    )
    validate_schedule_graph(graph)
    return graph


def validate_schedule_graph(graph: ScheduleMentionGraph | Mapping[str, Any]) -> ScheduleMentionGraph:
    """Fail closed on stale/foreign spans and route/state contradictions."""
    candidate = graph if isinstance(graph, ScheduleMentionGraph) else ScheduleMentionGraph.model_validate(graph)
    text = candidate.source.text
    for field, spans in candidate.spans.items():
        for span in spans:
            if text[span.start:span.end] != span.text:
                raise ValueError(f"schedule_span_not_in_source:{field}")
    if candidate.state == "complete" and not candidate.slots.start_date:
        raise ValueError("schedule_complete_without_start_date")
    if candidate.route == "clarify" and candidate.state not in {"needs_clarification", "incomplete"}:
        raise ValueError("schedule_clarify_state_mismatch")
    if candidate.route == "reject" and candidate.state != "reject":
        raise ValueError("schedule_reject_state_mismatch")
    if candidate.intent == "create" and candidate.route == "operation":
        raise ValueError("schedule_create_operation_mismatch")
    if candidate.provenance.parent_revision is not None and candidate.provenance.parent_revision >= candidate.provenance.draft_revision:
        raise ValueError("schedule_revision_not_monotonic")
    return candidate


def graph_to_draft(graph: ScheduleMentionGraph, *, draft_id: str | None = None) -> ScheduleDraft:
    graph = validate_schedule_graph(graph)
    payload = graph.model_dump(mode="json")
    revision = graph.provenance.draft_revision
    return ScheduleDraft(
        draft_id=draft_id or f"schedule-draft:{graph.source_id}:{revision}",
        graph_revision=revision,
        state=graph.state,
        slots=graph.slots,
        missing=graph.missing,
        source_id=graph.source_id,
        graph_sha256=_canonical_sha256(payload),
    )


def merge_schedule_clarification(
    graph: ScheduleMentionGraph,
    answer: str,
    *,
    parsed: Mapping[str, Any] | None = None,
) -> ScheduleMentionGraph:
    """Apply an answer to the existing draft, never parse the answer alone."""
    graph = validate_schedule_graph(graph)
    answer = str(answer).strip()
    if not answer:
        raise ValueError("schedule_clarification_empty")
    if parsed is None:
        raise ValueError("schedule_clarification_observation_required")
    merged = dict(parsed)
    combined_text = f"{graph.source.text}；补充：{answer}"
    return produce_schedule_graph(
        combined_text,
        graph.source.reference_datetime,
        graph.source.timezone,
        source_id=graph.source_id,
        parsed=merged,
        producer_revision=graph.provenance.producer_revision,
        draft_revision=graph.provenance.draft_revision + 1,
    )
