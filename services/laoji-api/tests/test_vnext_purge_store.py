from __future__ import annotations

import hashlib
import sqlite3
import uuid

import pytest

from app.config import settings
from app.services import device_identity, device_v2_identity, vnext_purge_store, vnext_task_store


def _setup(tmp_path, monkeypatch) -> device_v2_identity.DeviceV2Context:
    database = tmp_path / "purge-v2.db"
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
    return context


def _registration(secret: str) -> dict[str, str]:
    return {
        "capability_id": str(uuid.uuid4()),
        "secret_sha256": hashlib.sha256(secret.encode("ascii")).hexdigest(),
        "registration_request_id": f"purge-register-{uuid.uuid4()}",
    }


def _hash(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def test_binding_purge_deletes_task_payload_and_keeps_minimal_tombstone(tmp_path, monkeypatch) -> None:
    context = _setup(tmp_path, monkeypatch)
    secret = "binding-secret-value"
    registration = _registration(secret)
    binding_id = str(uuid.uuid4())
    generation = uuid.uuid4().hex
    vnext_task_store.register_binding(
        context,
        binding_id=binding_id,
        binding_generation=generation,
        binding_epoch_seq=1,
        purge_capability=registration,
    )
    vnext_task_store.create_task(
        context,
        task_id="task-private-result",
        binding_id=binding_id,
        binding_generation=generation,
        capability="summary",
        entity_id="opaque-entity",
        entity_revision=1,
        input_sha256=_hash("private input"),
        generation_id="generation-private-result",
    )
    attempt = vnext_task_store.claim_attempt(context, "task-private-result", lease_owner="worker-test")
    assert attempt is not None
    assert vnext_task_store.mark_success(
        context,
        "task-private-result",
        attempt["attempt_id"],
        {"private": "must be deleted"},
        lease_owner="worker-test",
    )

    result = vnext_purge_store.execute_purge(
        capability_id=registration["capability_id"],
        secret=secret,
        request_id="binding-purge-request-1",
    )
    assert result["state"] == "confirmed"
    assert vnext_task_store.get_task(context, "task-private-result") is None
    binding = vnext_task_store.get_binding(context, binding_id)
    assert binding is not None and binding["state"] == "purged"
    assert "private" not in str(binding)
    assert vnext_purge_store.execute_purge(
        capability_id=registration["capability_id"],
        secret=secret,
        request_id="binding-purge-request-replay",
    )["purge_id"] == result["purge_id"]


def test_epoch_purge_revokes_tokens_and_erases_all_generic_tasks(tmp_path, monkeypatch) -> None:
    context = _setup(tmp_path, monkeypatch)
    secret = "epoch-secret-value"
    registration = _registration(secret)
    with device_identity.control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        vnext_purge_store.register_capability(
            connection,
            scope_kind="epoch",
            capability_id=registration["capability_id"],
            device_id=context.device_id,
            epoch_id=context.epoch_id,
            secret_sha256=registration["secret_sha256"],
            registration_request_id=registration["registration_request_id"],
        )
        connection.execute(
            "INSERT INTO v2_tokens(token_hash, device_id, epoch_id, key_version, token_revision, created_at, expires_at) "
            "VALUES ('token-hash', ?, ?, 1, 1, 1, 9999999999)",
            (context.device_id, context.epoch_id),
        )
        connection.commit()
    binding_id = str(uuid.uuid4())
    generation = uuid.uuid4().hex
    vnext_task_store.register_binding(
        context,
        binding_id=binding_id,
        binding_generation=generation,
        binding_epoch_seq=1,
    )
    vnext_task_store.create_task(
        context,
        task_id="epoch-task",
        binding_id=binding_id,
        binding_generation=generation,
        capability="question",
        entity_id="opaque-entity",
        entity_revision=1,
        input_sha256=_hash("epoch private input"),
        generation_id="epoch-generation",
    )
    assert vnext_purge_store.execute_purge(
        capability_id=registration["capability_id"],
        secret=secret,
        request_id="epoch-purge-request-1",
    )["state"] == "confirmed"
    with device_identity.control_connection() as connection:
        epoch = connection.execute(
            "SELECT status FROM v2_device_epochs WHERE device_id = ? AND epoch_id = ?",
            (context.device_id, context.epoch_id),
        ).fetchone()
        token = connection.execute("SELECT revoked_at FROM v2_tokens WHERE token_hash = 'token-hash'").fetchone()
        task_count = connection.execute(
            "SELECT COUNT(*) FROM vnext_tasks WHERE device_id = ? AND epoch_id = ?",
            (context.device_id, context.epoch_id),
        ).fetchone()[0]
    assert epoch["status"] == "closed"
    assert token["revoked_at"] is not None
    assert task_count == 0


def test_purge_secret_is_required_and_unknown_capability_is_redacted(tmp_path, monkeypatch) -> None:
    _setup(tmp_path, monkeypatch)
    with pytest.raises(vnext_purge_store.VNextPurgeError) as unknown:
        vnext_purge_store.get_purge_status(capability_id=str(uuid.uuid4()), secret="anything")
    assert unknown.value.code == "CAPABILITY_NOT_REGISTERED"


def test_stale_running_purge_returns_to_pending_without_touching_fresh_work(tmp_path, monkeypatch) -> None:
    context = _setup(tmp_path, monkeypatch)
    now = 10_000
    old_capability = _registration("old-secret")
    fresh_capability = _registration("fresh-secret")
    old_binding = str(uuid.uuid4())
    fresh_binding = str(uuid.uuid4())
    with device_identity.control_connection() as connection:
        for registration, binding_id in ((old_capability, old_binding), (fresh_capability, fresh_binding)):
            vnext_purge_store.register_capability(
                connection,
                scope_kind="binding",
                capability_id=registration["capability_id"],
                device_id=context.device_id,
                epoch_id=context.epoch_id,
                secret_sha256=registration["secret_sha256"],
                registration_request_id=registration["registration_request_id"],
                binding_id=binding_id,
                binding_generation=uuid.uuid4().hex,
            )
        connection.execute(
            "INSERT INTO v2_purges(purge_id, capability_id, request_id, state, created_at, updated_at) "
            "VALUES ('old-purge', ?, 'old-request', 'running', ?, ?)",
            (old_capability["capability_id"], now - 3600, now - 3600),
        )
        connection.execute(
            "INSERT INTO v2_purges(purge_id, capability_id, request_id, state, created_at, updated_at) "
            "VALUES ('fresh-purge', ?, 'fresh-request', 'running', ?, ?)",
            (fresh_capability["capability_id"], now, now),
        )
        connection.commit()

    assert vnext_purge_store.recover_interrupted_purges(
        stale_after_seconds=1800,
        now_epoch=now,
    ) == 1
    with device_identity.control_connection() as connection:
        states = dict(connection.execute("SELECT purge_id, state FROM v2_purges" ).fetchall())
        error = connection.execute(
            "SELECT last_error_code FROM v2_purges WHERE purge_id = 'old-purge'"
        ).fetchone()[0]
    assert states == {"old-purge": "pending", "fresh-purge": "running"}
    assert error == "PURGE_PROCESS_RESTARTED"
