"""Small, provider-neutral vNext contracts shared by the mobile and API layers.

These models describe identity, source attribution, task attempts, projections and
the schedule graph. They do not own database state or perform parsing.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Sha256 = str


class VNextModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class EntityRevision(VNextModel):
    device_epoch: str = Field(min_length=8, max_length=160)
    entity_id: str = Field(min_length=1, max_length=180)
    revision: int = Field(ge=1)
    content_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class SourceRef(VNextModel):
    source_type: Literal["transcript", "manual_note", "attachment"]
    stable_id: str = Field(min_length=1, max_length=180)
    revision: int = Field(ge=1)
    content_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    start_utf8: int = Field(ge=0)
    end_utf8: int = Field(ge=0)
    quote: str = Field(min_length=1, max_length=600)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_ranges(self) -> "SourceRef":
        if self.end_utf8 < self.start_utf8:
            raise ValueError("source_utf8_range_invalid")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("source_time_range_invalid")
        return self


class TaskAttempt(VNextModel):
    task_id: str = Field(min_length=1, max_length=180)
    attempt_id: str = Field(min_length=1, max_length=180)
    attempt_number: int = Field(ge=1, le=3)
    state: Literal[
        "queued",
        "running",
        "succeeded",
        "retryable_failure",
        "terminal_failure",
        "cancelled",
        "lease_expired",
    ]
    phase: Literal["queued", "admitted", "running", "committing"]
    lease_generation: int = Field(ge=1)
    client_request_id: str = Field(min_length=8, max_length=160)
    generation_id: str = Field(min_length=8, max_length=160)
    cancel_revision: int = Field(ge=0)
    provider_request_id: str | None = Field(default=None, max_length=180)


class ProjectionEnvelope(VNextModel):
    device_epoch: str = Field(min_length=8, max_length=160)
    entity_id: str = Field(min_length=1, max_length=180)
    entity_revision: int = Field(ge=1)
    view_revision: int = Field(ge=1)
    surface_instance_id: str = Field(min_length=1, max_length=180)
    payload_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    payload: dict[str, Any]


class ScheduleGraphSource(VNextModel):
    text: str = Field(min_length=1, max_length=2000)
    mode: Literal["text", "audio_transcript"]
    reference_datetime: datetime
    timezone: str = Field(min_length=1, max_length=64)


class ScheduleGraphSlots(VNextModel):
    title: str | None = Field(default=None, max_length=100)
    start_date: str | None = Field(default=None, max_length=32)
    end_date: str | None = Field(default=None, max_length=32)
    start_time: str | None = Field(default=None, max_length=16)
    end_time: str | None = Field(default=None, max_length=16)
    time_period: Literal["early_morning", "morning", "noon", "afternoon", "evening", "night"] | None = None
    event_type: str = Field(default="once", max_length=32)
    location: str | None = Field(default=None, max_length=100)
    recurrence: dict[str, Any] | None = None
    reminder: dict[str, Any] | None = None


class ScheduleMentionSpan(VNextModel):
    text: str = Field(min_length=1, max_length=200)
    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_span(self) -> "ScheduleMentionSpan":
        if self.end < self.start:
            raise ValueError("schedule_span_invalid")
        return self


class ScheduleGraphProvenance(VNextModel):
    engine: Literal["mobile-local", "server-model", "recognizers"]
    engine_revision: str = Field(min_length=1, max_length=120)
    producer_revision: str = Field(min_length=1, max_length=120)
    draft_revision: int = Field(ge=1)
    parent_revision: int | None = Field(default=None, ge=1)


class ScheduleMentionGraph(VNextModel):
    schema_version: Literal[1] = 1
    source: ScheduleGraphSource
    source_id: str = Field(min_length=8, max_length=180)
    intent: Literal["create", "query", "delete", "clarify", "reject", "context_edit"]
    route: Literal["local_safe", "server_required", "preflight", "clarify", "operation", "reject"]
    slots: ScheduleGraphSlots
    state: Literal["complete", "needs_clarification", "operation", "reject", "incomplete"]
    missing: list[str] = Field(default_factory=list, max_length=12)
    spans: dict[str, list[ScheduleMentionSpan]] = Field(default_factory=dict)
    provenance: ScheduleGraphProvenance


class ScheduleDraft(VNextModel):
    schema_version: Literal[1] = 1
    draft_id: str = Field(min_length=8, max_length=180)
    graph_revision: int = Field(ge=1)
    state: Literal["complete", "needs_clarification", "operation", "reject", "incomplete"]
    slots: ScheduleGraphSlots
    missing: list[str] = Field(default_factory=list, max_length=12)
    source_id: str = Field(min_length=8, max_length=180)
    graph_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
