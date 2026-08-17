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


class SourceManifestDescriptorV2(VNextModel):
    chapter_ordinal: int = Field(ge=0, le=9_007_199_254_740_991)
    declared_bundle_count: int = Field(ge=1, le=8)
    declared_item_count: int = Field(ge=1, le=50_000)
    declared_uncompressed_bytes: int = Field(ge=1, le=128 * 1024 * 1024)
    chapter_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class SourceBundleItemV2(VNextModel):
    item_id: str = Field(min_length=8, max_length=180)
    source_type: Literal["transcript", "manual_note", "attachment"]
    source_id: str = Field(min_length=1, max_length=180)
    source_revision_id: str = Field(min_length=1, max_length=180)
    source_start_utf8: int = Field(ge=0, le=9_007_199_254_740_991)
    source_end_utf8: int = Field(ge=0, le=9_007_199_254_740_991)
    content_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    content: str = Field(min_length=1, max_length=16 * 1024 * 1024)
    start_ms: int | None = Field(default=None, ge=0, le=604_800_000)
    end_ms: int | None = Field(default=None, ge=0, le=604_800_000)
    speaker: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def validate_source_range(self) -> "SourceBundleItemV2":
        if self.source_end_utf8 < self.source_start_utf8:
            raise ValueError("source_utf8_range_invalid")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("source_time_range_invalid")
        return self


class SourceStreamSnapshotV2(VNextModel):
    schema_version: Literal[2] = 2
    contract_revision: Literal["source.stream.v2"] = "source.stream.v2"
    stream_id: str = Field(min_length=8, max_length=180)
    task_id: str = Field(min_length=8, max_length=512)
    binding_id: str = Field(min_length=8, max_length=180)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    cancel_revision: int = Field(ge=0, le=9_007_199_254_740_991)
    client_operation_id: str = Field(min_length=8, max_length=180)
    generation_id: str = Field(min_length=8, max_length=512)
    state: Literal["open", "consuming", "complete", "cancelled", "expired"]
    next_manifest_page: int = Field(ge=0)
    next_manifest_chapter: int = Field(ge=0)
    next_consumable_chapter: int = Field(ge=0)
    final_chapter_count: int | None = Field(default=None, ge=1)
    source_manifest_sha256: Sha256 | None = Field(
        default=None,
        pattern=r"^sha256:[0-9a-f]{64}$",
    )
    checkpoint_through_chapter: int | None = Field(default=None, ge=0)
    expires_at: int = Field(ge=0)


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


class UploadPartReceipt(VNextModel):
    part_number: int = Field(ge=1, le=10_000)
    etag: str = Field(min_length=1, max_length=512)


class UploadSession(VNextModel):
    schema_version: Literal[2] = 2
    session_id: str = Field(min_length=8, max_length=180)
    binding_id: str = Field(min_length=8, max_length=180)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1)
    cancel_revision: int = Field(ge=0)
    client_operation_id: str = Field(min_length=8, max_length=180)
    asset_id: str = Field(min_length=1, max_length=180)
    asset_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_size: int = Field(ge=1, le=1024 * 1024 * 1024)
    expected_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    mime_type: str = Field(min_length=1, max_length=160)
    mode: Literal["single", "multipart"]
    part_size: int = Field(ge=5 * 1024 * 1024)
    total_parts: int = Field(ge=1, le=10_000)
    state: Literal[
        "provisioning", "active", "completing", "verified",
        "cleanup_pending", "cancelled", "expired",
    ]
    expires_at: int = Field(ge=0)
    verified_asset_id: str | None = Field(default=None, max_length=180)
    transcription_task_id: str | None = Field(default=None, max_length=180)
    put_url: str | None = Field(default=None, max_length=4096)
    object_completed: bool = False
    uploaded_parts: list[UploadPartReceipt] = Field(default_factory=list, max_length=10_000)


