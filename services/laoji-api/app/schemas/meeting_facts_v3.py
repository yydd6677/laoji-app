"""Typed protocol for LaoJi meeting fact generation v3."""

from __future__ import annotations

from copy import deepcopy
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SCHEMA_VERSION = 3
PROMPT_REVISION = "facts-v3-r5"

FactId = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
Sha256 = Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]
SourceId = Annotated[
    str,
    Field(pattern=r"^(?:transcript|manual_note|attachment):[A-Za-z0-9._:-]{1,180}$"),
]

FactType = Literal[
    "topic",
    "context",
    "conclusion",
    "action",
    "risk",
    "question",
    "quote",
    "timeline",
]
Certainty = Literal["confirmed", "proposed", "uncertain", "negated", "completed"]
SourceType = Literal["transcript", "manual_note", "attachment"]
RelationType = Literal[
    "supports",
    "contradicts",
    "precedes",
    "depends_on",
    "alternative",
]
ScheduleFit = Literal["high", "medium", "low"]

_HTML_TAG = re.compile(r"<\s*/?\s*[A-Za-z][^>]*>")
_MARKDOWN_BLOCK = re.compile(
    r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)",
)
_MARKDOWN_INLINE = re.compile(
    r"(?:!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)|"
    r"`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__)",
)
_PRESENTATION_CODE = re.compile(
    r"[\{,]\s*[\"'](?:icon|color|fill|stroke|x|y|nodes|edges|coordinates)[\"']\s*:",
    re.IGNORECASE,
)


def _plain_text(value: str) -> str:
    normalized = value.strip()
    lowered = normalized.lower()
    forbidden = (
        "```",
        "~~~",
        "<svg",
        "</svg",
        "<html",
        "</html",
        "<script",
        "</script",
        "![",
        "fill=",
        "stroke=",
    )
    if (
        any(marker in lowered for marker in forbidden)
        or _HTML_TAG.search(normalized)
        or _MARKDOWN_BLOCK.search(normalized)
        or _MARKDOWN_INLINE.search(normalized)
        or _PRESENTATION_CODE.search(normalized)
    ):
        raise ValueError("rich_markup_not_allowed")
    return normalized


class V3Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class OverviewV3(V3Model):
    text: str = Field(min_length=1, max_length=160)
    fact_ids: list[FactId] = Field(min_length=1, max_length=12)

    _validate_text = field_validator("text")(_plain_text)


class ModelSourceReferenceV3(V3Model):
    source_id: SourceId
    source_type: SourceType
    quote: str = Field(min_length=1, max_length=600)
    # The model uses a compact per-request alias. The server resolves that
    # alias and restores the canonical source id/hash after quote validation.
    content_hash: Sha256 | None = None

    _validate_quote = field_validator("quote")(_plain_text)


class SourceReferenceV3(ModelSourceReferenceV3):
    content_hash: Sha256
    start_ms: int | None = Field(default=None, ge=0, le=604_800_000)
    end_ms: int | None = Field(default=None, ge=0, le=604_800_000)
    speaker: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def validate_time_range(self) -> "SourceReferenceV3":
        if self.start_ms is not None and self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("source_time_range_invalid")
        return self


class ModelFactV3(V3Model):
    fact_id: FactId
    fact_type: FactType
    certainty: Certainty
    content: str = Field(min_length=1, max_length=500)
    sources: list[ModelSourceReferenceV3] = Field(min_length=1, max_length=3)

    _validate_content = field_validator("content")(_plain_text)


class MeetingFactV3(V3Model):
    fact_id: FactId
    fact_type: FactType
    certainty: Certainty
    content: str = Field(min_length=1, max_length=500)
    sources: list[SourceReferenceV3] = Field(min_length=1, max_length=3)
    evidence_score: float = Field(ge=0, le=1)
    conflict_group_id: str | None = Field(
        default=None,
        pattern=r"^conflict:[0-9a-f]{16}$",
    )

    _validate_content = field_validator("content")(_plain_text)


class FactRelationV3(V3Model):
    relation_type: RelationType
    from_fact_id: FactId
    to_fact_id: FactId

    @model_validator(mode="after")
    def reject_self_relation(self) -> "FactRelationV3":
        if self.from_fact_id == self.to_fact_id:
            raise ValueError("fact_relation_self_reference")
        return self


