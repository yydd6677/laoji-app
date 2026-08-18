from __future__ import annotations

import hashlib
import sqlite3
import uuid

import pytest

from app.config import settings
from app.services import (
    device_identity,
    device_v2_identity,
    vnext_summary_chapter_pipeline,
    vnext_source_stream_store as source_store,
    vnext_task_store,
)


def _hash_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _fixed_hash(char: str) -> str:
    return "sha256:" + char * 64


def _setup(tmp_path, monkeypatch):
    database = tmp_path / "vnext-source.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "SECRET_KEY", "source-stream-test-secret")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    device_v2_identity.ensure_v2_schema()
    context = device_v2_identity.DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    with device_identity.control_connection() as connection:
        connection.execute(
            "INSERT INTO v2_devices(device_id, current_epoch_id, created_at) VALUES (?, ?, 1)",
            (context.device_id, context.epoch_id),
        )
        connection.execute(
            "INSERT INTO v2_device_epochs(device_id, epoch_id, status, created_at) VALUES (?, ?, 'active', 1)",
            (context.device_id, context.epoch_id),
        )
        connection.commit()
    generation = uuid.uuid4().hex
    vnext_task_store.register_binding(
        context,
        binding_id="binding-source-1",
        binding_generation=generation,
        binding_epoch_seq=1,
        binding_revision=2,
        cancel_revision=0,
    )
    source_store.ensure_vnext_source_stream_schema()
    return database, context, generation


def _create_stream(context, generation, *, suffix="1", capability="summary", now_epoch=None):
    return source_store.create_source_stream(
        context,
        stream_id=f"stream-source-{suffix}",
        task_id=f"task-source-{suffix}",
        binding_id="binding-source-1",
        binding_generation=generation,
        binding_revision=2,
        cancel_revision=0,
        client_operation_id=f"operation-source-{suffix}",
        generation_id=f"generation-source-{suffix}",
        request_sha256=_fixed_hash("a"),
        capability=capability,
        entity_id=f"meeting-source-{suffix}",
        entity_revision=1,
        task_input_sha256=_fixed_hash("b"),
        now_epoch=1_000 if now_epoch is None else now_epoch,
    )


def _chapter(ordinal: int, text: str):
    item = {
        "item_id": f"item-source-{ordinal}",
        "source_type": "transcript",
        "source_id": "transcript-source-1",
        "source_revision_id": "transcript-revision-1",
        "source_start_utf8": 0,
        "source_end_utf8": len(text.encode("utf-8")),
        "content_sha256": _hash_text(text),
        "content": text,
    }
    bundle_hash = source_store.bundle_sha256([item])
    chapter_hash = source_store.chapter_sha256([bundle_hash])
    descriptor = {
        "chapter_ordinal": ordinal,
        "declared_bundle_count": 1,
        "declared_item_count": 1,
        "declared_uncompressed_bytes": len(text.encode("utf-8")),
        "chapter_sha256": chapter_hash,
    }
    return item, bundle_hash, descriptor


def _upload_chapter(context, stream_id: str, descriptor, item, bundle_hash):
    ordinal = descriptor["chapter_ordinal"]
    group_id = f"group-source-{ordinal}"
    source_store.create_bundle_group(
        context,
        stream_id,
        group_id=group_id,
        chapter_ordinal=ordinal,
        declared_bundle_count=descriptor["declared_bundle_count"],
        declared_item_count=descriptor["declared_item_count"],
        declared_uncompressed_bytes=descriptor["declared_uncompressed_bytes"],
        chapter_hash=descriptor["chapter_sha256"],
        request_sha256=_fixed_hash(str((ordinal % 8) + 1)),
        now_epoch=1_100 + ordinal,
    )
    source_store.append_bundle(
        context,
        group_id,
        bundle_id=f"bundle-source-{ordinal}",
        ordinal=0,
        items=[item],
        supplied_bundle_sha256=bundle_hash,
    )
    return source_store.commit_bundle_group(context, group_id)


