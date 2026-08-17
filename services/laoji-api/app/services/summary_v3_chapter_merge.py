"""Deterministic bounded reducer for verified Meeting Facts V3 chapters."""

from __future__ import annotations

from collections import defaultdict
import hashlib
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.meeting_facts_v3 import (
    ActionCandidateV3,
    FactRelationV3,
    MeetingFactV3,
    MeetingFactsDocumentV3,
    OverviewV3,
    SourceReferenceV3,
)


CHECKPOINT_CONTRACT_REVISION = "meeting.facts.chapter-checkpoint.v1"
MAX_FACTS = 40
MAX_RELATIONS = 48
MAX_ACTIONS = 10

_SPACE = re.compile(r"\s+")
_FACT_TYPE_WEIGHT = {
    "action": 80,
    "conclusion": 75,
    "risk": 70,
    "question": 60,
    "timeline": 55,
    "topic": 50,
    "context": 40,
    "quote": 30,
}
_CERTAINTY_WEIGHT = {
    "confirmed": 15,
    "proposed": 8,
    "uncertain": 4,
    "negated": 2,
    "completed": 2,
}
_RELATION_WEIGHT = {
    "contradicts": 5,
    "depends_on": 4,
    "supports": 3,
    "precedes": 2,
    "alternative": 1,
}
_SCHEDULE_WEIGHT = {"high": 3, "medium": 2, "low": 1}


class FactsV3ChapterCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[3] = 3
    contract_revision: Literal["meeting.facts.chapter-checkpoint.v1"] = CHECKPOINT_CONTRACT_REVISION
    through_chapter_ordinal: int = Field(ge=0)
    facts_document: MeetingFactsDocumentV3
    fact_first_chapter: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_origins(self) -> "FactsV3ChapterCheckpoint":
        fact_ids = {fact.fact_id for fact in self.facts_document.facts}
        if set(self.fact_first_chapter) != fact_ids:
            raise ValueError("checkpoint_fact_origins_invalid")
        if any(value < 0 or value > self.through_chapter_ordinal for value in self.fact_first_chapter.values()):
            raise ValueError("checkpoint_fact_origin_range_invalid")
        return self


def _normalized(value: str) -> str:
    return _SPACE.sub("", value).casefold()


def _source_identity(source: SourceReferenceV3) -> tuple[str, str]:
    return source.source_id, source.content_hash


def _fact_digest(fact: MeetingFactV3) -> str:
    sources = sorted(
        f"{source.source_type}\0{source.source_id}\0{source.content_hash}\0{_normalized(source.quote)}"
        for source in fact.sources
    )
    material = "\0".join((fact.fact_type, _normalized(fact.content), *sources))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _stable_fact_id(fact: MeetingFactV3) -> str:
    return "f_" + _fact_digest(fact)[:20]


def _stable_action_id(action: ActionCandidateV3, fact_id: str) -> str:
    material = "\0".join(
        (
            fact_id,
            _normalized(action.content),
            _normalized(action.owner or ""),
            _normalized(action.due_text or ""),
        )
    )
    return "a_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]


def _fact_score(fact: MeetingFactV3) -> tuple[float, int, int]:
    return (
        float(_FACT_TYPE_WEIGHT[fact.fact_type])
        + float(_CERTAINTY_WEIGHT[fact.certainty])
        + fact.evidence_score * 20.0
        + len({_source_identity(source) for source in fact.sources}) * 2.0,
        len(fact.sources),
        -len(fact.content),
    )


def _merge_certainty(left: str, right: str) -> str:
    if left == right:
        return left
    terminal = {left, right}
    if "negated" in terminal or "completed" in terminal:
        return "uncertain"
    if terminal == {"confirmed", "proposed"}:
        return "confirmed"
    return "uncertain"


def _merge_fact(left: MeetingFactV3, right: MeetingFactV3) -> MeetingFactV3:
    sources: list[SourceReferenceV3] = []
    seen: set[tuple[str, str, str]] = set()
    for source in (*left.sources, *right.sources):
        key = (source.source_id, source.content_hash, _normalized(source.quote))
        if key in seen:
            continue
        seen.add(key)
        sources.append(source)
    preferred = max((left, right), key=lambda fact: (_fact_score(fact), -len(fact.content)))
    return MeetingFactV3(
        fact_id=preferred.fact_id,
        fact_type=preferred.fact_type,
        certainty=_merge_certainty(left.certainty, right.certainty),
        content=preferred.content,
        sources=sources[:3],
        evidence_score=max(left.evidence_score, right.evidence_score),
        conflict_group_id=left.conflict_group_id or right.conflict_group_id,
    )