class ModelActionCandidateV3(V3Model):
    action_id: FactId
    fact_id: FactId
    content: str = Field(min_length=1, max_length=300)
    owner: str | None = Field(default=None, max_length=80)
    due_text: str | None = Field(default=None, max_length=120)
    schedule_fit: ScheduleFit

    _validate_content = field_validator("content")(_plain_text)
    _validate_owner = field_validator("owner")(
        lambda value: _plain_text(value) if value is not None else None
    )
    _validate_due = field_validator("due_text")(
        lambda value: _plain_text(value) if value is not None else None
    )


class ActionCandidateV3(ModelActionCandidateV3):
    evidence_score: float = Field(ge=0, le=1)


class MeetingFactsModelResponseV3(V3Model):
    """The exact object generated by the model before deterministic verification."""

    schema_version: Literal[3] = SCHEMA_VERSION
    overview: OverviewV3
    facts: list[ModelFactV3] = Field(min_length=1, max_length=40)
    relations: list[FactRelationV3] = Field(default_factory=list, max_length=48)
    action_candidates: list[ModelActionCandidateV3] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_references(self) -> "MeetingFactsModelResponseV3":
        fact_ids = [fact.fact_id for fact in self.facts]
        if len(set(fact_ids)) != len(fact_ids):
            raise ValueError("fact_ids_not_unique")
        known = set(fact_ids)
        if not set(self.overview.fact_ids).issubset(known):
            raise ValueError("overview_fact_reference_invalid")
        for relation in self.relations:
            if relation.from_fact_id not in known or relation.to_fact_id not in known:
                raise ValueError("relation_fact_reference_invalid")
        action_ids: set[str] = set()
        for action in self.action_candidates:
            if action.fact_id not in known:
                raise ValueError("action_fact_reference_invalid")
            if action.action_id in action_ids:
                raise ValueError("action_ids_not_unique")
            action_ids.add(action.action_id)
        return self


class MeetingFactsDocumentV3(V3Model):
    """Verified, immutable fact document returned to LaoJi clients."""

    schema_version: Literal[3] = SCHEMA_VERSION
    overview: OverviewV3
    facts: list[MeetingFactV3] = Field(min_length=1, max_length=40)
    relations: list[FactRelationV3] = Field(default_factory=list, max_length=48)
    action_candidates: list[ActionCandidateV3] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_references(self) -> "MeetingFactsDocumentV3":
        fact_ids = [fact.fact_id for fact in self.facts]
        if len(set(fact_ids)) != len(fact_ids):
            raise ValueError("fact_ids_not_unique")
        known = set(fact_ids)
        if not set(self.overview.fact_ids).issubset(known):
            raise ValueError("overview_fact_reference_invalid")
        for relation in self.relations:
            if relation.from_fact_id not in known or relation.to_fact_id not in known:
                raise ValueError("relation_fact_reference_invalid")
        for action in self.action_candidates:
            if action.fact_id not in known:
                raise ValueError("action_fact_reference_invalid")
        return self


def model_response_json_schema() -> dict:
    """Return the detailed schema accepted by Ollama's structured-output API."""
    root = MeetingFactsModelResponseV3.model_json_schema()
    definitions = root.get("$defs") if isinstance(root.get("$defs"), dict) else {}

    def inline(value: object) -> object:
        if isinstance(value, list):
            return [inline(item) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference.removeprefix("#/$defs/")
            target = definitions.get(name)
            if not isinstance(target, dict):
                raise ValueError("summary_v3_schema_reference_invalid")
            merged = deepcopy(target)
            merged.update({key: item for key, item in value.items() if key != "$ref"})
            return inline(merged)
        # Titles, descriptions and defaults do not change validation. Removing
        # them keeps the complete schema inside the reserved protocol budget;
        # the inlined form otherwise repeats Pydantic presentation metadata for
        # every nested object.
        return {
            key: inline(item)
            for key, item in value.items()
            if key not in {"$defs", "title", "description", "default"}
        }

    inlined = inline(root)
    if not isinstance(inlined, dict):
        raise ValueError("summary_v3_schema_invalid")
    return inlined
