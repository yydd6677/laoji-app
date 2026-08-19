"""One-pass structured fact generation and deterministic verification for summary v3."""

from __future__ import annotations

from copy import deepcopy
from difflib import SequenceMatcher
import hashlib
import json
import os
from pathlib import Path
import re
import time
from typing import Any

from pydantic import ValidationError

from app.schemas.meeting_facts_v3 import (
    ActionCandidateV3,
    CompactMeetingFactsModelResponseV3,
    CompactModelActionV3,
    CompactModelFactV3,
    CompactModelRelationV3,
    FactRelationV3,
    MeetingFactV3,
    MeetingFactsDocumentV3,
    MeetingFactsModelResponseV3,
    ModelFactV3,
    OverviewV3,
    PROMPT_REVISION,
    SourceReferenceV3,
)
from app.services.llm_provider import (
    GENERATION_MODEL,
    LlmConfig,
    call_llm,
    canonical_ollama_base_url,
    provider_state,
)
from app.services.summary_v3_evidence import EvidencePackage, EvidenceSource


_PROMPT_PATH = Path(__file__).resolve().parents[1] / "prompts" / "meeting_facts_v3_system.txt"
_GENERATION_FACT_LIMIT = 12
_GENERATION_RELATION_LIMIT = 16
_GENERATION_ACTION_LIMIT = 6
_NUMBER_OR_DATE = re.compile(
    r"(?:\d+(?:\.\d+)?(?:%|％|年|月|日|号|点|时|分|秒|万|亿|元|人|次|个)?)"
)
_NUMBER_OR_DATE_WITH_SPACES = re.compile(
    r"\d+(?:\.\d+)?\s*(?:%|％|年|月|日|号|点|时|分|秒|万|亿|元|人|次|个)?"
)
_TEMPORAL_CLAIM = re.compile(
    r"(?:今天|明天|后天|本周|下周|本月|下月)(?:[一二三四五六日天])?(?:上午|下午|晚上|凌晨)?|"
    r"(?:周|星期)[一二三四五六日天](?:上午|下午|晚上)?|"
    r"(?:上午|下午|晚上|凌晨)|(?:月|年)底|季度",
)
_OWNER_CLAIM = (
    re.compile(
        r"(?:由|请|让|交给|负责人(?:是|为)?)"
        r"([\u3400-\u9fffA-Za-z·]{1,20}?)"
        r"(?=在|于|负责|跟进|完成|提交|处理|整理|发送|准备|确认|修复|提供|交付|开展|组织|安排|[，,。；;])",
    ),
    re.compile(
        r"^([\u3400-\u9fffA-Za-z·]{1,8}?)"
        r"(?=在|于|负责|需|需要|将|完成|提交|处理|跟进|整理|发送|准备|确认|修复|提供|交付|开展|组织|安排)",
    ),
)
_SELF_OWNER_CLAIM = re.compile(
    r"(?:由我|我负责|我来|我会|我将|"
    r"我(?:在|于)?\s*(?:今天|明天|后天|本周|下周|本月|下月|周[一二三四五六日天]|"
    r"星期[一二三四五六日天]|\d{1,4}\s*(?:年|月|日|号))[^。！？；]{0,48}|"
    r"我[^。！？；]{0,32}(?:完成|提交|处理|跟进|整理|发送|发出|修复|提供|交付|开展|组织|安排|提测|更新|验证|执行))",
)
_SENTENCE_SPLIT = re.compile(r"[。！？；\n]+")
_OWNER_NESTED_MARKER = re.compile(r"(?:由|请|让|交给|负责人)")
_OWNER_TRAILING_PREDICATE = re.compile(r"(?:计划|预计|承诺|确认|决定)$")
_ACTION_CONTINUATION_SIGNAL = re.compile(
    r"(?:不对|前面|此前|原先|原定|作废|改由|改为|更正|纠正|截止(?:日期|时间)|"
    r"最终|最后|确认|由我|我负责)",
)
_FINAL_RESOLUTION_SIGNAL = re.compile(
    r"(?:最终|最后|正式|确认|决定|作废|取消|撤销|不再|改为|改由|更正|纠正|"
    r"以后(?:面|者)为准|以.{0,24}为准)",
)
_DEFERMENT_RESOLUTION_SIGNAL = re.compile(
    r"(?:而是延期(?:到|至)|形成延期(?:决策|安排)|延期(?:到|至).{0,24}(?:执行|实施))",
)
_REPLACEMENT_SIGNAL = re.compile(
    r"(?:作废|取消|撤销|不再|改为|改由|更正|纠正|替换)",
)
# These signals describe the *state* of an action, rather than denying an
# action by vocabulary.  A proposal remains a valid fact and candidate; it is
# simply not presented as an already-adopted, calendar-ready commitment until
# the evidence contains an explicit adoption or final-confirmation expression.
_PROPOSAL_SIGNAL = re.compile(
    r"(?:提议|建议|倡议|设想|构想|想法|可以考虑|考虑(?:一下|下)|不妨|或许|可能|可行性|"
    r"是否可以|是否考虑|有必要(?:去)?|未来(?:可以|考虑)?|长期目标|方向是)",
)
_ADOPTION_SIGNAL = re.compile(
    r"(?:最终(?:决定|确认|采用|选定)|正式(?:决定|确认|采用|选定)|"
    r"确认(?:采用|选定|执行|落地|通过)|决定(?:采用|选定|执行|落地)|"
    r"同意(?:采用|执行|落地)?|采纳|批准|通过|敲定|落地(?:执行)?|"
    r"按.{0,24}执行|以.{0,24}为准|确定由|已安排|已经安排)",
)
_BROAD_ACTION_SIGNAL = re.compile(
    r"(?:加强|强化|提升|完善|推动|促进|持续推进|共同研发|鼓励和支持|加大(?:对|在)?|"
    r"建立[^。！？；]{0,24}(?:体系|网络|机制|平台)|形成[^。！？；]{0,24}(?:体系|网络|机制))"
)
_FINITE_ACTION_SIGNAL = re.compile(
    r"(?:提交|发送|整理|修复|完成|确认|准备|安排|召开|测试|评估|发布|交付|申请|预约|提供|编写|补齐|跟进|处理)"
)


class SummaryV3GenerationError(RuntimeError):
    def __init__(self, code: str, *, details: dict[str, Any] | None = None):
        super().__init__(code)
        self.code = code
        # Field paths and error kinds only. Never attach model output or source text.
        self.details = details or {}


def model_revision() -> str:
    state = provider_state(probe=False)
    provider = str(state.get("provider") or "unknown")
    model = str(state.get("generation_model") or GENERATION_MODEL)
    configured = os.getenv("LAOJI_GENERATION_MODEL_REVISION", "").strip()
    return configured or f"{provider}:{model}"


def _config() -> LlmConfig:
    return LlmConfig(base_url=canonical_ollama_base_url(), model=GENERATION_MODEL)


def _system_prompt() -> str:
    prompt = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    if not prompt:
        raise SummaryV3GenerationError("SUMMARY_PROMPT_UNAVAILABLE")
    return prompt