def _same_fact(left: MeetingFactV3, right: MeetingFactV3) -> bool:
    if left.fact_type != right.fact_type or _normalized(left.content) != _normalized(right.content):
        return False
    left_sources = {_source_identity(source) for source in left.sources}
    right_sources = {_source_identity(source) for source in right.sources}
    return bool(left_sources & right_sources)


def _overview(facts: list[MeetingFactV3], origins: dict[str, int]) -> OverviewV3:
    ranked = sorted(
        facts,
        key=lambda fact: (
            -_fact_score(fact)[0],
            origins[fact.fact_id],
            fact.fact_id,
        ),
    )
    selected = ranked[: min(6, len(ranked))]
    selected_ids = [fact.fact_id for fact in selected]
    chronological = sorted(
        selected,
        key=lambda fact: (origins[fact.fact_id], fact.fact_id),
    )
    parts: list[str] = []
    length = 0
    for fact in chronological:
        separator = "；" if parts else ""
        remaining = 160 - length - len(separator)
        if remaining <= 0:
            break
        text = fact.content[:remaining]
        if text:
            parts.append(text)
            length += len(separator) + len(text)
    return OverviewV3(text="；".join(parts), fact_ids=selected_ids)


def _conflict_groups(
    facts: list[MeetingFactV3],
    relations: list[FactRelationV3],
) -> dict[str, str]:
    parents = {fact.fact_id: fact.fact_id for fact in facts}

    def find(value: str) -> str:
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    def union(left: str, right: str) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[max(left_root, right_root)] = min(left_root, right_root)

    for relation in relations:
        if relation.relation_type == "contradicts":
            union(relation.from_fact_id, relation.to_fact_id)
    grouped: dict[str, list[str]] = defaultdict(list)
    for fact_id in parents:
        grouped[find(fact_id)].append(fact_id)
    result: dict[str, str] = {}
    for members in grouped.values():
        if len(members) < 2:
            continue
        digest = hashlib.sha256("\0".join(sorted(members)).encode("ascii")).hexdigest()[:16]
        for fact_id in members:
            result[fact_id] = f"conflict:{digest}"
    return result