def _verified_document(chapter: dict) -> dict:
    item = chapter["items"][0]
    return {
        "schema_version": 3,
        "overview": {"text": "确认交付安排", "fact_ids": ["chapterFact"]},
        "facts": [{
            "fact_id": "chapterFact",
            "fact_type": "action",
            "certainty": "confirmed",
            "content": "按计划完成本章安排",
            "sources": [{
                "source_id": f"transcript:{item['item_id']}",
                "source_type": "transcript",
                "quote": item["content"],
                "content_hash": item["content_sha256"],
                "start_ms": None,
                "end_ms": None,
                "speaker": None,
            }],
            "evidence_score": 0.95,
            "conflict_group_id": None,
        }],
        "relations": [],
        "action_candidates": [{
            "action_id": "chapterAction",
            "fact_id": "chapterFact",
            "content": "完成本章安排",
            "owner": None,
            "due_text": None,
            "schedule_fit": "medium",
            "evidence_score": 0.95,
        }],
    }


def test_source_stream_encrypts_payload_and_promotes_one_atomic_checkpoint(tmp_path, monkeypatch) -> None:
    database, context, generation = _setup(tmp_path, monkeypatch)
    stream, reused = _create_stream(context, generation)
    assert reused is False
    replay, reused = _create_stream(context, generation)
    assert reused is True and replay == stream

    item, bundle_hash, descriptor = _chapter(0, "第一章确认下周一交付接口文档。")
    page_hash = source_store.manifest_page_sha256([descriptor])
    page = source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=page_hash,
        final_page=True,
        now_epoch=1_050,
    )
    assert page["final_chapter_count"] == 1
    assert source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=page_hash,
        final_page=True,
        now_epoch=1_051,
    )["source_manifest_sha256"] == page["source_manifest_sha256"]
    assert _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)["state"] == "complete"

    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT ciphertext FROM vnext_encrypted_source_payloads WHERE item_id = ?",
            (item["item_id"],),
        ).fetchone()
        assert row is not None
        assert item["content"].encode("utf-8") not in bytes(row[0])

    attempt = vnext_task_store.claim_attempt(
        context,
        stream["task_id"],
        lease_owner="summary-worker-1",
    )
    assert attempt is not None
    loaded = source_store.load_next_chapter(
        context,
        stream["task_id"],
        attempt_id=attempt["attempt_id"],
        lease_owner="summary-worker-1",
    )
    assert loaded is not None
    assert loaded["items"][0]["content"] == item["content"]
    promoted = source_store.promote_checkpoint(
        context,
        stream["task_id"],
        attempt_id=attempt["attempt_id"],
        lease_owner="summary-worker-1",
        chapter_ordinal=0,
        aggregate={"schema_version": 3, "facts": [{"id": "fact-1"}]},
        handler_revision="summary-facts-v3-chapter-r1",
        provider_revision="provider-test-r1",
        now_epoch=1_200,
    )
    assert promoted["slot_no"] == 0
    assert promoted["stream_state"] == "complete"
    assert source_store.get_source_stream(context, stream["stream_id"])["checkpoint_through_chapter"] == 0

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_task_checkpoints").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_bundle_groups").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_encrypted_source_payloads").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_manifest_pages").fetchone()[0] == 0
        states = dict(connection.execute(
            "SELECT resource_kind, state FROM vnext_source_reservations"
        ).fetchall())
    assert states == {
            "task_checkpoint": "active",
            "source_manifest": "released",
            "source_payload": "released",
        }


