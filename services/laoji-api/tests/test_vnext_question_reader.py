from __future__ import annotations

import hashlib
import json

import pytest

from app.services import vnext_question_reader as reader


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _payload(text: str = "周五前由张敏提交接口文档。") -> dict:
    return {
        "schema_version": 2,
        "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION,
        "snapshot_id": "q2-snapshot-test",
        "source_fingerprint": _hash(text),
        "question": "谁负责提交接口文档？",
        "sources": [{
            "source_type": "transcript",
            "source_id": "line-1",
            "source_revision_id": "revision-1",
            "content_sha256": _hash(text),
            "text": text,
        }],
    }


def test_reader_grounding_returns_canonical_source(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    answer = "张敏负责提交接口文档。"
    monkeypatch.setattr(reader, "canonical_ollama_base_url", lambda: "http://127.0.0.1:21434")
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *args, **kwargs: json.dumps({
            "answer_kind": "answer",
            "answer": answer,
            "clauses": [{
                "clause_id": "c1",
                "answer_start_utf8": 0,
                "answer_end_utf8": len(answer.encode("utf-8")),
                "citations": [{
                    "citation_id": "cite-1",
                    "source_id": "s0",
                    "source_start_utf8": 0,
                    "source_end_utf8": len(text.encode("utf-8")),
                    "quote": text,
                }],
            }],
        }, ensure_ascii=False),
    )
    result = reader.read_q2(_payload(text))
    assert result["answer_kind"] == "answer"
    citation = result["clauses"][0]["citations"][0]
    assert citation["source_id"] == "line-1"
    assert citation["source_type"] == "transcript"


def test_reader_rejects_unmatched_quote(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    monkeypatch.setattr(reader, "canonical_ollama_base_url", lambda: "http://127.0.0.1:21434")
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *args, **kwargs: json.dumps({
            "answer_kind": "answer",
            "answer": "张敏负责提交接口文档。",
            "clauses": [{
                "clause_id": "c1",
                "answer_start_utf8": 0,
                "answer_end_utf8": len("张敏负责提交接口文档。".encode("utf-8")),
                "citations": [{
                    "citation_id": "cite-1",
                    "source_id": "s0",
                    "source_start_utf8": 0,
                    "source_end_utf8": len(text.encode("utf-8")),
                    "quote": "不属于来源的文字。",
                }],
            }],
        }, ensure_ascii=False),
    )
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload(text))
    assert captured.value.code == "Q2_GROUNDING_INVALID"
