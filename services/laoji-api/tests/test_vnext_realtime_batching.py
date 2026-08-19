from __future__ import annotations

import numpy as np
import pytest

from app.services import vnext_realtime_pipeline


class Segment:
    def __init__(self, start_ms: int, end_ms: int, value: int) -> None:
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.audio_data = np.full((end_ms - start_ms) * 16, value, dtype=np.float32)


def _pipeline(*, asr_call, asr_batch_call):
    return vnext_realtime_pipeline.VNextRealtimeTextPipeline(
        object(),
        "session-batch-test",
        "a" * 32,
        "task-batch-test",
        "b" * 32,
        "attempt-batch-test",
        "realtime:session-batch-test",
        lambda _event: None,
        asr_call=asr_call,
        asr_batch_call=asr_batch_call,
    )


@pytest.mark.asyncio
async def test_same_drain_uses_one_batch_call_and_commits_source_order(monkeypatch) -> None:
    scalar_calls = []
    batch_calls = []
    committed = []

    def scalar(**kwargs):
        scalar_calls.append(kwargs)
        raise AssertionError("multi-segment drain must not use scalar ASR")

    def batch(*, items, priority):
        batch_calls.append((items, priority))
        return {
            "items": [
                {
                    "id": item["id"],
                    "stable_segment_key": item["id"],
                    "segment_revision": 1,
                    "outcome": "text",
                    "text": f"文字-{index}",
                    "source_start_ms": item["source_start_ms"],
                    "source_end_ms": item["source_end_ms"],
                    "model_revision": "asr-r1",
                }
                for index, item in enumerate(items, start=1)
            ]
        }

    pipeline = _pipeline(asr_call=scalar, asr_batch_call=batch)
    pipeline._timeline_offset_ms = 100

    async def commit(segment, stable_key, pcm16, start_ms, end_ms, result):
        del pcm16
        committed.append((segment.start_ms, stable_key, start_ms, end_ms, result["text"]))

    monkeypatch.setattr(
        pipeline,
        "_commit_segment",
        commit,
    )

    await pipeline._publish_segments([
        Segment(0, 200, 100),
        Segment(350, 600, 200),
    ])

    assert scalar_calls == []
    assert len(batch_calls) == 1
    assert batch_calls[0][1] == "realtime"
    assert [row[0] for row in committed] == [0, 350]
    assert [row[2:4] for row in committed] == [(100, 300), (450, 700)]


@pytest.mark.asyncio
async def test_batch_item_mismatch_fails_before_any_commit(monkeypatch) -> None:
    committed = []

    def batch(*, items, priority):
        del priority
        result = [
            {
                "id": items[0]["id"],
                "stable_segment_key": items[0]["id"],
                "segment_revision": 1,
                "outcome": "text",
                "text": "第一段",
                "source_start_ms": items[0]["source_start_ms"],
                "source_end_ms": items[0]["source_end_ms"],
                "model_revision": "asr-r1",
            },
            {
                "id": items[1]["id"],
                "stable_segment_key": items[1]["id"],
                "segment_revision": 1,
                "outcome": "text",
                "text": "第二段",
                "source_start_ms": items[1]["source_start_ms"] + 1,
                "source_end_ms": items[1]["source_end_ms"],
                "model_revision": "asr-r1",
            },
        ]
        return {"items": result}

    pipeline = _pipeline(
        asr_call=lambda **_kwargs: pytest.fail("scalar path was not expected"),
        asr_batch_call=batch,
    )

    async def commit(*_args):
        committed.append(True)

    monkeypatch.setattr(
        pipeline,
        "_commit_segment",
        commit,
    )

    with pytest.raises(RuntimeError, match="realtime_asr_batch_item_mismatch"):
        await pipeline._publish_segments([Segment(0, 200, 100), Segment(300, 500, 200)])
    assert committed == []