def _generation_response_schema() -> dict[str, Any]:
    """Return a provider-only fixed-slot schema.

    Some local structured-output grammars validate item shape but ignore
    ``maxItems``.  A long meeting then emits an unbounded facts array until
    ``num_predict`` is exhausted.  Finite object properties plus
    ``additionalProperties=false`` make the cardinality a grammar property,
    not a request that the model may disregard.  The server expands this DTO
    into the unchanged public Facts V3 Pydantic contract.
    """
    source_id = {
        "type": "string",
        "pattern": r"^(?:transcript|manual_note|attachment):[A-Za-z0-9._:-]{1,180}$",
    }
    fact = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "type": {
                "type": "string",
                "enum": [
                    "topic", "context", "conclusion", "action", "risk",
                    "question", "quote", "timeline",
                ],
            },
            "state": {
                "type": "string",
                "enum": ["confirmed", "proposed", "uncertain", "negated", "completed"],
            },
            "content": {"type": "string", "minLength": 1, "maxLength": 500},
            "source_1": deepcopy(source_id),
            "source_2": deepcopy(source_id),
            "source_3": deepcopy(source_id),
        },
        "required": ["type", "state", "content", "source_1"],
    }
    relation = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "type": {
                "type": "string",
                "enum": ["supports", "contradicts", "precedes", "depends_on", "alternative"],
            },
            "from_fact": {"type": "string", "enum": [f"f{index}" for index in range(1, 13)]},
            "to_fact": {"type": "string", "enum": [f"f{index}" for index in range(1, 13)]},
        },
        "required": ["type", "from_fact", "to_fact"],
    }
    action = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "fact": {"type": "string", "enum": [f"f{index}" for index in range(1, 13)]},
            "owner": {"type": ["string", "null"], "maxLength": 80},
            "due": {"type": ["string", "null"], "maxLength": 120},
            "fit": {"type": "string", "enum": ["high", "medium", "low"]},
        },
        "required": ["fact"],
    }

    def slots(prefix: str, count: int, item: dict[str, Any], *, require_first: bool) -> dict[str, Any]:
        result = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                f"{prefix}{index}": deepcopy(item)
                for index in range(1, count + 1)
            },
        }
        if require_first:
            result["required"] = [f"{prefix}1"]
        return result

    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "v": {"type": "integer", "const": 3},
            "facts": slots("f", _GENERATION_FACT_LIMIT, fact, require_first=True),
            "relations": slots("r", _GENERATION_RELATION_LIMIT, relation, require_first=False),
            "actions": slots("a", _GENERATION_ACTION_LIMIT, action, require_first=False),
        },
        "required": ["v", "facts", "relations", "actions"],
    }


def _extract_object(raw: str) -> Any:
    value = raw.strip()
    if not value:
        raise ValueError("empty_response")
    return json.loads(value)


