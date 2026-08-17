"""Hybrid semantic retrieval primitives for single-meeting question answering.

The caller remains responsible for lexical ranking and prompt-budget policy.
This module only supplies query-to-source semantic scores. Production Q&A must
not silently become lexical-only when the embedding model is unavailable.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Iterable

from app.services.llm_provider import EMBEDDING_MODEL, embed_texts


LOGGER = logging.getLogger(__name__)

SourceIdentity = tuple[str, str]
Embedding = tuple[float, ...]
EmbedFunction = Callable[[list[str]], list[Embedding]]


class SemanticRetrievalUnavailable(RuntimeError):
    """The mandatory meeting embedding path is unavailable."""

_DEFAULT_MODEL = EMBEDDING_MODEL
_DEFAULT_DIMENSIONS = 256
_DEFAULT_BATCH_SIZE = 64
_DEFAULT_CACHE_MEETINGS = 16
_QUERY_INSTRUCTION = (
    "Instruct: Given a question about one meeting, retrieve passages that can "
    "answer it. Match paraphrases and omitted subjects while preserving exact "
    "people, dates, amounts, decisions, corrections, and negations."
)

_CACHE_LOCK = threading.Lock()
_SOURCE_BUILD_LOCK = threading.Lock()
_SOURCE_VECTOR_CACHE: OrderedDict[str, dict[SourceIdentity, Embedding]] = OrderedDict()
_QUERY_SCORE_CACHE: OrderedDict[str, dict[SourceIdentity, float]] = OrderedDict()
_CIRCUIT_OPEN_UNTIL = 0.0
_LAST_FAILURE_SIGNATURE: str | None = None


def _positive_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return min(maximum, max(minimum, value))


def _embedding_model() -> str:
    return os.getenv("MEETING_QUESTION_EMBEDDING_MODEL", _DEFAULT_MODEL).strip() or _DEFAULT_MODEL


def _embedding_dimensions() -> int:
    return _positive_int(
        "MEETING_QUESTION_EMBEDDING_DIMENSIONS",
        _DEFAULT_DIMENSIONS,
        minimum=32,
        maximum=1024,
    )


def _ollama_embed(texts: list[str]) -> list[Embedding]:
    return embed_texts(texts, priority="interactive", operation="meeting.question.embedding")


def _source_identity(source: dict[str, Any]) -> SourceIdentity:
    return str(source.get("kind") or ""), str(source.get("source_id") or "")


def _source_document(source: dict[str, Any]) -> str:
    fields = []
    title = str(source.get("title") or "").strip()
    speaker = str(source.get("speaker") or "").strip()
    text = str(source.get("text") or "").strip()
    if title:
        fields.append(f"标题：{title}")
    if speaker:
        fields.append(f"发言人：{speaker}")
    fields.append(text)
    return "\n".join(fields)[:4_000]


def _semantic_query(payload: dict[str, Any]) -> str:
    parts = [_QUERY_INSTRUCTION, f"Query: {str(payload.get('question') or '').strip()}"]
    context = payload.get("context") or []
    if context:
        previous = context[-1]
        previous_question = str(previous.get("question") or "").strip()
        previous_answer = str(previous.get("answer") or "").strip()
        if previous_question:
            parts.append(f"Previous question: {previous_question[:500]}")
        if previous_answer:
            parts.append(f"Previous answer: {previous_answer[:800]}")
    return "\n".join(parts)


def _cache_limit() -> int:
    return _positive_int(
        "MEETING_QUESTION_EMBEDDING_CACHE_MEETINGS",
        _DEFAULT_CACHE_MEETINGS,
        minimum=1,
        maximum=128,
    )


def _cache_get(cache: OrderedDict[str, Any], key: str) -> Any | None:
    with _CACHE_LOCK:
        value = cache.get(key)
        if value is not None:
            cache.move_to_end(key)
        return value


def _cache_put(cache: OrderedDict[str, Any], key: str, value: Any) -> None:
    with _CACHE_LOCK:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > _cache_limit():
            cache.popitem(last=False)


def _source_cache_key(evidence_fingerprint: str) -> str:
    return "|".join((_embedding_model(), str(_embedding_dimensions()), evidence_fingerprint))


def _query_cache_key(source_key: str, query: str) -> str:
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()
    return f"{source_key}|{digest}"


def _embed_batches(texts: list[str], embed: EmbedFunction) -> list[Embedding]:
    batch_size = _positive_int(
        "MEETING_QUESTION_EMBEDDING_BATCH_SIZE",
        _DEFAULT_BATCH_SIZE,
        minimum=1,
        maximum=256,
    )
    result: list[Embedding] = []
    for offset in range(0, len(texts), batch_size):
        result.extend(embed(texts[offset:offset + batch_size]))
    if len(result) != len(texts):
        raise RuntimeError("embedding batch result count changed")
    return result


def _source_vectors(
    evidence_fingerprint: str,
    sources: list[dict[str, Any]],
    embed: EmbedFunction,
) -> dict[SourceIdentity, Embedding]:
    key = _source_cache_key(evidence_fingerprint)
    cached = _cache_get(_SOURCE_VECTOR_CACHE, key)
    identities = [_source_identity(source) for source in sources]
    if cached is not None and set(cached) == set(identities):
        return cached
    # Concurrent questions for the same newly opened meeting must not encode
    # an identical Transcript several times. The embedding runner is itself a
    # bounded GPU service, so serializing cold source builds also avoids a
    # thundering herd across different meetings.
    with _SOURCE_BUILD_LOCK:
        cached = _cache_get(_SOURCE_VECTOR_CACHE, key)
        if cached is not None and set(cached) == set(identities):
            return cached
        documents = [_source_document(source) for source in sources]
        vectors = _embed_batches(documents, embed)
        mapped = dict(zip(identities, vectors, strict=True))
        _cache_put(_SOURCE_VECTOR_CACHE, key, mapped)
        return mapped


def _record_failure(error: Exception) -> None:
    global _CIRCUIT_OPEN_UNTIL, _LAST_FAILURE_SIGNATURE
    cooldown = _positive_int(
        "MEETING_QUESTION_EMBEDDING_FAILURE_COOLDOWN",
        60,
        minimum=1,
        maximum=600,
    )
    signature = f"{type(error).__name__}:{str(error)[:160]}"
    with _CACHE_LOCK:
        _CIRCUIT_OPEN_UNTIL = time.monotonic() + cooldown
        changed = signature != _LAST_FAILURE_SIGNATURE
        _LAST_FAILURE_SIGNATURE = signature
    if changed:
        LOGGER.warning("meeting semantic retrieval unavailable: %s", signature)


def semantic_source_scores(
    payload: dict[str, Any],
    evidence_fingerprint: str,
    sources: list[dict[str, Any]],
    *,
    embed: EmbedFunction | None = None,
) -> dict[SourceIdentity, float]:
    """Return cosine scores for request-owned sources or fail explicitly."""
    if not sources:
        return {}
    with _CACHE_LOCK:
        if embed is None and time.monotonic() < _CIRCUIT_OPEN_UNTIL:
            raise SemanticRetrievalUnavailable("embedding_circuit_open")
    active_embed = embed or _ollama_embed
    query = _semantic_query(payload)
    source_key = _source_cache_key(evidence_fingerprint)
    query_key = _query_cache_key(source_key, query)
    if embed is None:
        cached_scores = _cache_get(_QUERY_SCORE_CACHE, query_key)
        if cached_scores is not None:
            return cached_scores
    try:
        vectors = _source_vectors(evidence_fingerprint, sources, active_embed)
        query_vector = active_embed([query])[0]
        scores = {
            identity: math.fsum(a * b for a, b in zip(query_vector, vector))
            for identity, vector in vectors.items()
        }
        if embed is None:
            _cache_put(_QUERY_SCORE_CACHE, query_key, scores)
        return scores
    except Exception as error:
        if embed is None:
            _record_failure(error)
        raise SemanticRetrievalUnavailable("embedding_unavailable") from error


def reset_semantic_retrieval_state_for_tests() -> None:
    global _CIRCUIT_OPEN_UNTIL, _LAST_FAILURE_SIGNATURE
    with _CACHE_LOCK:
        _SOURCE_VECTOR_CACHE.clear()
        _QUERY_SCORE_CACHE.clear()
        _CIRCUIT_OPEN_UNTIL = 0.0
        _LAST_FAILURE_SIGNATURE = None
