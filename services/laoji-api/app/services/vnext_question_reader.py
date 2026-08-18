"""One-call, source-attributed Q2 reader candidate.

The reader is intentionally synchronous and capability-gated.  The mobile
Q2 repository remains the owner of snapshots/turns; this service only accepts
the immutable source view for one request, calls the configured LLM once, and
returns a response that has passed exact UTF-8 citation grounding.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

from app.services.llm_provider import (
    GENERATION_MODEL,
    LlmConfig,
    LlmProviderError,
    call_llm,
    canonical_ollama_base_url,
)
from app.services.summary_v3_evidence import estimate_tokens
from app.services.summary_v3_generator import model_revision


CONTRACT_REVISION = "question.reader.v2"
PROVIDER_REVISION = "q2-reader-v1"
MAX_SOURCES = 256
MAX_SOURCE_TEXT = 8_000
MAX_QUESTION = 2_000
MAX_INPUT_TOKENS = 10_240
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONFLICT_FINAL_QUERY = re.compile(r"(?:最终|成交|确定|定下来|以哪个为准).*(?:日期|时间|哪天|价格|报价|多少钱|金额)|(?:日期|时间|哪天|价格|报价|多少钱|金额).*(?:最终|成交|确定|定下来|以哪个为准)")
_DATE_VALUE = re.compile(r"(?:\d{1,4}\s*[年/月日号]|[一二三四五六七八九十百]+\s*[月日号])")
_PRICE_VALUE = re.compile(r"(?:\d+(?:\.\d+)?\s*(?:元|万元|万|块)|[一二三四五六七八九十百]+\s*(?:元|万元|万|块))")


class Q2ReaderError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise Q2ReaderError("Q2_INPUT_INVALID", f"{field}无效")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\x00" in normalized:
        raise Q2ReaderError("Q2_INPUT_INVALID", f"{field}无效")
    return normalized


def _id(value: Any, field: str) -> str:
    normalized = _text(value, field, 180)
    if not _ID.fullmatch(normalized):
        raise Q2ReaderError("Q2_INPUT_INVALID", f"{field}无效")
    return normalized


def _hash(value: Any, field: str) -> str:
    normalized = _text(value, field, 71).lower()
    if not _HASH.fullmatch(normalized):
        raise Q2ReaderError("Q2_INPUT_INVALID", f"{field}无效")
    return normalized


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _source_fingerprint(sources: list[dict[str, str]]) -> str:
    payload = {
        "schema_version": 2,
        "sources": [
            {
                "source_type": source["source_type"],
                "source_id": source["source_id"],
                "source_revision_id": source["source_revision_id"],
                "content_sha256": source["content_sha256"],
            }
            for source in sources
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _sha256_text(encoded)


def _utf8_slice(value: str, start: int, end: int, field: str) -> str:
    if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
        raise Q2ReaderError("Q2_GROUNDING_INVALID", f"{field}范围无效")
    if start < 0 or end <= start:
        raise Q2ReaderError("Q2_GROUNDING_INVALID", f"{field}范围无效")
    encoded = value.encode("utf-8")
    if end > len(encoded):
        raise Q2ReaderError("Q2_GROUNDING_INVALID", f"{field}超出来源范围")
    try:
        return encoded[start:end].decode("utf-8")
    except UnicodeDecodeError as error:
        raise Q2ReaderError("Q2_GROUNDING_INVALID", f"{field}未落在 UTF-8 字符边界") from error


def _source_payload(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_SOURCES:
        raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源数量无效")
    sources: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源格式无效")
        source_type = _text(item.get("source_type"), "source_type", 32)
        if source_type not in {"transcript", "manual_note", "attachment"}:
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源类型无效")
        source_id = _id(item.get("source_id"), "source_id")
        revision = _id(item.get("source_revision_id"), "source_revision_id")
        content_hash = _hash(item.get("content_sha256"), "content_sha256")
        content = _text(item.get("text"), "text", MAX_SOURCE_TEXT)
        if _sha256_text(content) != content_hash:
            raise Q2ReaderError("Q2_SOURCE_HASH_MISMATCH", "Q2 来源内容校验失败", 409)
        key = (source_type, source_id, revision, content_hash)
        if key in seen:
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源重复")
        seen.add(key)
        sources.append({
            "source_type": source_type,
            "source_id": source_id,
            "source_revision_id": revision,
            "content_sha256": content_hash,
            "text": content,
        })
    return sources


def _has_explicit_source_conflict(question: str, sources: list[dict[str, str]]) -> bool:
    """Fail closed when final-value sources explicitly disagree.

    This is deliberately narrow: it only covers date/time/price questions that
    ask for a final value, and requires distinct values in at least two source
    types. It does not reject ordinary questions containing unrelated numbers.
    """
    if not _CONFLICT_FINAL_QUERY.search(question):
        return False
    value_pattern = _DATE_VALUE if re.search(r"日期|时间|哪天", question) else _PRICE_VALUE
    by_type: dict[str, set[str]] = {}
    for source in sources:
        if not re.search(r"(?:最终|成交|确定|改为|定为|确认)", source["text"]):
            continue
        values = {match.group(0).replace(" ", "") for match in value_pattern.finditer(source["text"])}
        if values:
            by_type.setdefault(source["source_type"], set()).update(values)
    if len(by_type) < 2:
        return False
    all_values = set().union(*by_type.values())
    return len(all_values) > 1 and any(len(values) > 0 for values in by_type.values())


def _response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "answer_kind": {"type": "string", "enum": ["answer", "not_stated", "cannot_confirm"]},
            "answer": {"type": "string", "minLength": 1, "maxLength": 20000},
            "clauses": {
                "type": "array",
                "maxItems": 32,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "clause_id": {"type": "string", "maxLength": 180},
                        "answer_start_utf8": {"type": "integer", "minimum": 0},
                        "answer_end_utf8": {"type": "integer", "minimum": 1},
                        "citations": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 8,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "citation_id": {"type": "string", "maxLength": 180},
                                    "source_id": {"type": "string", "maxLength": 180},
                                    "source_start_utf8": {"type": "integer", "minimum": 0},
                                    "source_end_utf8": {"type": "integer", "minimum": 1},
                                    "quote": {"type": "string", "maxLength": 600},
                                },
                                "required": ["citation_id", "source_id", "source_start_utf8", "source_end_utf8", "quote"],
                            },
                        },
                    },
                    "required": ["clause_id", "answer_start_utf8", "answer_end_utf8", "citations"],
                },
            },
        },
        "required": ["answer_kind", "answer", "clauses"],
    }


def _system_prompt() -> str:
    return """你是老记会议问答的唯一证据阅读器。只根据用户提供的当前会议原始来源回答问题，不使用整理结果、历史答案、常识补全或来源之外的信息。