def _recover_compact_root_prefix(raw: str) -> str:
    """Rebuild complete nested fact slots before a provider limit stop.

    Ollama may honor the value type but continue with ``f13`` after the last
    allowed fact. The request stops immediately before that key, leaving the
    ``facts`` and root objects open. ``JSONDecoder.raw_decode`` walks only
    complete fact objects and then reconstructs empty optional relation/action
    containers. It never edits source text or a completed fact field.
    """
    value = raw.strip()
    if not value.startswith("{"):
        return raw
    decoder = json.JSONDecoder()
    index = 1
    root_values: dict[str, Any] = {}
    for expected_key in ("v", "facts"):
        while index < len(value) and value[index].isspace():
            index += 1
        try:
            key, key_end = decoder.raw_decode(value, index)
        except json.JSONDecodeError:
            return raw
        if key != expected_key:
            return raw
        index = key_end
        while index < len(value) and value[index].isspace():
            index += 1
        if index >= len(value) or value[index] != ":":
            return raw
        index += 1
        while index < len(value) and value[index].isspace():
            index += 1
        if expected_key == "v":
            try:
                item, index = decoder.raw_decode(value, index)
            except json.JSONDecodeError:
                return raw
            root_values["v"] = item
        elif index >= len(value) or value[index] != "{":
            return raw
        else:
            index += 1
            break
        while index < len(value) and value[index].isspace():
            index += 1
        if index >= len(value) or value[index] != ",":
            return raw
        index += 1

    facts: dict[str, Any] = {}
    allowed = {f"f{item}" for item in range(1, _GENERATION_FACT_LIMIT + 1)}
    while index < len(value):
        while index < len(value) and value[index].isspace():
            index += 1
        try:
            key, key_end = decoder.raw_decode(value, index)
        except json.JSONDecodeError:
            break
        if not isinstance(key, str) or key not in allowed or key in facts:
            break
        index = key_end
        while index < len(value) and value[index].isspace():
            index += 1
        if index >= len(value) or value[index] != ":":
            break
        index += 1
        while index < len(value) and value[index].isspace():
            index += 1
        try:
            item, index = decoder.raw_decode(value, index)
        except json.JSONDecodeError:
            break
        if not isinstance(item, dict):
            break
        facts[key] = item
        while index < len(value) and value[index].isspace():
            index += 1
        if index >= len(value) or value[index] != ",":
            break
        index += 1
    if root_values.get("v") != 3 or "f1" not in facts:
        return raw
    return json.dumps(
        {"v": 3, "facts": facts, "relations": {}, "actions": {}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _repair_truncated_root_arrays(raw: str) -> str:
    """Close a provider response cut inside a root array.

    Ollama can stop exactly at ``num_predict`` after emitting several valid
    relation objects.  A normal JSON parser cannot inspect the complete
    prefix, but dropping only the unfinished last object and closing the
    remaining optional root arrays is loss-bounded and still followed by the
    complete Pydantic/source validator.  Strings and nested objects are
    scanned structurally; no text replacement is performed.
    """
    value = raw.strip()
    if not value or not value.startswith("{"):
        return raw
    try:
        json.loads(value)
        return raw
    except (TypeError, ValueError):
        pass

    root_arrays = ("facts", "relations", "action_candidates")
    root_array_limits = {
        "facts": _GENERATION_FACT_LIMIT,
        "relations": _GENERATION_RELATION_LIMIT,
        "action_candidates": _GENERATION_ACTION_LIMIT,
    }
    stack: list[tuple[str, str | None]] = []
    item_ends: dict[str, list[int]] = {name: [] for name in root_arrays}
    current_array: str | None = None
    in_string = False
    escaped = False
    index = 0
    while index < len(value):
        character = value[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            index += 1
            continue
        if character == "{":
            parent_array = stack[-1][1] if stack and stack[-1][0] == "array" else None
            stack.append(("object", parent_array))
        elif character == "[":
            array_name: str | None = None
            if len(stack) == 1 and stack[0][0] == "object":
                match = re.search(r'"([^"\\]+)"\s*:\s*$', value[:index])
                candidate = match.group(1) if match else None
                if candidate in root_arrays:
                    array_name = candidate
            stack.append(("array", array_name))
            if array_name:
                current_array = array_name
        elif character == "}":
            if not stack or stack[-1][0] != "object":
                return raw
            _kind, parent_array = stack.pop()
            if parent_array:
                item_ends[parent_array].append(index + 1)
        elif character == "]":
            if not stack or stack[-1][0] != "array":
                return raw
            _kind, array_name = stack.pop()
            if array_name:
                current_array = None
        index += 1

    if current_array is None:
        current_array = next(
            (entry[1] for entry in reversed(stack) if entry[0] == "array" and entry[1]),
            None,
        )
    if current_array is None or not item_ends[current_array]:
        return raw
    valid_item_ends = item_ends[current_array][:root_array_limits[current_array]]
    cut = valid_item_ends[-1]
    repaired = value[:cut] + "]"
    current_index = root_arrays.index(current_array)
    for field in root_arrays[current_index + 1:]:
        repaired += f',"{field}":[]'
    repaired += "}"
    try:
        json.loads(repaired)
    except (TypeError, ValueError):
        return raw
    return repaired


def _repair_root_array_closures(raw: str) -> str:
    """Repair only a missing root array delimiter in an otherwise JSON reply.

    Qwen occasionally emits a complete ``facts`` item followed immediately by
    the next root key, omitting the closing ``]``.  The function is deliberately
    narrow: it only inserts the delimiter immediately before the known root
    keys and never edits quoted text, field values, or arbitrary syntax.  The
    normal JSON and Pydantic validators still decide whether the result is
    acceptable.
    """
    value = raw.strip()
    if not value.startswith("{"):
        return raw
    for key in ("relations", "action_candidates"):
        marker = f',"{key}":'
        position = value.find(marker)
        if position < 0:
            continue
        prefix = value[:position].rstrip()
        if prefix and not prefix.endswith("]"):
            value = prefix + "]" + value[position:]
    return value


def _project_model_overview(facts: list[Any]) -> dict[str, Any] | None:
    pieces: list[str] = []
    fact_ids: list[str] = []
    for fact in facts:
        if not isinstance(fact, dict):
            continue
        content = str(fact.get("content") or "").strip().rstrip("。！？；; ")
        fact_id = fact.get("fact_id")
        if not content or not isinstance(fact_id, str):
            continue
        if not pieces and len(content) > 159:
            pieces.append(content[:158].rstrip("，,；; ") + "…")
            fact_ids.append(fact_id)
            break
        projected = "；".join([*pieces, content])
        if len(projected) > 159:
            break
        pieces.append(content)
        fact_ids.append(fact_id)
        if len(fact_ids) == 6:
            break
    if not pieces:
        return None
    return {
        "text": "；".join(pieces).rstrip("。") + "。",
        "fact_ids": fact_ids,
    }


def _sanitize_model_value(
    value: Any,
    package: EvidencePackage | None = None,
) -> Any:
    """Apply loss-bounded protocol normalization before strict validation.

    An overlong citation is already unusable under the public contract and
    must not consume the one model repair attempt. Drop only that fact and
    deterministically remove references to it. This implements the v3 rule
    that an invalid individual citation removes the affected fact while the
    rest of a structurally readable response remains usable.
    """
    if not isinstance(value, dict):
        return value
    facts = value.get("facts")
    if isinstance(facts, list):
        sanitized_facts: list[Any] = []
        source_map = package.source_map() if package is not None else None
        for fact in facts[:_GENERATION_FACT_LIMIT]:
            if not isinstance(fact, dict):
                sanitized_facts.append(fact)
                continue
            # Qwen occasionally repeats a root field immediately after the
            # last source of a fact.  These misplaced containers carry no
            # fact data and are removed before the strict schema validator;
            # root-level fields remain authoritative.
            for misplaced in ("facts", "relations", "action_candidates"):
                fact.pop(misplaced, None)
            if isinstance(fact.get("sources"), list):
                # A fact may cite at most three sources.  Keep model order so
                # the first evidence it selected remains stable; source and
                # quote integrity is still checked after this normalization.
                fact["sources"] = fact["sources"][:3]
                if source_map is not None:
                    invalid_source = False
                    for source_reference in fact["sources"]:
                        if not isinstance(source_reference, dict):
                            invalid_source = True
                            break
                        source = source_map.get(str(source_reference.get("source_id") or ""))
                        if (
                            source is None
                            or source_reference.get("source_type") != source.source_type
                            or len(source.text) > 600
                        ):
                            invalid_source = True
                            break
                        source_reference["quote"] = source.text
                        source_reference.pop("content_hash", None)
                    if invalid_source:
                        continue
                if any(
                    isinstance(source, dict)
                    and isinstance(source.get("quote"), str)
                    and len(source["quote"].strip()) > 600
                    for source in fact["sources"]
                ):
                    continue
            sanitized_facts.append(fact)
        value["facts"] = sanitized_facts

        retained_fact_ids = {
            fact.get("fact_id")
            for fact in sanitized_facts
            if isinstance(fact, dict) and isinstance(fact.get("fact_id"), str)
        }
        projected_overview = _project_model_overview(sanitized_facts)
        if projected_overview is not None:
            value["overview"] = projected_overview
        relations = value.get("relations")
        if isinstance(relations, list):
            value["relations"] = [
                relation
                for relation in relations[:_GENERATION_RELATION_LIMIT]
                if not isinstance(relation, dict)
                or (
                    relation.get("from_fact_id") in retained_fact_ids
                    and relation.get("to_fact_id") in retained_fact_ids
                )
            ]
        action_candidates = value.get("action_candidates")
        if isinstance(action_candidates, list):
            value["action_candidates"] = [
                candidate
                for candidate in action_candidates[:_GENERATION_ACTION_LIMIT]
                if not isinstance(candidate, dict)
                or candidate.get("fact_id") in retained_fact_ids
            ]
    return value


def _slot_number(value: str) -> int:
    try:
        return int(value[1:])
    except (TypeError, ValueError):
        return 1_000_000


def _sanitize_compact_value(value: Any) -> Any:
    """Drop malformed optional slots without repairing the whole document.

    The public protocol already drops an individual fact whose citation is
    invalid. Applying the same loss-bounded rule to a provider-only optional
    slot prevents one bad enum in ``f7`` or one incomplete relation from
    spending a second full generation. ``f1`` is never dropped: if the first
    required fact is malformed, normal overall repair remains mandatory.
    """
    if not isinstance(value, dict) or not isinstance(value.get("facts"), dict):
        return value
    sanitized = dict(value)
    facts: dict[str, Any] = {}
    for slot, item in value["facts"].items():
        try:
            parsed = CompactModelFactV3.model_validate(item)
        except (TypeError, ValueError, ValidationError):
            if slot == "f1":
                facts[slot] = item
            continue
        facts[slot] = parsed.model_dump(mode="json")
    sanitized["facts"] = facts

    relations: dict[str, Any] = {}
    relation_items = (
        (value.get("relations") or {}).items()
        if isinstance(value.get("relations"), dict)
        else ()
    )
    for slot, item in relation_items:
        try:
            parsed = CompactModelRelationV3.model_validate(item)
        except (TypeError, ValueError, ValidationError):
            continue
        relations[slot] = parsed.model_dump(mode="json")
    sanitized["relations"] = relations

    actions: dict[str, Any] = {}
    action_items = (
        (value.get("actions") or {}).items()
        if isinstance(value.get("actions"), dict)
        else ()
    )
    for slot, item in action_items:
        try:
            parsed = CompactModelActionV3.model_validate(item)
        except (TypeError, ValueError, ValidationError):
            continue
        actions[slot] = parsed.model_dump(mode="json")
    sanitized["actions"] = actions
    return sanitized


def _expand_compact_model_response(
    response: CompactMeetingFactsModelResponseV3,
    package: EvidencePackage,
) -> MeetingFactsModelResponseV3:
    """Expand the bounded provider DTO into the public model contract.

    Source type, quote and content hash are immutable evidence properties, so
    accepting model copies of them adds tokens and disagreement modes without
    adding information.  Facts with an unknown or oversized source are
    removed here, and dangling relations/actions are removed with them.  This
    is the same fail-closed individual-citation behavior used by the verbose
    compatibility parser and does not spend the optional repair call.
    """
    source_map = package.source_map()
    facts: list[dict[str, Any]] = []
    retained: dict[str, dict[str, Any]] = {}
    for fact_id, fact in sorted(response.facts.items(), key=lambda item: _slot_number(item[0])):
        source_ids = [fact.source_1, fact.source_2, fact.source_3]
        sources: list[dict[str, Any]] = []
        invalid_source = False
        for source_id in (value for value in source_ids if value is not None):
            source = source_map.get(source_id)
            if source is None or len(source.text) > 600:
                invalid_source = True
                break
            sources.append({
                "source_id": source_id,
                "source_type": source.source_type,
                "quote": source.text,
            })
        if invalid_source or not sources:
            continue
        value = {
            "fact_id": fact_id,
            "fact_type": fact.type,
            "certainty": fact.state,
            "content": fact.content,
            "sources": sources,
        }
        retained[fact_id] = value
        facts.append(value)
    overview = _project_model_overview(facts)
    if overview is None:
        raise ValueError("compact_facts_empty_after_source_validation")

    relations = [
        {
            "relation_type": relation.type,
            "from_fact_id": relation.from_fact,
            "to_fact_id": relation.to_fact,
        }
        for _relation_id, relation in sorted(
            response.relations.items(),
            key=lambda item: _slot_number(item[0]),
        )
        if relation.from_fact in retained
        and relation.to_fact in retained
        and relation.from_fact != relation.to_fact
    ]
    actions = [
        {
            "action_id": action_id,
            "fact_id": action.fact,
            # Action content is the source-backed action fact.  Asking the
            # model to repeat it created a second text that could disagree.
            "content": retained[action.fact]["content"],
            "owner": action.owner,
            "due_text": action.due,
            # Missing provider fit never becomes calendar-ready by default.
            # The fact state is already a model semantic decision and gives a
            # deterministic conservative projection without a repair call.
            "schedule_fit": action.fit or (
                "low"
                if retained[action.fact]["certainty"] in {"proposed", "uncertain"}
                else "medium"
            ),
        }
        for action_id, action in sorted(
            response.actions.items(),
            key=lambda item: _slot_number(item[0]),
        )
        if action.fact in retained
    ]
    return MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": overview,
        "facts": facts,
        "relations": relations,
        "action_candidates": actions,
    })


def _validate_model_response(
    raw: str,
    package: EvidencePackage | None = None,
) -> MeetingFactsModelResponseV3:
    """Validate model JSON after dropping semantically void self-relations.

    A relation from a fact to itself cannot carry information and is already
    excluded by the verified document contract.  Removing that one harmless
    edge before Pydantic validation keeps a malformed relation from consuming
    the single repair attempt; all other structural and enum errors still go
    through the normal repair path.
    """
    extracted = _extract_object(raw)
    if (
        package is not None
        and isinstance(extracted, dict)
        and "v" in extracted
    ):
        compact = CompactMeetingFactsModelResponseV3.model_validate(
            _sanitize_compact_value(extracted)
        )
        return _expand_compact_model_response(compact, package)
    # Keep the verbose parser for immutable historical fixtures and rolling
    # compatibility during the candidate cycle.  The production schema and
    # prompt expose only the bounded compact DTO.
    value = _sanitize_model_value(extracted, package)
    if isinstance(value, dict) and isinstance(value.get("relations"), list):
        value["relations"] = [
            relation
            for relation in value["relations"]
            if not (
                isinstance(relation, dict)
                and relation.get("from_fact_id")
                and relation.get("from_fact_id") == relation.get("to_fact_id")
            )
        ]
    return MeetingFactsModelResponseV3.model_validate(value)


def _sanitized_errors(error: Exception) -> list[dict[str, str]]:
    if isinstance(error, ValidationError):
        values: list[dict[str, str]] = []
        for item in error.errors(include_input=False, include_url=False)[:24]:
            location = ".".join(str(part) for part in item.get("loc") or ()) or "$"
            values.append(
                {
                    "path": location[:160],
                    "type": str(item.get("type") or "validation_error")[:80],
                }
            )
        return values or [{"path": "$", "type": "validation_error"}]
    if isinstance(error, json.JSONDecodeError):
        return [{"path": "$", "type": "json_invalid"}]
    return [{"path": "$", "type": "response_invalid"}]


def _call_model(
    package: EvidencePackage,
    *,
    operation: str,
    repair_errors: list[dict[str, str]] | None = None,
) -> str:
    prompt = _system_prompt()
    if repair_errors:
        error_types = {item.get("type") for item in repair_errors}
        error_paths = {str(item.get("path") or "") for item in repair_errors}
        repair_guidance: list[str] = []
        if "json_invalid" in error_types:
            repair_guidance.append(
                "上次对象可能未闭合；减少重复背景事实，完整闭合 facts、relations、actions；"
                "写完 f12 后必须结束 facts，不得创建 f13。"
            )
        if "literal_error" in error_types:
            repair_guidance.append("存在枚举值错误；所有枚举必须逐字选自字段契约。")
        if any(path.endswith(".fact_type") for path in error_paths):
            repair_guidance.append(
                "facts 槽位中的 type 只能表示语义类别；proposed 等状态只能写入 state。"
            )
        if "missing" in error_types or "extra_forbidden" in error_types:
            repair_guidance.append(
                "丢弃任何通用摘要字段。根对象必须且只能使用 v、facts、relations、actions，"
                "并以" '{"v":3,"facts":{"f1":' "开始。"
            )
        prompt += (
            "\n\n上一次响应没有通过结构协议。根据原证据包重新生成完整对象。"
            "以下仅是脱敏字段错误，不包含上一次正文：\n"
            + json.dumps(repair_errors, ensure_ascii=False, separators=(",", ":"))
            + ("\n" + "".join(repair_guidance) if repair_guidance else "")
        )
    return call_llm(
        _config(),
        prompt,
        json.dumps(package.model_payload(), ensure_ascii=False, separators=(",", ":")),
        timeout=600,
        max_tokens=4096,
        options={
            "temperature": 0,
            "num_ctx": 16_384,
            "num_predict": 4096,
            # These strings can only occur as an out-of-contract slot key or
            # slot reference; quotes inside content are escaped and cannot match.
            "stop": ['"f13"', '"r17"', '"a7"'],
        },
        response_format=_generation_response_schema(),
        priority="background",
        telemetry_operation=operation,
    )


def generate_model_response(package: EvidencePackage) -> tuple[MeetingFactsModelResponseV3, int]:
    raw = _call_model(package, operation="summary.facts.v3")
    try:
        return _validate_model_response(raw, package), 1
    except (ValueError, TypeError, ValidationError) as first_error:
        compact = _recover_compact_root_prefix(raw)
        if compact != raw:
            try:
                return _validate_model_response(compact, package), 1
            except (ValueError, TypeError, ValidationError):
                pass
        # A delimiter-only repair is deterministic and does not spend the
        # optional model repair attempt.  It remains fail-closed because the
        # full schema validator runs immediately afterwards.
        normalized = _repair_root_array_closures(raw)
        if normalized != raw:
            try:
                return _validate_model_response(normalized, package), 1
            except (ValueError, TypeError, ValidationError):
                pass
        truncated = _repair_truncated_root_arrays(raw)
        if truncated != raw:
            try:
                return _validate_model_response(truncated, package), 1
            except (ValueError, TypeError, ValidationError):
                pass
        repaired = _call_model(
            package,
            operation="summary.facts.v3.repair",
            repair_errors=_sanitized_errors(first_error),
        )
        try:
            return _validate_model_response(repaired, package), 2
        except (ValueError, TypeError, ValidationError) as second_error:
            raise SummaryV3GenerationError(
                "SUMMARY_V3_FORMAT_INVALID",
                details={
                    "initial_errors": _sanitized_errors(first_error),
                    "repair_errors": _sanitized_errors(second_error),
                },
            ) from second_error


def _compact_whitespace(value: str) -> str:
    return re.sub(r"\s+", "", value)


def _quote_matches(quote: str, source: EvidenceSource) -> bool:
    normalized_quote = _compact_whitespace(quote)
    return bool(normalized_quote) and normalized_quote in _compact_whitespace(source.text)


def _numeric_claims_supported(content: str, quote_text: str) -> bool:
    normalized_quotes = _compact_whitespace(quote_text)
    return all(_compact_whitespace(claim) in normalized_quotes for claim in _NUMBER_OR_DATE.findall(content))


def _temporal_claims_supported(content: str, quote_text: str) -> bool:
    normalized_quotes = _compact_whitespace(quote_text)
    return all(
        _compact_whitespace(claim) in normalized_quotes
        for claim in _TEMPORAL_CLAIM.findall(content)
    )


def _owner_claims_supported(
    content: str,
    quote_text: str,
    sources: list[SourceReferenceV3],
) -> bool:
    normalized_quotes = _compact_whitespace(quote_text)
    claims: set[str] = set()
    for pattern_index, pattern in enumerate(_OWNER_CLAIM):
        for match in pattern.finditer(content):
            claim = _OWNER_TRAILING_PREDICATE.sub(
                "",
                _compact_whitespace(match.group(1)),
            )
            if not claim:
                continue
            # The anchored fallback can otherwise treat an entire object such
            # as "运行周报由陈工" as a second owner claim before "负责".
            if pattern_index > 0 and _OWNER_NESTED_MARKER.search(claim):
                continue
            claims.add(claim)
    self_supported_speakers = {
        _compact_whitespace(source.speaker)
        for source in sources
        if source.speaker and _SELF_OWNER_CLAIM.search(source.quote)
    }
    return all(
        claim in normalized_quotes or claim in self_supported_speakers
        for claim in claims
    )


def _bigrams(value: str) -> set[str]:
    normalized = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]", "", value).lower()
    if len(normalized) < 2:
        return {normalized} if normalized else set()
    return {normalized[index : index + 2] for index in range(len(normalized) - 1)}


