import pytest

from app.services import app_meeting_retrieval as retrieval


def _payload():
    return {"question": "会议最后决定什么时候交付？", "context": []}


def _sources():
    return [
        {
            "kind": "transcript",
            "source_id": "segment-1",
            "speaker": "发言人 1",
            "text": "最终决定周五交付。",
        }
    ]


def test_meeting_retrieval_calls_embedding_for_sources_and_query():
    retrieval.reset_semantic_retrieval_state_for_tests()
    calls = []

    def embed(texts):
        calls.append(list(texts))
        return [(1.0, 0.0) for _ in texts]

    scores = retrieval.semantic_source_scores(
        _payload(),
        "sha256:test",
        _sources(),
        embed=embed,
    )

    assert scores == {("transcript", "segment-1"): 1.0}
    assert len(calls) == 2


def test_meeting_retrieval_never_silently_falls_back_to_lexical_only():
    retrieval.reset_semantic_retrieval_state_for_tests()

    def unavailable(_texts):
        raise RuntimeError("embedding offline")

    with pytest.raises(retrieval.SemanticRetrievalUnavailable):
        retrieval.semantic_source_scores(
            _payload(),
            "sha256:test-failure",
            _sources(),
            embed=unavailable,
        )
