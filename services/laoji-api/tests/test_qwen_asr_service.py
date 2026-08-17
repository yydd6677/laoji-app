from __future__ import annotations

import base64
import json
import threading
import time

import numpy as np
import pytest

from qwen_asr_service import server


def _pcm(value: int, samples: int = 1600) -> bytes:
    return np.full(samples, value, dtype="<i2").tobytes()


def _item(item_id: str, value: int) -> server.InferenceItem:
    pcm = np.frombuffer(_pcm(value), dtype="<i2").astype(np.float32) / 32768.0
    return server.InferenceItem(
        item_id=item_id,
        pcm=pcm,
        language="Chinese",
        source_start_ms=100,
        source_end_ms=200,
    )


def test_batch_contract_keeps_stable_ids_and_source_ranges():
    request = {
        "priority": "offline",
        "items": [
            {
                "id": "asset-1:chunk-0",
                "pcm_base64": base64.b64encode(_pcm(1)).decode("ascii"),
                "sample_rate": 16000,
                "language": "zh",
                "source_start_ms": 1200,
                "source_end_ms": 1300,
            },
            {
                "id": "asset-1:chunk-1",
                "pcm_base64": base64.b64encode(_pcm(2)).decode("ascii"),
                "sample_rate": 16000,
                "language": "auto",
                "source_start_ms": 1300,
                "source_end_ms": 1400,
            },
        ],
    }

    priority, items = server._parse_batch_request(json.dumps(request).encode())

    assert priority == "offline"
    assert [item.item_id for item in items] == ["asset-1:chunk-0", "asset-1:chunk-1"]
    assert [(item.source_start_ms, item.source_end_ms) for item in items] == [
        (1200, 1300),
        (1300, 1400),
    ]
    assert [item.language for item in items] == ["Chinese", None]


def test_batch_contract_rejects_duplicate_item_ids():
    encoded = base64.b64encode(_pcm(1)).decode("ascii")
    request = {
        "items": [
            {"id": "same", "pcm_base64": encoded},
            {"id": "same", "pcm_base64": encoded},
        ]
    }

    with pytest.raises(server.AsrServiceError, match="item_id_invalid"):
        server._parse_batch_request(json.dumps(request).encode())


def test_pending_realtime_precedes_pending_offline_batch(monkeypatch):
    first_started = threading.Event()
    release_first = threading.Event()
    observed: list[int] = []

    class Result:
        def __init__(self, value: int):
            self.text = f"result-{value}"
            self.language = "Chinese"

    class Model:
        def transcribe(self, *, audio, language):
            value = round(float(audio[0][0][0]) * 32768)
            observed.append(value)
            if value == 1:
                first_started.set()
                assert release_first.wait(5)
            return [Result(round(float(item[0][0]) * 32768)) for item in audio]

    monkeypatch.setattr(server, "MODEL_REVISION", "test-revision")
    coordinator = server.InferenceCoordinator(lambda: Model(), max_queued_requests=8)
    responses: dict[str, dict] = {}

    def submit(name: str, priority: str, value: int) -> None:
        responses[name] = coordinator.submit(priority, [_item(name, value)])

    first = threading.Thread(target=submit, args=("first", "offline", 1))
    first.start()
    assert first_started.wait(5)
    second = threading.Thread(target=submit, args=("second", "offline", 2))
    realtime = threading.Thread(target=submit, args=("live", "realtime", 3))
    second.start()
    realtime.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and coordinator.snapshot()["depth"] < 2:
        time.sleep(0.01)
    release_first.set()
    for thread in (first, second, realtime):
        thread.join(5)
        assert not thread.is_alive()
    coordinator.close()

    assert observed == [1, 3, 2]
    assert responses["live"]["priority"] == "realtime"
    assert responses["live"]["items"][0]["id"] == "live"
    assert responses["live"]["items"][0]["model_revision"] == "test-revision"
    assert responses["live"]["items"][0]["source_start_ms"] == 100
    assert responses["live"]["items"][0]["source_end_ms"] == 200


def test_empty_pcm_is_a_valid_no_speech_result(monkeypatch):
    class Model:
        def transcribe(self, **_kwargs):
            raise AssertionError("empty audio must not reach the model")

    monkeypatch.setattr(server, "MODEL_REVISION", "test-revision")
    coordinator = server.InferenceCoordinator(lambda: Model())
    response = coordinator.submit(
        "schedule",
        [
            server.InferenceItem(
                item_id="empty",
                pcm=np.empty(0, dtype=np.float32),
                language="Chinese",
                source_start_ms=0,
                source_end_ms=0,
            )
        ],
    )
    coordinator.close()

    assert response["items"][0]["text"] == ""
    assert response["items"][0]["infer_ms"] == 0