def _similarity(left: str, right: str) -> float:
    left_bigrams = _bigrams(left)
    right_bigrams = _bigrams(right)
    if not left_bigrams or not right_bigrams:
        return 0.0
    jaccard = len(left_bigrams & right_bigrams) / len(left_bigrams | right_bigrams)
    sequence = SequenceMatcher(None, _compact_whitespace(left), _compact_whitespace(right)).ratio()
    return max(jaccard, sequence)


def _normalized_semantic_text(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u3400-\u9fff]", "", value).lower()


def _longest_common_anchor(left: str, right: str) -> str:
    def without_slots(value: str) -> str:
        return _NUMBER_OR_DATE_WITH_SPACES.sub("", _TEMPORAL_CLAIM.sub("", value))

    normalized_left = _normalized_semantic_text(without_slots(left))
    normalized_right = _normalized_semantic_text(without_slots(right))
    match = SequenceMatcher(None, normalized_left, normalized_right).find_longest_match()
    return normalized_left[match.a : match.a + match.size]


def _source_distance(
    left: list[SourceReferenceV3],
    right: list[SourceReferenceV3],
    source_map: dict[str, EvidenceSource],
) -> int:
    left_ordinals = [source_map[item.source_id].ordinal for item in left if item.source_id in source_map]
    right_ordinals = [source_map[item.source_id].ordinal for item in right if item.source_id in source_map]
    if not left_ordinals or not right_ordinals:
        return 1_000_000
    return min(abs(left_value - right_value) for left_value in left_ordinals for right_value in right_ordinals)