def merge_verified_chapter(
    current: FactsV3ChapterCheckpoint | dict[str, Any] | None,
    chapter: MeetingFactsDocumentV3 | dict[str, Any],
    *,
    chapter_ordinal: int,
) -> FactsV3ChapterCheckpoint:
    """Merge one verified chapter without another provider call.

    The reducer is intentionally semantic-policy-light: it validates states,
    exact provenance and bounded cardinality, but does not reject facts or
    actions by product-specific keywords.
    """
    if chapter_ordinal < 0:
        raise ValueError("chapter_ordinal_invalid")
    previous = (
        FactsV3ChapterCheckpoint.model_validate(current)
        if current is not None
        else None
    )
    chapter_document = MeetingFactsDocumentV3.model_validate(chapter)
    if previous is None:
        if chapter_ordinal != 0:
            raise ValueError("chapter_sequence_gap")
        old_document = None
    else:
        if chapter_ordinal != previous.through_chapter_ordinal + 1:
            raise ValueError("chapter_sequence_gap")
        old_document = previous.facts_document

    records: list[dict[str, Any]] = []
    old_index: dict[str, int] = {}
    new_index: dict[str, int] = {}
    if old_document is not None:
        for fact in old_document.facts:
            index = len(records)
            records.append({
                "fact": fact,
                "origin": previous.fact_first_chapter[fact.fact_id],
            })
            old_index[fact.fact_id] = index
    for fact in chapter_document.facts:
        match = next(
            (index for index, record in enumerate(records) if _same_fact(record["fact"], fact)),
            None,
        )
        if match is None:
            match = len(records)
            records.append({"fact": fact, "origin": chapter_ordinal})
        else:
            records[match]["fact"] = _merge_fact(records[match]["fact"], fact)
        new_index[fact.fact_id] = match

    ranked_indices = sorted(
        range(len(records)),
        key=lambda index: (
            -_fact_score(records[index]["fact"])[0],
            records[index]["origin"],
            _fact_digest(records[index]["fact"]),
        ),
    )[:MAX_FACTS]
    selected = set(ranked_indices)
    record_to_id: dict[int, str] = {}
    facts: list[MeetingFactV3] = []
    origins: dict[str, int] = {}
    for index in sorted(
        ranked_indices,
        key=lambda item: (records[item]["origin"], _fact_digest(records[item]["fact"])),
    ):
        fact = records[index]["fact"]
        stable_id = _stable_fact_id(fact)
        # A cryptographic collision is unrealistic; the deterministic suffix
        # keeps validation fail-closed even if crafted inputs force one.
        suffix = 1
        candidate_id = stable_id
        while candidate_id in origins:
            suffix += 1
            candidate_id = f"{stable_id[:58]}_{suffix}"
        stable_id = candidate_id
        record_to_id[index] = stable_id
        origins[stable_id] = int(records[index]["origin"])
        facts.append(fact.model_copy(update={"fact_id": stable_id, "conflict_group_id": None}))

    relation_candidates: list[tuple[int, FactRelationV3]] = []
    seen_relations: set[tuple[str, str, str]] = set()

    def add_relations(document: MeetingFactsDocumentV3 | None, mapping: dict[str, int]) -> None:
        if document is None:
            return
        for relation in document.relations:
            left_index = mapping.get(relation.from_fact_id)
            right_index = mapping.get(relation.to_fact_id)
            if left_index not in selected or right_index not in selected or left_index == right_index:
                continue
            left = record_to_id[left_index]
            right = record_to_id[right_index]
            key = (relation.relation_type, left, right)
            if key in seen_relations:
                continue
            seen_relations.add(key)
            relation_candidates.append((
                _RELATION_WEIGHT[relation.relation_type],
                FactRelationV3(
                    relation_type=relation.relation_type,
                    from_fact_id=left,
                    to_fact_id=right,
                ),
            ))

    add_relations(old_document, old_index)
    add_relations(chapter_document, new_index)
    relations = [
        relation
        for _, relation in sorted(
            relation_candidates,
            key=lambda item: (-item[0], item[1].from_fact_id, item[1].to_fact_id, item[1].relation_type),
        )[:MAX_RELATIONS]
    ]
    conflict_ids = _conflict_groups(facts, relations)
    facts = [
        fact.model_copy(update={"conflict_group_id": conflict_ids.get(fact.fact_id)})
        for fact in facts
    ]

    action_candidates: list[tuple[tuple[float, float, str], ActionCandidateV3]] = []
    seen_actions: set[tuple[str, str, str]] = set()

    def add_actions(document: MeetingFactsDocumentV3 | None, mapping: dict[str, int]) -> None:
        if document is None:
            return
        by_id = {fact.fact_id: fact for fact in document.facts}
        for action in document.action_candidates:
            index = mapping.get(action.fact_id)
            if index not in selected:
                continue
            source_fact = by_id.get(action.fact_id)
            if source_fact is None or source_fact.certainty in {"negated", "completed"}:
                continue
            target_fact_id = record_to_id[index]
            key = (
                _normalized(action.content),
                _normalized(action.owner or ""),
                _normalized(action.due_text or ""),
            )
            if key in seen_actions:
                continue
            seen_actions.add(key)
            stable_action = action.model_copy(update={
                "action_id": _stable_action_id(action, target_fact_id),
                "fact_id": target_fact_id,
            })
            action_candidates.append((
                (
                    float(_SCHEDULE_WEIGHT[action.schedule_fit]),
                    action.evidence_score,
                    stable_action.action_id,
                ),
                stable_action,
            ))

    add_actions(old_document, old_index)
    add_actions(chapter_document, new_index)
    actions = [
        action
        for _, action in sorted(
            action_candidates,
            key=lambda item: (-item[0][0], -item[0][1], item[0][2]),
        )[:MAX_ACTIONS]
    ]
    document = MeetingFactsDocumentV3(
        schema_version=3,
        overview=_overview(facts, origins),
        facts=facts,
        relations=relations,
        action_candidates=actions,
    )
    return FactsV3ChapterCheckpoint(
        schema_version=3,
        through_chapter_ordinal=chapter_ordinal,
        facts_document=document,
        fact_first_chapter=origins,
    )
