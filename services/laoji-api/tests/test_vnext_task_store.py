from __future__ import annotations

import sqlite3
import uuid

import pytest

from app.config import settings
from app.services import device_identity, vnext_task_store
from app.services.device_identity import DeviceContext


def _context(tmp_path, monkeypatch) -> DeviceContext:
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'vnext.db'}")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(tmp_path / "vnext.db") as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    vnext_task_store.ensure_vnext_task_schema()
    return DeviceContext(1, str(uuid.uuid4()), str(uuid.uuid4()))


def _hash(char: str = "a") -> str:
    return "sha256:" + char * 64


def test_binding_and_task_create_are_idempotent(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    binding = vnext_task_store.register_binding(
        context, binding_id="binding-1", binding_generation="generation-1"
    )
    assert binding["state"] == "active"
    assert binding["created"] is True
    replayed_binding = vnext_task_store.register_binding(
        context, binding_id="binding-1", binding_generation="generation-1"
    )
    assert replayed_binding["created"] is False
    first, reused = vnext_task_store.create_task(
        context,
        task_id="task-1",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="transcript",
        entity_id="meeting-1",
        entity_revision=1,
        input_sha256=_hash(),
        generation_id="generation-1",
    )
    assert reused is False
    replay, reused = vnext_task_store.create_task(
        context,
        task_id="task-1",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="transcript",
        entity_id="meeting-1",
        entity_revision=1,
        input_sha256=_hash(),
        generation_id="generation-1",
    )
    assert reused is True
    assert replay["task_id"] == first["task_id"] == "task-1"


def test_attempt_lease_success_and_stale_commit_are_fenced(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-1", binding_generation="generation-1")
    vnext_task_store.create_task(
        context,
        task_id="task-1",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="summary",
        entity_id="meeting-1",
        entity_revision=2,
        input_sha256=_hash("b"),
        generation_id="summary-generation-1",
    )
    attempt = vnext_task_store.claim_attempt(context, "task-1", lease_owner="worker-a")
    assert attempt and attempt["state"] == "running"
    assert vnext_task_store.mark_success(
        context,
        "task-1",
        attempt["attempt_id"],
        {"artifact_id": "artifact-1"},
        lease_owner="worker-a",
    )
    assert not vnext_task_store.mark_success(
        context,
        "task-1",
        attempt["attempt_id"],
        {"artifact_id": "late"},
        lease_owner="worker-a",
    )
    assert vnext_task_store.get_task(context, "task-1")["state"] == "success"


def test_retry_is_new_attempt_and_cancel_is_terminal(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-1", binding_generation="generation-1")
    vnext_task_store.create_task(
        context,
        task_id="task-1",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="question",
        entity_id="meeting-1",
        entity_revision=1,
        input_sha256=_hash("c"),
        generation_id="question-generation-1",
    )
    first = vnext_task_store.claim_attempt(context, "task-1", lease_owner="worker-a")
    assert first
    assert vnext_task_store.mark_failure(
        context, "task-1", first["attempt_id"], "PROVIDER_TIMEOUT",
        retryable=True, lease_owner="worker-a"
    )
    second = vnext_task_store.claim_attempt(context, "task-1", lease_owner="worker-b")
    assert second and second["attempt_number"] == 2
    assert vnext_task_store.cancel_task(context, "task-1")
    assert vnext_task_store.get_task(context, "task-1")["state"] == "cancelled"
    assert vnext_task_store.claim_attempt(context, "task-1", lease_owner="worker-c") is None


def test_retry_not_before_survives_store_polling(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(
        context,
        binding_id="binding-retry-delay",
        binding_generation="generation-retry-delay",
    )
    vnext_task_store.create_task(
        context,
        task_id="task-retry-delay",
        binding_id="binding-retry-delay",
        binding_generation="generation-retry-delay",
        capability="transcript",
        entity_id="asset-retry-delay",
        entity_revision=1,
        input_sha256=_hash("d"),
        generation_id="generation-task-retry-delay",
    )
    first = vnext_task_store.claim_attempt(
        context,
        "task-retry-delay",
        lease_owner="worker-delay-a",
    )
    assert first is not None
    assert vnext_task_store.mark_failure(
        context,
        "task-retry-delay",
        first["attempt_id"],
        "ASR_UNAVAILABLE",
        retryable=True,
        retry_after_seconds=30,
        lease_owner="worker-delay-a",
    )
    task = vnext_task_store.get_task(context, "task-retry-delay")
    assert task is not None and task["retry_not_before_epoch"] is not None
    assert vnext_task_store.claim_attempt(
        context,
        "task-retry-delay",
        lease_owner="worker-delay-b",
    ) is None
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_tasks SET retry_not_before_epoch = 0 WHERE task_id = ?",
            ("task-retry-delay",),
        )
        connection.commit()
    second = vnext_task_store.claim_attempt(
        context,
        "task-retry-delay",
        lease_owner="worker-delay-b",
    )
    assert second is not None and second["attempt_number"] == 2


def test_terminal_task_closes_final_retryable_attempt(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-limit", binding_generation="generation-limit")
    vnext_task_store.create_task(
        context,
        task_id="task-limit",
        binding_id="binding-limit",
        binding_generation="generation-limit",
        capability="transcript",
        entity_id="asset-limit",
        entity_revision=1,
        input_sha256=_hash("e"),
        generation_id="generation-limit",
    )

    for number in (1, 2):
        attempt = vnext_task_store.claim_attempt(context, "task-limit", lease_owner=f"worker-{number}")
        assert attempt is not None and attempt["attempt_number"] == number
        assert vnext_task_store.mark_failure(
            context,
            "task-limit",
            attempt["attempt_id"],
            "PROVIDER_TIMEOUT",
            retryable=True,
            lease_owner=f"worker-{number}",
        )

    final = vnext_task_store.claim_attempt(context, "task-limit", lease_owner="worker-3")
    assert final is not None and final["attempt_number"] == 3
    assert vnext_task_store.mark_failure(
        context,
        "task-limit",
        final["attempt_id"],
        "PROVIDER_TIMEOUT",
        retryable=True,
        lease_owner="worker-3",
    )
    assert vnext_task_store.get_task(context, "task-limit")["state"] == "failure"
    with device_identity.control_connection() as connection:
        state = connection.execute(
            "SELECT state FROM vnext_task_attempts WHERE attempt_id = ?",
            (final["attempt_id"],),
        ).fetchone()[0]
    assert state == "terminal_failure"


def test_schema_reconciles_retryable_attempt_under_terminal_task(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-reconcile", binding_generation="generation-reconcile")
    vnext_task_store.create_task(
        context,
        task_id="task-reconcile",
        binding_id="binding-reconcile",
        binding_generation="generation-reconcile",
        capability="summary",
        entity_id="meeting-reconcile",
        entity_revision=1,
        input_sha256=_hash("f"),
        generation_id="generation-reconcile",
    )
    attempt = vnext_task_store.claim_attempt(context, "task-reconcile", lease_owner="worker-reconcile")
    assert attempt is not None
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_tasks SET state = 'failure', terminal_at = ? WHERE task_id = ?",
            ("2026-08-19T00:00:00+00:00", "task-reconcile"),
        )
        connection.execute(
            "UPDATE vnext_task_attempts SET state = 'retryable_failure' WHERE attempt_id = ?",
            (attempt["attempt_id"],),
        )
        connection.commit()
    vnext_task_store.ensure_vnext_task_schema()
    with device_identity.control_connection() as connection:
        state = connection.execute(
            "SELECT state FROM vnext_task_attempts WHERE attempt_id = ?",
            (attempt["attempt_id"],),
        ).fetchone()[0]
    assert state == "terminal_failure"


def test_binding_generation_cannot_be_reused(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-1", binding_generation="generation-1")
    with pytest.raises(vnext_task_store.VNextTaskError) as error:
        vnext_task_store.register_binding(context, binding_id="binding-2", binding_generation="generation-1")
    assert error.value.code == "BINDING_CONFLICT"


def test_client_binding_sequence_cannot_skip_high_water(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    with pytest.raises(vnext_task_store.VNextTaskError) as error:
        vnext_task_store.register_binding(
            context,
            binding_id="binding-gap",
            binding_generation="generation-gap",
            binding_epoch_seq=2,
        )
    assert error.value.code == "BINDING_SEQUENCE_GAP"


def test_binding_and_epoch_cancellation_fence_active_tasks(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-1", binding_generation="generation-1")
    vnext_task_store.create_task(
        context,
        task_id="task-binding",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="summary",
        entity_id="meeting-1",
        entity_revision=1,
        input_sha256=_hash("d"),
        generation_id="summary-generation-1",
    )
    vnext_task_store.create_task(
        context,
        task_id="task-epoch",
        binding_id="binding-1",
        binding_generation="generation-1",
        capability="question",
        entity_id="meeting-1",
        entity_revision=1,
        input_sha256=_hash("e"),
        generation_id="question-generation-1",
    )
    assert vnext_task_store.cancel_binding_tasks(context, "binding-1") == 2
    assert vnext_task_store.get_task(context, "task-binding")["state"] == "cancelled"
    assert vnext_task_store.get_task(context, "task-epoch")["state"] == "cancelled"
    assert vnext_task_store.cancel_epoch_tasks(context) == 0


def test_legacy_principal_owner_rows_upgrade_to_single_device_owner(tmp_path, monkeypatch) -> None:
    database = tmp_path / "vnext-owner-upgrade.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    device_identity.ensure_device_schema()
    device_id = str(uuid.uuid4())
    epoch_id = str(uuid.uuid4())
    with device_identity.control_connection() as connection:
        connection.execute(
            "INSERT INTO device_principals(id, device_id, credential_hash, created_at, last_seen_at) "
            "VALUES (7, ?, 'hash', 'now', 'now')",
            (device_id,),
        )
        connection.executescript(
            """
            CREATE TABLE vnext_bindings (
                principal_id INTEGER NOT NULL, epoch_id TEXT NOT NULL, binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL, binding_revision INTEGER NOT NULL DEFAULT 1,
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                PRIMARY KEY(principal_id, epoch_id, binding_id)
            );
            CREATE TABLE vnext_tasks (
                task_id TEXT PRIMARY KEY, principal_id INTEGER NOT NULL, epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL, binding_generation TEXT NOT NULL, capability TEXT NOT NULL,
                entity_id TEXT NOT NULL, entity_revision INTEGER NOT NULL, input_sha256 TEXT NOT NULL,
                generation_id TEXT NOT NULL, predecessor_task_id TEXT, creation_reason TEXT NOT NULL,
                state TEXT NOT NULL, cancel_revision INTEGER NOT NULL DEFAULT 0, current_attempt_id TEXT,
                result_kind TEXT, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, terminal_at TEXT
            );
            CREATE TABLE vnext_task_attempts (
                attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
                state TEXT NOT NULL, phase TEXT NOT NULL, lease_owner TEXT, lease_expires_at_epoch REAL,
                error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT
            );
            """
        )
        connection.execute(
            "INSERT INTO vnext_bindings VALUES (7, ?, 'legacy-binding', 'legacy-generation', 1, 0, 'active', 'now', 'now')",
            (epoch_id,),
        )
        connection.execute(
            "INSERT INTO vnext_tasks VALUES ('legacy-task', 7, ?, 'legacy-binding', 'legacy-generation', "
            "'summary', 'entity', 1, ?, 'legacy-task-generation', NULL, 'original', 'active', 0, NULL, "
            "NULL, NULL, NULL, 'now', 'now', NULL)",
            (epoch_id, _hash("f")),
        )
        connection.commit()

    vnext_task_store.ensure_vnext_task_schema()
    context = DeviceContext(7, device_id, epoch_id)
    assert vnext_task_store.get_binding(context, "legacy-binding")["binding_epoch_seq"] == 1
    assert vnext_task_store.get_task(context, "legacy-task")["task_id"] == "legacy-task"
    with device_identity.control_connection() as connection:
        assert "principal_id" not in {
            str(row[1]) for row in connection.execute("PRAGMA table_info(vnext_tasks)").fetchall()
        }
