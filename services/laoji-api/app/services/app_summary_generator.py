"""Compact structured summary generation for LaoJi App meetings."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from app.services.llm_provider import LlmConfig, call_llm as call_ollama
from app.privacy_logging import privacy_log


APP_SUMMARY_PROMPT_PATH = Path(__file__).resolve().parents[1] / "prompts" / "app_summary_compact_system.txt"
ACTION_CANDIDATE_CONTRACT_VERSION = 2

_ACTION_CANDIDATE_TYPES = [
    "short_term_task",
    "follow_up",
    "appointment",
    "long_term_goal",
    "policy_proposal",
    "brainstorming_idea",
    "negotiation_term",
    "completed_fact",
    "decision_only",
    "cancelled_or_negated",
    "unclear",
]
_ACTION_CALENDAR_FITNESS = ["high", "needs_confirmation", "not_calendar"]
_ACTION_TIME_SCOPES = ["immediate", "short_term", "long_term", "unspecified"]

_COMPACT_RECOVERY_SUFFIX = """

上一次输出未通过结构校验。请重新根据同一份转写生成结果，并严格遵守：
1. 输出的第一个非空白字符必须是 { ，最后一个必须是 }。
2. 顶层必须是单个 JSON object，不得输出数组、字符串、代码围栏或解释文字。
3. 顶层固定包含 candidate_contract_version=2、overview、discussion_points、key_decisions和 action_items。
4. action_items 中每项必须包含协议规定的全部字段和真实转写引用；无法满足时少输出，不得伪造。
""".strip()

_TEMPLATE_SECTION_COMPACT_BASE_PROMPT = """你是老记 App 的模板字段整理器。只根据本场转写提取所选模板需要的专属字段，不重复生成概述、决定或行动项。

只输出一个 JSON 对象，顶层固定为 items。每项固定包含 section_key、content、source_segment_id、source_quote。

规则：
1. section_key 只能使用本次给出的字段；没有依据的字段不输出条目。
2. content 简洁且不重复，只保留转写中可直接确认且最终成立的内容。
3. source_segment_id 与 source_quote 必须来自同一条输入，source_quote 逐字复制；无法确认时两者都设为 null。
4. 已取消、被否定、尚未承诺或仅是假设的内容不得写成既定事实。
5. 访谈的后续问题只保留转写中明确提出或明确要求后续了解的问题，不自行发明。
6. topics、key_discussion、progress 和 scope_milestones 是覆盖型字段。会议有多个主要议题、方案或进展时，应选取数条互不重复的内容覆盖整场，不得只返回开头遇到的一个局部细节。
7. feedback_concerns、support_improvements、risks、interviewee_views、evidence_quotes 和 follow_up_questions 是证据型字段。只在转写有直接证据时输出；宁可留空，不得为了凑满模板而改写或猜测。
8. 同一事实只放在语义最匹配的字段中；不得换句话同时填入多个字段。
9. 每个字段最多 4 条，整个 items 最多 8 条。若主要议题超过 4 个，应将相关项合并成更高层的概括，不得继续追加导致 JSON 截断。
10. source_segment_id 只复制输入 `[seg:...]` 方括号内冒号后的 ID 本身，不包含 `seg:` 前缀。
"""

_TEMPLATE_SECTION_GUIDANCE = {
    "key_discussion": "关键方案、分歧、取舍或论据；覆盖整场且不重复概述",
    "topics": "本场实际讨论的主要主题；多主题时覆盖整场",
    "feedback_concerns": "明确的反馈、担忧或不满；普通方案描述不算",
    "support_improvements": "明确提出的支持需求或改进方式；不自行推导",
    "progress": "已完成或正在推进的项目工作；候选方案、设想和市场介绍不是进展",
    "risks": "已明确影响推进的风险、阻塞或依赖",
    "scope_milestones": "已确认的项目范围、交付物或里程碑；未选定的创意不算",
    "interviewee_views": "受访者明确表达的观点、经验或判断",
    "evidence_quotes": "能代表受访者核心观点的简短原话",
    "follow_up_questions": "转写中明确留待后续了解或追问的问题",
}

_ACTION_REVIEW_PROMPT = """你是老记 App 的行动候选复核器。主整理模型已经提出候选，你只能判断每条是否保留，不能改写或新增任务。

只输出一个 JSON 对象，顶层固定为 items。每项只包含 index、subject_supported、explicit_next_step、bounded_deliverable、historical_or_completed，不输出理由或其他字段。

三个字段必须分开判断：
- subject_supported：候选的动作对象是否由该候选自己的 source_context 支持；不得使用其他候选的上下文。
- explicit_next_step：source_context 是否明确要求后续执行，而不是提问、构想、选择方向或功能介绍。
- bounded_deliverable：是否是单次可完成、可验收的近期事项，而不是开发整个产品、构建平台或设计整套功能。
- historical_or_completed：source_context 是否在回顾已经完成的工作、实验、测量、研究过程或成果。只要是历史回顾就必须为 true，不得因候选 content 被改写成命令句而改为 false。

保留条件：
1. 原文及邻近上下文已经明确提出一个具体下一步、承诺、指派或预约。
2. 候选中的动作和对象均必须在 source_context 中找到或被唯一指代。对象不在 source_context 中时必须删除，不得从整场会议的其他主题补入。
3. needs_confirmation 只能表示已有具体下一步但缺负责人、时间或少量参数，不能用来保留大而泛的方向。
4. 候选必须能作为一个单次可完成、可验收的近期事项。“开发整个产品、构建平台、设计整套功能”若没有原文明确的单次交付物、负责人或近期里程碑，必须删除。

