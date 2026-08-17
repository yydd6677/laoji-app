import asyncio

import pytest

from app.asr.model_manager import ModelManager


@pytest.mark.asyncio
async def test_text_pipeline_can_initialize_vad_without_waiting_for_campplus(monkeypatch):
    manager = ModelManager()
    calls = {"vad": 0, "campplus": 0}

    def load_vad():
        calls["vad"] += 1
        manager.vad_model = object()

    def load_campplus():
        calls["campplus"] += 1
        manager.camp_model = object()

    monkeypatch.setattr(manager, "_load_vad", load_vad)
    monkeypatch.setattr(manager, "_load_campplus", load_campplus)

    await asyncio.gather(*(manager.initialize_vad() for _ in range(4)))

    assert manager.get_vad_model() is not None
    assert manager.get_camp_model() is None
    assert calls == {"vad": 1, "campplus": 0}
