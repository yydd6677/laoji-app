from __future__ import annotations

import pytest

from app.services import vnext_summary_worker as worker_module


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


@pytest.mark.asyncio
async def test_disabled_summary_worker_does_not_start(monkeypatch):
    monkeypatch.setenv("LAOJI_VNEXT_SUMMARY_SOURCE_STREAM_ENABLED", "0")
    worker = worker_module.VNextSummarySourceStreamWorker(scan_seconds=60)
    worker.start()
    assert worker._task is None
