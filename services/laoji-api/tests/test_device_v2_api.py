from __future__ import annotations

import hashlib
import sqlite3
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import device_v2
from app.config import settings
from app.services import (
    device_identity,
    device_v2_identity,
    vnext_source_stream_store as source_store,
    vnext_summary_runtime,
)


def _client(tmp_path, monkeypatch) -> tuple[TestClient, device_v2_identity.DeviceV2Context]:
    database = tmp_path / "device-v2-api.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
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
    app = FastAPI()
    app.include_router(device_v2.router, prefix="/api")
    app.dependency_overrides[device_v2.require_device_v2] = lambda: context
    return TestClient(app), context


def test_v2_binding_task_and_purge_wire_contract(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    capability_id = str(uuid.uuid4())
    secret = "native-only-purge-secret"
    binding = client.put(
        f"/api/device/v2/meetings/{binding_id}",
        json={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": 1,
            "binding_revision": 1,
            "cancel_revision": 0,
            "purge_capability": {
                "capability_id": capability_id,
                "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
                "registration_request_id": "binding-register-request-1",
            },
        },
    )
    assert binding.status_code == 200
    assert binding.json()["binding"]["created"] is True

    task = client.post(
        "/api/device/v2/tasks",
        json={
            "schema_version": 2,
            "task_id": "task-wire-1",
            "binding_id": binding_id,
            "binding_generation": binding_generation,
            "capability": "summary",
            "entity_id": "opaque-entity",
            "entity_revision": 1,
            "input_sha256": "sha256:" + "a" * 64,
            "generation_id": "task-generation-wire-1",
        },
    )
    assert task.status_code == 200
    assert client.get("/api/device/v2/tasks/task-wire-1").status_code == 200
    assert client.post(
        f"/api/device/v2/purge-capabilities/{capability_id}/execute",
        headers={"X-Laoji-Purge-Request-Id": "purge-wire-request-1"},
    ).status_code == 401
    purged = client.post(
        f"/api/device/v2/purge-capabilities/{capability_id}/execute",
        headers={
            "Authorization": f"LaojiPurge {secret}",
            "X-Laoji-Purge-Request-Id": "purge-wire-request-1",
        },
    )
    assert purged.status_code == 200
    assert purged.json()["state"] == "confirmed"
    assert client.get("/api/device/v2/tasks/task-wire-1").status_code == 404
    assert set(purged.json()) == {"schema_version", "state", "purge_id", "error_code"}


def test_worker_attempt_routes_are_not_device_bearer_surface(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    paths = {route.path for route in client.app.routes}
    assert not any("attempts" in path for path in paths if path.startswith("/api/device/v2"))


def test_upload_wire_routes_keep_binding_fence_and_task_identity(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    captured: dict[str, object] = {}

    def fake_create(_context, **kwargs):
        captured.update(kwargs)
        return {
            "schema_version": 2,
            "session_id": kwargs["session_id"],
            "binding_id": kwargs["binding_id"],
            "binding_generation": kwargs["binding_generation"],
            "binding_revision": kwargs["binding_revision"],
            "cancel_revision": kwargs["cancel_revision"],
            "client_operation_id": kwargs["client_operation_id"],
            "asset_id": kwargs["asset_id"],
            "asset_generation": kwargs["asset_generation"],
            "expected_size": kwargs["expected_size"],
            "expected_sha256": kwargs["expected_sha256"],
            "mime_type": kwargs["mime_type"],
            "mode": "single",
            "part_size": 5 * 1024 * 1024,
            "total_parts": 1,
            "state": "active",
            "expires_at": 1000,
            "verified_asset_id": None,
            "transcription_task_id": None,
            "put_url": "https://r2.invalid/put",
            "uploaded_parts": [],
        }, False

    monkeypatch.setattr(device_v2.vnext_upload_store, "create_upload_session", fake_create)
    response = client.post(
        "/api/device/v2/uploads",
        json={
            "schema_version": 2,
            "session_id": "upload-wire-session",
            "binding_id": "binding-wire-upload",
            "binding_generation": "a" * 32,
            "binding_revision": 3,
            "cancel_revision": 2,
            "client_operation_id": "upload-wire-operation",
            "asset_id": "asset-wire",
            "asset_generation": "b" * 32,
            "expected_size": 123,
            "expected_sha256": "sha256:" + "c" * 64,
            "mime_type": "audio/m4a",
        },
    )
    assert response.status_code == 201
    assert captured["binding_revision"] == 3
    assert captured["cancel_revision"] == 2
    assert captured["asset_generation"] == "b" * 32
    assert response.json()["session"]["put_url"] == "https://r2.invalid/put"


def test_source_stream_candidate_is_default_off_and_device_fenced(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    payload = {
        "schema_version": 2,
        "contract_revision": "source.stream.v2",
        "stream_id": "stream-wire-source-1",
        "task_id": "task-wire-source-1",
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "client_operation_id": "operation-wire-source-1",
        "generation_id": "generation-wire-source-1",
        "request_sha256": "sha256:" + "a" * 64,
        "capability": "summary",
        "entity_id": "meeting-wire-source-1",
        "entity_revision": 1,
        "task_input_sha256": "sha256:" + "b" * 64,
    }
    disabled = client.post(
        f"/api/device/v2/meetings/{binding_id}/source-streams",
        json=payload,
    )
    assert disabled.status_code == 404
    assert disabled.json()["detail"]["code"] == "SOURCE_STREAM_V2_DISABLED"

    monkeypatch.setenv("LAOJI_VNEXT_SOURCE_STREAM_V2_ENABLED", "1")
    runtime = vnext_summary_runtime.current_summary_runtime_revision()
    enabled_capabilities = client.get("/api/device/v2/capabilities")
    assert enabled_capabilities.status_code == 200
    assert enabled_capabilities.json()["summary_handler_revision"] == runtime.handler_revision
    assert enabled_capabilities.json()["summary_prompt_revision"] == runtime.prompt_revision
    assert enabled_capabilities.json()["summary_model_revision"] == runtime.model_revision
    secret = "source-wire-purge-secret"
    registered = client.put(
        f"/api/device/v2/meetings/{binding_id}",
        json={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": 1,
            "binding_revision": 1,
            "cancel_revision": 0,
            "purge_capability": {
                "capability_id": str(uuid.uuid4()),
                "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
                "registration_request_id": "source-wire-binding-request",
            },
        },
    )
    assert registered.status_code == 200
    missing_revision = client.post(
        f"/api/device/v2/meetings/{binding_id}/source-streams",
        json=payload,
    )
    assert missing_revision.status_code == 409
    assert missing_revision.json()["detail"]["code"] == "SUMMARY_RUNTIME_REVISION_CHANGED"
    payload.update({
        "summary_handler_revision": runtime.handler_revision,
        "summary_prompt_revision": runtime.prompt_revision,
        "summary_model_revision": "stale-model-revision",
    })
    stale_revision = client.post(
        f"/api/device/v2/meetings/{binding_id}/source-streams",
        json=payload,
    )
    assert stale_revision.status_code == 409
    assert stale_revision.json()["detail"]["code"] == "SUMMARY_RUNTIME_REVISION_CHANGED"
    payload["summary_model_revision"] = runtime.model_revision
    created = client.post(
        f"/api/device/v2/meetings/{binding_id}/source-streams",
        json=payload,
    )
    assert created.status_code == 202
    assert created.json()["state"] == "open"
    assert created.json()["checkpoint_through_chapter"] is None
    assert client.get(
        "/api/device/v2/source-streams/stream-wire-source-1"
    ).status_code == 200
    cancelled = client.delete(
        "/api/device/v2/source-streams/stream-wire-source-1"
    )
    assert cancelled.status_code == 202
    assert cancelled.json()["cancelled"] is True


def test_question_reader_route_is_capability_gated_and_typed(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    source_text = "周五前由张敏提交接口文档。"
    source_hash = "sha256:" + hashlib.sha256(source_text.encode("utf-8")).hexdigest()
    source_id = "transcript:" + "a" * 194
    source_revision_id = "revision:" + "b" * 119
    payload = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": "q2-reader-v2",
        "snapshot_id": "q2-route-snapshot",
        "source_fingerprint": "sha256:" + "a" * 64,
        "question": "谁负责提交接口文档？",
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "sources": [{
            "source_type": "transcript",
            "source_id": source_id,
            "source_revision_id": source_revision_id,
            "content_sha256": source_hash,
            "text": source_text,
        }],
    }
    disabled = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert disabled.status_code == 404
    assert disabled.json()["detail"]["code"] == "QUESTION_READER_V2_DISABLED"

    monkeypatch.setenv("LAOJI_VNEXT_Q2_READER_ENABLED", "1")
    secret = "question-reader-purge-secret"
    registered = client.put(
        f"/api/device/v2/meetings/{binding_id}",
        json={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": 1,
            "binding_revision": 1,
            "cancel_revision": 0,
            "purge_capability": {
                "capability_id": str(uuid.uuid4()),
                "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
                "registration_request_id": "question-reader-binding-request",
            },
        },
    )
    assert registered.status_code == 200
    calls: list[dict] = []

    def fake_read(value: dict) -> dict:
        calls.append(value)
        return {
            "schema_version": 2,
            "contract_revision": "question.reader.v2",
            "provider_revision": "q2-reader-v2",
            "model_revision": "test:model",
            "snapshot_id": value["snapshot_id"],
            "answer_kind": "not_stated",
            "answer": "会议记录没有说明。",
            "clauses": [],
        }

    monkeypatch.setattr(device_v2.vnext_question_reader, "read_q2", fake_read)
    response = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert response.status_code == 200
    assert response.json()["answer_kind"] == "not_stated"
    assert len(calls) == 1
    assert calls[0]["sources"][0]["source_id"] == source_id
    assert calls[0]["sources"][0]["source_revision_id"] == source_revision_id

    extra = {**payload, "unexpected": True}
    invalid = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=extra)
    assert invalid.status_code == 422


def test_question_reader_route_rejects_binding_revision_and_source_hash(tmp_path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("LAOJI_VNEXT_Q2_READER_ENABLED", "1")
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    secret = "question-reader-fence-secret"
    assert client.put(
        f"/api/device/v2/meetings/{binding_id}",
        json={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": 1,
            "binding_revision": 2,
            "cancel_revision": 3,
            "purge_capability": {
                "capability_id": str(uuid.uuid4()),
                "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
                "registration_request_id": "question-reader-fence-request",
            },
        },
    ).status_code == 200
    text = "周五开会。"
    payload = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": "q2-reader-v2",
        "snapshot_id": "q2-fence-snapshot",
        "source_fingerprint": "sha256:" + "b" * 64,
        "question": "什么时候开会？",
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 3,
        "sources": [{
            "source_type": "transcript",
            "source_id": "line-1",
            "source_revision_id": "revision-1",
            "content_sha256": "sha256:" + "c" * 64,
            "text": text,
        }],
    }
    fence = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert fence.status_code == 409
    assert fence.json()["detail"]["code"] == "BINDING_FENCE_INVALID"
    payload["binding_revision"] = 2
    hash_error = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert hash_error.status_code == 409
    assert hash_error.json()["detail"]["code"] == "Q2_SOURCE_HASH_MISMATCH"


def test_question_reader_source_stream_commits_result_and_replays_by_task(tmp_path, monkeypatch) -> None:
    client, context = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("LAOJI_VNEXT_Q2_READER_ENABLED", "1")
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    secret = "question-stream-route-secret"
    assert client.put(
        f"/api/device/v2/meetings/{binding_id}",
        json={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": 1,
            "binding_revision": 1,
            "cancel_revision": 0,
            "purge_capability": {
                "capability_id": str(uuid.uuid4()),
                "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
                "registration_request_id": "question-stream-route-binding",
            },
        },
    ).status_code == 200
    fingerprint = "sha256:" + "b" * 64
    stream, _ = source_store.create_source_stream(
        context,
        stream_id="stream-question-route-1",
        task_id="task-question-route-1",
        binding_id=binding_id,
        binding_generation=binding_generation,
        binding_revision=1,
        cancel_revision=0,
        client_operation_id="question-stream-route-operation",
        generation_id="question-stream-route-generation",
        request_sha256=fingerprint,
        capability="question",
        entity_id="meeting-question-route-1",
        entity_revision=1,
        task_input_sha256=fingerprint,
    )
    text = "周五前由张敏提交接口文档。"
    item = {
        "item_id": "question-route-item-1",
        "source_type": "transcript",
        "source_id": "line-1",
        "source_revision_id": "revision-1",
        "source_start_utf8": 0,
        "source_end_utf8": len(text.encode("utf-8")),
        "content_sha256": "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "content": text,
    }
    bundle_hash = source_store.bundle_sha256([item])
    chapter_hash = source_store.chapter_sha256([bundle_hash])
    descriptor = {
        "chapter_ordinal": 0,
        "declared_bundle_count": 1,
        "declared_item_count": 1,
        "declared_uncompressed_bytes": len(text.encode("utf-8")),
        "chapter_sha256": chapter_hash,
    }
    source_store.append_manifest_page(
        context,
        stream["stream_id"],
        page_seq=0,
        first_chapter_ordinal=0,
        descriptors=[descriptor],
        page_sha256=source_store.manifest_page_sha256([descriptor]),
        final_page=True,
    )
    source_store.create_bundle_group(
        context,
        stream["stream_id"],
        group_id="question-route-group-1",
        chapter_ordinal=0,
        declared_bundle_count=1,
        declared_item_count=1,
        declared_uncompressed_bytes=len(text.encode("utf-8")),
        chapter_hash=chapter_hash,
        request_sha256="sha256:" + "c" * 64,
    )
    source_store.append_bundle(
        context,
        "question-route-group-1",
        bundle_id="question-route-bundle-1",
        ordinal=0,
        items=[item],
        supplied_bundle_sha256=bundle_hash,
    )
    assert source_store.commit_bundle_group(context, "question-route-group-1")["state"] == "complete"
    calls: list[dict] = []

    def fake_read(value: dict) -> dict:
        calls.append(value)
        return {
            "schema_version": 2,
            "contract_revision": "question.reader.v2",
            "provider_revision": "q2-reader-v2",
            "model_revision": "test:model",
            "snapshot_id": value["snapshot_id"],
            "answer_kind": "not_stated",
            "answer": "会议记录没有说明。",
            "clauses": [],
        }

    monkeypatch.setattr(device_v2.vnext_question_reader, "read_q2", fake_read)
    payload = {
        "schema_version": 2,
        "contract_revision": "question.reader.v2",
        "provider_revision": "q2-reader-v2",
        "snapshot_id": "q2-stream-route-snapshot",
        "source_fingerprint": fingerprint,
        "question": "谁负责提交接口文档？",
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "task_id": "task-question-route-1",
        "source_stream_id": "stream-question-route-1",
        "sources": [],
    }
    response = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert response.status_code == 200
    assert response.json()["answer_kind"] == "not_stated"
    assert len(calls) == 1
    assert calls[0]["sources"][0]["text"] == text
    assert source_store.get_source_stream(context, stream["stream_id"]) is None

    replay = client.post(f"/api/device/v2/meetings/{binding_id}/questions-v2", json=payload)
    assert replay.status_code == 200
    assert replay.json() == response.json()
    assert len(calls) == 1
