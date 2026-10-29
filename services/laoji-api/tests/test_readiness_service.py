from __future__ import annotations

import asyncio
import threading
import time

import pytest

from app.services import readiness_service


def _reset_cache() -> None:
    readiness_service._LLM_READINESS_CACHE["value"] = None
    readiness_service._LLM_READINESS_CACHE["completed_at"] = 0.0
    readiness_service._LLM_READINESS_TASK = None


@pytest.mark.asyncio
async def test_readiness_returns_during_slow_probe_and_reuses_single_flight(monkeypatch):
    _reset_cache()
    calls = 0

    def slow_probe(*, probe: bool = False):
        nonlocal calls
        calls += 1
        time.sleep(0.08)
        return {
            "provider": "ollama",
            "generation_model": "qwen3.5:9b",
            "generation_ready": True,
            "embedding_provider": "ollama",
            "embedding_model": "qwen3-embedding:0.6b",
            "embedding_ready": True,
            "embedding_probe_latency_ms": 80.0,
            "embedding_probe_error": None,
            "queue": {"depth": 0},
            "probe_latency_ms": 80.0,
            "ready": True,
        }

    monkeypatch.setattr(readiness_service, "provider_state", slow_probe)
    started = time.perf_counter()
    first, second = await asyncio.gather(
        readiness_service._llm_readiness_state(),
        readiness_service._llm_readiness_state(),
    )
    elapsed = time.perf_counter() - started

    assert elapsed < 0.05
    assert first["ready"] is False
    assert second["ready"] is False
    assert calls == 1

    await asyncio.sleep(0.12)
    refreshed = await readiness_service._llm_readiness_state()
    assert refreshed["ready"] is True
    assert refreshed["generation_model"] == "qwen3.5:9b"
    assert calls == 1


@pytest.mark.asyncio
async def test_readiness_probe_failure_is_not_ready(monkeypatch):
    _reset_cache()

    def fail_probe(*, probe: bool = False):
        if probe:
            raise RuntimeError("probe failed")
        return {
            "provider": "ollama",
            "generation_model": "qwen3.5:9b",
            "embedding_provider": "ollama",
            "embedding_model": "qwen3-embedding:0.6b",
        }

    monkeypatch.setattr(readiness_service, "provider_state", fail_probe)
    await readiness_service._llm_readiness_state()
    await asyncio.sleep(0.02)
    state = await readiness_service._llm_readiness_state()
    assert state["ready"] is False
    assert state["embedding_ready"] is False


@pytest.mark.asyncio
async def test_cached_availability_does_not_cache_active_work_or_completed_inference(monkeypatch):
    _reset_cache()
    cached = {"ready": True, "generation_ready": True, "embedding_ready": True,
              "queue": {"depth": 0}, "inference": {"last_by_operation": {}}}
    readiness_service._LLM_READINESS_CACHE.update(
        value=cached, completed_at=asyncio.get_running_loop().time())
    runtime = {"queue": {"depth": 2, "active": {"operation": "question.q2.reader.v2"}},
               "inference": {"last_by_operation": {}}}
    monkeypatch.setattr(readiness_service, "provider_runtime_state", lambda: runtime)
    monkeypatch.setattr(readiness_service, "provider_state", lambda **kw: pytest.fail("warm health started I/O"))
    first = await readiness_service._llm_readiness_state()
    assert first["ready"] and first["queue"] == runtime["queue"]
    runtime = {"queue": {"depth": 0, "active": None}, "inference": {
        "last_by_operation": {"question.q2.reader.v2": {"call_count": 1}}}}
    second = await readiness_service._llm_readiness_state()
    assert second["ready"] and second["queue"]["active"] is None
    assert second["inference"] == runtime["inference"]
    assert readiness_service._LLM_READINESS_CACHE["value"] is cached
    assert cached["inference"] == {"last_by_operation": {}}
    assert readiness_service._LLM_READINESS_TASK is None


@pytest.mark.asyncio
async def test_cold_inflight_health_exposes_current_queue_without_waiting_for_probe(monkeypatch):
    _reset_cache()
    started, finish = threading.Event(), threading.Event()
    def slow_probe(**kwargs):
        started.set()
        assert finish.wait(2)
        return {"ready": True, "queue": {"depth": -1}, "inference": {"old": True}}
    monkeypatch.setattr(readiness_service, "provider_state", slow_probe)
    runtime = {"queue": {"depth": 1, "active": {"operation": "meeting.summary"}},
               "inference": {"last_by_operation": {}}}
    monkeypatch.setattr(readiness_service, "provider_runtime_state", lambda: runtime)
    try:
        first = await asyncio.wait_for(readiness_service._llm_readiness_state(), .2)
        assert not first["ready"] and first["queue"] == runtime["queue"]
        await asyncio.wait_for(asyncio.to_thread(started.wait), .5)
        runtime = {"queue": {"depth": 2, "active": None}, "inference": {"last_by_operation": {}}}
        second = await asyncio.wait_for(readiness_service._llm_readiness_state(), .2)
        assert not second["ready"] and second["queue"]["depth"] == 2
    finally:
        finish.set()
        await readiness_service._LLM_READINESS_TASK
    assert set(readiness_service._LLM_READINESS_CACHE["value"]) == {"ready"}
    assert (await readiness_service._llm_readiness_state())["queue"]["depth"] == 2