def test_three_chapters_keep_only_two_checkpoint_slots(tmp_path, monkeypatch) -> None:
    _, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="rolling")
    chapters = [
        _chapter(0, "先确认用户需求。"),
        _chapter(1, "随后完成接口联调。"),
        _chapter(2, "最后安排周五验收。"),
    ]
    descriptors = [chapter[2] for chapter in chapters]
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=descriptors,
        page_sha256=source_store.manifest_page_sha256(descriptors),
        final_page=True,
        now_epoch=2_000,
    )
    attempt = vnext_task_store.claim_attempt(
        context,
        stream["task_id"],
        lease_owner="summary-worker-rolling",
    )
    assert attempt is not None
    for ordinal, (item, bundle_hash, descriptor) in enumerate(chapters):
        _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
        loaded = source_store.load_next_chapter(
            context,
            stream["task_id"],
            attempt_id=attempt["attempt_id"],
            lease_owner="summary-worker-rolling",
        )
        assert loaded is not None and loaded["chapter_ordinal"] == ordinal
        source_store.promote_checkpoint(
            context,
            stream["task_id"],
            attempt_id=attempt["attempt_id"],
            lease_owner="summary-worker-rolling",
            chapter_ordinal=ordinal,
            aggregate={"schema_version": 3, "through": ordinal, "facts": list(range(ordinal + 1))},
            handler_revision="summary-facts-v3-chapter-r1",
            provider_revision="provider-test-r1",
            now_epoch=2_100 + ordinal,
        )

    with device_identity.control_connection() as connection:
        rows = connection.execute(
            "SELECT slot_no, through_chapter_ordinal FROM vnext_task_checkpoints ORDER BY slot_no"
        ).fetchall()
        assert [(int(row[0]), int(row[1])) for row in rows] == [(0, 2), (1, 1)]
        task = connection.execute(
            "SELECT current_checkpoint_slot, checkpoint_through_chapter FROM vnext_tasks WHERE task_id = ?",
            (stream["task_id"],),
        ).fetchone()
        assert tuple(task) == (0, 2)
    assert source_store.get_source_stream(context, stream["stream_id"])["state"] == "complete"


def test_manifest_pages_resume_after_non_final_page(tmp_path, monkeypatch) -> None:
    _, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="manifest-pages")
    chapters = [
        _chapter(0, "第一页的来源。"),
        _chapter(1, "第二页的来源。"),
    ]
    descriptors = [chapter[2] for chapter in chapters]
    first_page = [descriptors[0]]
    first_hash = source_store.manifest_page_sha256(first_page)
    snapshot = source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=first_page,
        page_sha256=first_hash,
        final_page=False,
        now_epoch=2_500,
    )
    assert snapshot["next_manifest_page"] == 1
    assert snapshot["next_manifest_chapter"] == 1
    replay = source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=first_page,
        page_sha256=first_hash,
        final_page=False,
        now_epoch=2_501,
    )
    assert replay["next_manifest_page"] == 1
    second_hash = source_store.manifest_page_sha256([descriptors[1]])
    final = source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=1,
        first_chapter_ordinal=1,
        descriptors=[descriptors[1]],
        page_sha256=second_hash,
        final_page=True,
        now_epoch=2_502,
    )
    assert final["next_manifest_page"] == 2
    assert final["next_manifest_chapter"] == 2
    assert final["final_chapter_count"] == 2


def test_stale_worker_cannot_read_or_promote_source(tmp_path, monkeypatch) -> None:
    _, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="stale")
    item, bundle_hash, descriptor = _chapter(0, "这是一条需要严格归属的会议来源。")
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
    attempt = vnext_task_store.claim_attempt(context, stream["task_id"], lease_owner="worker-current")
    assert attempt is not None
    with pytest.raises(source_store.VNextSourceStreamError) as captured:
        source_store.load_next_chapter(
            context,
            stream["task_id"],
            attempt_id=attempt["attempt_id"],
            lease_owner="worker-stale",
        )
    assert captured.value.code == "TASK_LEASE_LOST"


def test_cancel_clears_sources_checkpoints_and_capacity(tmp_path, monkeypatch) -> None:
    _, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="cancel")
    item, bundle_hash, descriptor = _chapter(0, "尚未处理完的来源应在取消时清理。")
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
    assert source_store.cancel_source_stream(context, stream["stream_id"])
    assert source_store.get_source_stream(context, stream["stream_id"])["state"] == "cancelled"
    assert vnext_task_store.get_task(context, stream["task_id"])["state"] == "cancelled"
    with device_identity.control_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_bundle_groups").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_manifest_pages").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_encrypted_source_payloads").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM vnext_source_reservations WHERE state = 'active'"
        ).fetchone()[0] == 0