def _owner_identities(content: str, sources: list[SourceReferenceV3]) -> set[str]:
    identities: set[str] = set()
    for pattern_index, pattern in enumerate(_OWNER_CLAIM):
        for match in pattern.finditer(content):
            claim = _OWNER_TRAILING_PREDICATE.sub(
                "",
                _compact_whitespace(match.group(1)),
            )
            if not claim or claim == "我":
                continue
            if pattern_index > 0 and _OWNER_NESTED_MARKER.search(claim):
                continue
            identities.add(claim)
    identities.update(
        _compact_whitespace(source.speaker)
        for source in sources
        if source.speaker and _SELF_OWNER_CLAIM.search(source.quote)
    )
    return identities


def _should_merge_fact(
    existing: MeetingFactV3,
    candidate: ModelFactV3,
    citations: list[SourceReferenceV3],
    source_map: dict[str, EvidenceSource],
) -> bool:
    if existing.fact_type != candidate.fact_type or existing.certainty != candidate.certainty:
        return False
    existing_source_ids = {source.source_id for source in existing.sources}
    candidate_source_ids = {source.source_id for source in citations}
    similarity = _similarity(candidate.content, existing.content)
    if existing_source_ids.intersection(candidate_source_ids) and similarity >= 0.82:
        return True
    if candidate.fact_type != "action" or candidate.certainty in {"negated", "completed"}:
        return False
    if _source_distance(list(existing.sources), citations, source_map) > 2:
        return False
    anchor = _longest_common_anchor(existing.content, candidate.content)
    anchor_cjk = sum(1 for character in anchor if "\u3400" <= character <= "\u9fff")
    if len(anchor) >= 4 and anchor_cjk >= 3:
        return True
    existing_owners = _owner_identities(existing.content, list(existing.sources))
    candidate_owners = _owner_identities(candidate.content, citations)
    return bool(
        existing_owners.intersection(candidate_owners)
        and (
            _ACTION_CONTINUATION_SIGNAL.search(existing.content)
            or _ACTION_CONTINUATION_SIGNAL.search(candidate.content)
        )
    )


def _prefer_candidate_content(
    existing: MeetingFactV3,
    candidate: ModelFactV3,
    citations: list[SourceReferenceV3],
) -> bool:
    existing_is_correction_shell = bool(
        re.search(r"(?:不对|前面|此前|作废|改由|截止(?:日期|时间))", existing.content)
    )
    candidate_is_self_commitment = any(
        source.speaker and _SELF_OWNER_CLAIM.search(source.quote)
        for source in citations
    )
    return existing_is_correction_shell and candidate_is_self_commitment


def _verified_source(
    value: Any,
    sources: dict[str, EvidenceSource],
) -> SourceReferenceV3 | None:
    source = sources.get(value.source_id)
    if source is None:
        return None
    if value.source_type != source.source_type:
        return None
    if value.content_hash is not None and value.content_hash != source.content_hash:
        return None
    if not _quote_matches(value.quote, source):
        return None
    return SourceReferenceV3(
        source_id=source.source_id,
        source_type=source.source_type,
        # Keep the complete source sentence when it fits the citation field.
        # Models often cite only the owner fragment; the full verbatim source
        # is needed to validate a deadline or numeric claim and is still a
        # precise, replayable citation.
        quote=source.text if len(source.text) <= 600 else value.quote,
        content_hash=source.content_hash,
        start_ms=source.start_ms,
        end_ms=source.end_ms,
        speaker=source.speaker,
    )


