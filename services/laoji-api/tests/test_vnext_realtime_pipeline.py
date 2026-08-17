from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest

from app.services import vnext_realtime_pipeline


@dataclass
class Segment:
    audio_data: np.ndarray
    start_ms: int = 0
    end_ms: int = 100


class OneSegmentVad:
    state = "idle"

    def __init__(self, emit: bool):
        self.emit = emit
        self.emitted = False

    def feed(self, audio):
        if self.emit and not self.emitted and np.any(audio):
            self.emitted = True
            return Segment(audio.copy())
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("emit_segment", "expected_outcomes"),
    [
        (True, ["text", "text"]),
        (False, ["no_speech"]),
    ],
)
async def test_realtime_pipeline_persists_before_publish(
    monkeypatch,
    emit_segment,
    expected_outcomes,
) -> None:
    context = object()
    pcm = (np.ones(1600, dtype="<i2") * 200).tobytes()
    chunks = [{
        "chunk_seq": 0,
        "start_ms": 0,
        "end_ms": 100,
        "encrypted_spool_locator": "chunk:one",
    }]
    persisted: list[dict] = []
    published: list[dict] = []

    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_store,
        "get_realtime_snapshot",
        lambda *_args, **_kwargs: {
            "session": {"last_durable_event_seq": 0},
            "events": [],
        },
    )

    def unconsumed(*_args, **_kwargs):
        return [] if any(item.get("consume_through_chunk_seq") == 0 for item in persisted) else list(chunks)

    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_store,
        "get_unconsumed_chunks",
        unconsumed,
    )
    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_crypto,
        "read_chunk",
        lambda _locator: pcm,
    )
    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_crypto,
        "seal_event",
        lambda _identity, _payload: b"encrypted-event",
    )
    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_crypto,
        "delete_chunk",
        lambda _locator: None,
    )

    def append_event(*_args, **kwargs):
        persisted.append(dict(kwargs))
        return {"event_seq": kwargs["event_seq"], "reused": False}

    monkeypatch.setattr(
        vnext_realtime_pipeline.vnext_realtime_store,
        "append_durable_event",
        append_event,
    )

    async def vad_factory():
        return OneSegmentVad(emit_segment)

    def asr_call(**kwargs):
        return {
            "id": kwargs["item_id"],
            "stable_segment_key": kwargs["item_id"],
            "segment_revision": 1,
            "text_state": "stable",
            "outcome": "text",
            "text": "项目进度正常",
            "language": "Chinese",
            "source_start_ms": kwargs["source_start_ms"],
            "source_end_ms": kwargs["source_end_ms"],
            "audio_ms": 100,
            "model_revision": "asr-revision-1",
            "queue_ms": 1,
            "infer_ms": 2,
        }

    async def send_event(event):
        assert len(persisted) > len(published)
        published.append(event)

    pipeline = vnext_realtime_pipeline.VNextRealtimeTextPipeline(
        context,
        "realtime-session-1",
        "a" * 32,
        send_event,
        vad_factory=vad_factory,
        asr_call=asr_call,
    )
    pipeline.start()
    pipeline.notify_chunk()
    await pipeline.finalize()

    assert [event["outcome"] for event in published] == expected_outcomes
    assert published[-1]["event_kind"] == "final"
    assert published[-1]["source_end_ms"] == 100
    assert [item["event_seq"] for item in persisted] == list(range(1, len(persisted) + 1))
