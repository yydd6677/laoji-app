"""One-call, source-attributed Q2 reader candidate.

The reader is intentionally synchronous and capability-gated.  The mobile
Q2 repository remains the owner of snapshots/turns; this service only accepts
the immutable source view for one request, calls the configured LLM once, and
returns a response that has passed exact UTF-8 citation grounding.
"""

from __future__ import annotations

from difflib import SequenceMatcher
import hashlib
import json
import os
import re
import unicodedata
from typing import Any

from app.services.llm_provider import (
    GENERATION_MODEL,
    LlmConfig,
    LlmProviderError,
    call_llm,
    canonical_ollama_base_url,
    embed_texts,
    embed_texts_cached,
    _reset_embedding_cache_for_tests,
)
from app.services.summary_v3_evidence import estimate_tokens
from app.services.summary_v3_generator import model_revision


CONTRACT_REVISION = "question.reader.v2"
PROVIDER_REVISION = "q2-reader-v2"
MAX_SOURCES = 1_024
MAX_VERIFIED_SOURCES = 50_000
MAX_SOURCE_TEXT = 8_000
MAX_QUESTION = 2_000
# Keep the attributed reader interactive on the local 9B model. Long meetings
# are narrowed to raw immutable evidence before generation; the complete source
# snapshot remains the only grounding authority below.
MAX_INPUT_TOKENS = 10_240
MAX_STREAM_INPUT_TOKENS = 4_096
RETRIEVAL_BATCH_SIZE = 256
RETRIEVAL_LAMBDA = 0.7
RETRIEVAL_UNIT_CHARS = 360
RETRIEVAL_UNIT_DURATION_MS = 30_000
_RETRIEVAL_SIGNAL = re.compile(
    r"(?:不是|并非|不要|无需|取消|改为|纠正|更正|确认|负责人|由.{0,12}(?:负责|跟进)|"
    r"(?:今天|明天|后天|本周|下周|本月|下月|季度|年底|月底|周[一二三四五六日天])|"
    r"(?:截止|日期|时间|上午|下午|晚上|安排|定于|开会|提交|完成|交付|到期))",
    re.IGNORECASE,
)
_RETRIEVAL_INTENTS: tuple[tuple[re.Pattern[str], tuple[str, ...]], ...] = (
    (re.compile(r"(?:什么方法|哪些方法|如何|怎么|怎样|技术路线|算法)"),
     ("方法", "算法", "采用", "使用", "通过", "优化", "方案")),
    (re.compile(r"(?:为什么|为何|原因|目的)"),
     ("因为", "原因", "因此", "所以", "导致", "目的")),
    (re.compile(r"(?:谁|哪位|负责人|负责者)"),
     ("负责", "负责人", "由", "人员", "发言人")),
    (re.compile(r"(?:什么时候|何时|哪天|日期|时间|截止|期限)"),
     ("日期", "时间", "截止", "安排", "计划", "完成")),
    (re.compile(r"(?:多少|几个|几项|比例|价格|金额|数量)"),
     ("数量", "比例", "价格", "金额", "达到", "共计")),
    (re.compile(r"(?:下一步|后续|计划|准备怎样)"),
     ("后续", "计划", "下一步", "准备", "改进", "安排")),
    (re.compile(r"(?:主要讨论|主题|议题|主要内容)"),
     ("讨论", "主题", "议题", "内容", "介绍", "汇报", "问题", "目标")),
    (re.compile(r"(?:问题|困难|挑战|风险|阻塞|短板)"),
     ("问题", "困难", "挑战", "风险", "阻塞", "短板", "影响", "经营")),
)
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
_SOURCE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")
_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONFLICT_FINAL_QUERY = re.compile(r"(?:最终|成交|确定|定下来|以哪个为准).*(?:日期|时间|哪天|价格|报价|多少钱|金额)|(?:日期|时间|哪天|价格|报价|多少钱|金额).*(?:最终|成交|确定|定下来|以哪个为准)")
_DATE_VALUE = re.compile(r"(?:\d{1,4}\s*[年/月日号]|[一二三四五六七八九十百]+\s*[月日号])")
_PRICE_VALUE = re.compile(r"(?:\d+(?:\.\d+)?\s*(?:元|万元|万|块)|[一二三四五六七八九十百]+\s*(?:元|万元|万|块))")
_FACT_VALUE = re.compile(
    r"\d+(?:\.\d+)?(?:\s*(?:%|％|亿元|万元|万|亿|元|人|位|个|次|天|日|号|月|年))?",
    re.IGNORECASE,
)
_COUNT_QUERY = re.compile(r"(?:多少|几个|几项|分为几|共有几|共几)")
_IMPROVEMENT_QUERY = re.compile(
    r"(?:(?:怎样|如何|怎么).*(?:改进|优化|调整|修改|升级)|"
    r"(?:改进|优化|调整|修改|升级).*(?:怎样|如何|怎么))"
)
_CHINESE_COUNT_VALUE = re.compile(
    r"[零〇一二两三四五六七八九十百千万]+(?:个|项|部分|份|人|位|次|天|日|月|年)"
)


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


def _retrieval_intent_terms(question: str) -> tuple[str, ...]:
    terms: list[str] = []
    for pattern, candidates in _RETRIEVAL_INTENTS:
        if pattern.search(question):
            terms.extend(candidates)
    return tuple(dict.fromkeys(terms))


def _embed_retrieval_units(units: list[dict[str, Any]]) -> list[tuple[float, ...]]:
    """Embed deterministic packed units with a bounded, content-free LRU.

    Q2 sends the same immutable transcript for each question. Re-encoding every
    source unit made long-meeting latency proportional to meeting length on
    every turn. The cache retains only model-scoped hashes and normalized
    vectors in process memory; source text remains in the encrypted task stream
    and cache loss merely causes a safe cold recomputation.
    """
    values: list[tuple[float, ...]] = []
    for offset in range(0, len(units), RETRIEVAL_BATCH_SIZE):
        batch = units[offset:offset + RETRIEVAL_BATCH_SIZE]
        values.extend(embed_texts_cached(
            [unit["text"] for unit in batch],
            priority="interactive",
            operation="question.q2.evidence.sources",
            timeout_seconds=60,
            # Keep one 2k CPU embedding runner shared with Summary evidence.
            # Loading a second 8k/GPU variant evicts the warm 9B generator and
            # adds several seconds of model reload to the first question for
            # every new meeting.
            num_ctx=2_048,
            num_gpu=0,
            embedder=embed_texts,
        ))
    if len(values) != len(units):
        raise LlmProviderError("q2_retrieval_embedding_count_mismatch")
    return values


def _reset_q2_embedding_cache_for_tests() -> None:
    _reset_embedding_cache_for_tests()


