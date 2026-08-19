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


def _large_payload(count: int = 320) -> dict:
    sources = []
    for index in range(count):
        text = (
            f"第{index}段讨论背景和上下文，会议参与者继续说明相关问题和当前进展。" * 3
            if index != 217
            else "第217段确认由林清在周五前提交接口文档，目标事项在这里。" * 3
        )
        sources.append({
            "source_type": "transcript",
            "source_id": f"line-{index}",
            "source_revision_id": "revision-1",
            "content_sha256": _hash(text),
            "text": text,
        })
    fingerprint_payload = {
        "schema_version": 2,
        "sources": [
            {
                "source_type": source["source_type"],
                "source_id": source["source_id"],
                "source_revision_id": source["source_revision_id"],
                "content_sha256": source["content_sha256"],
            }
            for source in sources
        ],
    }
    return {
        "schema_version": 2,
        "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION,
        "snapshot_id": "q2-large-snapshot-test",
        "source_fingerprint": _hash(json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )),
        "question": "谁负责提交接口文档？",
        "sources": sources,
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


def test_reader_preserves_android_stable_source_identity_over_180_chars(monkeypatch):
    text = "由五位同学对应用需求做简要介绍。"
    answer = "一共有五位同学。"
    source_id = "transcript:" + "a" * 194
    source_revision_id = "revision:" + "b" * 119
    assert len(source_id) == 205
    assert len(source_revision_id) == 128
    payload = _payload(text)
    payload["question"] = "本次会议一共有几位同学介绍应用需求？"
    payload["sources"][0]["source_id"] = source_id
    payload["sources"][0]["source_revision_id"] = source_revision_id
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    monkeypatch.setattr(reader, "canonical_ollama_base_url", lambda: "http://127.0.0.1:21434")
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *_args, **_kwargs: json.dumps({
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

    result = reader.read_q2(payload)

    citation = result["clauses"][0]["citations"][0]
    assert citation["source_id"] == source_id
    assert citation["source_revision_id"] == source_revision_id


def test_verified_fragment_stream_is_packed_only_for_retrieval() -> None:
    raw = []
    offset = 0
    for index in range(1_357):
        text = f"第{index}个连续字幕片段"
        encoded = text.encode("utf-8")
        raw.append({
            "source_type": "transcript",
            "source_id": "recording-1",
            "source_revision_id": "revision-1",
            "content_sha256": _hash(text),
            "source_start_utf8": offset,
            "source_end_utf8": offset + len(encoded),
            "start_ms": index * 1_000,
            "end_ms": index * 1_000 + 900,
            "text": text,
        })
        offset += len(encoded) + 1

    with pytest.raises(reader.Q2ReaderError):
        reader._source_payload(raw)
    sources = reader._source_payload(raw, max_sources=reader.MAX_VERIFIED_SOURCES)
    units = reader._retrieval_units(sources)

    assert len(sources) == 1_357
    assert len(units) < 100
    assert [index for unit in units for index in unit["member_indexes"]] == list(range(1_357))


def test_identical_text_at_different_recording_ranges_is_not_a_duplicate() -> None:
    text = "好的。"
    raw = [
        {
            "source_type": "transcript",
            "source_id": "recording-1",
            "source_revision_id": "revision-1",
            "content_sha256": _hash(text),
            "source_start_utf8": start,
            "source_end_utf8": start + len(text.encode("utf-8")),
            "text": text,
        }
        for start in (0, 100)
    ]

    assert len(reader._source_payload(raw)) == 2
    with pytest.raises(reader.Q2ReaderError):
        reader._source_payload([raw[0], dict(raw[0])])


def test_citation_offsets_are_restored_to_recording_utf8_range(monkeypatch) -> None:
    text = "周五前由张敏提交接口文档。"
    answer = "张敏负责提交接口文档。"
    payload = _payload(text)
    payload["sources"][0]["source_start_utf8"] = 120
    payload["sources"][0]["source_end_utf8"] = 120 + len(text.encode("utf-8"))
    monkeypatch.setattr(reader, "canonical_ollama_base_url", lambda: "http://127.0.0.1:21434")
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *_args, **_kwargs: json.dumps({
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

    result = reader.read_q2(payload)
    citation = result["clauses"][0]["citations"][0]
    assert citation["source_start_utf8"] == 120
    assert citation["source_end_utf8"] == 120 + len(text.encode("utf-8"))


def test_reader_uses_full_answer_when_provider_span_is_only_a_utf8_prefix(monkeypatch):
    text = "开场明确列出的国家有中国、美国和法国。"
    answer = "开场明确列出的国家有中国、美国和法国。"
    payload = _payload(text)
    payload["question"] = "开场明确列出了哪些国家？"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        # 15 is a valid UTF-8 byte prefix, but not a full answer cover. This
        # mirrors the character-offset style emitted by the local model.
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": 15,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len("开场明确列出的国家有中国".encode("utf-8")),
                "quote": "开场明确列出的国家有中国",
            }, {
                "citation_id": "cite-2",
                "source_id": "s0",
                "source_start_utf8": len("开场明确列出的国家有中国、".encode("utf-8")),
                "source_end_utf8": len("开场明确列出的国家有中国、美国".encode("utf-8")),
                "quote": "美国",
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert result["clauses"][0]["answer_end_utf8"] == len(answer.encode("utf-8"))
    assert {item["quote"] for item in result["clauses"][0]["citations"]} == {
        "开场明确列出的国家有中国",
        "美国",
    }


def test_reader_drops_unrelated_citation_for_partial_absence_clause(monkeypatch):
    text = "同时负责管理集团的科技信息管理平台。"
    answer = "负责科技信息平台的是发言者，联系电话未提及。"
    payload = _payload(text)
    payload["question"] = "谁负责科技信息平台，联系电话是多少？"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": 15,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len(text.encode("utf-8")),
                "quote": text,
            }],
        }, {
            "clause_id": "c2",
            "answer_start_utf8": 15,
            "answer_end_utf8": 30,
            "citations": [{
                "citation_id": "cite-2",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len(text.encode("utf-8")),
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert len(result["clauses"]) == 1
    assert [item["quote"] for item in result["clauses"][0]["citations"]] == [text]


def test_reader_retrieves_large_raw_source_set_without_relabeling_citations(monkeypatch):
    payload = _large_payload()
    source_vectors = []

    def fake_embed(texts, **_kwargs):
        if len(texts) == 1:
            return [(1.0, 0.0)]
        values = []
        for text in texts:
            values.append((1.0, 0.0) if "林清" in text else (0.0, 1.0))
        source_vectors.extend(values)
        return values

    captured = {}

    def fake_call(_config, _system, transcript, **_kwargs):
        captured.update(json.loads(transcript))
        selected = next(item for item in captured["sources"] if item["source_id"] == "s217")
        answer = "林清负责提交接口文档。"
        quote = selected["text"]
        return json.dumps({
            "answer_kind": "answer",
            "answer": answer,
            "clauses": [{
                "clause_id": "c1",
                "answer_start_utf8": 0,
                "answer_end_utf8": len(answer.encode("utf-8")),
                "citations": [{
                    "citation_id": "cite-1",
                    "source_id": "s217",
                    "source_start_utf8": 0,
                    "source_end_utf8": len(quote.encode("utf-8")),
                    "quote": quote,
                }],
            }],
        }, ensure_ascii=False)

    monkeypatch.setattr(reader, "embed_texts", fake_embed)
    monkeypatch.setattr(reader, "call_llm", fake_call)
    result = reader.read_q2(payload)
    assert len(captured["sources"]) < len(payload["sources"])
    assert result["clauses"][0]["citations"][0]["source_id"] == "line-217"
    assert source_vectors


def test_reader_accepts_verified_stream_source_larger_than_direct_item_limit(monkeypatch):
    text = "a" * 9_001
    payload = _payload(text)
    payload["source_fingerprint"] = _hash("stream-task-fingerprint")
    payload["source_stream_verified"] = True
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *args, **kwargs: json.dumps({
            "answer_kind": "not_stated",
            "answer": "当前会议记录没有提供足够信息确认。",
            "clauses": [],
        }, ensure_ascii=False),
    )
    result = reader.read_q2(payload)
    assert result["answer_kind"] == "not_stated"


def test_reader_fails_closed_when_large_source_retrieval_is_unavailable(monkeypatch):
    from app.services.llm_provider import LlmProviderError

    payload = _large_payload()

    def unavailable(*_args, **_kwargs):
        raise LlmProviderError("ollama_embedding_timeout")

    monkeypatch.setattr(reader, "embed_texts", unavailable)
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(payload)
    assert captured.value.code == "Q2_RETRIEVAL_UNAVAILABLE"
    assert captured.value.status_code == 503


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


def test_reader_rejects_exact_but_unrelated_quote(monkeypatch):
    text = "周一上午召开设计评审。"
    answer = "张敏负责提交接口文档。"
    payload = _payload("张敏负责提交接口文档。")
    payload["question"] = "谁负责提交接口文档？"
    payload["sources"][0]["text"] = text
    payload["sources"][0]["content_sha256"] = _hash(text)
    payload["source_fingerprint"] = _source_fingerprint(text)
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
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
    }, ensure_ascii=False))
    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(payload)
    assert captured.value.code == "Q2_GROUNDING_INVALID"
    assert "无关" in str(captured.value)