def _evidence_score(
    fact: ModelFactV3,
    sources: list[SourceReferenceV3],
    *,
    conflicted: bool = False,
) -> float:
    score = 0.58
    score += min(0.22, 0.11 * (len(sources) - 1))
    source_types = {source.source_type for source in sources}
    if len(source_types) > 1:
        score += 0.08
    joined_quotes = " ".join(source.quote for source in sources)
    if _similarity(fact.content, joined_quotes) >= 0.35:
        score += 0.08
    if fact.certainty == "uncertain":
        score -= 0.12
    if fact.certainty in {"negated", "completed"}:
        score -= 0.05
    if conflicted:
        score -= 0.18
    return round(min(1.0, max(0.0, score)), 4)


def _verified_facts(
    response: MeetingFactsModelResponseV3,
    package: EvidencePackage,
) -> tuple[list[MeetingFactV3], dict[str, str]]:
    source_map = package.source_map()
    values: list[MeetingFactV3] = []
    remap: dict[str, str] = {}
    rejected_with_valid_sources: list[tuple[ModelFactV3, list[SourceReferenceV3]]] = []
    for candidate in response.facts:
        resolved = [_verified_source(reference, source_map) for reference in candidate.sources]
        if any(reference is None for reference in resolved):
            continue
        citations = [reference for reference in resolved if reference is not None]
        if len({reference.source_id for reference in citations}) != len(citations):
            continue
        quote_text = " ".join(reference.quote for reference in citations)
        if not _numeric_claims_supported(candidate.content, quote_text):
            rejected_with_valid_sources.append((candidate, citations))
            continue
        if not _temporal_claims_supported(candidate.content, quote_text):
            rejected_with_valid_sources.append((candidate, citations))
            continue
        if candidate.fact_type == "action" and not _owner_claims_supported(
            candidate.content,
            quote_text,
            citations,
        ):
            rejected_with_valid_sources.append((candidate, citations))
            continue
        merged_into: MeetingFactV3 | None = None
        for existing in values:
            if _should_merge_fact(existing, candidate, citations, source_map):
                merged_into = existing
                break
        if merged_into is not None:
            remap[candidate.fact_id] = merged_into.fact_id
            merged_sources = list(merged_into.sources)
            known = {source.source_id for source in merged_sources}
            for source in citations:
                if source.source_id not in known and len(merged_sources) < 3:
                    merged_sources.append(source)
                    known.add(source.source_id)
            content = (
                candidate.content
                if _prefer_candidate_content(merged_into, candidate, citations)
                else merged_into.content
            )
            score_candidate = ModelFactV3(
                fact_id=merged_into.fact_id,
                fact_type=merged_into.fact_type,
                certainty=merged_into.certainty,
                content=content,
                sources=[
                    {
                        "source_id": source.source_id,
                        "source_type": source.source_type,
                        "quote": source.quote,
                        "content_hash": source.content_hash,
                    }
                    for source in merged_sources
                ],
            )
            replacement = merged_into.model_copy(
                update={
                    "content": content,
                    "sources": merged_sources,
                    "evidence_score": _evidence_score(score_candidate, merged_sources),
                }
            )
            values[values.index(merged_into)] = replacement
            continue
        remap[candidate.fact_id] = candidate.fact_id
        values.append(
            MeetingFactV3(
                fact_id=candidate.fact_id,
                fact_type=candidate.fact_type,
                certainty=candidate.certainty,
                content=candidate.content,
                sources=citations,
                evidence_score=_evidence_score(candidate, citations),
            )
        )
    for candidate, citations in rejected_with_valid_sources:
        if candidate.fact_id in remap:
            continue
        merged_into = next(
            (
                existing
                for existing in values
                if _should_merge_fact(existing, candidate, citations, source_map)
            ),
            None,
        )
        if merged_into is None:
            continue
        remap[candidate.fact_id] = merged_into.fact_id
        merged_sources = list(merged_into.sources)
        known = {source.source_id for source in merged_sources}
        for source in citations:
            if source.source_id not in known and len(merged_sources) < 3:
                merged_sources.append(source)
                known.add(source.source_id)
        score_candidate = ModelFactV3(
            fact_id=merged_into.fact_id,
            fact_type=merged_into.fact_type,
            certainty=merged_into.certainty,
            content=merged_into.content,
            sources=[
                {
                    "source_id": source.source_id,
                    "source_type": source.source_type,
                    "quote": source.quote,
                    "content_hash": source.content_hash,
                }
                for source in merged_sources
            ],
        )
        replacement = merged_into.model_copy(
            update={
                "sources": merged_sources,
                "evidence_score": _evidence_score(score_candidate, merged_sources),
            }
        )
        values[values.index(merged_into)] = replacement
    return values, remap


def _verified_relations(
    response: MeetingFactsModelResponseV3,
    fact_ids: set[str],
    remap: dict[str, str],
) -> list[FactRelationV3]:
    values: list[FactRelationV3] = []
    seen: set[tuple[str, str, str]] = set()
    for relation in response.relations:
        left = remap.get(relation.from_fact_id)
        right = remap.get(relation.to_fact_id)
        if left not in fact_ids or right not in fact_ids or left == right:
            continue
        identity = (relation.relation_type, left, right)
        if identity in seen:
            continue
        seen.add(identity)
        values.append(
            FactRelationV3(
                relation_type=relation.relation_type,
                from_fact_id=left,
                to_fact_id=right,
            )
        )
    return values[:48]


def _fact_ordinal_bounds(
    fact: MeetingFactV3,
    source_map: dict[str, EvidenceSource],
) -> tuple[int, int] | None:
    ordinals = [
        source_map[source.source_id].ordinal
        for source in fact.sources
        if source.source_id in source_map
    ]
    if not ordinals:
        return None
    return min(ordinals), max(ordinals)


def _fact_with_certainty(fact: MeetingFactV3, certainty: str) -> MeetingFactV3:
    if fact.certainty == certainty:
        return fact
    score_candidate = ModelFactV3(
        fact_id=fact.fact_id,
        fact_type=fact.fact_type,
        certainty=certainty,
        content=fact.content,
        sources=[
            {
                "source_id": source.source_id,
                "source_type": source.source_type,
                "quote": source.quote,
                "content_hash": source.content_hash,
            }
            for source in fact.sources
        ],
    )
    return fact.model_copy(
        update={
            "certainty": certainty,
            "conflict_group_id": None,
            "evidence_score": _evidence_score(score_candidate, list(fact.sources)),
        }
    )


