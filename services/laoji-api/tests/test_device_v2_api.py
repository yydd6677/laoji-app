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