class AsrBatchItemV2(VNextModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    pcm_base64: str = Field(min_length=1, max_length=12 * 1024 * 1024)
    sample_rate: Literal[16000] = 16000
    language: str | None = Field(default="Chinese", max_length=64)
    source_start_ms: int = Field(ge=0)
    source_end_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_source_range(self) -> "AsrBatchItemV2":
        if self.source_end_ms < self.source_start_ms:
            raise ValueError("asr_source_range_invalid")
        return self


class AsrBatchRequestV2(VNextModel):
    schema_version: Literal[2]
    contract_revision: Literal["asr.batch.v2"]
    priority: Literal["realtime", "schedule", "offline"]
    items: list[AsrBatchItemV2] = Field(min_length=1, max_length=8)


class AsrBatchResultItemV2(VNextModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    stable_segment_key: str = Field(min_length=1, max_length=180)
    segment_revision: int = Field(ge=1)
    text_state: Literal["stable"] = "stable"
    outcome: Literal["text", "no_speech"]
    text: str = Field(max_length=20_000)
    language: str | None = Field(default=None, max_length=64)
    source_start_ms: int = Field(ge=0)
    source_end_ms: int = Field(ge=0)
    audio_ms: int = Field(ge=0)
    model_revision: str = Field(min_length=1, max_length=180)
    queue_ms: int = Field(ge=0)
    infer_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_result(self) -> "AsrBatchResultItemV2":
        if self.source_end_ms < self.source_start_ms:
            raise ValueError("asr_source_range_invalid")
        if (self.outcome == "no_speech") != (not self.text.strip()):
            raise ValueError("asr_outcome_text_mismatch")
        return self


class AsrBatchResponseV2(VNextModel):
    schema_version: Literal[2] = 2
    contract_revision: Literal["asr.batch.v2"] = "asr.batch.v2"
    model: str = Field(min_length=1, max_length=240)
    model_revision: str = Field(min_length=1, max_length=180)
    priority: Literal["realtime", "schedule", "offline"]
    queue_ms: int = Field(ge=0)
    infer_ms: int = Field(ge=0)
    items: list[AsrBatchResultItemV2] = Field(min_length=1, max_length=8)


class TranscriptStreamEventV2(VNextModel):
    schema_version: Literal[2] = 2
    contract_revision: Literal["transcript.stream.v2"] = "transcript.stream.v2"
    session_id: str = Field(min_length=8, max_length=180)
    event_sequence: int = Field(ge=0)
    event_kind: Literal["partial", "stable", "final"]
    stable_segment_key: str | None = Field(default=None, max_length=180)
    segment_revision: int = Field(ge=1)
    text_state: Literal["partial", "stable", "final"]
    outcome: Literal["text", "no_speech"]
    text: str = Field(max_length=20_000)
    source_start_ms: int = Field(ge=0)
    source_end_ms: int = Field(ge=0)
    model_revision: str = Field(min_length=1, max_length=180)

    @model_validator(mode="after")
    def validate_event(self) -> "TranscriptStreamEventV2":
        if self.text_state != self.event_kind:
            raise ValueError("transcript_event_state_mismatch")
        if self.source_end_ms < self.source_start_ms:
            raise ValueError("transcript_event_range_invalid")
        if self.event_kind != "final" and not self.stable_segment_key:
            raise ValueError("transcript_segment_key_required")
        if self.event_kind == "partial" and self.event_sequence != 0:
            raise ValueError("transcript_partial_not_durable")
        if self.event_kind != "partial" and self.event_sequence < 1:
            raise ValueError("transcript_durable_sequence_required")
        if self.event_kind == "partial" and (
            self.outcome != "text" or not self.text.strip()
        ):
            raise ValueError("transcript_partial_content_required")
        if self.event_kind == "stable" and (
            (self.outcome == "no_speech") != (not self.text.strip())
        ):
            raise ValueError("transcript_outcome_text_mismatch")
        if self.event_kind == "final" and self.outcome == "no_speech" and self.text.strip():
            raise ValueError("transcript_no_speech_text_mismatch")
        return self


class RealtimeChunkHeaderV2(VNextModel):
    schema_version: Literal[2]
    contract_revision: Literal["realtime.chunk.v2"]
    type: Literal["audio.chunk"]
    chunk_seq: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    content_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_chunk_range(self) -> "RealtimeChunkHeaderV2":
        if self.end_ms < self.start_ms:
            raise ValueError("realtime_chunk_range_invalid")
        return self


class SpeakerOverlayAssignmentV2(VNextModel):
    stable_segment_key: str = Field(min_length=1, max_length=180)
    automatic_label: str | None = Field(default=None, max_length=120)
    speaker_cluster_id: str | None = Field(default=None, max_length=180)
    speaker_profile_id: str | None = Field(default=None, max_length=180)
    confidence: float | None = Field(default=None, ge=0, le=1)


class SpeakerOverlayDocumentV2(VNextModel):
    overlay_revision: int = Field(ge=1)
    source_manifest_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    profile_manifest_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    model_revision: str = Field(min_length=1, max_length=180)
    output_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    activated_at: str | None = Field(default=None, max_length=80)
    assignments: list[SpeakerOverlayAssignmentV2] = Field(max_length=20_000)


class SpeakerOverlaySnapshotV2(VNextModel):
    schema_version: Literal[2] = 2
    contract_revision: Literal["speaker.overlay.v2"] = "speaker.overlay.v2"
    session_id: str = Field(min_length=8, max_length=180)
    state: Literal[
        "collecting", "queued", "running", "succeeded", "no_content", "failed", "cancelled",
    ]
    task_id: str | None = Field(default=None, max_length=512)
    error_code: str | None = Field(default=None, max_length=160)
    overlay: SpeakerOverlayDocumentV2 | None = None


class ScheduleGraphSource(VNextModel):
    text: str = Field(min_length=1, max_length=2000)
    content_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
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


class ScheduleGraphRequestV1(VNextModel):
    schema_version: Literal[1] = 1
    text: str = Field(min_length=1, max_length=2000)
    reference_datetime: datetime
    timezone: str = Field(min_length=1, max_length=64)
    source_id: str | None = Field(default=None, min_length=8, max_length=180)
    client_request_id: str = Field(min_length=8, max_length=180)


class ScheduleGraphClarificationRequestV1(VNextModel):
    schema_version: Literal[1] = 1
    graph: ScheduleMentionGraph
    answer: str = Field(min_length=1, max_length=1000)
    client_request_id: str = Field(min_length=8, max_length=180)


class ScheduleDraft(VNextModel):
    schema_version: Literal[1] = 1
    draft_id: str = Field(min_length=8, max_length=180)
    graph_revision: int = Field(ge=1)
    state: Literal["complete", "needs_clarification", "operation", "reject", "incomplete"]
    slots: ScheduleGraphSlots
    missing: list[str] = Field(default_factory=list, max_length=12)
    source_id: str = Field(min_length=8, max_length=180)
    graph_sha256: Sha256 = Field(pattern=r"^sha256:[0-9a-f]{64}$")