def _resolve_superseded_conflicts(
    facts: list[MeetingFactV3],
    relations: list[FactRelationV3],
    package: EvidencePackage,
) -> tuple[list[MeetingFactV3], list[FactRelationV3]]:
    """Separate explicit transcript supersession from unresolved conflicts."""
    source_map = package.source_map()
    by_id = {fact.fact_id: fact for fact in facts}
    kept_relations: list[FactRelationV3] = []
    for relation in relations:
        if relation.relation_type != "contradicts":
            kept_relations.append(relation)
            continue
        left = by_id.get(relation.from_fact_id)
        right = by_id.get(relation.to_fact_id)
        if left is None or right is None:
            continue
        source_types = {
            source.source_type
            for fact in (left, right)
            for source in fact.sources
        }
        left_bounds = _fact_ordinal_bounds(left, source_map)
        right_bounds = _fact_ordinal_bounds(right, source_map)
        if source_types != {"transcript"} or left_bounds is None or right_bounds is None:
            kept_relations.append(relation)
            continue
        if left_bounds[1] < right_bounds[0]:
            older, newer = left, right
        elif right_bounds[1] < left_bounds[0]:
            older, newer = right, left
        else:
            kept_relations.append(relation)
            continue
        newer_text = " ".join(
            [newer.content, *(source.quote for source in newer.sources)]
        )
        historical_status = {older.certainty, newer.certainty}.intersection(
            {"proposed", "negated", "completed"}
        )
        if not historical_status and not _FINAL_RESOLUTION_SIGNAL.search(newer_text):
            kept_relations.append(relation)
            continue
        if _REPLACEMENT_SIGNAL.search(newer_text):
            by_id[older.fact_id] = _fact_with_certainty(older, "negated")
        if (
            newer.certainty in {"proposed", "uncertain"}
            and _FINAL_RESOLUTION_SIGNAL.search(newer_text)
            and not re.search(r"(?:尚未|未确认|不确定|待确认)", newer_text)
        ):
            by_id[newer.fact_id] = _fact_with_certainty(newer, "confirmed")
        # A resolved proposal, correction or cancellation is historical
        # supersession, not an unresolved contradiction relation.
    return [by_id[fact.fact_id] for fact in facts], kept_relations


def _mark_conflicts(
    facts: list[MeetingFactV3],
    relations: list[FactRelationV3],
) -> list[MeetingFactV3]:
    parent = {fact.fact_id: fact.fact_id for fact in facts}

    def find(value: str) -> str:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(left: str, right: str) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    by_id = {fact.fact_id: fact for fact in facts}
    for relation in relations:
        left = by_id.get(relation.from_fact_id)
        right = by_id.get(relation.to_fact_id)
        if (
            relation.relation_type == "contradicts"
            and left is not None
            and right is not None
            and left.certainty in {"confirmed", "uncertain"}
            and right.certainty in {"confirmed", "uncertain"}
        ):
            union(relation.from_fact_id, relation.to_fact_id)
    groups: dict[str, list[str]] = {}
    for fact_id in parent:
        groups.setdefault(find(fact_id), []).append(fact_id)
    conflict_ids: dict[str, str] = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        digest = hashlib.sha256("\0".join(sorted(members)).encode("utf-8")).hexdigest()[:16]
        for member in members:
            conflict_ids[member] = f"conflict:{digest}"
    result: list[MeetingFactV3] = []
    for fact in facts:
        conflict_id = conflict_ids.get(fact.fact_id)
        if conflict_id is None:
            result.append(fact)
            continue
        candidate = ModelFactV3(
            fact_id=fact.fact_id,
            fact_type=fact.fact_type,
            certainty="uncertain",
            content=fact.content,
            sources=[
                {
                    "source_id": source.source_id,
                    "source_type": source.source_type,
                    "quote": source.quote,
                    "content_hash": source.content_hash,
                }
                for source in fact.sources
            ],
        )
        result.append(
            fact.model_copy(
                update={
                    "certainty": "uncertain",
                    "conflict_group_id": conflict_id,
                    "evidence_score": _evidence_score(candidate, list(fact.sources), conflicted=True),
                }
            )
        )
    return result


def _overview_supported(text: str, facts: list[MeetingFactV3]) -> bool:
    if not text.strip():
        return False
    fact_text = "。".join(fact.content for fact in facts)
    if not _numeric_claims_supported(text, fact_text):
        return False
    clauses = [clause for clause in _SENTENCE_SPLIT.split(text) if clause.strip()]
    return bool(clauses) and all(
        max((_similarity(clause, fact.content) for fact in facts), default=0.0) >= 0.28
        for clause in clauses
    )


def _overview(
    response: MeetingFactsModelResponseV3,
    facts: list[MeetingFactV3],
    remap: dict[str, str],
) -> OverviewV3:
    by_id = {fact.fact_id: fact for fact in facts}
    ids: list[str] = []
    for raw_id in response.overview.fact_ids:
        fact_id = remap.get(raw_id)
        if fact_id in by_id and fact_id not in ids:
            ids.append(fact_id)
    if not ids:
        ids = [
            fact.fact_id
            for fact in facts
            if fact.certainty not in {"negated", "completed"}
        ][:4]
    supporting = [by_id[fact_id] for fact_id in ids if fact_id in by_id]
    if not supporting:
        supporting = facts[:1]
        ids = [fact.fact_id for fact in supporting]
    text = response.overview.text
    if not _overview_supported(text, supporting):
        pieces: list[str] = []
        for fact in supporting:
            candidate = fact.content.rstrip("。；; ")
            projected = "；".join(pieces + [candidate])
            if len(projected) > 159:
                break
            pieces.append(candidate)
        text = ("；".join(pieces) or supporting[0].content)[:159].rstrip("；") + "。"
        text = text[:160]
    return OverviewV3(text=text, fact_ids=ids[:12])


def _field_supported(
    value: str | None,
    facts: list[MeetingFactV3],
    *,
    allow_speaker_self_reference: bool = False,
    allow_composed_temporal: bool = False,
) -> str | None:
    if not value:
        return None
    normalized = _compact_whitespace(value)
    quotes = _compact_whitespace(" ".join(source.quote for fact in facts for source in fact.sources))
    if normalized and normalized in quotes:
        return value
    if allow_composed_temporal:
        joined_quotes = " ".join(
            source.quote for fact in facts for source in fact.sources
        )
        direction_markers = {
            marker for marker in ("前", "后", "内", "起", "至") if marker in value
        }
        remainder = _NUMBER_OR_DATE_WITH_SPACES.sub("", value)
        remainder = _TEMPORAL_CLAIM.sub("", remainder)
        remainder = re.sub(r"[年月日号点时分秒前后内起至到于\s]", "", remainder)
        if (
            _numeric_claims_supported(value, joined_quotes)
            and _temporal_claims_supported(value, joined_quotes)
            and all(marker in joined_quotes for marker in direction_markers)
            and (not remainder or _compact_whitespace(remainder) in quotes)
        ):
            return value
    if allow_speaker_self_reference and any(
        normalized == _compact_whitespace(source.speaker)
        and _SELF_OWNER_CLAIM.search(source.quote)
        for fact in facts
        for source in fact.sources
        if source.speaker
    ):
        return value
    return None


def _supported_action_owner(
    value: str | None,
    fact: MeetingFactV3,
) -> str | None:
    # "我/本人" appearing verbatim in the quote is not a stable owner name;
    # resolve it to the speaker who made the self-commitment before the generic
    # quote-substring check can accept the pronoun itself.
    if value and _compact_whitespace(value) in {"我", "本人", "自己"}:
        self_speakers = {
            source.speaker.strip()
            for source in fact.sources
            if source.speaker
            and source.speaker.strip()
            and _SELF_OWNER_CLAIM.search(source.quote)
        }
        return next(iter(self_speakers)) if len(self_speakers) == 1 else None
    supported = _field_supported(
        value,
        [fact],
        allow_speaker_self_reference=True,
    )
    if supported is not None:
        return supported
    self_speakers = {
        source.speaker.strip()
        for source in fact.sources
        if source.speaker
        and source.speaker.strip()
        and _SELF_OWNER_CLAIM.search(source.quote)
    }
    return next(iter(self_speakers)) if len(self_speakers) == 1 else None