def test_summary_pipeline_atomically_publishes_encrypted_artifact(tmp_path, monkeypatch) -> None:
    database, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="artifact")
    item, bundle_hash, descriptor = _chapter(0, "周五前完成候选版本验收。")
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
    attempt = vnext_task_store.claim_attempt(
        context,
        stream["task_id"],
        lease_owner="summary-artifact-worker",
    )
    assert attempt is not None
    result = vnext_summary_chapter_pipeline.process_next_summary_chapter(
        context,
        stream["task_id"],
        attempt_id=attempt["attempt_id"],
        lease_owner="summary-artifact-worker",
        handler_revision="summary-facts-v3-chapter-r1",
        provider_revision="provider-test-r1",
        generate_verified_chapter=_verified_document,
    )
    assert result["state"] == "success"
    task = vnext_task_store.get_task(context, stream["task_id"])
    assert task["state"] == "success"
    assert task["result"]["artifact_id"] == result["artifact"]["artifact_id"]
    assert "facts_document" not in task["result"]
    artifact = source_store.load_generated_artifact(context, stream["task_id"])
    assert artifact is not None
    assert artifact["output"]["facts_document"]["schema_version"] == 3
    assert artifact["output"]["meeting_id"] == "meeting-source-artifact"
    assert artifact["output"]["source_fingerprint"].startswith("sha256:")
    assert artifact["output"]["coverage"]["input_token_budget"] == 10240
    assert artifact["output"]["facts_document"]["action_candidates"]
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT encrypted_output FROM vnext_generated_artifacts WHERE task_id = ?",
            (stream["task_id"],),
        ).fetchone()
        assert row is not None
        assert "周五前完成候选版本验收".encode("utf-8") not in bytes(row[0])
        assert connection.execute("SELECT COUNT(*) FROM vnext_task_checkpoints").fetchone()[0] == 0
        assert connection.execute(
            "SELECT state FROM vnext_source_reservations WHERE resource_kind = 'task_checkpoint'"
        ).fetchone()[0] == "released"


def test_chapter_evidence_restores_time_and_source_identity_without_global_transcript_lookup() -> None:
    chapter = {
        "items": [{
            "source_type": "transcript",
            "source_id": "recording-1",
            "source_revision_id": "revision-3",
            "source_start_utf8": 0,
            "source_end_utf8": 18,
            "content_sha256": _hash_text("这是带时间的来源。"),
            "content": "这是带时间的来源。",
            "start_ms": 12_300,
            "end_ms": 15_600,
            "speaker": "张敏",
        }],
    }
    package = vnext_summary_chapter_pipeline.build_chapter_evidence_package(chapter)
    assert package.sources[0].source_id.startswith("transcript:")
    assert package.sources[0].start_ms == 12_300
    assert package.sources[0].end_ms == 15_600
    assert package.sources[0].speaker == "张敏"
    assert package.sources[0].content_hash == chapter["items"][0]["content_sha256"]
    assert package.coverage["source_coverage"] == 1.0