def _retrieval_units(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pack adjacent transcript fragments only for embedding retrieval.

    The model and final grounding continue to use the original source rows,
    hashes and UTF-8 ranges. This keeps retrieval cost independent of ASR
    punctuation frequency without inventing a derived citation source.
    """
    units: list[dict[str, Any]] = []
    current_indexes: list[int] = []
    current_members: list[tuple[int, int, int]] = []
    current_texts: list[str] = []

    def flush() -> None:
        nonlocal current_indexes, current_members, current_texts
        if current_indexes:
            units.append({
                "member_indexes": tuple(current_indexes),
                "members": tuple(current_members),
                "text": " ".join(current_texts),
            })
        current_indexes = []
        current_members = []
        current_texts = []

    for index, source in enumerate(sources):
        source_text = source["text"]
        if len(source_text) > RETRIEVAL_UNIT_CHARS:
            flush()
            for start in range(0, len(source_text), RETRIEVAL_UNIT_CHARS):
                end = min(len(source_text), start + RETRIEVAL_UNIT_CHARS)
                units.append({
                    "member_indexes": (index,),
                    "members": ((index, start, end),),
                    "text": source_text[start:end],
                })
            continue
        if source["source_type"] != "transcript":
            flush()
            units.append({
                "member_indexes": (index,),
                "members": ((index, 0, len(source_text)),),
                "text": source_text,
            })
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
        current_members.append((index, 0, len(source_text)))
        current_texts.append(source_text)
    flush()
    return units


def _model_source_alias(source: dict[str, Any], index: int) -> str:
    return str(source.get("_model_alias") or f"s{int(source.get('_original_index', index))}")


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
                "source_id": _model_source_alias(source, index),
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


def _source_projection(
    sources: list[dict[str, Any]],
    member: tuple[int, int, int],
) -> dict[str, Any]:
    index, start, end = member
    source = sources[index]
    if start == 0 and end == len(source["text"]):
        return {**source, "_original_index": index, "_model_alias": f"s{index}"}
    prefix_bytes = len(source["text"][:start].encode("utf-8"))
    excerpt = source["text"][start:end]
    return {
        **source,
        "text": excerpt,
        "source_start_utf8": int(source.get("source_start_utf8") or 0) + prefix_bytes,
        "source_end_utf8": int(source.get("source_start_utf8") or 0)
        + prefix_bytes
        + len(excerpt.encode("utf-8")),
        "_original_index": index,
        "_model_alias": f"s{index}w{start}",
    }


def _select_model_sources(
    question: str,
    source_fingerprint: str,
    sources: list[dict[str, str]],
    *,
    input_token_budget: int = MAX_INPUT_TOKENS,
) -> tuple[list[dict[str, Any]], bool]:
    """Select a bounded raw-source view without creating a derived summary.

    The complete immutable source list remains the grounding authority. Only
    the model input is narrowed when it exceeds the context budget. Exact
    source IDs, hashes and quotes are still checked against the full list
    after generation. Embedding failure is explicit; there is no lexical or
    summary fallback that could silently answer from incomplete evidence.
    """
    if _estimate_model_payload(question, source_fingerprint, sources) <= input_token_budget:
        return sources, True

    units = _retrieval_units(sources)
    intent_terms = _retrieval_intent_terms(question)
    retrieval_question = " ".join((question, *intent_terms)).strip()
    query_vectors = embed_texts_cached(
        [retrieval_question],
        priority="interactive",
        operation="question.q2.evidence.query",
        timeout_seconds=30,
        # Query embedding on CPU coexists with the warm 9B generator. Sending
        # this 0.6B request to GPU would add a ~28s generator reload per turn.
        num_ctx=2_048,
        num_gpu=0,
        embedder=embed_texts,
    )
    if len(query_vectors) != 1:
        raise LlmProviderError("q2_retrieval_embedding_count_mismatch")
    source_vectors = _embed_retrieval_units(units)
    query_vector = query_vectors[0]
    literal_query_terms = _support_terms(question)
    query_terms = _support_terms(retrieval_question)
    scores = []
    for unit, vector in zip(units, source_vectors):
        semantic = _cosine(query_vector, vector)
        overlap = len(query_terms & _support_terms(unit["text"]))
        lexical = min(1.0, overlap / max(1, min(8, len(query_terms))))
        scores.append(semantic * 0.75 + lexical * 0.25)

    # Preserve explicit corrections, dates, owners and boundary statements as
    # evidence candidates, then rank the remaining raw segments by similarity.
    forced = {
        index for index, unit in enumerate(units)
        if _RETRIEVAL_SIGNAL.search(unit["text"])
    }
    literal_overlap = [
        len(literal_query_terms & _support_terms(unit["text"]))
        for unit in units
    ]
    literal_candidates = [
        index for index, overlap in enumerate(literal_overlap)
        if overlap >= 2
    ]
    leading_literal = sorted(
        literal_candidates,
        key=lambda index: (-literal_overlap[index], -scores[index], index),
    )[:32]
    intent_candidates = [
        index for index, unit in enumerate(units)
        if any(term.lower() in unit["text"].lower() for term in intent_terms)
    ]
    leading_intent = sorted(intent_candidates, key=lambda index: (-scores[index], index))[:16]
    intent_priority: list[int] = []
    for index in (*leading_literal, *leading_intent):
        for neighbor in (index, index - 1, index + 1):
            if 0 <= neighbor < len(units) and neighbor not in intent_priority:
                intent_priority.append(neighbor)
    ranked = sorted(range(len(units)), key=lambda index: (-scores[index], index))
    selected_units: list[int] = []
    selected_unit_set: set[int] = set()
    selected_members: set[tuple[int, int, int]] = set()

    def try_add(index: int) -> bool:
        if index in selected_unit_set:
            return True
        candidate_members = selected_members.union(units[index]["members"])
        candidate = [
            _source_projection(sources, member)
            for member in sorted(candidate_members)
        ]
        if _estimate_model_payload(question, source_fingerprint, candidate) > input_token_budget:
            return False
        selected_units.append(index)
        selected_unit_set.add(index)
        selected_members.update(units[index]["members"])
        return True

    # Query-specific intent and its immediate context get first chance. Generic
    # corrections/dates/owners follow, and all paths obey the same hard budget.
    for index in intent_priority:
        try_add(index)
    for index in sorted(forced.difference(intent_priority), key=lambda item: (-scores[item], item)):
        try_add(index)
    for index in ranked:
        if len(selected_units) >= len(units):
            break
        # One adjacent raw segment keeps a split utterance/correction
        # understandable without adding an unbounded context window.
        for neighbor in (index - 1, index, index + 1):
            if 0 <= neighbor < len(units):
                try_add(neighbor)

    if not selected_members:
        raise LlmProviderError("q2_retrieval_no_evidence")
    return [
        _source_projection(sources, member)
        for member in sorted(selected_members)
    ], False


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


def _answer_text_clause_ranges(
    answer: str,
    clauses: list[Any],
) -> list[tuple[int, int, str]] | None:
    """Build UTF-8 ranges from model clause text only when it exactly partitions the answer."""
    character_offset = 0
    positions: list[tuple[int, int, str]] = []
    for clause in clauses:
        text = clause.get("text") if isinstance(clause, dict) else None
        if not isinstance(text, str) or not text:
            return None
        position = answer.find(text, character_offset)
        if position < 0:
            return None
        gap = answer[character_offset:position]
        if any(not (character.isspace() or unicodedata.category(character).startswith("P")) for character in gap):
            return None
        character_end = position + len(text)
        positions.append((position, character_end, text))
        character_offset = character_end
    trailing = answer[character_offset:]
    if any(not (character.isspace() or unicodedata.category(character).startswith("P")) for character in trailing):
        return None
    ranges: list[tuple[int, int, str]] = []
    range_start_character = 0
    for index, (_position, character_end, text) in enumerate(positions):
        next_start = positions[index + 1][0] if index + 1 < len(positions) else len(answer)
        start = len(answer[:range_start_character].encode("utf-8"))
        end = len(answer[:next_start].encode("utf-8"))
        ranges.append((start, end, text))
        range_start_character = next_start
    return ranges


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


_GENERIC_CLAIM_TERMS = {
    "影响", "问题", "方面", "包括", "以及", "主要", "会议", "提到",
    "报告", "指出", "认为", "当前", "相关", "进行", "这个", "一个",
}
_GENERIC_QUERY_FOCUS_TERMS = _GENERIC_CLAIM_TERMS | {
    "怎样", "如何", "怎么", "准备", "后续", "改进", "优化", "调整",
    "修改", "升级", "哪些", "什么", "多少", "几个", "分为",
}
_CLAIM_NEGATION = re.compile(r"(?:并非|不是|没有|尚未|未曾|无需|不得|取消|未|不)")


def _enumerated_claim_segments(value: str) -> list[str]:
    """Split an obvious model list into claims without inventing wording.

    Parenthetical examples and a trailing conjunction are independent claims
    for grounding purposes. Keeping them attached to a supported umbrella such
    as ``关键问题`` would otherwise let one exact citation legitimize several
    unsupported examples. This tokenizer is deliberately activated only after
    the caller has established that the clause is an explicit enumeration.
    """
    expanded = re.sub(r"[（(](?:例如|如)", "、", value)
    expanded = re.sub(r"[）)](?:以及|和|及)?", "、", expanded)
    segments = []
    for raw in re.split(r"[、，,；;]", expanded):
        segment = raw.strip(" ：:。.!！?？()（）")
        segment = re.sub(r"^(?:以及|并且|而且|同时|此外|其次|然后|和|及)+", "", segment)
        if segment:
            segments.append(segment)
    return segments


def _claim_grounding_core(value: str) -> str:
    """Remove reporting scaffolding before measuring evidence coverage."""
    core = value.strip(" ：:。.!！?？()（）")
    core = re.sub(
        r"^(?:(?:这次|本次)?会议|文中|报告中|发言人)?"
        r"(?:主要)?(?:讨论|介绍|汇报|提到|指出)(?:了|的是|到)?",
        "",
        core,
    )
    core = re.sub(r"^(?:包括|以及|并且|同时|将)", "", core)
    return core.strip(" ：:。.!！?？()（）") or value


def _enumerated_claim_support_metrics(
    claim: str,
    quotes: list[str],
) -> tuple[bool, float, int]:
    """Return strict support plus deterministic ranking metrics."""
    if not quotes:
        return False, 0.0, 0
    core = _claim_grounding_core(claim)
    compact_core, _ = _alignment_view(core)
    compact_quotes = [_alignment_view(quote)[0] for quote in quotes]
    combined_quote = "".join(compact_quotes)
    if not compact_core or not combined_quote:
        return False, 0.0, 0
    # Lexical equality must not turn a negated source into a positive answer or
    # vice versa. This narrow polarity fence is intentionally conservative;
    # ambiguous mixed-polarity excerpts are rejected by requiring each quote
    # group to agree with the claim's negation state.
    claim_negated = bool(_CLAIM_NEGATION.search(core))
    quote_negated = bool(_CLAIM_NEGATION.search(" ".join(quotes)))
    if claim_negated != quote_negated:
        return False, 0.0, 0
    values = _fact_values(core)
    if values and not values.issubset(_fact_values(" ".join(quotes))):
        return False, 0.0, 0
    # Reporting scaffolding has already been removed, so predicate bigrams such
    # as ``影响`` and ``完成`` are evidence-bearing here. Dropping them as
    # generic would let a matching subject legitimize an unsupported claim.
    core_terms = _lexical_terms(core)
    quote_terms = set().union(*(_lexical_terms(quote) for quote in quotes))
    longest = SequenceMatcher(
        None,
        compact_core,
        combined_quote,
        autojunk=False,
    ).find_longest_match().size
    if len(compact_core) <= 4 and compact_core in combined_quote:
        return True, 1.0, len(compact_core)
    if not core_terms:
        return longest >= 4, 0.0, longest
    coverage = len(core_terms & quote_terms) / len(core_terms)
    supported = (longest >= 4 and coverage >= 0.6) or (
        longest >= 3 and coverage >= (2 / 3)
    )
    return supported, coverage, longest


def _citation_supports_enumerated_claim(claim: str, quote: str) -> bool:
    """Require strong literal coverage for one list item.

    This is intentionally stricter than the ordinary citation bridge. A list
    item can carry an independent fact, so sharing only a generic two-character
    phrase (for example ``温度``) is not enough. Short named entities remain
    usable when copied verbatim; longer claims need either a four-character
    exact run or a three-character run with at least two-thirds term coverage.
    """
    supported, _coverage, _longest = _enumerated_claim_support_metrics(
        claim,
        [quote],
    )
    return supported


def _bounded_source_citation(
    claim: str,
    source: dict[str, Any],
    clause_index: int,
    citation_index: int,
) -> dict[str, Any] | None:
    """Project one immutable source row into a bounded exact citation."""
    source_text = source["text"]
    if len(source_text) <= 600:
        quote = source_text
        character_start = 0
    else:
        exact = _adjacent_exact_span(_claim_grounding_core(claim), source_text)
        if exact is None:
            return None
        window = _quote_window(source_text, exact)
        if window is None:
            return None
        relative_start, _relative_end, quote = window
        character_start = len(source_text.encode("utf-8")[:relative_start].decode("utf-8"))
    start_utf8 = (
        int(source.get("source_start_utf8") or 0)
        + len(source_text[:character_start].encode("utf-8"))
    )
    return {
        "citation_id": f"cite-{clause_index + 1}-enum-{citation_index + 1}",
        "source_type": source["source_type"],
        "source_id": source["source_id"],
        "source_revision_id": source["source_revision_id"],
        "content_sha256": source["content_sha256"],
        "source_start_utf8": start_utf8,
        "source_end_utf8": start_utf8 + len(quote.encode("utf-8")),
        "quote": quote,
    }


def _recover_enumerated_claim_citations(
    claim: str,
    sources: list[dict[str, Any]],
    clause_index: int,
) -> list[dict[str, Any]]:
    """Find the best exact one- or two-row support for a model-written claim.

    Adjacent pairs are needed because ASR subtitle boundaries often split the
    subject from its value. The answer text is never created or expanded here;
    this step only rebinds a model claim to exact rows in the current immutable
    source snapshot. A deterministic best match is acceptable when several
    repetitions support the same claim because every candidate has already
    passed the same strict literal and polarity fence.
    """
    core = _claim_grounding_core(claim)
    compact_core, _ = _alignment_view(core)
    claim_terms = _lexical_terms(core)
    source_terms = [_lexical_terms(source["text"]) for source in sources]
    source_compact = [_alignment_view(source["text"])[0] for source in sources]
    groups: list[tuple[int, ...]] = [(index,) for index in range(len(sources))]
    groups.extend(
        (index, index + 1)
        for index in range(len(sources) - 1)
        if sources[index]["source_type"] == sources[index + 1]["source_type"]
        and sources[index]["source_id"] == sources[index + 1]["source_id"]
        and sources[index]["source_revision_id"] == sources[index + 1]["source_revision_id"]
    )
    candidates: list[tuple[float, int, int, tuple[int, ...]]] = []

    def collect(candidate_groups: list[tuple[int, ...]]) -> None:
        for group in candidate_groups:
            group_terms = set().union(*(source_terms[index] for index in group))
            if len(compact_core) <= 4:
                if compact_core not in "".join(source_compact[index] for index in group):
                    continue
            elif len(claim_terms & group_terms) < 2:
                continue
            supported, coverage, longest = _enumerated_claim_support_metrics(
                claim,
                [sources[index]["text"] for index in group],
            )
            if supported:
                candidates.append((coverage, longest, -len(group), group))

    collect(groups)
    if not candidates and re.match(
        r"^(?:(?:这次|本次)?会议|文中|报告中|发言人)?"
        r"(?:主要)?(?:讨论|介绍|汇报|提到|指出)",
        claim,
    ):
        # A high-level topic can legitimately span a title phrase and a later
        # subject phrase. Try only the 16 strongest literal rows and at most two
        # non-adjacent citations; specific facts never use this composition.
        ranked = sorted(
            range(len(sources)),
            key=lambda index: (
                -len(claim_terms & source_terms[index]),
                index,
            ),
        )[:16]
        overview_pairs = [
            (left, right)
            for position, left in enumerate(ranked)
            for right in ranked[position + 1:]
            if sources[left]["source_type"] == sources[right]["source_type"]
            and sources[left]["source_id"] == sources[right]["source_id"]
            and sources[left]["source_revision_id"] == sources[right]["source_revision_id"]
        ]
        collect(overview_pairs)
    if not candidates:
        return []
    candidates.sort(key=lambda item: (item[0], item[1], item[2], tuple(-i for i in item[3])), reverse=True)
    group = candidates[0][3]
    recovered = [
        _bounded_source_citation(claim, sources[index], clause_index, citation_index)
        for citation_index, index in enumerate(group)
    ]
    citations = [citation for citation in recovered if citation is not None]
    supported, _coverage, _longest = _enumerated_claim_support_metrics(
        claim,
        [citation["quote"] for citation in citations],
    )
    return citations if supported else []


def _project_grounded_enumerated_claims(
    clause_text: str,
    citations: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    clause_index: int,
) -> tuple[str | None, list[dict[str, Any]]]:
    """Delete unsupported list items while preserving supported model text.

    A model can otherwise put many independent claims into one clause and cite
    only one of them.  We activate this gate only for an obvious list (a
    Chinese enumeration comma or semicolon), so normal multi-clause causal
    sentences are not fragmented mechanically merely because they use commas.
    Question terms and generic reporting words do not count as support; each
    retained item must share a content bigram or literal token with an exact
    quote. This projection only removes verbatim model segments; it never
    invents, paraphrases or supplements an answer.
    """
    obvious_list = (
        "、" in clause_text
        or "；" in clause_text
        or ";" in clause_text
    )
    if not obvious_list:
        return clause_text, citations
    segments = _enumerated_claim_segments(clause_text)
    if len(segments) < 2:
        return clause_text, citations
    retained: list[str] = []
    retained_citations: list[dict[str, Any]] = []
    retained_citation_keys: set[tuple[str, int, int, str]] = set()
    for segment in segments:
        candidate_supports = [
            citation
            for citation in citations
            if _lexical_terms(_claim_grounding_core(segment)) & _lexical_terms(citation["quote"])
        ]
        supports: list[dict[str, Any]] = []
        if candidate_supports:
            supported, _coverage, _longest = _enumerated_claim_support_metrics(
                segment,
                [citation["quote"] for citation in candidate_supports[:2]],
            )
            if supported:
                supports = candidate_supports[:2]
        if not supports:
            supports = _recover_enumerated_claim_citations(
                segment,
                sources,
                clause_index,
            )
        if not supports:
            continue
        retained.append(segment)
        for citation in supports:
            key = (
                citation["source_id"],
                citation["source_start_utf8"],
                citation["source_end_utf8"],
                citation["quote"],
            )
            if key not in retained_citation_keys:
                retained_citation_keys.add(key)
                retained_citations.append(citation)
    if not retained:
        return None, []
    retained_citations = [
        {
            **citation,
            "citation_id": f"cite-{clause_index + 1}-enum-{index + 1}",
        }
        for index, citation in enumerate(retained_citations[:8])
    ]
    if len(retained) == len(segments):
        return clause_text, retained_citations
    terminal = clause_text[-1] if clause_text[-1] in "。.!！?？" else ""
    return (
        "、".join(retained).rstrip("。.!！?？") + terminal,
        retained_citations,
    )


def _alignment_view(value: str) -> tuple[str, list[int]]:
    characters: list[str] = []
    indexes: list[int] = []
    for index, character in enumerate(value):
        if character.isspace() or unicodedata.category(character).startswith("P"):
            continue
        lowered = character.lower()
        characters.append(lowered)
        indexes.append(index)
    return "".join(characters), indexes


def _recover_exact_quote(
    question: str,
    clause_text: str,
    model_quote: str,
    source_text: str,
) -> str | None:
    """Recover only a strong, unique contiguous span from the bound source.

    The local model sometimes drops punctuation or a filler word while copying
    a long quote. The UI must still receive verbatim source text. We therefore
    keep only the longest source-contiguous overlap when it is both substantial
    and unique; weak two-word semantic overlaps remain rejected rather than
    being upgraded into evidence.
    """
    compact_quote, _ = _alignment_view(model_quote)
    compact_source, source_indexes = _alignment_view(source_text)
    if not compact_quote or not compact_source:
        return None
    match = SequenceMatcher(
        None,
        compact_quote,
        compact_source,
        autojunk=False,
    ).find_longest_match()
    if match.size <= 0:
        return None
    matched_text = compact_source[match.b:match.b + match.size]
    if compact_source.count(matched_text) != 1:
        return None
    start = source_indexes[match.b]
    end = source_indexes[match.b + match.size - 1] + 1
    # Alignment deliberately ignores punctuation, but `%`/`％` are also
    # punctuation in Unicode.  Preserve an exact numeric suffix when the
    # matched span touches the same literal fact value in both strings;
    # otherwise a verbatim `65%` source is shortened to `65` and the later
    # quantitative grounding gate correctly (but unnecessarily) rejects it.
    # The two-character proximity bound prevents this from pulling a separate
    # number into an otherwise lexical match.
    shared_values = _fact_values(model_quote) & _fact_values(source_text)
    for value in shared_values:
        value_pattern = re.compile(r"\s*".join(re.escape(char) for char in value))
        for value_match in value_pattern.finditer(source_text):
            if value_match.start() <= end + 2 and value_match.end() >= start - 2:
                start = min(start, value_match.start())
                end = max(end, value_match.end())
                break
    recovered = source_text[start:end]
    same_number = bool(_fact_values(model_quote) & _fact_values(recovered))
    if (
        (match.size < 6 and not same_number)
        or (match.size < 8 and match.size / len(compact_quote) < 0.6 and not same_number)
    ):
        return None
    if not _citation_supports_text(question, clause_text, recovered):
        return None
    return recovered


def _fact_values(value: str) -> set[str]:
    """Extract literal quantitative claims that must be present in evidence.

    This is a grounding check, not an answer rule: values are taken only from
    the model's answer and verified against exact current-source text.
    """
    return {re.sub(r"\s+", "", match.group(0)) for match in _FACT_VALUE.finditer(value)}


def _lexical_terms(value: str) -> set[str]:
    return {term for term in _support_terms(value) if not re.search(r"\d", term)}


def _adjacent_exact_span(reference: str, source_text: str) -> str | None:
    compact_reference, _ = _alignment_view(reference)
    compact_source, source_indexes = _alignment_view(source_text)
    if not compact_reference or not compact_source:
        return None
    match = SequenceMatcher(
        None,
        compact_reference,
        compact_source,
        autojunk=False,
    ).find_longest_match()
    if match.size < 4:
        return None
    matched_text = compact_source[match.b:match.b + match.size]
    if compact_source.count(matched_text) != 1:
        return None
    start = source_indexes[match.b]
    end = source_indexes[match.b + match.size - 1] + 1
    return source_text[start:end]


def _complete_adjacent_clause_support(
    clause_text: str,
    sources: list[dict[str, Any]],
    citations: list[dict[str, Any]],
    clause_index: int,
) -> list[dict[str, Any]]:
    """Add exact adjacent ASR spans only when they cover a missing clause term.

    A provider quote can bridge two subtitle rows while citations must stay on
    immutable rows. Starting from an already grounded anchor, inspect at most
    one row on either side and add a unique exact span only when it contributes
    at least two previously uncovered clause bigrams. This cannot create a fact;
    it only preserves evidence that the model copied across an ASR boundary.
    """
    if not citations or len(citations) >= 3:
        return citations
    clause_terms = _lexical_terms(clause_text)
    covered = set().union(*(_lexical_terms(item["quote"]) for item in citations))
    missing = clause_terms - covered
    if len(missing) < 2:
        return citations
    source_index = {
        (source["source_id"], source["content_sha256"]): index
        for index, source in enumerate(sources)
    }
    anchor_indexes = {
        source_index[(citation["source_id"], citation["content_sha256"])]
        for citation in citations
        if (citation["source_id"], citation["content_sha256"]) in source_index
    }
    candidate_indexes = sorted({
        neighbor
        for anchor in anchor_indexes
        for neighbor in (anchor - 1, anchor + 1)
        if 0 <= neighbor < len(sources)
    })
    for index in candidate_indexes:
        source = sources[index]
        if not any(
            source["source_type"] == sources[anchor]["source_type"]
            and source["source_revision_id"] == sources[anchor]["source_revision_id"]
            for anchor in anchor_indexes
        ):
            continue
        exact = _adjacent_exact_span(clause_text, source["text"])
        if exact is None:
            continue
        gain = missing & _lexical_terms(exact)
        if len(gain) < 2:
            continue
        character_start = source["text"].find(exact)
        if character_start < 0:
            continue
        start_utf8 = (
            int(source.get("source_start_utf8") or 0)
            + len(source["text"][:character_start].encode("utf-8"))
        )
        end_utf8 = start_utf8 + len(exact.encode("utf-8"))
        citations.append({
            "citation_id": f"cite-{clause_index + 1}-adjacent-{len(citations) + 1}",
            "source_type": source["source_type"],
            "source_id": source["source_id"],
            "source_revision_id": source["source_revision_id"],
            "content_sha256": source["content_sha256"],
            "source_start_utf8": start_utf8,
            "source_end_utf8": end_utf8,
            "quote": exact,
        })
        covered.update(_lexical_terms(exact))
        missing = clause_terms - covered
        if len(citations) >= 3 or len(missing) < 2:
            break
    return citations


def _recover_unique_lexical_citation(
    clause_text: str,
    sources: list[dict[str, Any]],
    clause_index: int,
) -> list[dict[str, Any]]:
    """Rebind a clause only when one exact source is uniquely specific.

    This is used after every provider citation was rejected.  At least three
    substantive clause terms must occur in one immutable source, and no other
    source may tie that overlap.  The function never creates answer text and
    refuses long source blobs rather than selecting an arbitrary excerpt.
    """
    clause_terms = _lexical_terms(clause_text) - _GENERIC_CLAIM_TERMS
    if len(clause_terms) < 3:
        return []
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    for index, source in enumerate(sources):
        if len(source["text"]) > 600:
            continue
        overlap = clause_terms & (_lexical_terms(source["text"]) - _GENERIC_CLAIM_TERMS)
        if len(overlap) >= 3:
            candidates.append((len(overlap), -index, source))
    if not candidates:
        return []
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best = candidates[0]
    if len(candidates) > 1 and candidates[1][0] == best[0]:
        return []
    source = best[2]
    start_utf8 = int(source.get("source_start_utf8") or 0)
    return [{
        "citation_id": f"cite-{clause_index + 1}-lexical-1",
        "source_type": source["source_type"],
        "source_id": source["source_id"],
        "source_revision_id": source["source_revision_id"],
        "content_sha256": source["content_sha256"],
        "source_start_utf8": start_utf8,
        "source_end_utf8": start_utf8 + len(source["text"].encode("utf-8")),
        "quote": source["text"],
    }]


def _quote_window(source_text: str, value: str) -> tuple[int, int, str] | None:
    compact_characters: list[str] = []
    original_indexes: list[int] = []
    for index, character in enumerate(source_text):
        if character.isspace():
            continue
        compact_characters.append(character)
        original_indexes.append(index)
    compact_text = "".join(compact_characters)
    compact_position = compact_text.find(re.sub(r"\s+", "", value))
    if compact_position < 0:
        return None
    value_end = compact_position + len(re.sub(r"\s+", "", value)) - 1
    if value_end >= len(original_indexes):
        return None
    position = original_indexes[compact_position]
    original_value_end = original_indexes[value_end] + 1
    start_character = max(0, position - 120)
    end_character = min(len(source_text), original_value_end + 120)
    if end_character - start_character > 600:
        end_character = start_character + 600
    quote = source_text[start_character:end_character]
    start_utf8 = len(source_text[:start_character].encode("utf-8"))
    end_utf8 = start_utf8 + len(quote.encode("utf-8"))
    return start_utf8, end_utf8, quote


def _ground_quantitative_citations(
    question: str,
    clause_text: str,
    sources: list[dict[str, Any]],
    citations: list[dict[str, Any]],
    clause_index: int,
) -> list[dict[str, Any]]:
    """Require every answer value to have an exact, semantically linked quote.

    Providers sometimes cite a nearby sentence with a different percentage.
    Such a quote is exact but does not support the answer. Remove conflicting
    numeric citations, then deterministically add only a current-source quote
    that contains the missing value and at least two shared lexical terms.
    Existing citation proximity breaks ties so split adjacent ASR segments can
    ground one statement without guessing across the meeting.
    """
    answer_values = _fact_values(clause_text)
    if not answer_values:
        return citations
    filtered = [
        citation
        for citation in citations
        if not _fact_values(citation["quote"])
        or bool(_fact_values(citation["quote"]) & answer_values)
    ]
    source_index = {
        (source["source_id"], source["content_sha256"]): index
        for index, source in enumerate(sources)
    }
    anchor_indexes = [
        source_index[(citation["source_id"], citation["content_sha256"])]
        for citation in filtered
        if (citation["source_id"], citation["content_sha256"]) in source_index
    ]
    lexical = _lexical_terms(f"{question} {clause_text}")
    for value in sorted(answer_values):
        if any(value in re.sub(r"\s+", "", citation["quote"]) for citation in filtered):
            continue
        candidates: list[tuple[int, int, int, dict[str, Any], tuple[int, int, str]]] = []
        for index, source in enumerate(sources):
            compact_text = re.sub(r"\s+", "", source["text"])
            if value not in compact_text:
                continue
            overlap = len(lexical & _lexical_terms(source["text"]))
            distances = [
                abs(index - anchor)
                for anchor in anchor_indexes
                if sources[anchor]["source_type"] == source["source_type"]
                and sources[anchor]["source_revision_id"] == source["source_revision_id"]
            ]
            # A numeric claim split across ASR rows may be grounded by an
            # adjacent source.  A matching number elsewhere in a long meeting
            # is not interchangeable evidence, even when it shares generic
            # terms such as "比例". Fail closed instead of crossing topics.
            if anchor_indexes and (not distances or min(distances) > 3):
                continue
            distance = min(distances, default=0)
            # A party name can be replaced by a conversational pronoun in the
            # answer (for example, ``您方``), leaving the adjacent ASR row with
            # no lexical bigram in common. Exact values in the immediately
            # adjacent row are still grounded by the already verified anchor.
            # More distant rows continue to require a lexical bridge so a
            # repeated percentage elsewhere in a long meeting cannot leak in.
            if overlap < 2 and not (anchor_indexes and distance <= 1):
                continue
            window = _quote_window(source["text"], value)
            if window is not None:
                candidates.append((-distance, overlap, -index, source, window))
        if not candidates:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "回答中的数字缺少逐字依据", 502)
        candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        best = candidates[0]
        if len(candidates) > 1 and candidates[1][:3] == best[:3]:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "回答中的数字存在多处无法区分的依据", 502)
        _, _, _, source, (start_utf8, end_utf8, quote) = best
        start_utf8 += int(source.get("source_start_utf8") or 0)
        end_utf8 += int(source.get("source_start_utf8") or 0)
        filtered.append({
            "citation_id": f"cite-{clause_index + 1}-ground-{len(filtered) + 1}",
            "source_type": source["source_type"],
            "source_id": source["source_id"],
            "source_revision_id": source["source_revision_id"],
            "content_sha256": source["content_sha256"],
            "source_start_utf8": start_utf8,
            "source_end_utf8": end_utf8,
            "quote": quote,
        })
        anchor_indexes.append(source_index[(source["source_id"], source["content_sha256"])])
    return filtered[:8]


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
    citation_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "citation_id": {"type": "string", "maxLength": 32},
            "source_id": {"type": "string", "maxLength": 32},
            "quote": {"type": "string", "minLength": 1, "maxLength": 240},
        },
        "required": ["citation_id", "source_id", "quote"],
    }
    citations_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            f"e{index}": citation_schema
            for index in range(1, 3)
        },
        "required": ["e1"],
    }
    clause_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "clause_id": {"type": "string", "maxLength": 32},
            "text": {"type": "string", "minLength": 1, "maxLength": 240},
            "citations": citations_schema,
        },
        "required": ["clause_id", "text", "citations"],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "answer_kind": {"type": "string", "enum": ["answer", "not_stated", "cannot_confirm"]},
            "answer": {"type": "string", "minLength": 1, "maxLength": 600},
            "clauses": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    f"c{index}": clause_schema
                    for index in range(1, 5)
                },
            },
        },
        "required": ["answer_kind", "answer", "clauses"],
    }


def _system_prompt() -> str:
    return """你是老记会议问答的唯一证据阅读器。只根据用户提供的当前会议原始来源回答问题，不使用整理结果、历史答案、常识补全或来源之外的信息。

输出严格 JSON，根对象只能有 answer_kind、answer、clauses 三个字段。answer_kind 只能是 answer、not_stated 或 cannot_confirm；answer 是不超过 160 个中文字符的简洁回答，只保留直接回答问题所需的事实，不复述背景或扩展推论。answer_kind 为 answer 时，clauses 是固定槽位对象，只能按顺序使用 c1、c2、c3、c4，禁止输出 c5 或更多分句；每个槽位只能有 clause_id、text、citations 三个字段。各 text 按顺序无缝拼接后必须与 answer 完全相同。citations 也是固定槽位对象，只能按顺序使用 e1、e2，每个槽位只能有 citation_id、source_id、quote 三个字段；每个分句只保留最多两条直接证据。先选择逐字 quote，再围绕 quote 写 text；每个 clause 只表达一个独立事实，text 必须复用 quote 中至少一个连续四字短语，少于四字的姓名、术语或数值必须完整照抄。枚举问题最多选择四个最直接的项目，每个项目使用独立的 c 槽位；禁止在一个 text 中用顿号、多个逗号、以及、及、和串联多个独立项目。主题或概述问题也不得用一个宽泛结论包裹多个例子；quote 没有逐字支撑的例子、原因、范围或上位概念一律不写。

每个独立事实都必须由包含该事实关键名词、数字或状态的逐字引用支撑；不要只引用相邻背景句。answer 中出现的每个阿拉伯数字及其单位必须原样出现在该分句至少一条 quote 中，禁止把中文数字改写成阿拉伯数字、补全数量或换算单位；问题没有要求数字时省略非必要数字细节。每条 quote 必须是单个 source text 中连续存在的原文，不能拼接相邻来源、改写或添加标点。问题包含多个子项、并列对象或成对概念时，优先逐项回答每个有依据的对象；在这些对象全部覆盖前，不得添加问题没有要求的旁支。只要其中一部分有来源支持，就回答已知部分并明确指出其余部分未提及，使用 answer；只有全部子项都没有依据时才使用 not_stated。来源以“我”或“本人”自述负责某项工作但未给姓名时，责任主体可表述为“发言人本人”，不得因姓名或联系方式缺失而抹掉已知职责；缺失子项仍明确说明未提及。不同来源对同一事实冲突时不得自行选边，使用 cannot_confirm 且 clauses 为空对象。not_stated 或 cannot_confirm 时 answer 可以简短说明缺少依据，但 clauses 必须是空对象。不要输出 Markdown、解释、额外字段、递归 clauses 或虚构来源。"""


def _parse_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError) as error:
        # Some local 9B runs produce one redundant closing brace after an
        # otherwise complete schema-conforming object. Decode exactly one root
        # object and accept only a tiny suffix made solely of closing tokens;
        # never infer, insert or rewrite answer/citation content.
        if not isinstance(value, str):
            raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502) from error
        try:
            parsed, end = json.JSONDecoder().raw_decode(value.lstrip())
        except (TypeError, ValueError) as nested_error:
            raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502) from nested_error
        suffix = value.lstrip()[end:].strip()
        if not suffix or len(suffix) > 2 or any(character not in "]}" for character in suffix):
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


def _model_clauses(value: Any) -> list[Any] | None:
    """Normalize the bounded provider DTO while retaining legacy test inputs.

    Qwen can ignore ``maxItems`` on arrays and keep emitting citations until
    the response token budget is exhausted. Fixed object slots make the output
    grammar finite. Slot names are provider-only metadata; the public Q2
    response remains the existing ordered list with server-owned coordinates.
    """
    if isinstance(value, list):
        clauses: list[Any] = []
        for item in value:
            if not isinstance(item, dict):
                clauses.append(item)
                continue
            clause = dict(item)
            citations_raw = clause.get("citations")
            if isinstance(citations_raw, dict):
                if not set(citations_raw).issubset({f"e{index}" for index in range(1, 4)}):
                    return None
                citations = [
                    citations_raw[f"e{citation_index}"]
                    for citation_index in range(1, 4)
                    if f"e{citation_index}" in citations_raw
                ]
                if any(not isinstance(citation, dict) for citation in citations):
                    return None
                clause["citations"] = citations
            clauses.append(clause)
        return clauses
    if not isinstance(value, dict):
        return None
    if not set(value).issubset({f"c{index}" for index in range(1, 5)}):
        return None

    clauses: list[Any] = []
    clause_gap = False
    for clause_index in range(1, 5):
        key = f"c{clause_index}"
        if key not in value:
            clause_gap = True
            continue
        if clause_gap or not isinstance(value[key], dict):
            return None
        clause = dict(value[key])
        citations_raw = clause.get("citations")
        if not isinstance(citations_raw, dict):
            return None
        if not set(citations_raw).issubset({f"e{index}" for index in range(1, 4)}):
            return None
        citations = [
            citations_raw[f"e{citation_index}"]
            for citation_index in range(1, 4)
            if f"e{citation_index}" in citations_raw
        ]
        if any(not isinstance(citation, dict) for citation in citations):
            return None
        clause["citations"] = citations
        clauses.append(clause)
    return clauses


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
    input_token_budget = (
        MAX_STREAM_INPUT_TOKENS
        if source_stream_verified
        else MAX_INPUT_TOKENS
    )
    try:
        model_sources, complete_source_view = _select_model_sources(
            question,
            source_fingerprint,
            sources,
            input_token_budget=input_token_budget,
        )
    except LlmProviderError as error:
        raise Q2ReaderError("Q2_RETRIEVAL_UNAVAILABLE", "会议来源检索暂时不可用", 503) from error
    model_input = _model_payload(question, source_fingerprint, model_sources)
    estimated = estimate_tokens(json.dumps(model_input, ensure_ascii=False, separators=(",", ":")))
    if estimated > input_token_budget:
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
    clauses_raw = _model_clauses(response.get("clauses"))
    if clauses_raw is None:
        raise Q2ReaderError("Q2_READER_FORMAT_INVALID", "问答结果格式异常", 502)
    answer = _model_answer(answer_kind, response.get("answer"), clauses_raw)
    if answer_kind != "answer":
        if clauses_raw:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "无依据回答不应包含引用", 502)
        if answer_kind == "not_stated" and not complete_source_view:
            answer_kind = "cannot_confirm"
            answer = "当前只检索了部分会议来源，无法确认会议中是否未提及。"
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
    if not 1 <= len(clauses_raw) <= 4:
        raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答分句数量无效", 502)
    source_by_alias = {
        _model_source_alias(source, index): source
        for index, source in enumerate(model_sources)
    }
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
    grounded_clause_records: list[dict[str, Any]] = []
    answer_reprojected = False
    canonical_citations: list[dict[str, Any]] = []
    seen_citations: set[tuple[str, int, int, str]] = set()
    text_clause_ranges = _answer_text_clause_ranges(answer, clauses_raw)
    coordinate_valid = text_clause_ranges is not None or _answer_coordinates_cover_full_text(answer, clauses_raw)
    for clause_index, clause in enumerate(clauses_raw):
        if not isinstance(clause, dict):
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答分句格式无效", 502)
        model_clause_text = clause.get("text")
        if (
            isinstance(model_clause_text, str)
            and model_clause_text.strip()
            and not (_support_terms(model_clause_text) & _support_terms(answer))
            and not _is_absence_clause(model_clause_text)
        ):
            # A bounded provider can still emit an auxiliary evidence clause
            # that is not present in its own top-level answer. It must not make
            # the public answer fail or acquire unrelated citations. Drop only
            # a clause with no lexical bridge at all; answer-wide citation and
            # quantitative checks remain fail-closed below.
            coordinate_valid = False
            continue
        clause_id = _model_identifier(clause.get("clause_id"), f"c{clause_index + 1}")
        start = clause.get("answer_start_utf8")
        end = clause.get("answer_end_utf8")
        clause_text = answer
        if text_clause_ranges is not None:
            start, end, clause_text = text_clause_ranges[clause_index]
        elif coordinate_valid:
            # The full-cover preflight above guarantees these spans are
            # contiguous UTF-8 byte ranges. Keep this check defensive if the
            # loop is reused independently.
            try:
                _utf8_slice(answer, start, end, "回答分句")
            except (TypeError, Q2ReaderError):
                coordinate_valid = False
        if text_clause_ranges is None and isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(answer_bytes):
            try:
                clause_text = _utf8_slice(answer, start, end, "回答分句")
            except Q2ReaderError:
                clause_text = answer
        # When top-level answer text and provider clauses disagree, ground the
        # explicit clause text and later rebuild the public answer from only
        # those verified clauses. Reusing the whole top-level answer for every
        # clause would both retain unsupported expansions and require every
        # numeric value to appear in every citation set.
        if (
            text_clause_ranges is None
            and not coordinate_valid
            and isinstance(model_clause_text, str)
            and model_clause_text.strip()
        ):
            clause_text = model_clause_text.strip()
            answer_reprojected = True
        # A malformed/character-offset clause with no usable text still uses
        # the full answer as relevance context; citation byte grounding remains
        # strict and the answer-wide fallback below stays fail-closed.
        elif text_clause_ranges is None and (
            not coordinate_valid or len(re.findall(r"[\u3400-\u9fff]", clause_text)) <= 1
        ):
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
        provider_exact_quote_seen = False
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
            if any(model_quote in candidate["text"] for candidate in sources):
                provider_exact_quote_seen = True
            if not _citation_supports_text(question, clause_text, model_quote):
                # Providers sometimes attach an extra transition/background
                # quote beside the actual evidence. Discard that quote instead
                # of rejecting a clause that still has independently verified
                # support. A clause left with no support fails closed below.
                continue
            if model_quote not in source["text"]:
                # A provider can choose an adjacent short-window alias while
                # still returning an exact quote from the current immutable
                # snapshot. Rebind only when the quote identifies exactly one
                # current source. An unmatched extra quote is discarded; the
                # clause still fails closed below unless another citation is
                # exact, relevant support.
                matching_sources = [candidate for candidate in sources if model_quote in candidate["text"]]
                if len(matching_sources) == 1:
                    source = matching_sources[0]
                    source_start = None
                    source_end = None
                else:
                    recovered_quote = _recover_exact_quote(
                        question,
                        clause_text,
                        model_quote,
                        source["text"],
                    )
                    if recovered_quote is None:
                        continue
                    model_quote = recovered_quote
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
        if not citations and provider_exact_quote_seen:
            citations = _recover_unique_lexical_citation(
                clause_text,
                sources,
                clause_index,
            )
        citations = _complete_adjacent_clause_support(
            clause_text,
            sources,
            citations,
            clause_index,
        )
        projected_clause_text, projected_citations = _project_grounded_enumerated_claims(
            clause_text,
            citations,
            sources,
            clause_index,
        )
        if projected_clause_text is None:
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "回答中的枚举项缺少逐字依据", 502)
        if projected_clause_text != clause_text:
            clause_text = projected_clause_text
            citations = projected_citations
            answer_reprojected = True
            coordinate_valid = False
        else:
            citations = projected_citations
        citations = _ground_quantitative_citations(
            question,
            clause_text,
            sources,
            citations,
            clause_index,
        )
        if not citations:
            # An absence statement has no positive source span to cite. If an
            # earlier clause is supported, omit only this absent sub-answer;
            # every other unsupported clause remains a hard failure.
            if _is_absence_clause(clause_text) and canonical_citations:
                coordinate_valid = False
                continue
            raise Q2ReaderError("Q2_GROUNDING_INVALID", "问答引用与回答无关", 502)
        grounded_clause_records.append({
            "clause_id": clause_id,
            "text": clause_text,
            "citations": citations,
        })
        for citation in citations:
            citation_key = (
                citation["source_id"],
                citation["source_start_utf8"],
                citation["source_end_utf8"],
                citation["quote"],
            )
            if citation_key not in seen_citations:
                seen_citations.add(citation_key)
                canonical_citations.append(citation)
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
    if _COUNT_QUERY.search(question) and len(grounded_clause_records) > 1:
        count_records = [
            record
            for record in grounded_clause_records
            if _fact_values(record["text"])
            or _CHINESE_COUNT_VALUE.search(record["text"])
        ]
        if count_records:
            question_terms = _lexical_terms(question) - _GENERIC_QUERY_FOCUS_TERMS
            scored = [
                (len(question_terms & _lexical_terms(record["text"])), index, record)
                for index, record in enumerate(count_records)
            ]
            highest = max(score for score, _index, _record in scored)
            best = [record for score, _index, record in scored if score == highest]
            selected_count_records = best if len(best) == 1 else count_records
        else:
            selected_count_records = []
        if selected_count_records and selected_count_records != grounded_clause_records:
            grounded_clause_records = selected_count_records
            answer_reprojected = True
    elif _IMPROVEMENT_QUERY.search(question) and len(grounded_clause_records) > 1:
        focus_terms = _lexical_terms(question) - _GENERIC_QUERY_FOCUS_TERMS
        focused_records = []
        for record in grounded_clause_records:
            evidence_terms = _lexical_terms(record["text"])
            for citation in record["citations"]:
                evidence_terms.update(_lexical_terms(citation["quote"]))
            if focus_terms & evidence_terms:
                focused_records.append(record)
        if focused_records and len(focused_records) < len(grounded_clause_records):
            grounded_clause_records = focused_records
            answer_reprojected = True
    if answer_reprojected:
        rendered_texts = [
            record["text"].strip().rstrip("。.!！?？；;")
            for record in grounded_clause_records
        ]
        rendered_texts = [
            text + ("；" if index < len(rendered_texts) - 1 else "。")
            for index, text in enumerate(rendered_texts)
        ]
        answer = "".join(rendered_texts)
        clauses = []
        offset = 0
        for record, rendered_text in zip(grounded_clause_records, rendered_texts):
            end = offset + len(rendered_text.encode("utf-8"))
            clauses.append({
                "clause_id": record["clause_id"],
                "answer_start_utf8": offset,
                "answer_end_utf8": end,
                "citations": record["citations"],
            })
            offset = end
    elif not coordinate_valid:
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
