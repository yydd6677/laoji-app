from __future__ import annotations

import sqlite3
import socket
import time

from app.config import settings
from app.services import summary_task_store
from app.workers import summary_tasks


def _use_store(tmp_path, monkeypatch):
    monkeypatch.setattr(
        settings,
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'summary-tasks.db'}",
    )
    summary_task_store.reset_store_for_tests()
    with summary_tasks._summary_task_lock:
        summary_tasks._submitted_tasks.clear()
        summary_tasks._task_metadata.clear()
        summary_tasks._task_completed_at.clear()
        summary_tasks._task_ids_by_dedupe_key.clear()
        summary_tasks._serialized_task_futures.clear()


def _wait_status(task_id: str, expected: str):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = summary_tasks.get_submitted_summary_status(task_id)
        if status and status["status"] == expected:
            return status
        time.sleep(0.01)
    raise AssertionError(summary_tasks.get_submitted_summary_status(task_id))


def test_successful_summary_identity_survives_memory_loss(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    task = summary_tasks._submit_summary_future(
        label="test",
        worker=lambda meeting_id, value: {"meeting_id": meeting_id, "value": value},
        worker_args=("meeting-1", 7),
        meeting_id="meeting-1",
        task_scope="user:7",
        task_kind="final",
        dedupe_key="same-input",
    )
    status = _wait_status(task.id, "SUCCESS")
    assert status["result"] == {"meeting_id": "meeting-1", "value": 7}

    with summary_tasks._summary_task_lock:
        summary_tasks._submitted_tasks.clear()
        summary_tasks._task_metadata.clear()
    persisted = summary_tasks.get_submitted_summary_status(
        task.id,
        expected_scope="user:7",
        expected_meeting_id="meeting-1",
    )
    assert persisted["status"] == "SUCCESS"
    assert persisted["result"] == status["result"]

    replay = summary_tasks._submit_summary_future(
        label="test",
        worker=lambda *_args: {"unexpected": True},
        worker_args=("meeting-1", 7),
        meeting_id="meeting-1",
        task_scope="user:7",
        task_kind="final",
        dedupe_key="same-input",
    )
    assert replay.id == task.id
    assert replay.reused is True


def test_device_result_body_expires_but_task_identity_remains(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    record, reused = summary_task_store.create_task(
        task_id="device-expiring-task",
        task_kind="device-final",
        task_scope="device:1:epoch-1",
        meeting_id="meeting-1",
        dedupe_key="device-input",
        request={"worker_args": ["meeting-1", "general", 2]},
        force=False,
        retain_generated_result=False,
        result_ttl_seconds=60,
    )
    assert reused is False
    assert record["retain_generated_result"] is False
    assert summary_task_store.claim_task("device-expiring-task", "worker", lease_seconds=30)
    assert summary_task_store.mark_success(
        "device-expiring-task", {"overview": "只保留一小时"}, lease_owner="worker"
    )

    assert summary_task_store.latest_device_summary_result(
        task_scope="device:1:epoch-1", meeting_id="meeting-1"
    ) == {"overview": "只保留一小时"}
    assert summary_task_store.purge_expired_results("2099-01-01T00:00:00+00:00") == 1
    assert summary_task_store.get_task("device-expiring-task")["status"] == "success"
    assert summary_task_store.get_task("device-expiring-task")["result"] is None
    assert summary_task_store.latest_device_summary_result(
        task_scope="device:1:epoch-1", meeting_id="meeting-1"
    ) is None


def test_device_retained_result_has_no_expiry(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    record, _ = summary_task_store.create_task(
        task_id="device-retained-task",
        task_kind="device-final",
        task_scope="device:1:epoch-1",
        meeting_id="meeting-1",
        dedupe_key="device-retained-input",
        request={"worker_args": ["meeting-1", "general", 2]},
        force=False,
        retain_generated_result=True,
        result_ttl_seconds=60,
    )
    assert record["retain_generated_result"] is True
    assert record["result_expires_at"] is None


def test_queued_summary_is_resumed_with_same_task_id(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    record, reused = summary_task_store.create_task(
        task_id="persistent-task-1",
        task_kind="final",
        task_scope="user:7",
        meeting_id="meeting-1",
        dedupe_key="resume-input",
        request={"worker_args": ["meeting-1", "payload"]},
        force=False,
    )
    assert reused is False
    assert record["status"] == "queued"
    monkeypatch.setattr(
        summary_tasks,
        "_do_final_summary",
        lambda meeting_id, payload: {"meeting_id": meeting_id, "payload": payload},
    )

    assert summary_tasks.recover_persistent_summary_jobs() == 1
    status = _wait_status("persistent-task-1", "SUCCESS")

    assert status["result"] == {"meeting_id": "meeting-1", "payload": "payload"}
    stored = summary_task_store.get_task("persistent-task-1")
    assert stored["attempt"] == 1


def test_failure_status_is_chinese_and_persistent(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)

    def fail(*_args):
        raise RuntimeError("provider internals must not be shown")

    task = summary_tasks._submit_summary_future(
        label="test",
        worker=fail,
        worker_args=("meeting-1",),
        meeting_id="meeting-1",
        task_scope="user:7",
        task_kind="final",
    )
    status = _wait_status(task.id, "FAILURE")
    assert status["result"] == "整理生成失败，请稍后重试"
    with summary_tasks._summary_task_lock:
        summary_tasks._submitted_tasks.clear()
        summary_tasks._task_metadata.clear()
    assert summary_tasks.get_submitted_summary_status(task.id)["result"] == (
        "整理生成失败，请稍后重试"
    )


def test_summary_artifact_id_is_stable_for_retried_task():
    token = summary_tasks._ACTIVE_SUMMARY_TASK_ID.set("task-stable-1")
    try:
        first = summary_tasks._stable_summary_id("final", "meeting-1")
        second = summary_tasks._stable_summary_id("final", "meeting-1")
    finally:
        summary_tasks._ACTIVE_SUMMARY_TASK_ID.reset(token)
    assert first == second


def test_guest_summary_does_not_write_persistent_checkpoint(monkeypatch):
    captured = {}

    def fake_generate(_text, **kwargs):
        captured.update(kwargs)
        return {
            "overview": "游客整理成功。",
            "key_decisions": [],
            "action_items": [],
        }

    monkeypatch.setattr(summary_tasks, "generate_progressive_summary", fake_generate)
    task_token = summary_tasks._ACTIVE_SUMMARY_TASK_ID.set("guest-task-1")
    lease_token = summary_tasks._ACTIVE_SUMMARY_LEASE_OWNER.set(None)
    try:
        result = summary_tasks._try_compact_summary(
            "发言人：这是一段需要整理的会议内容。",
            "guest-final",
            {"id": "general", "revision": 1},
        )
    finally:
        summary_tasks._ACTIVE_SUMMARY_LEASE_OWNER.reset(lease_token)
        summary_tasks._ACTIVE_SUMMARY_TASK_ID.reset(task_token)

    assert result["overview"] == "游客整理成功。"
    assert captured["checkpoint"] is None
    assert captured["checkpoint_callback"] is None


def test_summary_lease_prevents_stale_worker_from_overwriting_result(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    summary_task_store.create_task(
        task_id="leased-task-1",
        task_kind="final",
        task_scope="user:7",
        meeting_id="meeting-1",
        dedupe_key=None,
        request={"worker_args": ["meeting-1", []]},
        force=False,
    )

    assert summary_task_store.claim_task(
        "leased-task-1",
        "worker-old",
        lease_seconds=30,
    ) is True
    assert summary_task_store.claim_task(
        "leased-task-1",
        "worker-new",
        lease_seconds=30,
    ) is False
    assert summary_task_store.recoverable_tasks() == []

    database = tmp_path / "summary-tasks.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE summary_tasks_v2 SET lease_expires_at_epoch = 0 WHERE id = ?",
            ("leased-task-1",),
        )
        connection.commit()

    assert [item["id"] for item in summary_task_store.recoverable_tasks()] == [
        "leased-task-1"
    ]
    assert summary_task_store.claim_task(
        "leased-task-1",
        "worker-new",
        lease_seconds=30,
    ) is True
    assert summary_task_store.mark_success(
        "leased-task-1",
        {"overview": "旧结果"},
        lease_owner="worker-old",
    ) is False
    assert summary_task_store.mark_success(
        "leased-task-1",
        {"overview": "新结果"},
        lease_owner="worker-new",
    ) is True
    assert summary_task_store.get_task("leased-task-1")["result"] == {
        "overview": "新结果"
    }


def test_invalid_expired_task_can_be_failed_by_recovery(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    summary_task_store.create_task(
        task_id="invalid-expired-task",
        task_kind="unknown",
        task_scope="user:7",
        meeting_id="meeting-1",
        dedupe_key=None,
        request={},
        force=False,
    )
    assert summary_task_store.claim_task(
        "invalid-expired-task",
        "old-worker",
        lease_seconds=30,
    ) is True
    with sqlite3.connect(tmp_path / "summary-tasks.db") as connection:
        connection.execute(
            "UPDATE summary_tasks_v2 SET lease_expires_at_epoch = 0 WHERE id = ?",
            ("invalid-expired-task",),
        )
        connection.commit()

    assert summary_task_store.mark_failure(
        "invalid-expired-task",
        "summary_task_request_invalid",
    ) is True
    assert summary_task_store.get_task("invalid-expired-task")["status"] == "failure"


def test_dead_local_worker_lease_is_requeued_at_startup(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    summary_task_store.create_task(
        task_id="orphaned-local-task",
        task_kind="final",
        task_scope="user:7",
        meeting_id="meeting-1",
        dedupe_key=None,
        request={"worker_args": ["meeting-1", []]},
        force=False,
    )
    owner = f"{socket.gethostname()}:424242:dead-instance"
    assert summary_task_store.claim_task(
        "orphaned-local-task",
        owner,
        lease_seconds=180,
    ) is True
    monkeypatch.setattr(summary_task_store, "_pid_is_alive", lambda _pid: False)

    assert summary_task_store.requeue_orphaned_local_tasks() == 1
    stored = summary_task_store.get_task("orphaned-local-task")
    assert stored["status"] == "queued"
    assert stored["lease_owner"] is None
    assert stored["checkpoint"] is None


def test_live_or_remote_worker_lease_is_not_requeued(tmp_path, monkeypatch):
    _use_store(tmp_path, monkeypatch)
    for task_id, owner in (
        ("live-local-task", f"{socket.gethostname()}:1234:live-instance"),
        ("remote-task", "another-host:5678:remote-instance"),
    ):
        summary_task_store.create_task(
            task_id=task_id,
            task_kind="final",
            task_scope="user:7",
            meeting_id="meeting-1",
            dedupe_key=None,
            request={"worker_args": ["meeting-1", []]},
            force=False,
        )
        assert summary_task_store.claim_task(task_id, owner, lease_seconds=180)
    monkeypatch.setattr(summary_task_store, "_pid_is_alive", lambda _pid: True)

    assert summary_task_store.requeue_orphaned_local_tasks() == 0
    assert summary_task_store.get_task("live-local-task")["status"] == "running"
    assert summary_task_store.get_task("remote-task")["status"] == "running"
