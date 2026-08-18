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

输出严格 JSON：answer_kind 为 answer、not_stated 或 cannot_confirm；answer 是简洁中文回答；answer_kind 为 answer 时，clauses 必须按 answer 的 UTF-8 字节范围连续覆盖全文，每个 clause 至少有一个引用。引用必须使用来源的 source_id，并给出原文中连续的 UTF-8 字节范围和逐字 quote。若来源无法支持问题，使用 not_stated 或 cannot_confirm，clauses 必须为空。不要输出 Markdown、解释、额外字段或虚构来源。"""


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


def _model_answer(answer_kind: str, value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
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
    try:
        raw = call_llm(
            LlmConfig(base_url=canonical_ollama_base_url(), model=GENERATION_MODEL),
            _system_prompt(),
            json.dumps(model_input, ensure_ascii=False, separators=(",", ":")),
            timeout=120,
            max_tokens=2048,
            options={"temperature": 0, "num_ctx": 16_384, "num_predict": 2048},
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
    answer = _model_answer(answer_kind, response.get("answer"))
    clauses_raw = response.get("clauses")
    if not isinstance(clauses_raw, list):
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
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
            _utf8_slice(answer, start, end, "回答分句")
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
        if not 1 <= len(citations_raw) <= 8:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用数量无效", 502)
        citations: list[dict[str, Any]] = []
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
            if citation.get("_derive_range_from_quote") is True:
                model_quote = citation.get("quote")
                if not isinstance(model_quote, str) or not model_quote or len(model_quote) > 600:
                    raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文无效", 502)
                character_start = source["text"].find(model_quote)
                if character_start < 0:
                    raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文不匹配", 502)
                source_start = len(source["text"][:character_start].encode("utf-8"))
                source_end = source_start + len(model_quote.encode("utf-8"))
            elif not isinstance(source_start, int) or not isinstance(source_end, int):
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用范围无效", 502)
            quote = _utf8_slice(source["text"], source_start, source_end, "来源引用")
            if quote != citation.get("quote"):
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用原文不匹配", 502)
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
            citations.append(normalized_citation)
            citation_key = (source["source_id"], source_start, source_end, quote)
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