_REJECTED_PROPOSAL_SIGNAL = re.compile(
    r"(?:不(?:采用|采纳|考虑|再考虑|执行)|否决|驳回|放弃|不成立|暂不(?:采用|执行))",
)


def _normalize_proposal_states(facts: list[MeetingFactV3]) -> list[MeetingFactV3]:
    """Normalize an explicitly proposed action without filtering it out.

    The model is still responsible for deciding whether a sentence represents
    an action.  This guard only corrects a state inconsistency that is
    mechanically observable in the cited evidence: proposal language without
    an adoption/confirmation expression cannot be shown as an adopted,
    calendar-ready commitment.  Explicit rejection is marked negated so it
    cannot become an action candidate.
    """
    normalized: list[MeetingFactV3] = []
    for fact in facts:
        if fact.fact_type != "action" or fact.certainty in {"negated", "completed"}:
            normalized.append(fact)
            continue
        evidence_text = " ".join([fact.content, *(source.quote for source in fact.sources)])
        has_proposal = bool(_PROPOSAL_SIGNAL.search(evidence_text))
        has_resolution = bool(
            _ADOPTION_SIGNAL.search(evidence_text)
            or _DEFERMENT_RESOLUTION_SIGNAL.search(evidence_text)
        )
        if has_proposal and _REJECTED_PROPOSAL_SIGNAL.search(evidence_text):
            normalized.append(_fact_with_certainty(fact, "negated"))
            continue
        if has_resolution:
            # A deferment is a resolved state change when the source says
            # "而是延期" or explicitly records a deferment decision; it is
            # not an unadopted proposal merely because no owner is assigned.
            normalized.append(
                _fact_with_certainty(fact, "confirmed")
                if fact.certainty in {"proposed", "uncertain"}
                else fact
            )
            continue
        if not has_proposal:
            normalized.append(fact)
            continue
        normalized.append(_fact_with_certainty(fact, "proposed"))
    return normalized


def _verified_actions(
    response: MeetingFactsModelResponseV3,
    facts: list[MeetingFactV3],
    remap: dict[str, str],
) -> list[ActionCandidateV3]:
    by_id = {fact.fact_id: fact for fact in facts}
    values: list[ActionCandidateV3] = []
    for candidate in response.action_candidates:
        fact_id = remap.get(candidate.fact_id)
        fact = by_id.get(fact_id or "")
        if fact is None or fact.fact_type != "action":
            continue
        if fact.certainty in {"negated", "completed"}:
            continue
        quote_text = " ".join(source.quote for source in fact.sources)
        if not _numeric_claims_supported(candidate.content, quote_text):
            continue
        fit = candidate.schedule_fit
        if fact.certainty in {"proposed", "uncertain"}:
            fit = "low"
        if _BROAD_ACTION_SIGNAL.search(candidate.content) and not _FINITE_ACTION_SIGNAL.search(candidate.content):
            # Strategic directions can remain visible as candidates, but are
            # never calendar-ready without a bounded deliverable verb.
            fit = "low"
        verified = ActionCandidateV3(
            action_id=candidate.action_id,
            fact_id=fact.fact_id,
            content=candidate.content,
            owner=_supported_action_owner(candidate.owner, fact),
            due_text=_field_supported(
                candidate.due_text,
                [fact],
                allow_composed_temporal=True,
            ),
            schedule_fit=fit,
            evidence_score=fact.evidence_score,
        )
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(values)
                if existing.fact_id == verified.fact_id
                or _similarity(verified.content, existing.content) >= 0.86
            ),
            None,
        )
        if duplicate_index is None:
            values.append(verified)
            continue
        existing = values[duplicate_index]
        existing_score = (
            int(existing.owner is not None),
            int(existing.due_text is not None),
            int(existing.schedule_fit == "high"),
            len(existing.due_text or ""),
            len(existing.content),
        )
        verified_score = (
            int(verified.owner is not None),
            int(verified.due_text is not None),
            int(verified.schedule_fit == "high"),
            len(verified.due_text or ""),
            len(verified.content),
        )
        if verified_score > existing_score:
            values[duplicate_index] = verified
    # The protocol requires one candidate for every verified action fact.  A
    # model can occasionally emit the fact correctly but omit its companion
    # candidate (often when several owners are named in one source).  Since
    # the fact has already passed source, numeric, temporal, and owner checks,
    # projecting that fact is deterministic and does not introduce a new
    # semantic decision.  Keep the fallback conservative (`medium` rather
    # than `high`) and leave an unsupported due date empty.
    covered_fact_ids = {candidate.fact_id for candidate in values}
    used_action_ids = {candidate.action_id for candidate in values}
    for fact in facts:
        if (
            fact.fact_type != "action"
            or fact.certainty in {"negated", "completed"}
            or fact.fact_id in covered_fact_ids
            or len(fact.content) > 300
        ):
            continue
        owner_candidates = _owner_identities(fact.content, list(fact.sources))
        owner = next(iter(owner_candidates)) if len(owner_candidates) == 1 else None
        if owner == "我":
            speakers = {
                source.speaker.strip()
                for source in fact.sources
                if source.speaker and _SELF_OWNER_CLAIM.search(source.quote)
            }
            owner = next(iter(speakers)) if len(speakers) == 1 else None
        action_id = f"auto-{fact.fact_id}"
        suffix = 1
        while action_id in used_action_ids:
            suffix += 1
            action_id = f"auto-{fact.fact_id}-{suffix}"
        values.append(
            ActionCandidateV3(
                action_id=action_id,
                fact_id=fact.fact_id,
                content=fact.content,
                owner=_supported_action_owner(owner, fact),
                due_text=None,
                schedule_fit=(
                    "low" if fact.certainty in {"proposed", "uncertain"} else "medium"
                ),
                evidence_score=fact.evidence_score,
            )
        )
        covered_fact_ids.add(fact.fact_id)
        used_action_ids.add(action_id)
    return values[:10]


def verify_model_response(
    response: MeetingFactsModelResponseV3,
    package: EvidencePackage,
) -> MeetingFactsDocumentV3:
    facts, remap = _verified_facts(response, package)
    if not facts:
        raise SummaryV3GenerationError("SUMMARY_V3_NO_VERIFIED_FACTS")
    fact_ids = {fact.fact_id for fact in facts}
    relations = _verified_relations(response, fact_ids, remap)
    facts, relations = _resolve_superseded_conflicts(facts, relations, package)
    facts = _normalize_proposal_states(facts)
    facts = _mark_conflicts(facts, relations)
    return MeetingFactsDocumentV3(
        schema_version=3,
        overview=_overview(response, facts, remap),
        facts=facts,
        relations=relations,
        action_candidates=_verified_actions(response, facts, remap),
    )


def generate_verified_document(package: EvidencePackage) -> dict[str, Any]:
    started = time.perf_counter()
    response, call_count = generate_model_response(package)
    generated = time.perf_counter()
    document = verify_model_response(response, package)
    verified = time.perf_counter()
    return {
        "document": document.model_dump(mode="json"),
        "model_calls": call_count,
        "model_output_counts": {
            "facts": len(response.facts),
            "relations": len(response.relations),
            "action_candidates": len(response.action_candidates),
        },
        "verified_output_counts": {
            "facts": len(document.facts),
            "relations": len(document.relations),
            "action_candidates": len(document.action_candidates),
        },
        "timings_ms": {
            "generating": round((generated - started) * 1000, 3),
            "verifying": round((verified - generated) * 1000, 3),
            "total": round((verified - started) * 1000, 3),
        },
    }
