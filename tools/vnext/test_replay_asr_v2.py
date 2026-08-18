from __future__ import annotations

import pytest

from tools.vnext.replay_asr_v2 import Chunk, validate_batch_response


def _response(*chunks: Chunk) -> dict:
    return {
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "model_revision": "model-revision-1",
        "items": [
            {
                "id": f"replay-{chunk.index:06d}",
                "stable_segment_key": f"replay-{chunk.index:06d}",
                "segment_revision": 1,
                "text_state": "stable",
                "source_start_ms": chunk.start_ms,
                "source_end_ms": chunk.end_ms,
                "outcome": "text",
                "text": "测试",
            }
            for chunk in chunks
        ],
    }


def test_validate_batch_response_accepts_exact_identity_and_ranges() -> None:
    chunks = [Chunk(0, 0, 1000, b"pcm"), Chunk(1, 1000, 2000, b"pcm")]
    assert validate_batch_response(_response(*chunks), chunks, None) == "model-revision-1"


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda value: value.update(schema_version=1), "contract revision"),
        (lambda value: value.update(model_revision="unresolved"), "pinned model revision"),
        (lambda value: value["items"].append(dict(value["items"][0])), "item count"),
        (lambda value: value["items"][0].update(source_end_ms=999), "source range mismatch"),
        (lambda value: value["items"][0].update(stable_segment_key="other"), "stable segment key"),
        (lambda value: value["items"][0].update(outcome="no_speech"), "text/outcome mismatch"),
    ],
)
def test_validate_batch_response_rejects_contract_drift(mutation, message: str) -> None:
    chunks = [Chunk(0, 0, 1000, b"pcm")]
    response = _response(*chunks)
    mutation(response)
    with pytest.raises(RuntimeError, match=message):
        validate_batch_response(response, chunks, None)


def test_validate_batch_response_rejects_revision_change() -> None:
    chunk = Chunk(0, 0, 1000, b"pcm")
    with pytest.raises(RuntimeError, match="revision changed"):
        validate_batch_response(_response(chunk), [chunk], "model-revision-2")