删除条件：
1. 只是“我想、可以、建议、方向、思路”等构想，没有确认进入执行。
2. 候选自行添加了原文没有的“调研、构建、开发、落实”等动作。
3. 是长期战略、宏观目标、政策倡议、已完成事实、被取消内容或普通决定，不是一项可单独完成的近期行动。
4. 会议只是“选定、倾向、认可”某个项目或方向，并不等于已经创建了“开发该项目”的日程任务。只有原文另外明确指定近期交付物或执行人时才可保留。
5. 学术报告、述职和成果汇报中的“我们对…进行了…”、“已经测试/测量/得到/发现/证实”只是过去完成的研究过程。候选内容即使被改写成“对…进行…”的命令句，只要 source_context 没有“下一步、接下来、后续、将、计划、需要”等未来承诺，explicit_next_step 必须为 false。

关键反例：
- 上下文明说“也需要做一个调研”，可保留调研候选。
- 只说“现在主要想的是，我们可以开发某功能”，仍是产品构想，应删除。
- 会议讨论“小区车位市场是否饱和”时，不得把对象换成另一主题的“宠物项圈市场”；对象错配必须删除。
""".strip()

_ACTION_REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "minimum": 0, "maximum": 11},
                    "subject_supported": {"type": "boolean"},
                    "explicit_next_step": {"type": "boolean"},
                    "bounded_deliverable": {"type": "boolean"},
                    "historical_or_completed": {"type": "boolean"},
                },
                "required": [
                    "index",
                    "subject_supported",
                    "explicit_next_step",
                    "bounded_deliverable",
                    "historical_or_completed",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}

_COMPACT_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "candidate_contract_version": {
            "type": "integer",
            "enum": [ACTION_CANDIDATE_CONTRACT_VERSION],
        },
        "overview": {"type": "string", "maxLength": 100},
        "discussion_points": {
            "type": "array",
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "maxLength": 120},
                    "source_segment_id": {"type": "string", "maxLength": 240},
                    "source_quote": {"type": "string", "maxLength": 240},
                },
                "required": ["content", "source_segment_id", "source_quote"],
                "additionalProperties": False,
            },
        },
        "key_decisions": {
            "type": "array",
            "maxItems": 3,
            "items": {"type": "string", "maxLength": 70},
        },
        "action_items": {
            "type": "array",
            "maxItems": 6,
            "items": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "maxLength": 60},
                    "candidate_type": {
                        "type": "string",
                        "enum": _ACTION_CANDIDATE_TYPES,
                    },
                    "calendar_fitness": {
                        "type": "string",
                        "enum": _ACTION_CALENDAR_FITNESS,
                    },
                    "time_scope": {
                        "type": "string",
                        "enum": _ACTION_TIME_SCOPES,
                    },
                    "assignee": {
                        "type": ["string", "null"],
                        "maxLength": 20,
                    },
                    "due_date": {
                        "type": ["string", "null"],
                        "maxLength": 30,
                    },
                    "source_segment_id": {
                        "type": "string",
                        "maxLength": 240,
                    },
                    "source_quote": {
                        "type": "string",
                        "maxLength": 240,
                    },
                    "confidence": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "reason": {"type": "string", "maxLength": 80},
                },
                "required": [
                    "content",
                    "candidate_type",
                    "calendar_fitness",
                    "time_scope",
                    "assignee",
                    "due_date",
                    "source_segment_id",
                    "source_quote",
                    "confidence",
                    "reason",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": [
        "candidate_contract_version",
        "overview",
        "discussion_points",
        "key_decisions",
        "action_items",
    ],
    "additionalProperties": False,
}

_DERIVED_TEMPLATE_SECTION_KEYS = {
    "overview",
    "decisions",
    "commitments",
    "action_items",
    "follow_ups",
}


class CompactSummaryError(RuntimeError):
    pass


def extract_json(raw_response: str) -> dict[str, Any] | list[Any]:
    """Extract one JSON object/array from an Ollama response.

    Ollama's JSON format normally returns a bare value, but this bounded
    recovery also handles an accidental Markdown fence or short prose prefix
    without bringing the retired summary package into the production image.
    """
    stripped = str(raw_response or "").strip()
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, (dict, list)):
            return parsed
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char not in "[{":
            continue
        # Recovery is only for a short prose/Markdown prefix before one
        # top-level value. If an earlier JSON opener already exists, this
        # position is a nested fragment of a truncated response and must not
        # be promoted to the whole summary.
        prefix = stripped[:index]
        if "{" in prefix or "[" in prefix:
            continue
        try:
            parsed, _ = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, (dict, list)):
            return parsed
    raise CompactSummaryError("compact summary JSON 无法解析")


def _compact_template_sections(template: dict[str, Any] | None) -> list[dict[str, str]]:
    if not isinstance(template, dict) or template.get("id") in (None, ""):
        return []
    result: list[dict[str, str]] = []
    raw_sections = template.get("sections")
    if not isinstance(raw_sections, (list, tuple)):
        return result
    for raw in raw_sections:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "").strip()
        title = str(raw.get("title") or "").strip()
        kind = str(raw.get("kind") or "bullets").strip()
        if (
            key in _DERIVED_TEMPLATE_SECTION_KEYS
            or not re.fullmatch(r"[a-z0-9_]{1,64}", key)
            or not title
        ):
            continue
        result.append({"key": key, "title": title[:40], "kind": kind})
    return result


def _template_section_response_schema(
    sections: list[dict[str, str]],
    action_review_indexes: list[int] | None = None,
) -> dict[str, Any]:
    keys = [section["key"] for section in sections]
    review_indexes = action_review_indexes or []
    max_items = min(8, sum(
        3 if section["kind"] == "paragraph" else 4
        for section in sections
    ))
    properties: dict[str, Any] = {
        "items": {
            "type": "array",
            "maxItems": max_items,
            "items": {
                "type": "object",
                "properties": {
                    "section_key": {"type": "string", "enum": keys},
                    "content": {"type": "string", "maxLength": 120},
                    "source_segment_id": {
                        "type": ["string", "null"],
                        "maxLength": 240,
                    },
                    "source_quote": {
                        "type": ["string", "null"],
                        "maxLength": 240,
                    },
                },
                "required": [
                    "section_key",
                    "content",
                    "source_segment_id",
                    "source_quote",
                ],
                "additionalProperties": False,
            },
        },
    }
    required = ["items"]
    if review_indexes:
        properties["action_reviews"] = {
            "type": "array",
            "minItems": len(review_indexes),
            "maxItems": len(review_indexes),
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "enum": review_indexes},
                    "subject_supported": {"type": "boolean"},
                    "explicit_next_step": {"type": "boolean"},
                    "bounded_deliverable": {"type": "boolean"},
                },
                "required": [
                    "index",
                    "subject_supported",
                    "explicit_next_step",
                    "bounded_deliverable",
                ],
                "additionalProperties": False,
            },
        }
        required.append("action_reviews")
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _template_section_prompt(
    template: dict[str, Any],
    sections: list[dict[str, str]],
) -> str:
    identity = (
        f"{str(template.get('title') or template.get('id') or '').strip()}"
        f"（{template.get('id')}@{template.get('revision')}）"
    )
    contract = "\n".join(
        f'- "{section["key"]}": {section["title"]}；'
        f'{_TEMPLATE_SECTION_GUIDANCE.get(section["key"], "只提取直接证据")}'
        for section in sections
    )
    return (
        f"{_TEMPLATE_SECTION_COMPACT_BASE_PROMPT.rstrip()}\n\n"
        f"本次模板：{identity}\n可用字段：\n{contract}"
    )


def _normalize_template_section_result(
    value: Any,
    sections: list[dict[str, str]],
) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise CompactSummaryError("template compact result is not an object")
    raw_items = value.get("items")
    if not isinstance(raw_items, list):
        raise CompactSummaryError("template compact items are invalid")

    definitions = {section["key"]: section for section in sections}
    limits = {
        key: 3 if section["kind"] == "paragraph" else 4
        for key, section in definitions.items()
    }
    grouped: dict[str, list[dict[str, Any]]] = {key: [] for key in definitions}
    seen: dict[str, set[str]] = {key: set() for key in definitions}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        key = str(item.get("section_key") or "").strip()
        content = str(item.get("content") or "").strip()
        if key not in definitions or not content or len(grouped[key]) >= limits[key]:
            continue
        identity = re.sub(r"\s+", "", content).casefold()
        if not identity or identity in seen[key]:
            continue
        normalized: dict[str, Any] = {"content": content[:1000]}
        normalized.update(_compact_citation_metadata(item))
        source_quote = str(normalized.get("source_quote") or "").strip()
        if key == "evidence_quotes":
            if not source_quote:
                continue
            normalized["content"] = source_quote[:1000]
        if key == "follow_up_questions":
            if not re.search(
                r"(?:[?？]|(?:需要|需|待|后续).{0,18}(?:调研|了解|确认|追问|核实)|"
                r"(?:调研|了解|确认|追问|核实).{0,18}(?:是否|如何|怎么|什么|哪))",
                source_quote,
            ):
                continue
        grouped[key].append(normalized)
        seen[key].add(identity)
    return {key: items for key, items in grouped.items() if items}


_CANONICAL_INPUT_ROW_RE = re.compile(
    r"(?m)^\[seg:(?P<segment_id>[^\]\s]+)\]\s*(?P<row>[^\n]*)$"
)

_COMPLETED_RESEARCH_ACTION_RE = re.compile(
    r"(?:我们|团队|课题组)?[^\n。；;]{0,50}"
    r"(?:进行了|完成了|已经进行|已经完成|做了|"
    r"测试了|测量了|掺杂了|处理了)"
)
_COMPLETED_RESEARCH_RESULT_RE = re.compile(
    r"(?:得到|发现|测得|确认|证实|测试结果|研究结果|实验结果)"
)
_EXPLICIT_FUTURE_ACTION_RE = re.compile(
    r"(?:下一步|接下来|后续|新的一年|新一年|工作计划|"
    r"(?:我|我们|团队)将|计划|着手|继续|需要|必须|务必)"
)


def _high_confidence_completed_research(rows: list[str]) -> bool:
    context = " ".join(rows)
    return bool(
        _COMPLETED_RESEARCH_ACTION_RE.search(context)
        and _COMPLETED_RESEARCH_RESULT_RE.search(context)
        and not _EXPLICIT_FUTURE_ACTION_RE.search(context)
    )


def _action_review_items(
    result: dict[str, Any],
    transcript_text: str,
) -> tuple[list[dict[str, Any]], list[int]]:
    actions = result.get("action_items")
    if not isinstance(actions, list) or not actions:
        return [], []
    rows = [
        (match.group("segment_id"), match.group("row"))
        for match in _CANONICAL_INPUT_ROW_RE.finditer(transcript_text)
    ]
    row_indexes = {segment_id: index for index, (segment_id, _row) in enumerate(rows)}
    review_items: list[dict[str, Any]] = []
    reviewed_indexes: list[int] = []
    for index, action in enumerate(actions[:12]):
        if not isinstance(action, dict):
            continue
        if (
            action.get("candidate_type") not in {"short_term_task", "follow_up", "appointment"}
            or action.get("calendar_fitness") not in {"high", "needs_confirmation"}
            or action.get("time_scope") == "long_term"
        ):
            continue
        source_segment_id = str(action.get("source_segment_id") or "").strip()
        row_index = row_indexes.get(source_segment_id)
        if row_index is None:
            continue
        context_rows = rows[max(0, row_index - 8):min(len(rows), row_index + 7)]
        source_context = [row for _segment_id, row in context_rows]
        review_items.append({
            "index": index,
            "candidate": {
                key: action.get(key)
                for key in (
                    "content",
                    "candidate_type",
                    "calendar_fitness",
                    "time_scope",
                    "assignee",
                    "due_date",
                    "source_quote",
                    "reason",
                )
            },
            "source_context": source_context,
            "high_confidence_completed_history": _high_confidence_completed_research(
                source_context
            ),
        })
        reviewed_indexes.append(index)
    return review_items, reviewed_indexes


def _apply_action_reviews(
    result: dict[str, Any],
    raw_decisions: Any,
    review_items: list[dict[str, Any]],
) -> dict[str, Any]:
    reviewed_indexes = [int(item["index"]) for item in review_items]
    if not reviewed_indexes:
        return result
    if not isinstance(raw_decisions, list):
        raise CompactSummaryError("action review items are invalid")
    decisions: dict[int, bool] = {}
    for item in raw_decisions:
        if not isinstance(item, dict):
            continue
        try:
            item_index = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if item_index in reviewed_indexes:
            semantic_checks = (
                item.get("subject_supported"),
                item.get("explicit_next_step"),
                item.get("bounded_deliverable"),
                item.get("historical_or_completed"),
            )
            if all(isinstance(value, bool) for value in semantic_checks):
                decisions[item_index] = all(semantic_checks[:3]) and not semantic_checks[3]
    for review_item in review_items:
        if review_item.get("high_confidence_completed_history") is True:
            decisions[int(review_item["index"])] = False
    if set(decisions) != set(reviewed_indexes):
        raise CompactSummaryError("action review is incomplete")
    actions = result.get("action_items") or []
    reviewed = dict(result)
    reviewed["action_items"] = [
        action for index, action in enumerate(actions)
        if decisions.get(index, True)
    ]
    return reviewed


def _review_action_candidates(
    result: dict[str, Any],
    transcript_text: str,
    config: Any,
) -> dict[str, Any]:
    review_items, reviewed_indexes = _action_review_items(result, transcript_text)
    if not review_items:
        return result

    decisions: list[dict[str, Any]] = []
    for review_item in review_items:
        try:
            raw = call_ollama(
                config,
                system_prompt=_ACTION_REVIEW_PROMPT,
                transcript=json.dumps(
                    {"candidates": [review_item]},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                timeout=_int_env("APP_SUMMARY_ACTION_REVIEW_TIMEOUT", 60, 10, 180),
                max_tokens=_int_env("APP_SUMMARY_ACTION_REVIEW_MAX_TOKENS", 384, 128, 768),
                options={
                    "num_ctx": _int_env("APP_SUMMARY_ACTION_REVIEW_NUM_CTX", 4096, 2048, 8192),
                    "temperature": 0,
                },
                response_format=(
                    _ACTION_REVIEW_SCHEMA
                    if getattr(config, "provider", None) == "ollama"
                    else "json"
                ),
                priority="background",
                telemetry_operation="summary.action_review",
            )
            parsed = extract_json(raw)
            items = parsed.get("items") if isinstance(parsed, dict) else None
            if not isinstance(items, list) or len(items) != 1:
                raise CompactSummaryError("action review item is invalid")
            decisions.extend(items)
        except Exception as exc:
            privacy_log(
                "summary_action_review_failed",
                capability="summary",
                error_type=type(exc).__name__,
                status="degraded",
            )
            return result
    try:
        return _apply_action_reviews(result, decisions, review_items)
    except Exception as exc:
        privacy_log(
            "summary_action_review_failed",
            capability="summary",
            error_type=type(exc).__name__,
            status="degraded",
        )
        return result


_LONG_SUMMARY_SIGNAL_RE = re.compile(
    r"(?:最终|正式|明确|开场|中段|结束前|收尾).{0,24}(?:决定|确认|结论)|"
    r"(?:决定|确认)(?:在|：|:)|"
    r"(?:由|改由).{1,28}(?:负责|在.{0,16}前)|"
    r"(?:我负责|截止.{0,18}|前(?:完成|提交|更新|交付))|"
    r"(?:只有.{0,12}(?:行动|决定))"
)
_LONG_SUMMARY_CORRECTION_RE = re.compile(
    r"(?:最终|正式).{0,24}(?:确认|决定)|(?:更正|改为|改由|作废|取消|撤销)"
)
_LONG_SUMMARY_NEGATED_RE = re.compile(
    r"(?:没有|未|并非|不|尚未).{0,24}"
    r"(?:决定|决策|结论|行动|任务|负责人|截止|排期|交付)"
)
_LINE_SPEAKER_PREFIX_RE = re.compile(r"^[^：:\n]{1,40}[：:]\s*")
_LINE_SEGMENT_PREFIX_RE = re.compile(r"^\[seg:[^\]\n]+\]\s*")
_LINE_NUMBER_RE = re.compile(r"[0-9０-９]+")


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def compact_summary_max_chars() -> int:
    return _int_env("APP_SUMMARY_COMPACT_MAX_CHARS", 12000, 200, 12000)


def should_use_compact_summary(transcript_text: str) -> bool:
    return bool(transcript_text.strip()) and len(transcript_text) <= compact_summary_max_chars()


def _is_priority_summary_line(line: str) -> bool:
    if _LONG_SUMMARY_CORRECTION_RE.search(line):
        return True
    if _LONG_SUMMARY_NEGATED_RE.search(line):
        return False
    return bool(_LONG_SUMMARY_SIGNAL_RE.search(line))


def _line_family(line: str) -> str:
    line = _LINE_SEGMENT_PREFIX_RE.sub("", line)
    content = _LINE_SPEAKER_PREFIX_RE.sub("", line)
    content = _LINE_NUMBER_RE.sub("#", content)
    return re.sub(r"\s+", "", content)


def _evenly_spaced(values: list[int], count: int) -> list[int]:
    if count >= len(values):
        return values
    if count <= 1:
        return [values[len(values) // 2]]
    return [
        values[round(index * (len(values) - 1) / (count - 1))]
        for index in range(count)
    ]


def prepare_compact_summary_input(
    transcript_text: str,
    max_chars: int | None = None,
) -> str | None:
    """Build bounded extractive evidence for a long App summary.

    Explicit decisions, actions, corrections and cancellations are retained
    verbatim. Repeated low-priority status lines are collapsed by family; if
    the remaining unique context is still long, representative lines are
    sampled uniformly over the meeting timeline. Dense high-priority input is
    never truncated and returns ``None`` so the full pipeline can handle it.
    """
    limit = compact_summary_max_chars() if max_chars is None else max_chars
    cleaned = transcript_text.strip()
    if not cleaned:
        return None
    if len(cleaned) <= limit:
        return cleaned

    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    selected_indexes: set[int] = set()
    representative: list[int] = []
    seen_families: set[str] = set()
    for index, line in enumerate(lines):
        is_context = (
            line.startswith("【")
            or line.startswith("会议标题：")
            or line.startswith("会议日期：")
        )
        if is_context or _is_priority_summary_line(line):
            selected_indexes.add(index)
            continue
        family = _line_family(line)
        if family and family not in seen_families:
            seen_families.add(family)
            representative.append(index)

    header_template = (
        "【超长会议抽取证据：保留 {kept}/{total} 行；明确决定、行动、"
        "更正和作废语句均按原文保留】\n"
    )
    reserved_header_chars = len(
        header_template.format(kept=len(lines), total=len(lines))
    )
    selected_chars = sum(len(lines[index]) + 1 for index in selected_indexes)
    if selected_chars + reserved_header_chars > limit:
        return None

    remaining = limit - selected_chars - reserved_header_chars
    if representative and remaining > 0:
        average_chars = max(
            1,
            sum(len(lines[index]) + 1 for index in representative)
            // len(representative),
        )
        target_count = min(len(representative), max(1, remaining // average_chars))
        for index in _evenly_spaced(representative, target_count):
            line_chars = len(lines[index]) + 1
            if line_chars <= remaining:
                selected_indexes.add(index)
                remaining -= line_chars

    selected = [lines[index] for index in sorted(selected_indexes)]
    header = header_template.format(kept=len(selected), total=len(lines))
    compacted = header + "\n".join(selected)
    return compacted if len(compacted) <= limit else None


def _load_config() -> LlmConfig:
    base_url = os.getenv(
        "LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21434"
    ).strip().rstrip("/")
    model = os.getenv("MEETING_SUMMARY_MODEL", "qwen3.5:9b").strip() or "qwen3.5:9b"
    return LlmConfig(
        base_url=base_url,
        model=model,
        provider="ollama",
        api_key="",
        chat_path="/v1/chat/completions",
    )


def _compact_model_config():
    """Use the configured bounded-summary model."""
    config = _load_config()
    model = (
        os.getenv("APP_SUMMARY_COMPACT_MODEL", "qwen3.5:9b").strip()
        or "qwen3.5:9b"
    )
    return config._replace(model=model) if hasattr(config, "_replace") else config


def _compact_single_citation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("source_segment_id", "segment_id"):
        raw = value.get(key)
        if raw not in (None, ""):
            segment_id = str(raw).strip()
            if segment_id.startswith("seg:"):
                segment_id = segment_id[4:]
            result[key] = segment_id[:240]
            break
    for key in ("source_quote", "quote"):
        raw = value.get(key)
        if raw not in (None, ""):
            result[key] = str(raw).strip()[:2000]
            break
    return result


def _compact_citation_metadata(value: Any) -> dict[str, Any]:
    result = _compact_single_citation(value)
    if not isinstance(value, dict):
        return result
    nested = value.get("citations")
    if isinstance(nested, list):
        citations = [
            citation
            for citation in (_compact_single_citation(item) for item in nested[:20])
            if citation
        ]
        if citations:
            result["citations"] = citations
    return result


def _normalize_compact_result(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        # A few Ollama builds return one object per map block even with an
        # object schema. Merge only known fields; the source contract below
        # still validates every candidate before it can reach the app.
        objects = [item for item in value if isinstance(item, dict)]
        strings = [
            str(item).strip()
            for item in value
            if isinstance(item, str) and str(item).strip()
        ]
        if not objects and not strings:
            raise CompactSummaryError("compact summary result is not an object")
        merged: dict[str, Any] = {
            "candidate_contract_version": ACTION_CANDIDATE_CONTRACT_VERSION,
            "overview": "",
            "discussion_points": [],
            "key_decisions": [],
            "action_items": [],
        }
        for item in objects:
            overview = str(
                item.get("overview")
                or item.get("summary")
                or item.get("content")
                or item.get("text")
                or ""
            ).strip()
            if len(overview) > len(str(merged["overview"])):
                merged["overview"] = overview
            for key in ("discussion_points", "key_decisions", "action_items"):
                raw = item.get(key)
                if isinstance(raw, list):
                    merged[key].extend(raw)
        if strings and not merged["overview"]:
            merged["overview"] = "；".join(strings[:8])
        value = merged
    if not isinstance(value, dict):
        raise CompactSummaryError("compact summary result is not an object")

    try:
        contract_version = int(
            value.get("candidate_contract_version", ACTION_CANDIDATE_CONTRACT_VERSION)
        )
    except (TypeError, ValueError):
        raise CompactSummaryError("action candidate contract version is invalid")
    if contract_version != ACTION_CANDIDATE_CONTRACT_VERSION:
        raise CompactSummaryError("action candidate contract version is unsupported")

    overview = str(value.get("overview") or "").strip()
    raw_decisions = value.get("key_decisions") or []
    raw_actions = value.get("action_items") or []
    raw_discussion = value.get("discussion_points") or []
    if (
        not isinstance(raw_discussion, list)
        or not isinstance(raw_decisions, list)
        or not isinstance(raw_actions, list)
    ):
        raise CompactSummaryError("compact summary arrays have invalid types")

    discussion_points: list[dict[str, Any]] = []
    for item in raw_discussion[:4]:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        source_segment_id = str(item.get("source_segment_id") or "").strip()
        if source_segment_id.startswith("seg:"):
            source_segment_id = source_segment_id[4:]
        source_quote = str(item.get("source_quote") or "").strip()
        if not content or not source_segment_id or not source_quote:
            continue
        discussion_points.append({
            "content": content[:1000],
            "source_segment_id": source_segment_id[:240],
            "source_quote": source_quote[:2000],
        })

    decisions: list[str | dict[str, Any]] = []
    for item in raw_decisions:
        if isinstance(item, dict):
            content = str(
                item.get("description") or item.get("decision") or item.get("content") or ""
            ).strip()
            if not content:
                continue
            normalized = {"description": content[:1000]}
            normalized.update(_compact_citation_metadata(item))
            decisions.append(normalized)
        elif str(item).strip():
            decisions.append(str(item).strip()[:1000])
    actions = []
    for item in raw_actions:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or item.get("task") or "").strip()
        if not content:
            continue
        assignee = item.get("assignee")
        due_date = item.get("due_date", item.get("due", item.get("deadline")))
        normalized = {
            "content": content[:1000],
            "assignee": str(assignee).strip()[:100] if assignee not in (None, "") else None,
            "due_date": str(due_date).strip()[:100] if due_date not in (None, "") else None,
        }
        for key, allowed in (
            ("candidate_type", _ACTION_CANDIDATE_TYPES),
            ("calendar_fitness", _ACTION_CALENDAR_FITNESS),
            ("time_scope", _ACTION_TIME_SCOPES),
        ):
            field = str(item.get(key) or "").strip()
            if field not in allowed:
                raise CompactSummaryError(f"action candidate {key} is invalid")
            normalized[key] = field
        source_segment_id = str(item.get("source_segment_id") or "").strip()
        if source_segment_id.startswith("seg:"):
            source_segment_id = source_segment_id[4:]
        source_quote = str(item.get("source_quote") or "").strip()
        if not source_segment_id or not source_quote:
            raise CompactSummaryError("action candidate source is missing")
        normalized["source_segment_id"] = source_segment_id[:240]
        normalized["source_quote"] = source_quote[:2000]
        try:
            confidence = float(item.get("confidence"))
        except (TypeError, ValueError):
            raise CompactSummaryError("action candidate confidence is invalid")
        if not 0 <= confidence <= 1:
            raise CompactSummaryError("action candidate confidence is invalid")
        normalized["confidence"] = confidence
        normalized["reason"] = str(item.get("reason") or "").strip()[:500]
        normalized.update(_compact_citation_metadata(item))
        actions.append(normalized)

    if not overview:
        raise CompactSummaryError("compact summary overview is empty")
    result = {
        "candidate_contract_version": ACTION_CANDIDATE_CONTRACT_VERSION,
        "overview": overview[:4000],
        "discussion_points": discussion_points,
        "key_decisions": decisions[:50],
        "action_items": actions[:100],
    }
    raw_template_sections = value.get("template_sections")
    if isinstance(raw_template_sections, dict):
        template_sections: dict[str, str | list[str | dict[str, Any]]] = {}
        for raw_key, raw_content in list(raw_template_sections.items())[:20]:
            key = str(raw_key).strip()
            if not re.fullmatch(r"[a-z0-9_]{1,64}", key):
                continue
            if isinstance(raw_content, str):
                content = raw_content.strip()
                if content:
                    template_sections[key] = content[:4000]
                continue
            if isinstance(raw_content, list):
                items: list[str | dict[str, Any]] = []
                for item in raw_content[:50]:
                    if isinstance(item, dict):
                        content = str(
                            item.get("content")
                            or item.get("summary")
                            or item.get("description")
                            or item.get("text")
                            or ""
                        ).strip()
                        if not content:
                            continue
                        normalized: dict[str, Any] = {"content": content[:1000]}
                        normalized.update(_compact_citation_metadata(item))
                        items.append(normalized)
                    elif str(item).strip():
                        items.append(str(item).strip()[:1000])
                if items:
                    template_sections[key] = items
        if template_sections:
            result["template_sections"] = template_sections
    overview_citations = value.get("overview_citations")
    if isinstance(overview_citations, list):
        result["overview_citations"] = [
            _compact_citation_metadata(item)
            for item in overview_citations[:20]
            if isinstance(item, dict) and _compact_citation_metadata(item)
        ]
    return result


def generate_compact_summary(
    transcript_text: str,
    *,
    template: dict[str, Any] | None = None,
    authorized_context_prompt: str = "",
    meeting_context_prompt: str = "",
) -> dict[str, Any]:
    if not should_use_compact_summary(transcript_text):
        raise CompactSummaryError("transcript exceeds compact summary limit")
    if not APP_SUMMARY_PROMPT_PATH.exists():
        raise CompactSummaryError(f"compact summary prompt is missing: {APP_SUMMARY_PROMPT_PATH}")

    template_sections = _compact_template_sections(template)
    prompt = APP_SUMMARY_PROMPT_PATH.read_text(encoding="utf-8")
    # The selected presentation template must not change the meeting's action
    # candidates. Template-specific content is generated by the dedicated
    # section pass below; keeping this primary prompt invariant also makes the
    # temperature-zero candidate result stable across General, 1:1, Project,
    # and Interview views without an extra model call.
    if authorized_context_prompt.strip():
        prompt += (
            "\n\n补充上下文使用规则：\n"
            "1. 本场转写仍是本场事实、决定和行动项的唯一证据。\n"
            "2. 经用户明确授权的历史背景可用于解释本场的指代和延续语义，"
            "但历史内容本身不是本场新决定或新行动项。"
            "除非本场转写明确重新确认，不得把它写入 key_decisions 或 action_items。\n"
            "3. 未出现在授权上下文中的其他历史内容不得猜测或引入。\n"
            "4. 历史内容不得生成或借用本场 Transcript 引用。\n\n"
            + authorized_context_prompt.strip()
        )
    if meeting_context_prompt.strip():
        prompt += (
            "\n\n用户明确授权的本场补充材料使用规则：\n"
            "1. 补充材料可以完善本场的背景和细节，但不属于 Transcript。\n"
            "2. 不得为补充材料伪造 Transcript 片段 ID 或原文引用。\n"
            "3. 补充材料与转写冲突时保留不确定性，不得自行选边。\n\n"
            + meeting_context_prompt.strip()
        )
    config = _compact_model_config()
    raw = call_ollama(
        config,
        system_prompt=prompt,
        transcript=transcript_text,
        timeout=_int_env(
            "APP_SUMMARY_COMPACT_TIMEOUT",
            150,
            10,
            600,
        ),
        max_tokens=_int_env(
            "APP_SUMMARY_COMPACT_MAX_TOKENS",
            1536,
            768,
            3072,
        ),
        options={
            "num_ctx": _int_env("APP_SUMMARY_COMPACT_NUM_CTX", 12288, 2048, 16384),
            "temperature": 0,
        },
        response_format=(
            _COMPACT_RESPONSE_SCHEMA
            if getattr(config, "provider", None) == "ollama"
            else "json"
        ),
        priority="background",
        telemetry_operation="summary.compact",
    )
    try:
        result = _normalize_compact_result(extract_json(raw))
    except CompactSummaryError:
        # A durable task must not fail merely because the model wrapped an
        # otherwise recoverable answer in the wrong top-level shape. Retry once
        # with a different, stricter instruction; repeating the same
        # temperature-zero request can deterministically reproduce the error.
        recovery_raw = call_ollama(
            config,
            system_prompt=f"{prompt}\n\n{_COMPACT_RECOVERY_SUFFIX}",
            transcript=transcript_text,
            timeout=_int_env(
                "APP_SUMMARY_COMPACT_TIMEOUT",
                150,
                10,
                600,
            ),
            max_tokens=_int_env(
                "APP_SUMMARY_COMPACT_MAX_TOKENS",
                1536,
                768,
                3072,
            ),
            options={
                "num_ctx": _int_env("APP_SUMMARY_COMPACT_NUM_CTX", 12288, 2048, 16384),
                "temperature": 0,
            },
            response_format=(
                _COMPACT_RESPONSE_SCHEMA
                if getattr(config, "provider", None) == "ollama"
                else "json"
            ),
            priority="background",
            telemetry_operation="summary.compact.recovery",
        )
        try:
            result = _normalize_compact_result(extract_json(recovery_raw))
        except CompactSummaryError as recovery_error:
            raise CompactSummaryError(
                "compact summary result remained invalid after constrained retry"
            ) from recovery_error
    if template_sections:
        section_prompt = _template_section_prompt(template, template_sections)
        if authorized_context_prompt.strip():
            section_prompt += (
            "\n\n用户明确授权的历史参考只能帮助理解指代，不得作为本场新事实，"
            "也不得借用本场引用：\n" + authorized_context_prompt.strip()
            )
        if meeting_context_prompt.strip():
            section_prompt += (
            "\n\n用户授权的本场补充材料可用于完善模板字段，"
            "但不得伪造 Transcript 引用，与转写冲突时保留不确定性：\n"
            + meeting_context_prompt.strip()
            )
        try:
            section_raw = call_ollama(
            config,
            system_prompt=section_prompt,
            transcript=transcript_text,
            timeout=_int_env("APP_SUMMARY_TEMPLATE_COMPACT_TIMEOUT", 120, 10, 600),
            max_tokens=_int_env(
                "APP_SUMMARY_TEMPLATE_COMPACT_MAX_TOKENS",
                1536,
                256,
                2048,
            ),
            options={
                "num_ctx": _int_env("APP_SUMMARY_COMPACT_NUM_CTX", 12288, 2048, 16384),
                "temperature": 0,
            },
            response_format=(
                _template_section_response_schema(template_sections)
                if getattr(config, "provider", None) == "ollama"
                else "json"
            ),
            priority="background",
            telemetry_operation="summary.template_sections",
        )
            parsed_sections = extract_json(section_raw)
            normalized_sections = _normalize_template_section_result(
                parsed_sections,
                template_sections,
            )
            if normalized_sections:
                result["template_sections"] = normalized_sections
        except Exception as exc:
            privacy_log(
                "summary_template_generation_failed",
                capability="summary",
                error_type=type(exc).__name__,
                status="degraded",
            )
    return _review_action_candidates(result, transcript_text, config)


def _split_progressive_inputs(transcript_text: str, limit: int) -> list[str]:
    lines = [line for line in transcript_text.splitlines() if line.strip()]
    if not lines:
        return []
    blocks: list[str] = []
    current: list[str] = []
    current_chars = 0
    for line in lines:
        pieces = [line[index:index + limit] for index in range(0, len(line), limit)] or [line]
        for piece in pieces:
            extra = len(piece) + (1 if current else 0)
            if current and current_chars + extra > limit:
                blocks.append("\n".join(current))
                current = []
                current_chars = 0
            current.append(piece)
            current_chars += len(piece) + (1 if len(current) > 1 else 0)
    if current:
        blocks.append("\n".join(current))
    return blocks


def _summary_results_as_inputs(results: list[dict[str, Any]], limit: int) -> list[str]:
    prefix = "【上一层分块整理结果；仅用于继续合并，不得新增事实】\n"
    rows = [
        json.dumps(
            {"chunk": index, "summary": result},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        for index, result in enumerate(results)
    ]
    blocks: list[str] = []
    current = prefix
    for row in rows:
        if len(current) > len(prefix) and len(current) + len(row) + 1 > limit:
            blocks.append(current)
            current = prefix
        if len(row) + len(prefix) > limit:
            row = row[: max(1, limit - len(prefix) - 1)]
        current += row + "\n"
    if len(current) > len(prefix):
        blocks.append(current.rstrip())
    return blocks


def generate_progressive_summary(
    transcript_text: str,
    *,
    template: dict[str, Any] | None = None,
    authorized_context_prompt: str = "",
    meeting_context_prompt: str = "",
    checkpoint: dict[str, Any] | None = None,
    checkpoint_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Generate in-process Map/Reduce summaries with resumable block checkpoints.

    Every model request returns to ``LlmProvider`` before the next block is
    submitted, so queued interactive work can run between background blocks.
    """
    cleaned = transcript_text.strip()
    if not cleaned:
        raise CompactSummaryError("transcript is empty")
    limit = compact_summary_max_chars()
    fingerprint_payload = {
        "candidate_contract_version": ACTION_CANDIDATE_CONTRACT_VERSION,
        "transcript": cleaned,
        "template_id": template.get("id") if isinstance(template, dict) else None,
        "template_revision": template.get("revision") if isinstance(template, dict) else None,
        "authorized_context_prompt": authorized_context_prompt,
        "meeting_context_prompt": meeting_context_prompt,
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    level = 0
    inputs = _split_progressive_inputs(cleaned, limit)
    completed: list[dict[str, Any]] = []
    if (
        isinstance(checkpoint, dict)
        and checkpoint.get("schema_version") == 1
        and checkpoint.get("fingerprint") == fingerprint
    ):
        try:
            level = max(0, int(checkpoint.get("level", 0)))
            stored_inputs = checkpoint.get("inputs")
            stored_completed = checkpoint.get("completed")
            if level > 0 and isinstance(stored_inputs, list) and all(
                isinstance(item, str) for item in stored_inputs
            ):
                inputs = list(stored_inputs)
            if isinstance(stored_completed, list) and all(
                isinstance(item, dict) for item in stored_completed
            ) and len(stored_completed) <= len(inputs):
                completed = list(stored_completed)
        except (TypeError, ValueError):
            level = 0
            inputs = _split_progressive_inputs(cleaned, limit)
            completed = []

    while True:
        for index in range(len(completed), len(inputs)):
            final_call = len(inputs) == 1
            result = generate_compact_summary(
                inputs[index],
                template=template if final_call else None,
                authorized_context_prompt=authorized_context_prompt if final_call else "",
                meeting_context_prompt=meeting_context_prompt if final_call else "",
            )
            completed.append(result)
            if checkpoint_callback is not None:
                checkpoint_callback({
                    "schema_version": 1,
                    "fingerprint": fingerprint,
                    "level": level,
                    "inputs": inputs if level > 0 else None,
                    "completed": completed,
                })
        if len(completed) == 1:
            return completed[0]
        next_inputs = _summary_results_as_inputs(completed, limit)
        if len(completed) > 1 and len(next_inputs) >= len(completed):
            raise CompactSummaryError("progressive summary cannot reduce within context limit")
        inputs = next_inputs
        completed = []
        level += 1
        if not inputs:
            raise CompactSummaryError("progressive summary produced no reduce input")
        if checkpoint_callback is not None:
            checkpoint_callback({
                "schema_version": 1,
                "fingerprint": fingerprint,
                "level": level,
                "inputs": inputs,
                "completed": [],
            })