def test_reader_canonicalizes_non_contiguous_answer_clauses(monkeypatch):
    text = "项目按计划推进。"
    answer = "项目按计划推进"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
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
    assert result["clauses"][0]["answer_end_utf8"] == len(answer.encode("utf-8"))


def test_reader_rejects_unsupported_citation_and_repairs_utf8_boundary(monkeypatch):
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
    result = reader.read_q2(_payload(text))
    citation = result["clauses"][0]["citations"][0]
    assert citation["quote"] == "甲"
    assert citation["source_start_utf8"] == 0
    assert citation["source_end_utf8"] == len("甲".encode("utf-8"))


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


def test_reader_fails_closed_on_final_value_conflict_without_provider_call(monkeypatch):
    transcript = "文字记录最终成交价格为18元。"
    note = "我的笔记记录最终成交价格改为20元。"
    payload = _payload(transcript)
    payload["question"] = "最终成交价格是多少？"
    payload["sources"].append({
        "source_type": "manual_note",
        "source_id": "note-1",
        "source_revision_id": "7",
        "content_sha256": _hash(note),
        "text": note,
    })
    fingerprint_payload = {
        "schema_version": 2,
        "sources": [
            {
                "source_type": source["source_type"],
                "source_id": source["source_id"],
                "source_revision_id": source["source_revision_id"],
                "content_sha256": source["content_sha256"],
            }
            for source in payload["sources"]
        ],
    }
    payload["source_fingerprint"] = _hash(json.dumps(
        fingerprint_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ))
    calls = []
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: calls.append(True))
    result = reader.read_q2(payload)
    assert result["answer_kind"] == "cannot_confirm"
    assert result["clauses"] == []
    assert calls == []


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


