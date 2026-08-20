from __future__ import annotations

import pytest

from app.services import vnext_summary_worker as worker_module
from app.services.summary_v3_generator import SummaryV3GenerationError


@pytest.mark.asyncio
async def test_summary_worker_processes_one_chapter_without_creating_a_second_owner(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "get_task",
        lambda context, task_id: {
            "task_id": task_id,
            "state": "active",
            "source_stream_id": "stream-1",
        },
    )
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "claim_attempt",
        lambda *args, **kwargs: {
            "attempt_id": "task-1:attempt:1:test",
            "attempt_number": 1,
        },
    )

    def process(*args, **kwargs):
        calls.append(kwargs)
        return {"state": "chapter_committed", "task_id": "task-1"}

    worker = worker_module.VNextSummarySourceStreamWorker(process_chapter=process, scan_seconds=60)
    await worker._process(worker_module.SummaryTaskOwner("device-1", "epoch-1"), "task-1")

    assert len(calls) == 1
    assert calls[0]["handler_revision"] == worker_module.HANDLER_REVISION
    assert calls[0]["provider_revision"] == worker_module.PROVIDER_REVISION
    assert calls[0]["prompt_revision"]
    assert calls[0]["model_revision"]


def test_summary_worker_lease_meets_restart_recovery_budget() -> None:
    assert worker_module.LEASE_SECONDS == 30
    assert 0 < worker_module.HEARTBEAT_SECONDS < worker_module.LEASE_SECONDS


@pytest.mark.asyncio
async def test_disabled_summary_worker_does_not_start(monkeypatch):
    monkeypatch.setenv("LAOJI_VNEXT_SUMMARY_SOURCE_STREAM_ENABLED", "0")
    worker = worker_module.VNextSummarySourceStreamWorker(scan_seconds=60)
    worker.start()
    assert worker._task is None


def test_summary_worker_preserves_sanitized_generator_error_code() -> None:
    error = SummaryV3GenerationError(
        "SUMMARY_V3_FORMAT_INVALID",
        details={"repair_errors": [{"path": "facts.0.sources", "type": "missing"}]},
    )
    assert worker_module._safe_generation_failure(error) == (
        "SUMMARY_V3_FORMAT_INVALID",
        {"repair_errors": [{"path": "facts.0.sources", "type": "missing"}]},
    )
    assert worker_module._safe_generation_failure(RuntimeError("private text")) is None


@pytest.mark.asyncio
async def test_summary_worker_does_not_repeat_a_completed_generation_repair(monkeypatch):
    failures: list[dict] = []
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "get_task",
        lambda *_args: {
            "task_id": "task-1",
            "state": "active",
            "source_stream_id": "stream-1",
        },
    )
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "claim_attempt",
        lambda *_args, **_kwargs: {"attempt_id": "attempt-1", "attempt_number": 1},
    )
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "mark_failure",
        lambda *_args, **kwargs: failures.append(kwargs) or True,
    )

    def reject(*_args, **_kwargs):
        raise SummaryV3GenerationError("SUMMARY_V3_FORMAT_INVALID")

    worker = worker_module.VNextSummarySourceStreamWorker(
        process_chapter=reject,
        scan_seconds=60,
    )
    await worker._process(worker_module.SummaryTaskOwner("device-1", "epoch-1"), "task-1")

    assert failures == [{
        "retryable": False,
        "retry_after_seconds": 0,
        "lease_owner": worker._lease_owner,
    }]


@pytest.mark.asyncio
async def test_summary_worker_retries_preempted_background_generation_immediately(monkeypatch):
    failures: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "get_task",
        lambda *_args: {
            "task_id": "task-preempted",
            "state": "active",
            "source_stream_id": "stream-preempted",
        },
    )
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "claim_attempt",
        lambda *_args, **_kwargs: {
            "attempt_id": "attempt-preempted",
            "attempt_number": 1,
        },
    )
    monkeypatch.setattr(
        worker_module.vnext_task_store,
        "mark_failure",
        lambda *args, **kwargs: failures.append((args, kwargs)) or True,
    )

    def yield_to_interactive(*_args, **_kwargs):
        raise worker_module.LlmProviderPreempted("llm_background_preempted")

    worker = worker_module.VNextSummarySourceStreamWorker(
        process_chapter=yield_to_interactive,
        scan_seconds=60,
    )
    await worker._process(
        worker_module.SummaryTaskOwner("device-1", "epoch-1"),
        "task-preempted",
    )

    assert len(failures) == 1
    args, kwargs = failures[0]
    assert args[3] == "SUMMARY_BACKGROUND_PREEMPTED"
    assert kwargs == {
        "retryable": True,
        "retry_after_seconds": 0,
        "lease_owner": worker._lease_owner,
    }
