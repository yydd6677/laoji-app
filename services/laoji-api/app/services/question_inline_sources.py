"""Batch transport into the existing encrypted, resumable Q2 source owner.

This removes HTTP round trips, not Task checkpoints or privacy boundaries.
The deterministic layout is identical to the mobile multipart uploader, so an
interrupted preparation can resume through either transport.
"""
from __future__ import annotations

import math
import re
from typing import Any

from app.services import vnext_question_reader as reader
from app.services import vnext_source_stream_store as store
from app.services.question_source_codec import MAX_INLINE_BYTES


def transport_seed(payload: dict[str, Any]) -> str:
    task_id, stream_id = payload.get("task_id"), payload.get("source_stream_id")
    match = re.fullmatch(r"q2-task:([0-9a-f]{64})", task_id or "")
    if (not match or stream_id != f"q2-source-stream:{match[1]}"
        or not payload.get("source_entity_id") or payload.get("source_stream_verified")):
        raise reader.Q2ReaderError("Q2_INPUT_INVALID", "会议问答来源标识无效")
    return match[1]


def prepare(context: Any, binding_id: str, payload: dict[str, Any]) -> None:
    seed = transport_seed(payload)
    task_id, stream_id = payload["task_id"], payload["source_stream_id"]
    sources = reader._source_payload(payload.get("sources"))
    if reader._source_fingerprint(sources) != payload["source_fingerprint"]:
        raise reader.Q2ReaderError("Q2_SOURCE_FINGERPRINT_MISMATCH", "会议问答来源校验失败", 409)
    # Bound the actual serialized request material, including opaque handles.
    if len(store._canonical(payload["sources"])) > MAX_INLINE_BYTES:
        raise reader.Q2ReaderError("Q2_INLINE_SOURCES_TOO_LARGE", "会议问答来源过大", 413)
    items = [{
        "item_id": f"q2-item:{index}:{source['content_sha256'][-20:]}",
        **{key: source[key] for key in ("source_type", "source_id", "source_revision_id", "content_sha256")},
        "source_start_utf8": 0, "source_end_utf8": len(source["text"].encode("utf-8")),
        "content": source["text"], "start_ms": None, "end_ms": None, "speaker": None,
    } for index, source in enumerate(sources)]
    size = max(1, math.ceil(len(items) / 8))
    bundles = [items[offset:offset + size] for offset in range(0, len(items), size)]
    hashes = [store.bundle_sha256(bundle) for bundle in bundles]
    descriptor = {"chapter_ordinal": 0, "declared_bundle_count": len(bundles),
        "declared_item_count": len(items),
        "declared_uncompressed_bytes": sum(len(item["content"].encode("utf-8")) for item in items),
        "chapter_sha256": store.chapter_sha256(hashes)}
    stream, _ = store.create_source_stream(context, stream_id=stream_id, task_id=task_id,
        binding_id=binding_id, binding_generation=payload["binding_generation"],
        binding_revision=payload["binding_revision"], cancel_revision=payload["cancel_revision"],
        client_operation_id=f"q2-operation:{seed}", generation_id=f"q2-generation:{seed}",
        request_sha256=payload["source_fingerprint"], task_input_sha256=payload["source_fingerprint"],
        capability="question", entity_id=payload["source_entity_id"], entity_revision=1)
    if stream["state"] == "complete":
        return
    store.append_manifest_page(context, stream_id, page_seq=0, first_chapter_ordinal=0,
        descriptors=[descriptor], page_sha256=store.manifest_page_sha256([descriptor]), final_page=True)
    group_id = f"{stream_id}:group:0"
    store.create_bundle_group(context, stream_id, group_id=group_id, chapter_ordinal=0,
        declared_bundle_count=len(bundles), declared_item_count=len(items),
        declared_uncompressed_bytes=descriptor["declared_uncompressed_bytes"],
        chapter_hash=descriptor["chapter_sha256"], request_sha256=payload["source_fingerprint"])
    for ordinal, (bundle, sha) in enumerate(zip(bundles, hashes)):
        store.append_bundle(context, group_id, bundle_id=f"{stream_id}:bundle:{ordinal}",
            ordinal=ordinal, items=bundle, supplied_bundle_sha256=sha)
    store.commit_bundle_group(context, group_id)