def test_reader_joins_compact_clause_answers_when_top_level_answer_is_missing(monkeypatch):
    text = "本文研究任务卸载算法，并使用模拟退火得到最优解。"
    monkeypatch.setattr(reader, "model_revision", lambda: "ollama:qwen3.5:9b")
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "clauses": [
            {
                "answer": "本文研究任务卸载算法。",
                "source_id": "s0",
                "quote": "本文研究任务卸载算法",
            },
            {
                "answer": "并使用模拟退火得到最优解。",
                "source_id": "s0",
                "quote": "使用模拟退火得到最优解",
            },
        ],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    assert result["answer"] == "本文研究任务卸载算法。并使用模拟退火得到最优解。"
    assert len(result["clauses"][0]["citations"]) == 2


def test_reader_deduplicates_bounded_repeated_citations(monkeypatch):
    text = "园区规划需要设备功率和运行效率。"
    answer = "需要设备功率和运行效率。"
    citation = {
        "citation_id": "duplicate",
        "source_id": "s0",
        "source_start_utf8": 0,
        "source_end_utf8": len(text.encode("utf-8")),
        "quote": text,
    }
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": len(answer.encode("utf-8")),
            "citations": [citation for _ in range(12)],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    assert len(result["clauses"][0]["citations"]) == 1
    assert result["clauses"][0]["citations"][0]["source_id"] == "line-1"


def test_reader_rebinds_exact_quote_to_unique_current_source(monkeypatch):
    first = "这是相邻的上下文。"
    second = "后续输入改为提交文件，输出改为Excel。"
    payload = _payload(first)
    payload["sources"].append({
        "source_type": "transcript",
        "source_id": "line-2",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(second),
        "text": second,
    })
    payload["source_fingerprint"] = _hash(json.dumps({
        "schema_version": 2,
        "sources": [{
            "source_type": source["source_type"],
            "source_id": source["source_id"],
            "source_revision_id": source["source_revision_id"],
            "content_sha256": source["content_sha256"],
        } for source in payload["sources"]],
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    answer = "后续输入输出改为文件形式。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
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
                "source_end_utf8": len(second.encode("utf-8")),
                "quote": second,
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert result["clauses"][0]["citations"][0]["source_id"] == "line-2"
