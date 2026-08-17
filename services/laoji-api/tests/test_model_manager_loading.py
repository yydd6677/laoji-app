import asyncio
import concurrent.futures
import threading
import time

import numpy as np
import pytest
import torch

from app.asr import campplus_features
from app.asr.model_manager import ModelManager, ModelPaths, SpeakerEmbeddingExtractor


@pytest.mark.asyncio
async def test_qwen_support_initialization_loads_only_vad_and_speaker_models(monkeypatch):
    manager = ModelManager()
    manager._paths = ModelPaths("", "cpu", "")

    calls = {"vad": 0, "campplus": 0}

    def load_vad():
        calls["vad"] += 1
        time.sleep(0.02)
        manager.vad_model = object()

    def load_campplus():
        calls["campplus"] += 1
        time.sleep(0.02)
        manager.camp_model = object()

    monkeypatch.setattr(manager, "_load_vad", load_vad)
    monkeypatch.setattr(manager, "_load_campplus", load_campplus)

    await asyncio.gather(*(manager.initialize() for _ in range(4)))

    assert manager.get_vad_model() is not None
    assert manager.get_camp_model() is not None
    assert manager.required_models_ready() is True
    assert calls == {"vad": 1, "campplus": 1}


def test_qwen_support_readiness_requires_vad_and_chinese_speaker_model():
    manager = object.__new__(ModelManager)
    manager._initialized = True
    manager.vad_model = object()
    manager.camp_model = None

    assert manager.required_models_ready() is False

    manager.camp_model = object()
    assert manager.required_models_ready() is True


def test_realtime_sessions_receive_independent_stateful_vad_instances(monkeypatch):
    class ProbeVad:
        def __init__(self, instance_id):
            self.instance_id = instance_id
            self.eval_called = False
            self.reset_called = False

        def eval(self):
            self.eval_called = True

        def reset_states(self):
            self.reset_called = True

    created = []

    def fake_load(_path, map_location):
        model = ProbeVad((len(created), str(map_location)))
        created.append(model)
        return model

    monkeypatch.setattr(torch.jit, "load", fake_load)
    manager = ModelManager()
    manager.vad_model = ProbeVad("template")
    manager._vad_jit_file = "/models/silero-vad.jit"
    manager._paths = ModelPaths("", "cpu", "")

    first = manager.create_vad_model()
    second = manager.create_vad_model()

    assert first is not second
    assert len(created) == 2
    assert first.eval_called is True
    assert first.reset_called is True
    assert second.eval_called is True
    assert second.reset_called is True


def test_shared_campplus_model_is_serialized_across_realtime_extractors(monkeypatch):
    state_lock = threading.Lock()
    active = 0
    max_active = 0

    class ProbeModel:
        def __call__(self, _features):
            nonlocal active, max_active
            with state_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return torch.ones((1, 192), dtype=torch.float32)

    monkeypatch.setattr(
        campplus_features,
        "extract_feature",
        lambda _audio: (torch.zeros((1, 10, 80)), [10], [1600]),
    )
    model = ProbeModel()
    extractors = [SpeakerEmbeddingExtractor(model, device="cpu") for _ in range(4)]
    audio = np.zeros(1600, dtype=np.float32)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        outputs = list(executor.map(lambda item: item.extract(audio), extractors))

    assert all(output.shape == (192,) for output in outputs)
    assert max_active == 1
