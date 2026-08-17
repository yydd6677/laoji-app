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


def test_binding_generation_cannot_be_reused(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path, monkeypatch)
    vnext_task_store.register_binding(context, binding_id="binding-1", binding_generation="generation-1")
    with pytest.raises(vnext_task_store.VNextTaskError) as error:
        vnext_task_store.register_binding(context, binding_id="binding-2", binding_generation="generation-1")
    assert error.value.code == "BINDING_CONFLICT"


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