def test_question_stream_reads_complete_sources_and_purges_atomically(tmp_path, monkeypatch) -> None:
    database, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="question", capability="question")
    item, bundle_hash, descriptor = _chapter(0, "周五前由张敏提交接口文档。")
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    uploaded = _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
    assert uploaded["state"] == "complete"
    loaded = source_store.load_question_source_stream(context, stream["stream_id"])
    assert loaded is not None
    assert loaded["task_id"] == stream["task_id"]
    assert loaded["sources"][0]["text"] == item["content"]
    assert source_store.get_source_stream(context, stream["stream_id"])["state"] == "complete"

    attempt = vnext_task_store.claim_attempt(context, stream["task_id"], lease_owner="q2-worker")
    assert attempt is not None
    result = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": "q2-reader-v1",
        "model_revision": "test:model",
        "snapshot_id": "q2-snapshot-question",
        "answer_kind": "answer",
        "answer": "张敏负责提交接口文档。",
        "clauses": [],
    }
    committed = source_store.commit_question_result(
        context,
        stream["task_id"],
        attempt_id=attempt["attempt_id"],
        lease_owner="q2-worker",
        source_stream_id=stream["stream_id"],
        source_fingerprint=_fixed_hash("b"),
        result=result,
    )
    assert committed["task_id"] == stream["task_id"]
    assert vnext_task_store.get_task(context, stream["task_id"])["state"] == "success"
    assert vnext_task_store.get_task(context, stream["task_id"])["result"]["answer"] == result["answer"]
    assert source_store.get_source_stream(context, stream["stream_id"]) is None
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_encrypted_source_payloads").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_bundle_groups").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_manifest_pages").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM vnext_source_reservations WHERE state = 'active'"
        ).fetchone()[0] == 0


def test_expired_source_stream_cleanup_is_terminal_and_payload_free(tmp_path, monkeypatch) -> None:
    database, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="expiry", now_epoch=1_000)
    removed = source_store.purge_expired_source_streams(
        now_epoch=1_000 + source_store.SOURCE_TTL_SECONDS + 1,
    )
    assert removed == 1
    assert source_store.get_source_stream(context, stream["stream_id"]) is None
    task = vnext_task_store.get_task(context, stream["task_id"])
    assert task["state"] == "failure"
    assert task["error_code"] == "SOURCE_STREAM_EXPIRED"
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM vnext_source_reservations WHERE state = 'active'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM vnext_encrypted_source_payloads").fetchone()[0] == 0


def test_final_checkpoint_recovers_after_worker_lease_loss_without_regeneration(tmp_path, monkeypatch) -> None:
    _, context, generation = _setup(tmp_path, monkeypatch)
    stream, _ = _create_stream(context, generation, suffix="recovery")
    item, bundle_hash, descriptor = _chapter(0, "最终章节已经生成但进程尚未发布结果。")
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    _upload_chapter(context, stream["stream_id"], descriptor, item, bundle_hash)
    first = vnext_task_store.claim_attempt(context, stream["task_id"], lease_owner="worker-before-crash")
    assert first is not None
    chapter = source_store.load_next_chapter(
        context,
        stream["task_id"],
        attempt_id=first["attempt_id"],
        lease_owner="worker-before-crash",
    )
    from app.services.summary_v3_chapter_merge import merge_verified_chapter

    checkpoint = merge_verified_chapter(None, _verified_document(chapter), chapter_ordinal=0)
    source_store.promote_checkpoint(
        context,
        stream["task_id"],
        attempt_id=first["attempt_id"],
        lease_owner="worker-before-crash",
        chapter_ordinal=0,
        aggregate=checkpoint.model_dump(mode="json"),
        handler_revision="summary-facts-v3-chapter-r1",
        provider_revision="provider-test-r1",
    )
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_task_attempts SET lease_expires_at_epoch = 0 WHERE attempt_id = ?",
            (first["attempt_id"],),
        )
        connection.commit()
    second = vnext_task_store.claim_attempt(context, stream["task_id"], lease_owner="worker-after-crash")
    assert second is not None and second["attempt_number"] == 2
    calls = 0

    def must_not_generate(_chapter):
        nonlocal calls
        calls += 1
        raise AssertionError("final checkpoint recovery must not call provider")

    recovered = vnext_summary_chapter_pipeline.process_next_summary_chapter(
        context,
        stream["task_id"],
        attempt_id=second["attempt_id"],
        lease_owner="worker-after-crash",
        handler_revision="summary-facts-v3-chapter-r1",
        provider_revision="provider-test-r1",
        generate_verified_chapter=must_not_generate,
    )
    assert recovered["state"] == "success"
    assert calls == 0