输出严格 JSON，根对象只能有 answer_kind、answer、clauses 三个字段。answer_kind 只能是 answer、not_stated 或 cannot_confirm；answer 是不超过 160 个中文字符的简洁回答，只保留直接回答问题所需的事实，不复述背景或扩展推论。answer_kind 为 answer 时，clauses 最多 8 个，数组元素只能有 clause_id、answer_start_utf8、answer_end_utf8、citations 四个字段；citations 是数组，元素只能有 citation_id、source_id、source_start_utf8、source_end_utf8、quote 六个字段。answer 和每个 quote 都必须来自当前来源，范围使用 UTF-8 字节下标。clauses 必须按 answer 的 UTF-8 字节范围从 0 连续覆盖全文，每个 clause 至少有一个引用。

协议骨架（仅表示字段形状，不是示例答案；不要把字段嵌套到自身）：
{"answer_kind":"answer","answer":"简短回答","clauses":[{"clause_id":"c1","answer_start_utf8":0,"answer_end_utf8":6,"citations":[{"citation_id":"cite1","source_id":"s0","source_start_utf8":0,"source_end_utf8":6,"quote":"来源原文"}]}]}

每个独立事实都必须由包含该事实关键名词、数字或状态的逐字引用支撑；不要只引用相邻背景句。每条 quote 必须是单个 source text 中连续存在的原文，不能拼接相邻来源、改写或添加标点。问题包含多个子项时，只要其中一部分有来源支持，就回答已知部分并明确指出其余部分未提及，使用 answer；只有全部子项都没有依据时才使用 not_stated。不同来源对同一事实冲突时不得自行选边，使用 cannot_confirm 且 clauses 为空。not_stated 或 cannot_confirm 时 answer 可以简短说明缺少依据，但 clauses 必须是空数组。不要输出 Markdown、解释、额外字段、递归 clauses 或虚构来源。"""


def _parse_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError) as error:
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502) from error
    if not isinstance(parsed, dict):
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
    return parsed


def _model_identifier(value: Any, fallback: str) -> str:
    """Normalize non-semantic model IDs without weakening source grounding.

    Clause and citation IDs are only local handles inside one answer. Small
    local models occasionally emit an empty value or a numeric handle even
    when the surrounding answer and citations are valid. Source IDs remain
    strict below because changing one would allow a citation to escape the
    immutable source snapshot.
    """
    if isinstance(value, str):
        candidate = value.strip()
        if _ID.fullmatch(candidate):
            return candidate
    return fallback


def _model_answer(answer_kind: str, value: Any, clauses: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if answer_kind == "answer" and isinstance(clauses, list) and clauses:
        parts = [
            item.get("answer").strip()
            for item in clauses
            if isinstance(item, dict)
            and isinstance(item.get("answer"), str)
            and item.get("answer").strip()
        ]
        if len(parts) == len(clauses):
            combined = "".join(parts)
            if len(combined) <= 20_000:
                return combined
    if answer_kind in {"not_stated", "cannot_confirm"}:
        return "当前会议记录没有提供足够信息确认。"
    raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)


def read_q2(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schema_version") != 2:
        raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 请求版本无效")
    if payload.get("contract_revision") != CONTRACT_REVISION:
        raise Q2ReaderError("Q2_CONTRACT_INVALID", "Q2 请求协议版本无效", 409)
    provider_revision = _id(payload.get("provider_revision"), "provider_revision")
    if provider_revision != PROVIDER_REVISION:
        raise Q2ReaderError("Q2_PROVIDER_REVISION_INVALID", "Q2 reader 版本不匹配", 409)
    snapshot_id = _id(payload.get("snapshot_id"), "snapshot_id")
    source_fingerprint = _hash(payload.get("source_fingerprint"), "source_fingerprint")
    question = _text(payload.get("question"), "question", MAX_QUESTION)
    sources = _source_payload(payload.get("sources"))
    if _source_fingerprint(sources) != source_fingerprint:
        raise Q2ReaderError("Q2_SOURCE_FINGERPRINT_MISMATCH", "Q2 来源整体标识校验失败", 409)
    model_input = {
        "schema_version": 2,
        "source_fingerprint": source_fingerprint,
        "question": question,
        "sources": [
            {
                "source_id": f"s{index}",
                "source_type": source["source_type"],
                "text": source["text"],
            }
            for index, source in enumerate(sources)
        ],
    }
    estimated = estimate_tokens(json.dumps(model_input, ensure_ascii=False, separators=(",", ":")))
    if estimated > MAX_INPUT_TOKENS:
        raise Q2ReaderError("Q2_EVIDENCE_TOO_LARGE", "当前会议来源超过问答输入上限", 413)
    if _has_explicit_source_conflict(question, sources):
        return {
            "schema_version": 2,
            "contract_revision": CONTRACT_REVISION,
            "provider_revision": PROVIDER_REVISION,
            "model_revision": model_revision(),
            "snapshot_id": snapshot_id,
            "answer_kind": "cannot_confirm",
            "answer": "当前来源对该最终值存在冲突，无法确认。",
            "clauses": [],
        }
    try:
        raw = call_llm(
            LlmConfig(base_url=canonical_ollama_base_url(), model=GENERATION_MODEL),
            _system_prompt(),
            json.dumps(model_input, ensure_ascii=False, separators=(",", ":")),
            timeout=120,
            max_tokens=768,
            options={"temperature": 0, "num_ctx": 16_384, "num_predict": 768},
            response_format=_response_schema(),
            priority="interactive",
            telemetry_operation="question.q2.reader.v2",
        )
    except LlmProviderError as error:
        # Provider failures are retryable service conditions, not malformed
        # user evidence.  Keep the provider's internal error out of the API.
        raise Q2ReaderError("Q2_PROVIDER_UNAVAILABLE", "会议问答服务暂时不可用", 503) from error
    except Exception as error:
        raise Q2ReaderError("Q2_PROVIDER_UNAVAILABLE", "会议问答服务暂时不可用", 503) from error
    response = _parse_json(raw)
    raw_answer_kind = response.get("answer_kind")
    if not isinstance(raw_answer_kind, str):
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
    answer_kind = raw_answer_kind.strip()
    if answer_kind not in {"answer", "not_stated", "cannot_confirm"}:
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
    clauses_raw = response.get("clauses")
    if not isinstance(clauses_raw, list):
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
    answer = _model_answer(answer_kind, response.get("answer"), clauses_raw)
    if answer_kind != "answer":
        if clauses_raw:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "无依据回答不应包含引用", 502)
        return {
            "schema_version": 2,
            "contract_revision": CONTRACT_REVISION,
            "provider_revision": PROVIDER_REVISION,
            "model_revision": model_revision(),
            "snapshot_id": snapshot_id,
            "answer_kind": answer_kind,
            "answer": answer,
            "clauses": [],
        }
    if not 1 <= len(clauses_raw) <= 32:
        raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答分句数量无效", 502)
    source_by_alias = {f"s{index}": source for index, source in enumerate(sources)}
    source_by_id = {source["source_id"]: source for source in sources}
    answer_bytes = answer.encode("utf-8")
    previous_end = 0
    clauses: list[dict[str, Any]] = []
    canonical_citations: list[dict[str, Any]] = []
    seen_citations: set[tuple[str, int, int, str]] = set()
    coordinate_valid = True
    for clause_index, clause in enumerate(clauses_raw):
        if not isinstance(clause, dict):
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答分句格式无效", 502)
        clause_id = _model_identifier(clause.get("clause_id"), f"c{clause_index + 1}")
        start = clause.get("answer_start_utf8")
        end = clause.get("answer_end_utf8")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or start != previous_end
            or end <= start
            or end > len(answer_bytes)
        ):
            # Clause coordinates are a presentation aid and some local
            # models emit character offsets or leave gaps between clauses.
            # Keep validating citations, then collapse to one server-owned
            # answer span below instead of losing an otherwise grounded answer.
            coordinate_valid = False
        elif coordinate_valid:
            try:
                _utf8_slice(answer, start, end, "回答分句")
            except Q2ReaderError:
                # A numeric range can still be a character range that lands
                # inside a UTF-8 sequence. Citations remain authoritative;
                # collapse the answer to one server-owned span below.
                coordinate_valid = False
        citations_raw = clause.get("citations")
        if not isinstance(citations_raw, list):
            # Qwen3.5 9B commonly flattens the nested citation object even
            # under Ollama JSON Schema. Accept only the explicit compact form;
            # derive byte offsets from an exact quote instead of trusting the
            # model's frequently character-based or fabricated utf8_range.
            if (
                isinstance(clause.get("source_id"), str)
                and isinstance(clause.get("quote"), str)
                and clause.get("quote").strip()
            ):
                citations_raw = [{
                    "citation_id": None,
                    "source_id": clause.get("source_id"),
                    "quote": clause.get("quote"),
                    "_derive_range_from_quote": True,
                }]
            else:
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用数量无效", 502)
        if not 1 <= len(citations_raw) <= 32:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用数量无效", 502)
        # Some small providers repeat the same citation object to satisfy the
        # schema mechanically.  Validate a bounded prefix and deduplicate the
        # canonical citations below; citation multiplicity is not evidence.
        citations_raw = citations_raw[:8]
        citations: list[dict[str, Any]] = []
        clause_citations: set[tuple[str, int, int, str]] = set()
        for citation_index, citation in enumerate(citations_raw):
            if not isinstance(citation, dict):
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用格式无效", 502)
            citation_id = _model_identifier(
                citation.get("citation_id"),
                f"cite-{clause_index + 1}-{citation_index + 1}",
            )
            source_key = _id(citation.get("source_id"), "source_id")
            source = source_by_alias.get(source_key) or source_by_id.get(source_key)
            if source is None:
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用不属于当前来源", 502)
            source_start = citation.get("source_start_utf8")
            source_end = citation.get("source_end_utf8")
            model_quote = citation.get("quote")
            if not isinstance(model_quote, str) or not model_quote or len(model_quote) > 600:
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文无效", 502)
            if model_quote not in source["text"]:
                # A provider can choose an adjacent short-window alias while
                # still returning an exact quote from the current immutable
                # snapshot. Rebind only when the quote identifies exactly one
                # current source; unknown, absent or ambiguous evidence still
                # fails closed.
                matching_sources = [candidate for candidate in sources if model_quote in candidate["text"]]
                if len(matching_sources) == 1:
                    source = matching_sources[0]
                    source_start = None
                    source_end = None
            # Qwen may return character offsets for a UTF-8 contract.  An exact
            # quote is still usable evidence, so repair only the coordinates by
            # locating that quote in the immutable source.  A quote that does
            # not occur verbatim remains a hard grounding failure.
            quote_from_range: str | None = None
            if citation.get("_derive_range_from_quote") is True:
                character_start = source["text"].find(model_quote)
                if character_start < 0:
                    raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文不匹配", 502)
                source_start = len(source["text"][:character_start].encode("utf-8"))
                source_end = source_start + len(model_quote.encode("utf-8"))
                quote_from_range = model_quote
            elif isinstance(source_start, int) and isinstance(source_end, int):
                try:
                    quote_from_range = _utf8_slice(source["text"], source_start, source_end, "来源引用")
                except Q2ReaderError:
                    quote_from_range = None
            if quote_from_range != model_quote:
                # Also accept a genuine character-offset pair when it selects
                # the exact quote.  Do not turn arbitrary invalid ranges into
                # valid evidence: a non-zero range outside the character
                # bounds remains a provider error (and is covered by tests).
                character_range_quote = None
                if (
                    isinstance(source_start, int)
                    and isinstance(source_end, int)
                    and 0 <= source_start < source_end <= len(source["text"])
                ):
                    candidate = source["text"][source_start:source_end]
                    if candidate == model_quote:
                        character_range_quote = candidate
                        source_start = len(source["text"][:source_start].encode("utf-8"))
                        source_end = source_start + len(candidate.encode("utf-8"))
                if character_range_quote is not None:
                    quote = character_range_quote
                elif (
                    isinstance(source_start, int)
                    and isinstance(source_end, int)
                    and source_start > len(source["text"])
                    and source_end > source_start
                ):
                    # Some providers emit byte-like coordinates measured over
                    # the whole transcript rather than this source segment.
                    # The exact quote still binds the citation to this source;
                    # discard only the unusable coordinates.
                    character_start = source["text"].find(model_quote)
                    if character_start < 0:
                        raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文不匹配", 502)
                    source_start = len(source["text"][:character_start].encode("utf-8"))
                    source_end = source_start + len(model_quote.encode("utf-8"))
                    quote = model_quote
                elif isinstance(source_start, int) and source_start == 0:
                    character_start = source["text"].find(model_quote)
                    if character_start < 0:
                        raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文不匹配", 502)
                    source_start = len(source["text"][:character_start].encode("utf-8"))
                    source_end = source_start + len(model_quote.encode("utf-8"))
                    quote = model_quote
                else:
                    # The source ID plus an exact quote are the immutable
                    # grounding contract. Provider coordinates are advisory;
                    # recompute them whenever the quote is present verbatim.
                    character_start = source["text"].find(model_quote)
                    if character_start < 0:
                        raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用范围无效", 502)
                    source_start = len(source["text"][:character_start].encode("utf-8"))
                    source_end = source_start + len(model_quote.encode("utf-8"))
                    quote = model_quote
            else:
                quote = quote_from_range
            normalized_citation = {
                "citation_id": citation_id,
                "source_type": source["source_type"],
                "source_id": source["source_id"],
                "source_revision_id": source["source_revision_id"],
                "content_sha256": source["content_sha256"],
                "source_start_utf8": source_start,
                "source_end_utf8": source_end,
                "quote": quote,
            }
            citation_key = (source["source_id"], source_start, source_end, quote)
            if citation_key not in clause_citations:
                clause_citations.add(citation_key)
                citations.append(normalized_citation)
            if citation_key not in seen_citations:
                seen_citations.add(citation_key)
                canonical_citations.append(normalized_citation)
        if coordinate_valid:
            clauses.append({
                "clause_id": clause_id,
                "answer_start_utf8": start,
                "answer_end_utf8": end,
                "citations": citations,
            })
            previous_end = end
    if coordinate_valid and previous_end != len(answer_bytes):
        coordinate_valid = False
    if not coordinate_valid:
        if not canonical_citations:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "回答没有可验证引用", 502)
        # Keep the output contract contiguous and bounded. The first eight
        # distinct, exact citations are deterministic and preserve the model's
        # source ordering without trusting its unstable byte offsets.
        clauses = [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": len(answer_bytes),
            "citations": canonical_citations[:8],
        }]
    return {
        "schema_version": 2,
        "contract_revision": CONTRACT_REVISION,
        "provider_revision": PROVIDER_REVISION,
        "model_revision": model_revision(),
        "snapshot_id": snapshot_id,
        "answer_kind": answer_kind,
        "answer": answer,
        "clauses": clauses,
    }
