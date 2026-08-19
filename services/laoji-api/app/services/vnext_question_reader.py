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
    embed_texts,
)
from app.services.summary_v3_evidence import estimate_tokens
from app.services.summary_v3_generator import model_revision


CONTRACT_REVISION = "question.reader.v2"
PROVIDER_REVISION = "q2-reader-v1"
MAX_SOURCES = 1_024
MAX_VERIFIED_SOURCES = 50_000
MAX_SOURCE_TEXT = 8_000
MAX_QUESTION = 2_000
MAX_INPUT_TOKENS = 10_240
RETRIEVAL_BATCH_SIZE = 32
RETRIEVAL_LAMBDA = 0.7
RETRIEVAL_UNIT_CHARS = 360
RETRIEVAL_UNIT_DURATION_MS = 30_000
_RETRIEVAL_SIGNAL = re.compile(
    r"(?:不是|并非|不要|无需|取消|改为|纠正|更正|确认|负责人|由.{0,12}(?:负责|跟进)|"
    r"(?:今天|明天|后天|本周|下周|本月|下月|季度|年底|月底|周[一二三四五六日天])|"
    r"(?:截止|日期|时间|上午|下午|晚上|安排|定于|开会|提交|完成|交付|到期))",
    re.IGNORECASE,
)
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
_SOURCE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")
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


