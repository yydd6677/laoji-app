"""Deterministic source normalization and long-meeting evidence selection."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
from typing import Any, Iterable

from app.services.llm_provider import LlmProviderError, embed_texts
from app.services.summary_v3_store import source_fingerprint


INPUT_TOKEN_BUDGET = 10_240
TRANSCRIPT_MIN_BUDGET = 7_680
NOTE_MAX_BUDGET = 1_536
ATTACHMENT_MAX_BUDGET = 1_536
MMR_LAMBDA = 0.7
MMR_ADDITIONAL_MIN_SCORE = 0.45
PACKAGE_METADATA_RESERVE = 256
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
_OPAQUE_TOKEN = re.compile(r"[A-Za-z0-9._:-]{24,}")
_FORCED_SIGNAL = re.compile(
    r"(?:不是|并非|不要|无需|取消|改为|纠正|更正|确认|负责人|由.{0,12}(?:负责|跟进)|"
    r"(?:今天|明天|后天|本周|下周|本月|下月|季度|年底|月底|周[一二三四五六日天])|"
    r"\d{1,4}(?:年|月|日|号|点|时|分|%|％|万|亿)|"
    r"首先|其次|最后|另外|另一方面|关于|接下来|回到|换个话题)",
    re.IGNORECASE,
)
_FORCED_CRITICAL_SIGNAL = re.compile(
    r"(?:不是|并非|不要|无需|取消|改为|纠正|更正|确认|负责人|"
    r"由.{0,12}(?:负责|跟进)|今天|明天|后天|本周|下周|本月|下月|季度|年底|月底|"
    r"周[一二三四五六日天]|"
    r"(?:截止|日期|时间|上午|下午|晚上|凌晨|安排|定于|预约|开会|会议|提交|完成|交付|到期|之前|之后)"
    r".{0,20}\d{1,4}(?:年|月|日|号|点|时|分)|"
    r"\d{1,4}(?:年|月|日|号|点|时|分).{0,20}"
    r"(?:截止|日期|时间|上午|下午|晚上|安排|定于|开会|会议|提交|完成|交付|到期))",
    re.IGNORECASE,
)
_FORCED_CONNECTOR_SIGNAL = re.compile(
    r"(?:首先|其次|最后|另外|另一方面|关于|接下来|回到|换个话题)",
    re.IGNORECASE,
)
_NO_NEW_INFORMATION_SIGNAL = re.compile(
    r"(?:没有|无|未|尚未)[^。！？；]{0,18}(?:新增|形成|产生|指定)?[^。！？；]{0,8}"
    r"(?:决策|决定|行动项|负责人|截止(?:日期|时间))",
)

# Subtitle/ASR emitters commonly split one utterance into many short rows.
# Feeding those rows as independent model items spends the context window on
# repeated ids/timestamps and removes the local syntax needed to understand a
# topic, correction, or commitment.  Long meetings use deterministic packing
# below; short meetings retain their original line-level source identity.
_TRANSCRIPT_PACK_THRESHOLD = 32
_TRANSCRIPT_PACK_MAX_CHARS = 360
_TRANSCRIPT_PACK_MAX_DURATION_MS = 30_000


class SummaryEvidenceIncomplete(RuntimeError):
    code = "SUMMARY_EVIDENCE_INCOMPLETE"


@dataclass(frozen=True)
class EvidenceSource:
    source_id: str
    source_type: str
    text: str
    content_hash: str
    start_ms: int | None
    end_ms: int | None
    ordinal: int
    speaker: str | None = None
    parent_id: str | None = None
    model_source_id: str | None = None

    @property
    def token_cost(self) -> int:
        # The model must receive stable IDs and hashes as well as source text.
        # Counting text alone materially underestimates long meetings because
        # every source adds JSON keys, a SHA-256 digest and timing metadata.
        serialized = json.dumps(
            self.model_payload(),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return estimate_tokens(serialized)

    def model_payload(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "source_id": self.model_source_id or self.source_id,
            "source_type": self.source_type,
            "text": self.text,
        }
        if self.start_ms is not None:
            value["start_ms"] = self.start_ms
        if self.end_ms is not None:
            value["end_ms"] = self.end_ms
        if self.speaker:
            value["speaker"] = self.speaker
        return value


@dataclass(frozen=True)
class EvidencePackage:
    sources: tuple[EvidenceSource, ...]
    source_fingerprint: str
    transcript_revision: str
    coverage: dict[str, Any]
    estimated_tokens: int

    def model_payload(self) -> dict[str, Any]:
        return {
            "schema_version": 3,
            "source_fingerprint": self.source_fingerprint,
            "transcript_revision": self.transcript_revision,
            "coverage": self.coverage,
            "sources": [source.model_payload() for source in self.sources],
        }

    def source_map(self) -> dict[str, EvidenceSource]:
        values = {source.source_id: source for source in self.sources}
        values.update(
            {
                source.model_source_id: source
                for source in self.sources
                if source.model_source_id
            }
        )
        return values


def _sha256(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _safe_part(value: object) -> str:
    normalized = str(value or "").strip()
    if _SAFE_ID.fullmatch(normalized):
        return normalized
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def estimate_tokens(value: str) -> int:
    """Conservative tokenizer-independent estimate for Chinese-heavy JSON input."""
    cjk = sum(1 for character in value if "\u3400" <= character <= "\u9fff")
    opaque = sum(len(match.group(0)) for match in _OPAQUE_TOKEN.finditer(value))
    other = max(0, len(value) - cjk - opaque)
    # Random hashes, UUID-like source IDs and fingerprints tokenize much more
    # densely than prose. Treating them as ordinary ASCII caused a nominal
    # 10k evidence package to exceed Qwen's real 16k context after protocol
    # overhead, which made Ollama truncate the system contract from the front.
    return max(1, cjk + math.ceil(opaque / 1.8) + math.ceil(other / 3.2))


def _split_text(value: str, *, max_chars: int = 800) -> list[str]:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", normalized) if part.strip()]
    chunks: list[str] = []
    for paragraph in paragraphs:
        remaining = paragraph
        while len(remaining) > max_chars:
            boundary = max(
                remaining.rfind("。", 0, max_chars + 1),
                remaining.rfind("！", 0, max_chars + 1),
                remaining.rfind("？", 0, max_chars + 1),
                remaining.rfind("；", 0, max_chars + 1),
                remaining.rfind("\n", 0, max_chars + 1),
            )
            if boundary < max_chars // 2:
                boundary = max_chars
            else:
                boundary += 1
            chunks.append(remaining[:boundary].strip())
            remaining = remaining[boundary:].strip()
        if remaining:
            chunks.append(remaining)
    return chunks


def _transcript_sources(lines: list[dict[str, Any]]) -> list[EvidenceSource]:
    """Normalize transcript rows into stable, citation-safe source chunks.

    A long transcript is packed only along its original order and time range.
    A packed source is still immutable and its quote is the exact normalized
    concatenation sent to the model; the source timestamp spans all rows in the
    chunk so UI citation jumps remain deterministic.  Keeping short meetings
    line-level avoids changing existing source contracts unnecessarily.
    """
    normalized: list[dict[str, Any]] = []
    for ordinal, line in enumerate(lines):
        text = str(line.get("text") or "").strip()
        if not text:
            continue
        normalized.append({
            "ordinal": ordinal,
            "raw_id": str(line.get("id") or f"line-{ordinal}"),
            "text": text,
            "start_ms": _milliseconds(line.get("start_ms"), line.get("start")),
            "end_ms": _milliseconds(line.get("end_ms"), line.get("end")),
            "speaker": str(line.get("speaker") or line.get("speaker_label") or "").strip() or None,
        })

    if len(normalized) <= _TRANSCRIPT_PACK_THRESHOLD:
        chunks = [[item] for item in normalized]
    else:
        chunks: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        current_chars = 0
        for item in normalized:
            next_chars = current_chars + (1 if current else 0) + len(item["text"])
            current_start = current[0]["start_ms"] if current else None
            current_end = item["end_ms"]
            duration = (
                current_end - current_start
                if current_start is not None and current_end is not None
                else 0
            )
            speaker_changed = bool(
                current
                and current[-1]["speaker"]
                and item["speaker"]
                and current[-1]["speaker"] != item["speaker"]
            )
            if current and (
                speaker_changed
                or next_chars > _TRANSCRIPT_PACK_MAX_CHARS
                or duration > _TRANSCRIPT_PACK_MAX_DURATION_MS
            ):
                chunks.append(current)
                current = []
                current_chars = 0
            current.append(item)
            current_chars += (1 if len(current) > 1 else 0) + len(item["text"])
        if current:
            chunks.append(current)

    values: list[EvidenceSource] = []
    for chunk_ordinal, chunk in enumerate(chunks):
        first = chunk[0]
        last = chunk[-1]
        raw_id = first["raw_id"] if len(chunk) == 1 else f"{first['raw_id']}--{last['raw_id']}"
        source_id = f"transcript:{_safe_part(raw_id)}"
        start_ms = first["start_ms"]
        end_ms = last["end_ms"]
        if start_ms is not None and end_ms is not None and end_ms < start_ms:
            end_ms = start_ms
        speakers = {item["speaker"] for item in chunk}
        # Do not attribute a packed chunk to a named speaker when any row in
        # it is unknown; that would turn partial diarization into a false
        # speaker claim in every citation using the chunk.
        speaker = next(iter(speakers)) if len(speakers) == 1 and None not in speakers else None
        text = " ".join(item["text"] for item in chunk)
        values.append(
            EvidenceSource(
                source_id=source_id,
                source_type="transcript",
                text=text,
                content_hash=_sha256(text),
                start_ms=start_ms,
                end_ms=end_ms,
                ordinal=chunk_ordinal,
                speaker=speaker,
                parent_id=(first["raw_id"] if len(chunk) > 1 else None),
                model_source_id=f"transcript:t{chunk_ordinal:x}",
            )
        )
    return values


def normalize_transcript_evidence_sources(
    lines: list[dict[str, Any]],
) -> list[EvidenceSource]:
    """Public adapter for immutable source-stream transcript rows.

    Both the legacy Summary V3 request and the vNext chapter worker must apply
    the same deterministic subtitle packing. Keeping this boundary public
    prevents the source-stream path from treating every ASR fragment as an
    isolated sentence and then rejecting otherwise valid cross-fragment
    verbatim citations.
    """
    return _transcript_sources(lines)


def _milliseconds(milliseconds: object, seconds: object) -> int | None:
    if milliseconds is not None:
        try:
            return max(0, int(round(float(milliseconds))))
        except (TypeError, ValueError):
            return None
    if seconds is not None:
        try:
            return max(0, int(round(float(seconds) * 1000)))
        except (TypeError, ValueError):
            return None
    return None


def _manual_note_sources(note: dict[str, Any] | None, start_ordinal: int) -> list[EvidenceSource]:
    if not note:
        return []
    revision = max(0, int(note.get("revision") or 0))
    parent = f"manual_note:{revision}"
    chunks = _split_text(str(note.get("content") or ""))
    return [
        EvidenceSource(
            source_id=f"{parent}:{index}",
            source_type="manual_note",
            text=text,
            content_hash=_sha256(text),
            start_ms=None,
            end_ms=None,
            ordinal=start_ordinal + index,
            parent_id=parent,
            model_source_id=f"manual_note:n{index:x}",
        )
        for index, text in enumerate(chunks)
    ]


def _attachment_sources(
    attachments: list[dict[str, Any]] | None,
    start_ordinal: int,
) -> list[EvidenceSource]:
    values: list[EvidenceSource] = []
    for attachment_index, attachment in enumerate(attachments or []):
        attachment_id = _safe_part(attachment.get("attachment_id") or attachment_index)
        revision = max(0, int(attachment.get("revision") or 0))
        parent = f"attachment:{attachment_id}:{revision}"
        position_ms = _milliseconds(attachment.get("position_ms"), None)
        for chunk_index, text in enumerate(_split_text(str(attachment.get("content") or ""))):
            values.append(
                EvidenceSource(
                    source_id=f"{parent}:{chunk_index}",
                    source_type="attachment",
                    text=text,
                    content_hash=_sha256(text),
                    start_ms=position_ms,
                    end_ms=position_ms,
                    ordinal=start_ordinal + len(values),
                    parent_id=parent,
                    model_source_id=f"attachment:a{attachment_index:x}.{chunk_index:x}",
                )
            )
    return values


def normalize_sources(
    transcript_lines: list[dict[str, Any]],
    manual_note: dict[str, Any] | None,
    attachments: list[dict[str, Any]] | None,
) -> tuple[list[EvidenceSource], str, str]:
    transcript = _transcript_sources(transcript_lines)
    if not transcript:
        raise SummaryEvidenceIncomplete("transcript_empty")
    note = _manual_note_sources(manual_note, len(transcript))
    attachment = _attachment_sources(attachments, len(transcript) + len(note))
    all_sources = transcript + note + attachment
    identity = [
        {
            "source_id": source.source_id,
            "source_type": source.source_type,
            "content_hash": source.content_hash,
            "start_ms": source.start_ms,
            "end_ms": source.end_ms,
            # Speaker labels are part of the model input. A correction must
            # create a new identity even when transcript text is unchanged.
            "speaker": source.speaker,
        }
        for source in all_sources
    ]
    transcript_identity = identity[: len(transcript)]
    return (
        all_sources,
        source_fingerprint({"sources": identity}),
        source_fingerprint({"sources": transcript_identity}),
    )


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _embed_all(sources: list[EvidenceSource]) -> list[tuple[float, ...]]:
    vectors: list[tuple[float, ...]] = []
    try:
        configured_batch_size = int(os.getenv("SUMMARY_V3_EMBED_BATCH_SIZE", "64"))
    except (TypeError, ValueError):
        configured_batch_size = 64
    batch_size = max(4, min(64, configured_batch_size))
    for offset in range(0, len(sources), batch_size):
        batch = sources[offset : offset + batch_size]
        try:
            vectors.extend(
                embed_texts(
                    [source.text for source in batch],
                    priority="background",
                    operation="summary.v3.evidence.embedding",
                    timeout_seconds=45,
                )
            )
        except LlmProviderError as error:
            # Keep provider outages inside the stable evidence contract. The
            # worker can then retry or expose SUMMARY_EVIDENCE_INCOMPLETE
            # without leaking requests/urllib exceptions to the API surface.
            raise SummaryEvidenceIncomplete("embedding_unavailable") from error
    if len(vectors) != len(sources):
        raise SummaryEvidenceIncomplete("embedding_count_mismatch")
    return vectors


def _transcript_groups(
    sources: list[EvidenceSource],
    vectors: list[tuple[float, ...]],
) -> list[list[int]]:
    groups: list[list[int]] = []
    for index, source in enumerate(sources):
        if not groups:
            groups.append([index])
            continue
        previous_index = groups[-1][-1]
        previous = sources[previous_index]
        gap_ms = None
        if previous.end_ms is not None and source.start_ms is not None:
            gap_ms = max(0, source.start_ms - previous.end_ms)
        similar = _cosine(vectors[previous_index], vectors[index]) >= 0.55
        continuous = gap_ms is None or gap_ms <= 60_000
        group_cost = sum(sources[item].token_cost for item in groups[-1])
        # Repetitive status narration can otherwise create dozens of tiny
        # groups merely because the safety cost cap is reached.  A very high
        # semantic match is sufficient evidence that these adjacent segments
        # belong to one topic group; only moderately similar material keeps
        # the cap so distinct subtopics remain separately represented.
        highly_similar = _cosine(vectors[previous_index], vectors[index]) >= 0.85
        if continuous and similar and (
            group_cost + source.token_cost <= 1_600 or highly_similar
        ):
            groups[-1].append(index)
        else:
            groups.append([index])
    return groups


def _centroid_relevance(index: int, group: list[int], vectors: list[tuple[float, ...]]) -> float:
    if len(group) == 1:
        return 1.0
    return sum(_cosine(vectors[index], vectors[other]) for other in group if other != index) / (
        len(group) - 1
    )


def _representative(
    group: list[int],
    selected: set[int],
    vectors: list[tuple[float, ...]],
) -> int:
    best_index = group[0]
    best_score = -float("inf")
    for index in group:
        relevance = _centroid_relevance(index, group, vectors)
        redundancy = max(
            (_cosine(vectors[index], vectors[chosen]) for chosen in selected),
            default=0.0,
        )
        score = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * redundancy
        if score > best_score or (score == best_score and index < best_index):
            best_index = index
            best_score = score
    return best_index


def _fit_forced_signals(
    candidates: set[int],
    sources: list[EvidenceSource],
    budget: int,
) -> set[int]:
    """Keep critical signals, then fill the bounded remainder deterministically.

    The signal regex intentionally includes weak numeric/connective hints for
    coverage telemetry, but a long transcript can contain hundreds of routine
    numbers. Corrections, negations, responsibility claims and explicit
    temporal expressions are mandatory; weaker hints are admitted in source
    order only while budget remains. If the critical layer itself cannot fit,
    the package fails closed rather than emitting a partial summary.
    """
    if not sources:
        return set()
    endpoints = {0, len(sources) - 1}
    selected = endpoints.intersection(range(len(sources)))
    critical = {
        index for index in candidates if _FORCED_CRITICAL_SIGNAL.search(sources[index].text)
    }
    selected.update(critical)
    if sum(sources[index].token_cost for index in selected) > budget:
        raise SummaryEvidenceIncomplete("forced_evidence_exceeds_budget")
    remainder = sorted(
        candidates - selected,
        key=lambda index: (0 if _FORCED_CONNECTOR_SIGNAL.search(sources[index].text) else 1, index),
    )
    for index in remainder:
        candidate_cost = sum(sources[item].token_cost for item in selected) + sources[index].token_cost
        if candidate_cost <= budget:
            selected.add(index)
    return selected


def _required_selection(
    groups: list[list[int]],
    forced: set[int],
    vectors: list[tuple[float, ...]],
) -> set[int]:
    selected = set(forced)
    for group in groups:
        if not selected.intersection(group):
            selected.add(_representative(group, selected, vectors))
    return selected


def _merge_closest_adjacent_groups(
    groups: list[list[int]],
    vectors: list[tuple[float, ...]],
) -> list[list[int]]:
    if len(groups) <= 1:
        return groups
    boundary = max(
        range(len(groups) - 1),
        key=lambda index: (
            _cosine(vectors[groups[index][-1]], vectors[groups[index + 1][0]]),
            -index,
        ),
    )
    return [
        *groups[:boundary],
        groups[boundary] + groups[boundary + 1],
        *groups[boundary + 2 :],
    ]


def _select_transcript(
    sources: list[EvidenceSource],
    vectors: list[tuple[float, ...]],
    budget: int,
) -> tuple[set[int], int, int, int, int]:
    raw_groups = _transcript_groups(sources, vectors)
    forced_candidates = {
        index
        for index, source in enumerate(sources)
        if _FORCED_SIGNAL.search(source.text)
        and not _NO_NEW_INFORMATION_SIGNAL.search(source.text)
    }
    forced = _fit_forced_signals(forced_candidates, sources, budget)
    groups = [list(group) for group in raw_groups]
    selected = _required_selection(groups, forced, vectors)
    while (
        sum(sources[index].token_cost for index in selected) > budget
        and len(groups) > 1
    ):
        groups = _merge_closest_adjacent_groups(groups, vectors)
        selected = _required_selection(groups, forced, vectors)
    if sum(sources[index].token_cost for index in selected) > budget:
        raise SummaryEvidenceIncomplete("transcript_source_exceeds_budget")

    context_candidates: list[int] = []
    for index in sorted(selected):
        for adjacent in (index - 1, index + 1):
            if 0 <= adjacent < len(sources) and adjacent not in selected:
                context_candidates.append(adjacent)
    for index in context_candidates:
        if sum(sources[item].token_cost for item in selected) + sources[index].token_cost <= budget:
            selected.add(index)

    all_indexes = list(range(len(sources)))
    dimension = len(vectors[0]) if vectors else 0
    centroid = tuple(
        sum(vector[position] for vector in vectors) / len(vectors)
        for position in range(dimension)
    ) if vectors else tuple()
    remaining = set(all_indexes) - selected
    while remaining:
        scores = {
            index: MMR_LAMBDA * _cosine(vectors[index], centroid)
            - (1 - MMR_LAMBDA)
            * max((_cosine(vectors[index], vectors[item]) for item in selected), default=0.0)
            for index in remaining
        }
        candidate = max(remaining, key=lambda index: (scores[index], -index))
        if scores[candidate] < MMR_ADDITIONAL_MIN_SCORE:
            break
        if sum(sources[item].token_cost for item in selected) + sources[candidate].token_cost > budget:
            remaining.remove(candidate)
            continue
        selected.add(candidate)
        remaining.remove(candidate)
    return (
        selected,
        len(raw_groups),
        len(groups),
        len(forced_candidates),
        len(forced.intersection(forced_candidates)),
    )


def _select_auxiliary(
    indexes: list[int],
    sources: list[EvidenceSource],
    vectors: list[tuple[float, ...]],
    budget: int,
) -> set[int]:
    if not indexes:
        return set()
    parents: dict[str, list[int]] = {}
    for index in indexes:
        parents.setdefault(sources[index].parent_id or sources[index].source_id, []).append(index)
    selected: set[int] = set()
    for parent_indexes in parents.values():
        selected.add(_representative(parent_indexes, selected, vectors))
    if sum(sources[index].token_cost for index in selected) > budget:
        raise SummaryEvidenceIncomplete("auxiliary_source_coverage_incomplete")
    remaining = set(indexes) - selected
    while remaining:
        candidate = max(
            remaining,
            key=lambda index: (
                _centroid_relevance(index, indexes, vectors)
                - 0.3 * max((_cosine(vectors[index], vectors[item]) for item in selected), default=0.0),
                -index,
            ),
        )
        current_cost = sum(sources[index].token_cost for index in selected)
        if current_cost + sources[candidate].token_cost <= budget:
            selected.add(candidate)
        remaining.remove(candidate)
    return selected


def build_evidence_package_from_sources(
    sources: list[EvidenceSource],
    *,
    source_fingerprint_value: str,
    transcript_revision: str,
    input_token_budget: int = INPUT_TOKEN_BUDGET,
) -> EvidencePackage:
    """Build a bounded package from already normalized immutable sources."""
    if not sources:
        raise SummaryEvidenceIncomplete("source_empty")
    fingerprint = source_fingerprint_value
    if not fingerprint.startswith("sha256:") or len(fingerprint) != 71:
        raise SummaryEvidenceIncomplete("source_fingerprint_invalid")
    if not transcript_revision.startswith("sha256:") or len(transcript_revision) != 71:
        raise SummaryEvidenceIncomplete("transcript_revision_invalid")
    if len({source.source_id for source in sources}) != len(sources):
        raise SummaryEvidenceIncomplete("source_id_duplicate")
    if any(source.ordinal != index for index, source in enumerate(sources)):
        raise SummaryEvidenceIncomplete("source_ordinal_invalid")
    source_token_budget = max(1, input_token_budget - PACKAGE_METADATA_RESERVE)
    total_cost = sum(source.token_cost for source in sources)
    transcript_indexes = [index for index, source in enumerate(sources) if source.source_type == "transcript"]
    note_indexes = [index for index, source in enumerate(sources) if source.source_type == "manual_note"]
    attachment_indexes = [
        index for index, source in enumerate(sources) if source.source_type == "attachment"
    ]
    selected_indexes: set[int]
    raw_topic_group_count: int
    topic_group_count: int
    forced_signal_count = 0
    included_forced_signal_count = 0
    used_embeddings = total_cost > source_token_budget
    if not used_embeddings:
        selected_indexes = set(range(len(sources)))
        raw_topic_group_count = 1 if transcript_indexes else 0
        topic_group_count = raw_topic_group_count
    else:
        vectors = _embed_all(sources)
        note_budget = min(NOTE_MAX_BUDGET, sum(sources[index].token_cost for index in note_indexes))
        attachment_budget = min(
            ATTACHMENT_MAX_BUDGET,
            sum(sources[index].token_cost for index in attachment_indexes),
        )
        transcript_budget = source_token_budget - note_budget - attachment_budget
        if transcript_budget < min(TRANSCRIPT_MIN_BUDGET, sum(sources[index].token_cost for index in transcript_indexes)):
            deficit = min(TRANSCRIPT_MIN_BUDGET, sum(sources[index].token_cost for index in transcript_indexes)) - transcript_budget
            reducible_attachment = max(0, attachment_budget - (min((sources[index].token_cost for index in attachment_indexes), default=0)))
            reduction = min(deficit, reducible_attachment)
            attachment_budget -= reduction
            transcript_budget += reduction
            deficit -= reduction
            reducible_note = max(0, note_budget - (min((sources[index].token_cost for index in note_indexes), default=0)))
            reduction = min(deficit, reducible_note)
            note_budget -= reduction
            transcript_budget += reduction
        transcript_sources = [sources[index] for index in transcript_indexes]
        transcript_vectors = [vectors[index] for index in transcript_indexes]
        (
            local_selected,
            raw_topic_group_count,
            topic_group_count,
            forced_signal_count,
            included_forced_signal_count,
        ) = _select_transcript(
            transcript_sources,
            transcript_vectors,
            transcript_budget,
        )
        selected_indexes = {transcript_indexes[index] for index in local_selected}
        selected_indexes.update(_select_auxiliary(note_indexes, sources, vectors, note_budget))
        selected_indexes.update(
            _select_auxiliary(attachment_indexes, sources, vectors, attachment_budget)
        )

    selected = tuple(sources[index] for index in sorted(selected_indexes))
    selected_types = {source.source_type for source in selected}
    expected_types = {source.source_type for source in sources}
    if selected_types != expected_types:
        raise SummaryEvidenceIncomplete("source_type_coverage_incomplete")
    selected_source_tokens = sum(source.token_cost for source in selected)
    if selected_source_tokens > source_token_budget:
        raise SummaryEvidenceIncomplete("evidence_budget_exceeded")
    coverage = {
        "total_segments": len(sources),
        "included_segments": len(selected),
        "topic_groups": topic_group_count,
        "covered_topic_groups": topic_group_count,
        "topic_coverage": 1.0,
        "raw_topic_groups": raw_topic_group_count,
        "compacted_topic_groups": topic_group_count,
        "forced_signal_segments": forced_signal_count,
        "included_forced_signal_segments": included_forced_signal_count,
        "source_types": sorted(expected_types),
        "included_source_types": sorted(selected_types),
        "source_coverage": round(len(selected) / max(1, len(sources)), 6),
        "used_embeddings": used_embeddings,
        "input_token_budget": input_token_budget,
        "estimated_input_tokens": 0,
    }
    provisional_payload = {
        "schema_version": 3,
        "source_fingerprint": fingerprint,
        "transcript_revision": transcript_revision,
        "coverage": coverage,
        "sources": [source.model_payload() for source in selected],
    }
    estimated_tokens = estimate_tokens(
        json.dumps(provisional_payload, ensure_ascii=False, separators=(",", ":"))
    )
    coverage["estimated_input_tokens"] = estimated_tokens
    if estimated_tokens > input_token_budget:
        raise SummaryEvidenceIncomplete("evidence_budget_exceeded")
    return EvidencePackage(
        sources=selected,
        source_fingerprint=fingerprint,
        transcript_revision=transcript_revision,
        coverage=coverage,
        estimated_tokens=estimated_tokens,
    )


def build_evidence_package(
    transcript_lines: list[dict[str, Any]],
    manual_note: dict[str, Any] | None,
    attachments: list[dict[str, Any]] | None,
    *,
    input_token_budget: int = INPUT_TOKEN_BUDGET,
) -> EvidencePackage:
    sources, fingerprint, transcript_revision = normalize_sources(
        transcript_lines,
        manual_note,
        attachments,
    )
    return build_evidence_package_from_sources(
        sources,
        source_fingerprint_value=fingerprint,
        transcript_revision=transcript_revision,
        input_token_budget=input_token_budget,
    )


def source_hash_matches(content: str, expected: str) -> bool:
    return _sha256(content) == expected.strip().lower()


def iter_source_text(sources: Iterable[EvidenceSource]) -> Iterable[str]:
    for source in sources:
        yield source.text
