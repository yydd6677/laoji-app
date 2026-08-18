from __future__ import annotations

import asyncio
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
