import asyncio
import time
from threading import Event

import pytest

from app.config import settings
from app.services import summary_task_store
from app.workers import summary_tasks


@pytest.fixture(autouse=True)
def isolate_summary_task_registry(tmp_path, monkeypatch):
    monkeypatch.setattr(
        settings,
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'summary-tasks.db'}",
    )
    summary_task_store.reset_store_for_tests()
    with summary_tasks._summary_task_lock:
        summary_tasks._submitted_tasks.clear()
        summary_tasks._guest_summary_task_ids.clear()
        summary_tasks._task_completed_at.clear()
        summary_tasks._task_metadata.clear()
        summary_tasks._task_ids_by_dedupe_key.clear()
        summary_tasks._serialized_task_futures.clear()
    yield
    for future in list(summary_tasks._submitted_tasks.values()):
        try:
            future.result(timeout=2)
        except Exception:
            pass
    with summary_tasks._summary_task_lock:
        summary_tasks._submitted_tasks.clear()
        summary_tasks._guest_summary_task_ids.clear()
        summary_tasks._task_completed_at.clear()
        summary_tasks._task_metadata.clear()
        summary_tasks._task_ids_by_dedupe_key.clear()
        summary_tasks._serialized_task_futures.clear()


def test_payload_fingerprint_is_stable_and_input_sensitive():
    lines = [{"speaker": "甲", "text": "确认周五发布", "start": 0, "end": 2}]
    first = summary_tasks.summary_payload_fingerprint(lines, "发布会", "2026-07-13")

    assert summary_tasks.summary_payload_fingerprint(lines, "发布会", "2026-07-13") == first
    assert summary_tasks.summary_payload_fingerprint(
        [{**lines[0], "text": "改为下周发布"}],
        "发布会",
        "2026-07-13",
    ) != first
    assert summary_tasks.summary_payload_fingerprint(lines, "另一个标题", "2026-07-13") != first


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1", 1),
        ("2", 2),
        ("4", 4),
        ("0", 1),
        ("99", 4),
        ("invalid", 1),
    ],
)
def test_summary_worker_concurrency_is_bounded(value, expected):
    assert summary_tasks._configured_summary_worker_count(value) == expected


def test_summary_worker_concurrency_defaults_to_one(monkeypatch):
    monkeypatch.delenv("SUMMARY_WORKER_CONCURRENCY", raising=False)
    assert summary_tasks._configured_summary_worker_count() == 1


def test_same_meeting_final_summaries_run_in_submission_order():
    first_started = Event()
    release_first = Event()
    second_started = Event()

    def first_worker():
        first_started.set()
        assert release_first.wait(timeout=2)
        return {"overview": "first"}

    def second_worker():
        second_started.set()
        return {"overview": "second"}

    first = summary_tasks._submit_summary_future(
        label="first",
        worker=first_worker,
        worker_args=(),
        meeting_id="same-meeting",
        task_scope="user:1",
        task_kind="final",
    )
    assert first_started.wait(timeout=2)
    second = summary_tasks._submit_summary_future(
        label="second",
        worker=second_worker,
        worker_args=(),
        meeting_id="same-meeting",
        task_scope="user:1",
        task_kind="final",
    )

    assert not second_started.wait(timeout=0.1)
    release_first.set()
    assert summary_tasks._submitted_tasks[first.id].result(timeout=2)["overview"] == "first"
    assert summary_tasks._submitted_tasks[second.id].result(timeout=2)["overview"] == "second"
    assert second_started.is_set()


def test_different_meetings_can_use_both_summary_workers():
    both_started = Event()
    release = Event()
    started_count = 0
    started_lock = summary_tasks.Lock()

    def worker():
        nonlocal started_count
        with started_lock:
            started_count += 1
            if started_count == 2:
                both_started.set()
        assert release.wait(timeout=2)
        return {"overview": "done"}

    original_executor = summary_tasks._summary_executor
    test_executor = summary_tasks.ThreadPoolExecutor(max_workers=2)
    summary_tasks._summary_executor = test_executor
    first = None
    second = None
    try:
        first = summary_tasks._submit_summary_future(
            label="meeting-a",
            worker=worker,
            worker_args=(),
            meeting_id="meeting-a",
            task_scope="user:1",
            task_kind="final",
        )
        second = summary_tasks._submit_summary_future(
            label="meeting-b",
            worker=worker,
            worker_args=(),
            meeting_id="meeting-b",
            task_scope="user:1",
            task_kind="final",
        )
        assert both_started.wait(timeout=2)
    finally:
        release.set()
        if first is not None:
            summary_tasks._submitted_tasks[first.id].result(timeout=2)
        if second is not None:
            summary_tasks._submitted_tasks[second.id].result(timeout=2)
        test_executor.shutdown(wait=True)
        summary_tasks._summary_executor = original_executor