def _source_id(value: Any, field: str) -> str:
    normalized = _text(value, field, 512)
    if not _SOURCE_ID.fullmatch(normalized):
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


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _retrieval_units(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pack adjacent transcript fragments only for embedding retrieval.

    The model and final grounding continue to use the original source rows,
    hashes and UTF-8 ranges. This keeps retrieval cost independent of ASR
    punctuation frequency without inventing a derived citation source.
    """
    units: list[dict[str, Any]] = []
    current_indexes: list[int] = []
    current_texts: list[str] = []

    def flush() -> None:
        nonlocal current_indexes, current_texts
        if current_indexes:
            units.append({
                "member_indexes": tuple(current_indexes),
                "text": " ".join(current_texts),
            })
        current_indexes = []
        current_texts = []

    for index, source in enumerate(sources):
        if source["source_type"] != "transcript":
            flush()
            units.append({"member_indexes": (index,), "text": source["text"]})
            continue
        can_join = bool(current_indexes)
        if can_join:
            first = sources[current_indexes[0]]
            previous = sources[current_indexes[-1]]
            projected_chars = sum(len(text) for text in current_texts) + len(current_texts) + len(source["text"])
            start_ms = first.get("start_ms")
            end_ms = source.get("end_ms")
            duration_ok = (
                start_ms is None
                or end_ms is None
                or int(end_ms) - int(start_ms) <= RETRIEVAL_UNIT_DURATION_MS
            )
            can_join = bool(
                previous["source_id"] == source["source_id"]
                and previous["source_revision_id"] == source["source_revision_id"]
                and projected_chars <= RETRIEVAL_UNIT_CHARS
                and duration_ok
            )
        if not can_join:
            flush()
        current_indexes.append(index)
        current_texts.append(source["text"])
    flush()
    return units


def _model_payload(
    question: str,
    source_fingerprint: str,
    sources: list[dict[str, str]],
) -> dict[str, Any]:
    # Preserve original aliases even after retrieval. Citations returned as
    # s17 must resolve against the immutable full snapshot, not a renumbered
    # subset that could point at another segment.
    return {
        "schema_version": 2,
        "source_fingerprint": source_fingerprint,
        "question": question,
        "sources": [
            {
                "source_id": f"s{int(source.get('_original_index', index))}",
                "source_type": source["source_type"],
                "text": source["text"],
            }
            for index, source in enumerate(sources)
        ],
    }


def _estimate_model_payload(question: str, source_fingerprint: str, sources: list[dict[str, str]]) -> int:
    return estimate_tokens(json.dumps(
        _model_payload(question, source_fingerprint, sources),
        ensure_ascii=False,
        separators=(",", ":"),
    ))


def _select_model_sources(
    question: str,
    source_fingerprint: str,
    sources: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Select a bounded raw-source view without creating a derived summary.

    The complete immutable source list remains the grounding authority. Only
    the model input is narrowed when it exceeds the context budget. Exact
    source IDs, hashes and quotes are still checked against the full list
    after generation. Embedding failure is explicit; there is no lexical or
    summary fallback that could silently answer from incomplete evidence.
    """
    if _estimate_model_payload(question, source_fingerprint, sources) <= MAX_INPUT_TOKENS:
        return sources

    units = _retrieval_units(sources)
    query_vectors = embed_texts(
        [question],
        priority="interactive",
        operation="question.q2.evidence.query",
        timeout_seconds=30,
    )
    if len(query_vectors) != 1:
        raise LlmProviderError("q2_retrieval_embedding_count_mismatch")
    source_vectors: list[tuple[float, ...]] = []
    for offset in range(0, len(units), RETRIEVAL_BATCH_SIZE):
        batch = units[offset:offset + RETRIEVAL_BATCH_SIZE]
        vectors = embed_texts(
            [unit["text"] for unit in batch],
            priority="interactive",
            operation="question.q2.evidence.sources",
            timeout_seconds=45,
        )
        if len(vectors) != len(batch):
            raise LlmProviderError("q2_retrieval_embedding_count_mismatch")
        source_vectors.extend(vectors)
    query_vector = query_vectors[0]
    scores = [_cosine(query_vector, vector) for vector in source_vectors]

    # Preserve explicit corrections, dates, owners and boundary statements as
    # evidence candidates, then rank the remaining raw segments by similarity.
    forced = {
        index for index, unit in enumerate(units)
        if _RETRIEVAL_SIGNAL.search(unit["text"])
    }
    ranked = sorted(range(len(units)), key=lambda index: (-scores[index], index))
    selected_units: list[int] = []
    selected_unit_set: set[int] = set()
    selected_source_indexes: set[int] = set()

    def try_add(index: int) -> bool:
        if index in selected_unit_set:
            return True
        candidate_indexes = selected_source_indexes.union(units[index]["member_indexes"])
        candidate = [
            {**sources[item], "_original_index": item}
            for item in sorted(candidate_indexes)
        ]
        if _estimate_model_payload(question, source_fingerprint, candidate) > MAX_INPUT_TOKENS:
            return False
        selected_units.append(index)
        selected_unit_set.add(index)
        selected_source_indexes.update(units[index]["member_indexes"])
        return True

    # Critical signals get first chance, but still obey the same hard budget.
    for index in sorted(forced, key=lambda item: (-scores[item], item)):
        try_add(index)
    for index in ranked:
        if len(selected_units) >= len(units):
            break
        # One adjacent raw segment keeps a split utterance/correction
        # understandable without adding an unbounded context window.
        for neighbor in (index - 1, index, index + 1):
            if 0 <= neighbor < len(units):
                try_add(neighbor)

    if not selected_source_indexes:
        raise LlmProviderError("q2_retrieval_no_evidence")
    return [
        {**sources[index], "_original_index": index}
        for index in sorted(selected_source_indexes)
    ]


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


def _answer_coordinates_cover_full_text(answer: str, clauses: list[Any]) -> bool:
    """Check provider answer spans before using them for citation relevance.

    Qwen sometimes emits character offsets for a UTF-8 byte contract. A
    prefix can still decode successfully, so checking each span in isolation
    is insufficient: a later citation may then be compared with only the
    first few characters of the answer and be rejected as unrelated. The
    coordinates are presentation metadata; when they do not form one exact
    UTF-8 cover, the immutable answer text remains the relevance context and
    the server-owned citation spans are rebuilt below.
    """
    previous_end = 0
    answer_length = len(answer.encode("utf-8"))
    for clause in clauses:
        if not isinstance(clause, dict):
            return False
        start = clause.get("answer_start_utf8")
        end = clause.get("answer_end_utf8")
        if (
            not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start != previous_end
            or end <= start
            or end > answer_length
        ):
            return False
        try:
            _utf8_slice(answer, start, end, "回答分句")
        except Q2ReaderError:
            return False
        previous_end = end
    return previous_end == answer_length


def _is_absence_clause(value: str) -> bool:
    """Whether a clause explicitly reports that a requested field is absent."""
    return bool(re.search(r"(?:未提及|没有提及|未说明|没有说明|未提供|没有提供|没有信息|无法确认|不详)", value))


def _support_terms(value: str) -> set[str]:
    """Return short evidence terms for a conservative citation relevance gate.

    This is not an answer generator or a semantic fallback. It only catches a
    citation that is exact source text but has no lexical bridge to either the
    answer clause or the question. Chinese bigrams preserve names, dates and
    domain phrases better than whitespace tokenization; ASCII/digit runs are
    retained as complete terms.
    """
    normalized = re.sub(r"\s+", "", str(value or "")).lower()
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", normalized))
    terms = {cjk[index:index + 2] for index in range(max(0, len(cjk) - 1))}
    terms.update(re.findall(r"[a-z0-9][a-z0-9._:/%-]{1,}", normalized))
    if len(cjk) == 1:
        terms.add(cjk)
    return {term for term in terms if term}


def _citation_supports_text(question: str, clause: str, quote: str) -> bool:
    quote_terms = _support_terms(quote)
    if not quote_terms:
        return False
    answer_terms = _support_terms(clause)
    question_terms = _support_terms(question)
    return bool(quote_terms & answer_terms or quote_terms & question_terms)


def _source_payload(
    raw: Any,
    *,
    max_source_text: int = MAX_SOURCE_TEXT,
    max_sources: int = MAX_SOURCES,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= max_sources:
        raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源数量无效")
    sources: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, int, int, str]] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源格式无效")
        source_type = _text(item.get("source_type"), "source_type", 32)
        if source_type not in {"transcript", "manual_note", "attachment"}:
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源类型无效")
        source_id = _source_id(item.get("source_id"), "source_id")
        revision = _source_id(item.get("source_revision_id"), "source_revision_id")
        content_hash = _hash(item.get("content_sha256"), "content_sha256")
        content = _text(item.get("text"), "text", max_source_text)
        if _sha256_text(content) != content_hash:
            raise Q2ReaderError("Q2_SOURCE_HASH_MISMATCH", "Q2 来源内容校验失败", 409)
        source_start = item.get("source_start_utf8", 0)
        source_end = item.get("source_end_utf8", source_start + len(content.encode("utf-8")))
        if (
            not isinstance(source_start, int)
            or isinstance(source_start, bool)
            or not isinstance(source_end, int)
            or isinstance(source_end, bool)
            or source_start < 0
            or source_end < source_start
        ):
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源范围无效")
        start_ms = item.get("start_ms")
        end_ms = item.get("end_ms")
        if start_ms is not None and (
            not isinstance(start_ms, int) or isinstance(start_ms, bool) or start_ms < 0
        ):
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源时间无效")
        if end_ms is not None and (
            not isinstance(end_ms, int)
            or isinstance(end_ms, bool)
            or end_ms < 0
            or (start_ms is not None and end_ms < start_ms)
        ):
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源时间无效")
        key = (
            source_type,
            source_id,
            revision,
            source_start,
            source_end,
            content_hash,
        )
        if key in seen:
            raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源重复")
        seen.add(key)
        sources.append({
            "source_type": source_type,
            "source_id": source_id,
            "source_revision_id": revision,
            "content_sha256": content_hash,
            "text": content,
            "source_start_utf8": source_start,
            "source_end_utf8": source_end,
            "start_ms": start_ms,
            "end_ms": end_ms,
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
    source_stream_verified = payload.get("source_stream_verified", False)
    if not isinstance(source_stream_verified, bool):
        raise Q2ReaderError("Q2_INPUT_INVALID", "Q2 来源流标记无效")
    sources = _source_payload(
        payload.get("sources"),
        max_source_text=16 * 1024 * 1024 if source_stream_verified else MAX_SOURCE_TEXT,
        max_sources=MAX_VERIFIED_SOURCES if source_stream_verified else MAX_SOURCES,
    )
    if not source_stream_verified and _source_fingerprint(sources) != source_fingerprint:
        raise Q2ReaderError("Q2_SOURCE_FINGERPRINT_MISMATCH", "Q2 来源整体标识校验失败", 409)
    try:
        model_sources = _select_model_sources(question, source_fingerprint, sources)
    except LlmProviderError as error:
        raise Q2ReaderError("Q2_RETRIEVAL_UNAVAILABLE", "会议来源检索暂时不可用", 503) from error
    model_input = _model_payload(question, source_fingerprint, model_sources)
    estimated = estimate_tokens(json.dumps(model_input, ensure_ascii=False, separators=(",", ":")))
    if estimated > MAX_INPUT_TOKENS:
        raise Q2ReaderError("Q2_EVIDENCE_INCOMPLETE", "会议来源过长，暂时无法完整检索", 413)
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
    sources_by_id: dict[str, list[dict[str, Any]]] = {}
    for source in sources:
        sources_by_id.setdefault(source["source_id"], []).append(source)
    # A recording-level source ID can legitimately repeat across immutable
    # rows. Only accept an unaliased provider ID when it is unambiguous.
    source_by_id = {
        source_id: values[0]
        for source_id, values in sources_by_id.items()
        if len(values) == 1
    }
    answer_bytes = answer.encode("utf-8")
    previous_end = 0
    clauses: list[dict[str, Any]] = []
    canonical_citations: list[dict[str, Any]] = []
    seen_citations: set[tuple[str, int, int, str]] = set()
    coordinate_valid = _answer_coordinates_cover_full_text(answer, clauses_raw)
    for clause_index, clause in enumerate(clauses_raw):
        if not isinstance(clause, dict):
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答分句格式无效", 502)
        clause_id = _model_identifier(clause.get("clause_id"), f"c{clause_index + 1}")
        start = clause.get("answer_start_utf8")
        end = clause.get("answer_end_utf8")
        if coordinate_valid:
            # The full-cover preflight above guarantees these spans are
            # contiguous UTF-8 byte ranges. Keep this check defensive if the
            # loop is reused independently.
            try:
                _utf8_slice(answer, start, end, "回答分句")
            except (TypeError, Q2ReaderError):
                coordinate_valid = False
        clause_text = answer
        if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(answer_bytes):
            try:
                clause_text = _utf8_slice(answer, start, end, "回答分句")
            except Q2ReaderError:
                clause_text = answer
        # A malformed/character-offset clause can isolate one CJK glyph even
        # though the answer is otherwise meaningful. Use the full answer as
        # relevance context in that narrow case; citation byte grounding
        # remains strict below.
        if not coordinate_valid or len(re.findall(r"[\u3400-\u9fff]", clause_text)) <= 1:
            clause_text = answer
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
            if not _citation_supports_text(question, clause_text, model_quote):
                # An absence statement has no positive source span to cite.
                # If another clause already has verified evidence, discard
                # only this unrelated citation; never expose it as support.
                # A wholly unsupported answer still fails closed below.
                if _is_absence_clause(clause_text) and canonical_citations:
                    continue
                raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用与回答无关", 502)
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
            source_start += int(source.get("source_start_utf8") or 0)
            source_end += int(source.get("source_start_utf8") or 0)
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
        if not citations and _is_absence_clause(clause_text) and canonical_citations:
            # Do not expose a clause that has no positive source citation. The
            # answer is collapsed to one server-owned span after validation,
            # retaining only the verified citations from supported clauses.
            coordinate_valid = False
            continue
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
