"""Task/Attempt adapter for bounded Meeting Facts V3 chapter processing."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
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
    normalize_transcript_evidence_sources,
)
from app.services.summary_v3_store import source_fingerprint


ARTIFACT_CONTRACT_REVISION = "meeting.facts.v3"
_SAFE_SOURCE_PART = re.compile(r"^[A-Za-z0-9._:-]{1,150}$")


class SummaryChapterOwnerContext(Protocol):
    device_id: str
    epoch_id: str


@dataclass(frozen=True)
class VerifiedSummaryChapter:
    document: MeetingFactsDocumentV3
    coverage: dict[str, Any]


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
    source_coverage = round(
        checkpoint.included_source_segments / max(1, checkpoint.total_source_segments),
        6,
    )
    topic_coverage = round(
        checkpoint.covered_topic_groups / max(1, checkpoint.topic_groups),
        6,
    )
    # ``task_id`` is intentionally allowed to carry a descriptive capability,
    # meeting identity, and generation identity.  Embedding that unbounded wire
    # identifier in ``document_id`` made the Android/server contract depend on
    # incidental task-name length (the first real device artifact was 161
    # characters while the mobile document contract allowed 160).  The
    # document identity is opaque, so derive a compact deterministic ID from
    # the same immutable task and source-manifest fence instead.
    document_identity = hashlib.sha256(
        f"{task['task_id']}\0{stream['source_manifest_sha256']}".encode("utf-8")
    ).hexdigest()
    return {
        "schema_version": 3,
        "contract_revision": ARTIFACT_CONTRACT_REVISION,
        "document_id": f"vnext:{document_identity}",
        "meeting_id": str(task["entity_id"]),
        "source_fingerprint": str(stream["source_manifest_sha256"]),
        "transcript_revision": str(task["input_sha256"]),
        "model_revision": provider_revision,
        "prompt_revision": handler_revision,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "coverage": {
            "total_segments": checkpoint.total_source_segments,
            "included_segments": checkpoint.included_source_segments,
            "topic_groups": checkpoint.topic_groups,
            "covered_topic_groups": checkpoint.covered_topic_groups,
            "topic_coverage": topic_coverage,
            "source_types": checkpoint.source_types or source_types,
            "included_source_types": checkpoint.included_source_types or source_types,
            "source_coverage": source_coverage,
            "used_embeddings": checkpoint.used_embeddings,
            "input_token_budget": checkpoint.input_token_budget,
            "estimated_input_tokens": checkpoint.estimated_input_tokens,
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
    transcript_items = [
        item
        for item in raw_items
        if str(item.get("source_type") or "") == "transcript"
    ]
    transcript_source_id_counts: dict[str, int] = {}
    for item in transcript_items:
        source_id = str(item.get("source_id") or "").strip()
        if source_id:
            transcript_source_id_counts[source_id] = (
                transcript_source_id_counts.get(source_id, 0) + 1
            )
    transcript_sources = normalize_transcript_evidence_sources([
        {
            # Prefer the mobile transcript row identity when it is unique, so
            # short evidence sources remain directly addressable by Android.
            # Generic source streams may use one recording-level source_id for
            # many byte ranges; those retain their unique immutable item_id.
            "id": (
                item.get("source_id")
                if transcript_source_id_counts.get(
                    str(item.get("source_id") or "").strip(),
                    0,
                ) == 1
                else item.get("item_id") or item.get("source_id")
            ),
            "text": item.get("content"),
            "start_ms": item.get("start_ms"),
            "end_ms": item.get("end_ms"),
            "speaker": item.get("speaker"),
        }
        for item in transcript_items
    ])
    sources: list[EvidenceSource] = list(transcript_sources)
    source_id_counts: dict[str, int] = {}
    for source in sources:
        source_id_counts[source.source_id] = source_id_counts.get(source.source_id, 0) + 1
    for item in raw_items:
        source_type = str(item.get("source_type") or "")
        if source_type not in {"transcript", "manual_note", "attachment"}:
            raise ValueError("summary_chapter_source_type_invalid")
        if source_type == "transcript":
            continue
        ordinal = len(sources)
        # Keep the public identity aligned with the immutable source owner so
        # a mobile citation can jump back to the original transcript row.
        # Revision/range/hash remain part of the source record and are still
        # checked by the source package and provider verifier. Duplicate IDs
        # (for example note chunks) receive a deterministic ordinal suffix.
        source_base = f"{source_type}:{_source_part(item.get('source_id'))}"
        duplicate_count = source_id_counts.get(source_base, 0)
        source_id_counts[source_base] = duplicate_count + 1
        source_id = source_base if duplicate_count == 0 else f"{source_base}:{duplicate_count}"
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
    identity = [
        {
            "source_id": source.source_id,
            "source_type": source.source_type,
            "content_hash": source.content_hash,
            "start_ms": source.start_ms,
            "end_ms": source.end_ms,
            "speaker": source.speaker,
        }
        for source in sources
    ]
    transcript_identity = identity[: len(transcript_sources)]
    fingerprint = source_fingerprint({"sources": identity})
    transcript_revision = source_fingerprint({
        "sources": transcript_identity or identity,
    })
    return build_evidence_package_from_sources(
        sources,
        source_fingerprint_value=fingerprint,
        transcript_revision=transcript_revision,
    )


def generate_verified_summary_chapter(chapter: dict[str, Any]) -> VerifiedSummaryChapter:
    """Run the selected Facts V3 provider once and verify exact chapter citations."""
    from app.services.summary_v3_generator import (
        generate_model_response,
        verify_model_response,
    )

    package = build_chapter_evidence_package(chapter)
    response, _model_calls = generate_model_response(package)
    return VerifiedSummaryChapter(
        document=verify_model_response(response, package),
        coverage=dict(package.coverage),
    )


def _fallback_chapter_coverage(chapter: dict[str, Any]) -> dict[str, Any]:
    items = chapter.get("items") if isinstance(chapter.get("items"), list) else []
    source_types = sorted({
        str(item.get("source_type"))
        for item in items
        if isinstance(item, dict)
        and str(item.get("source_type")) in {"transcript", "manual_note", "attachment"}
    })
    topic_groups = 1 if any(
        isinstance(item, dict) and item.get("source_type") == "transcript"
        for item in items
    ) else 0
    return {
        "total_segments": len(items),
        "included_segments": len(items),
        "topic_groups": topic_groups,
        "covered_topic_groups": topic_groups,
        "source_types": source_types,
        "included_source_types": source_types,
        "used_embeddings": False,
        "input_token_budget": 10_240,
        "estimated_input_tokens": 0,
    }


def process_next_summary_chapter(
    context: SummaryChapterOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    handler_revision: str,
    provider_revision: str,
    generate_verified_chapter: Callable[
        [dict[str, Any]],
        VerifiedSummaryChapter | MeetingFactsDocumentV3 | dict[str, Any],
    ],
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
    generated_value = generate_verified_chapter(chapter)
    if isinstance(generated_value, VerifiedSummaryChapter):
        generated = generated_value.document
        chapter_coverage = generated_value.coverage
    else:
        generated = MeetingFactsDocumentV3.model_validate(generated_value)
        chapter_coverage = _fallback_chapter_coverage(chapter)
    checkpoint = merge_verified_chapter(
        current,
        generated,
        chapter_ordinal=int(chapter["chapter_ordinal"]),
        chapter_coverage=chapter_coverage,
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
