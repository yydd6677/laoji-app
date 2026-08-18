from __future__ import annotations

import hashlib
import json

import pytest

from app.services import vnext_question_reader as reader


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _source_fingerprint(text: str) -> str:
    payload = {
        "schema_version": 2,
        "sources": [{
            "source_type": "transcript",
            "source_id": "line-1",
            "source_revision_id": "revision-1",
            "content_sha256": _hash(text),
        }],
    }
    return _hash(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _payload(text: str = "周五前由张敏提交接口文档。") -> dict:
    return {
        "schema_version": 2,
        "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION,
        "snapshot_id": "q2-snapshot-test",
        "source_fingerprint": _source_fingerprint(text),
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
    calls = []
    monkeypatch.setattr(reader, "canonical_ollama_base_url", lambda: "http://127.0.0.1:21434")
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    def fake_call(*args, **kwargs):
        calls.append((args, kwargs))
        return json.dumps({
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
        }, ensure_ascii=False)
    monkeypatch.setattr(reader, "call_llm", fake_call)
    result = reader.read_q2(_payload(text))
    assert result["answer_kind"] == "answer"
    assert len(calls) == 1
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


def test_reader_canonicalizes_non_contiguous_answer_clauses(monkeypatch):
    text = "项目按计划推进。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": "甲乙",
        "clauses": [
            {
                "clause_id": "c1",
                "answer_start_utf8": 0,
                "answer_end_utf8": 3,
                "citations": [{
                    "citation_id": "cite-1", "source_id": "s0",
                    "source_start_utf8": 0, "source_end_utf8": len(text.encode("utf-8")),
                    "quote": text,
                }],
            },
            {
                "clause_id": "c2",
                "answer_start_utf8": 4,
                "answer_end_utf8": 6,
                "citations": [{
                    "citation_id": "cite-2", "source_id": "s0",
                    "source_start_utf8": 0, "source_end_utf8": len(text.encode("utf-8")),
                    "quote": text,
                }],
            },
        ],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    assert len(result["clauses"]) == 1
    assert result["clauses"][0]["answer_start_utf8"] == 0
    assert result["clauses"][0]["answer_end_utf8"] == len("甲乙".encode("utf-8"))


def test_reader_rejects_utf8_boundary_and_unsupported_citation_for_refusal(monkeypatch):
    text = "甲乙"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "not_stated",
        "answer": "会议记录没有说明。",
        "clauses": [{"clause_id": "c1"}],
    }, ensure_ascii=False))
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload(text))
    assert captured.value.code == "Q2_GROUNDING_INVALID"

    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": "甲",
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": 3,
            "citations": [{
                "citation_id": "cite-1", "source_id": "s0",
                "source_start_utf8": 1, "source_end_utf8": 3,
                "quote": "甲",
            }],
        }],
    }, ensure_ascii=False))
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload(text))
    assert captured.value.code == "Q2_GROUNDING_INVALID"


def test_reader_maps_provider_failure_to_retryable_service_error(monkeypatch):
    from app.services.llm_provider import LlmProviderError

    def fail_provider(*args, **kwargs):
        raise LlmProviderError("ollama_request_timeout")

    monkeypatch.setattr(reader, "call_llm", fail_provider)
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload())
    assert captured.value.code == "Q2_PROVIDER_UNAVAILABLE"
    assert captured.value.status_code == 503


def test_reader_rejects_source_fingerprint_mismatch(monkeypatch):
    payload = _payload()
    payload["source_fingerprint"] = _hash("caller-supplied identity")
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(payload)
    assert captured.value.code == "Q2_SOURCE_FINGERPRINT_MISMATCH"
    assert captured.value.status_code == 409


def test_reader_normalizes_non_semantic_model_ids_and_empty_refusal(monkeypatch):
    text = "项目按计划推进。"
    answer = "项目按计划推进。"
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "",
            "answer_start_utf8": 0,
            "answer_end_utf8": len(answer.encode("utf-8")),
            "citations": [{
                "citation_id": 7,
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len(text.encode("utf-8")),
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    assert result["clauses"][0]["clause_id"] == "c1"
    assert result["clauses"][0]["citations"][0]["citation_id"] == "cite-1-1"

    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "not_stated",
        "answer": "",
        "clauses": [],
    }, ensure_ascii=False))
    refusal = reader.read_q2(_payload(text))
    assert refusal["answer_kind"] == "not_stated"
    assert refusal["answer"] == "当前会议记录没有提供足够信息确认。"


def test_reader_grounds_compact_qwen_clause_from_exact_quote(monkeypatch):
    text = "使用李亚普诺夫优化保证约束满足，并通过模拟退火得到最优解。"
    answer = "文中使用李亚普诺夫优化和模拟退火。"
    quote = "使用李亚普诺夫优化保证约束满足"
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause": answer,
            "source_id": "s0",
            "quote": quote,
            "utf8_range": {"start": 999, "end": 1000},
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    citation = result["clauses"][0]["citations"][0]
    assert citation["quote"] == quote
    assert citation["source_start_utf8"] == 0
    assert citation["source_end_utf8"] == len(quote.encode("utf-8"))

    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{"source_id": "s0", "quote": "来源中不存在的句子"}],
    }, ensure_ascii=False))
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload(text))
    assert captured.value.code == "Q2_GROUNDING_INVALID"
