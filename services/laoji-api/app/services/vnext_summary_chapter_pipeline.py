"""Task/Attempt adapter for bounded Meeting Facts V3 chapter processing."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import re
from typing import Any, Protocol

from app.schemas.meeting_facts_v3 import MeetingFactsDocumentV3
from app.services import vnext_source_stream_store, vnext_task_store
from app.services.summary_v3_chapter_merge import (
    CHECKPOINT_CONTRACT_REVISION,
    FactsV3ChapterCheckpoint,
    merge_verified_chapter,
)
from app.services.summary_v3_evidence import (
    EvidencePackage,
    EvidenceSource,
    build_evidence_package_from_sources,
)
from app.services.summary_v3_store import source_fingerprint


ARTIFACT_CONTRACT_REVISION = "meeting.facts.v3"
_SAFE_SOURCE_PART = re.compile(r"^[A-Za-z0-9._:-]{1,150}$")


class SummaryChapterOwnerContext(Protocol):
    device_id: str
    epoch_id: str


def _artifact(
    checkpoint: FactsV3ChapterCheckpoint,
    *,
    task: dict[str, Any],
    stream: dict[str, Any],
    handler_revision: str,
    provider_revision: str,
) -> dict[str, Any]:
    source_types = sorted({
        source.source_type
        for fact in checkpoint.facts_document.facts
        for source in fact.sources
    })
    fact_count = len(checkpoint.facts_document.facts)
    return {
        "schema_version": 3,
        "contract_revision": ARTIFACT_CONTRACT_REVISION,
        "document_id": f"vnext:{task['task_id']}:{stream['source_manifest_sha256']}",
        "meeting_id": str(task["entity_id"]),
        "source_fingerprint": str(stream["source_manifest_sha256"]),
        "transcript_revision": str(task["input_sha256"]),
        "model_revision": provider_revision,
        "prompt_revision": handler_revision,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "coverage": {
            "total_segments": fact_count,
            "included_segments": fact_count,
            "topic_groups": fact_count,
            "covered_topic_groups": fact_count,
            "topic_coverage": 1.0,
            "source_types": source_types,
            "included_source_types": source_types,
            "source_coverage": 1.0,
            "used_embeddings": False,
            "input_token_budget": 10240,
            "estimated_input_tokens": 0,
        },
        "through_chapter_ordinal": checkpoint.through_chapter_ordinal,
        "facts_document": checkpoint.facts_document.model_dump(mode="json"),
        "fact_first_chapter": dict(checkpoint.fact_first_chapter),
    }


def _source_part(value: object) -> str:
    normalized = str(value or "").strip()
    if _SAFE_SOURCE_PART.fullmatch(normalized):
        return normalized
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def build_chapter_evidence_package(chapter: dict[str, Any]) -> EvidencePackage:
    """Restore exact immutable source identity from one decrypted chapter."""
    raw_items = chapter.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("summary_chapter_sources_empty")
    sources: list[EvidenceSource] = []
    identity: list[dict[str, Any]] = []
    transcript_identity: list[dict[str, Any]] = []
    for ordinal, item in enumerate(raw_items):
        source_type = str(item.get("source_type") or "")
        if source_type not in {"transcript", "manual_note", "attachment"}:
            raise ValueError("summary_chapter_source_type_invalid")
        source_id = (
            f"{source_type}:"
            f"{_source_part(item.get('source_id'))}:"
            f"{_source_part(item.get('source_revision_id'))}:"
            f"{int(item.get('source_start_utf8') or 0)}-"
            f"{int(item.get('source_end_utf8') or 0)}"
        )
        if len(source_id) > 190:
            source_id = f"{source_type}:" + hashlib.sha256(source_id.encode("utf-8")).hexdigest()
        content_hash = str(item.get("content_sha256") or "")
        content = str(item.get("content") or "")
        model_prefix = {"transcript": "t", "manual_note": "n", "attachment": "a"}[source_type]
        source = EvidenceSource(
            source_id=source_id,
            source_type=source_type,
            text=content,
            content_hash=content_hash,
            start_ms=item.get("start_ms"),
            end_ms=item.get("end_ms"),
            ordinal=ordinal,
            speaker=str(item.get("speaker") or "").strip() or None,
            parent_id=f"{source_type}:{_source_part(item.get('source_id'))}",
            model_source_id=f"{source_type}:{model_prefix}{ordinal:x}",
        )
        sources.append(source)
        source_identity = {
            "source_id": source.source_id,
            "source_type": source.source_type,
            "content_hash": source.content_hash,
            "start_ms": source.start_ms,
            "end_ms": source.end_ms,
            "speaker": source.speaker,
        }
        identity.append(source_identity)
        if source_type == "transcript":
            transcript_identity.append(source_identity)
    fingerprint = source_fingerprint({"sources": identity})
    transcript_revision = source_fingerprint({
        "sources": transcript_identity or identity,
    })
    return build_evidence_package_from_sources(
        sources,
        source_fingerprint_value=fingerprint,
        transcript_revision=transcript_revision,
    )


def generate_verified_summary_chapter(chapter: dict[str, Any]) -> MeetingFactsDocumentV3:
    """Run the selected Facts V3 provider once and verify exact chapter citations."""
    from app.services.summary_v3_generator import (
        generate_model_response,
        verify_model_response,
    )

    package = build_chapter_evidence_package(chapter)
    response, _model_calls = generate_model_response(package)
    return verify_model_response(response, package)


def process_next_summary_chapter(
    context: SummaryChapterOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    handler_revision: str,
    provider_revision: str,
    generate_verified_chapter: Callable[[dict[str, Any]], MeetingFactsDocumentV3 | dict[str, Any]],
) -> dict[str, Any]:
    """Process at most one chapter, yielding naturally to higher-priority work.

    ``generate_verified_chapter`` is the versioned provider adapter boundary.
    The adapter must return a server-verified Facts V3 document; this function
    never accepts raw model JSON and never performs a second template call.
    """
    chapter = vnext_source_stream_store.load_next_chapter(
        context,
        task_id,
        attempt_id=attempt_id,
        lease_owner=lease_owner,
    )
    if chapter is None:
        task = vnext_task_store.get_task(context, task_id)
        stream = (
            vnext_source_stream_store.get_source_stream(
                context,
                str(task["source_stream_id"]),
            )
            if task is not None and task.get("source_stream_id")
            else None
        )
        if stream is None or stream["state"] != "complete":
            return {"state": "awaiting_source", "task_id": task_id}
        stream_task = vnext_source_stream_store.load_current_checkpoint(
            context,
            task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
        )
        if stream_task is None:
            raise vnext_source_stream_store.VNextSourceStreamError(
                "CHECKPOINT_INCOMPLETE",
                "整理恢复点尚未覆盖全部来源",
                409,
            )
        checkpoint = FactsV3ChapterCheckpoint.model_validate(stream_task["aggregate"])
        artifact = vnext_source_stream_store.commit_checkpoint_artifact(
            context,
            task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            artifact=_artifact(
                checkpoint,
                task=task,
                stream=stream,
                handler_revision=handler_revision,
                provider_revision=provider_revision,
            ),
            contract_revision=ARTIFACT_CONTRACT_REVISION,
            provider_revision=provider_revision,
        )
        return {"state": "success", "task_id": task_id, "artifact": artifact}

    current = (
        FactsV3ChapterCheckpoint.model_validate(chapter["current_aggregate"])
        if chapter["current_aggregate"] is not None
        else None
    )
    generated = MeetingFactsDocumentV3.model_validate(generate_verified_chapter(chapter))
    checkpoint = merge_verified_chapter(
        current,
        generated,
        chapter_ordinal=int(chapter["chapter_ordinal"]),
    )
    promoted = vnext_source_stream_store.promote_checkpoint(
        context,
        task_id,
        attempt_id=attempt_id,
        lease_owner=lease_owner,
        chapter_ordinal=int(chapter["chapter_ordinal"]),
        aggregate=checkpoint.model_dump(mode="json"),
        handler_revision=handler_revision,
        provider_revision=provider_revision,
    )
    if promoted["stream_state"] != "complete":
        return {
            "state": "chapter_committed",
            "task_id": task_id,
            "through_chapter_ordinal": checkpoint.through_chapter_ordinal,
            "checkpoint_contract_revision": CHECKPOINT_CONTRACT_REVISION,
        }
    task = vnext_task_store.get_task(context, task_id)
    stream = vnext_source_stream_store.get_source_stream(context, str(chapter["stream_id"]))
    if task is None or stream is None:
        raise vnext_source_stream_store.VNextSourceStreamError(
            "SOURCE_STREAM_NOT_FOUND",
            "整理来源流不存在",
            404,
        )
    artifact = vnext_source_stream_store.commit_checkpoint_artifact(
        context,
        task_id,
        attempt_id=attempt_id,
        lease_owner=lease_owner,
        artifact=_artifact(
            checkpoint,
            task=task,
            stream=stream,
            handler_revision=handler_revision,
            provider_revision=provider_revision,
        ),
        contract_revision=ARTIFACT_CONTRACT_REVISION,
        provider_revision=provider_revision,
    )
    return {"state": "success", "task_id": task_id, "artifact": artifact}