def test_identical_active_and_recent_success_tasks_are_reused_but_force_is_not():
    started = Event()
    release = Event()

    def worker():
        started.set()
        assert release.wait(timeout=2)
        return {"overview": "完成"}

    first = summary_tasks._submit_summary_future(
        label="test",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="same-input",
    )
    assert started.wait(timeout=2)
    duplicate = summary_tasks._submit_summary_future(
        label="test",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="same-input",
    )

    assert duplicate.id == first.id
    assert duplicate.reused is True
    release.set()
    summary_tasks._submitted_tasks[first.id].result(timeout=2)

    replay = summary_tasks._submit_summary_future(
        label="test",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="same-input",
    )
    forced = summary_tasks._submit_summary_future(
        label="test",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="same-input",
        force=True,
    )

    assert replay.id == first.id and replay.reused is True
    assert forced.id != first.id and forced.reused is False


def test_task_status_requires_matching_user_scope_and_meeting():
    task = summary_tasks._submit_summary_future(
        label="ownership",
        worker=lambda: {"overview": "私有总结"},
        worker_args=(),
        meeting_id="meeting-owner",
        task_scope="user:7",
        task_kind="final",
    )
    summary_tasks._submitted_tasks[task.id].result(timeout=2)

    owned_status = summary_tasks.get_submitted_summary_status(
        task.id,
        expected_scope="user:7",
        expected_meeting_id="meeting-owner",
    )
    assert owned_status["status"] == "SUCCESS"
    assert owned_status["long_poll_supported"] is True
    assert summary_tasks.get_submitted_summary_status(
        task.id,
        expected_scope="user:8",
        expected_meeting_id="meeting-owner",
    ) is None
    assert summary_tasks.get_submitted_summary_status(
        task.id,
        expected_scope="user:7",
        expected_meeting_id="meeting-other",
    ) is None


def test_long_poll_returns_as_soon_as_the_task_finishes():
    started = Event()
    release = Event()

    def worker():
        started.set()
        assert release.wait(timeout=2)
        return {"overview": "长轮询拿到结果"}

    task = summary_tasks._submit_summary_future(
        label="long-poll",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-long-poll",
        task_scope="user:7",
        task_kind="final",
    )
    assert started.wait(timeout=2)

    async def scenario():
        waiter = asyncio.create_task(summary_tasks.wait_for_submitted_summary_status(
            task.id,
            timeout_seconds=1,
            expected_scope="user:7",
            expected_meeting_id="meeting-long-poll",
        ))
        await asyncio.sleep(0.02)
        assert not waiter.done()
        released_at = time.perf_counter()
        release.set()
        status = await waiter
        return status, (time.perf_counter() - released_at) * 1000

    status, completion_delay_ms = asyncio.run(scenario())
    assert status["status"] == "SUCCESS"
    assert status["result"]["overview"] == "长轮询拿到结果"
    assert completion_delay_ms < 250


def test_long_poll_timeout_and_ownership_checks_do_not_block():
    started = Event()
    release = Event()

    def worker():
        started.set()
        assert release.wait(timeout=2)
        return {"overview": "完成"}

    task = summary_tasks._submit_summary_future(
        label="long-poll-timeout",
        worker=worker,
        worker_args=(),
        meeting_id="meeting-owner",
        task_scope="user:7",
        task_kind="final",
    )
    assert started.wait(timeout=2)

    async def scenario():
        rejected_started = time.perf_counter()
        rejected = await summary_tasks.wait_for_submitted_summary_status(
            task.id,
            timeout_seconds=0.5,
            expected_scope="user:8",
            expected_meeting_id="meeting-owner",
        )
        rejected_ms = (time.perf_counter() - rejected_started) * 1000
        timed_started = time.perf_counter()
        timed = await summary_tasks.wait_for_submitted_summary_status(
            task.id,
            timeout_seconds=0.03,
            expected_scope="user:7",
            expected_meeting_id="meeting-owner",
        )
        timed_ms = (time.perf_counter() - timed_started) * 1000
        return rejected, rejected_ms, timed, timed_ms

    try:
        rejected, rejected_ms, timed, timed_ms = asyncio.run(scenario())
        assert rejected is None
        assert rejected_ms < 100
        assert timed["status"] == "STARTED"
        assert 20 <= timed_ms < 250
    finally:
        release.set()


def test_guest_long_poll_rejects_non_guest_tasks():
    task = summary_tasks._submit_summary_future(
        label="private",
        worker=lambda: {"overview": "私有"},
        worker_args=(),
        meeting_id="meeting-private",
        task_scope="user:7",
        task_kind="final",
    )
    summary_tasks._submitted_tasks[task.id].result(timeout=2)

    assert asyncio.run(summary_tasks.wait_for_guest_summary_status(
        task.id,
        timeout_seconds=0.5,
    )) is None


def test_failed_task_is_not_reused():
    def fail():
        raise RuntimeError("model failed")

    first = summary_tasks._submit_summary_future(
        label="failure",
        worker=fail,
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="failed-input",
    )
    with pytest.raises(RuntimeError, match="model failed"):
        summary_tasks._submitted_tasks[first.id].result(timeout=2)

    second = summary_tasks._submit_summary_future(
        label="failure",
        worker=lambda: {"overview": "recovered"},
        worker_args=(),
        meeting_id="meeting-1",
        task_scope="user:1",
        task_kind="final",
        dedupe_key="failed-input",
    )
    assert second.id != first.id
