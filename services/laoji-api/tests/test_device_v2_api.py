from __future__ import annotations

import hashlib
import sqlite3
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import device_v2
from app.config import settings
from app.services import device_identity, device_v2_identity


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
