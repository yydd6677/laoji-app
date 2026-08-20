from __future__ import annotations

import hashlib
import json

import pytest

from app.services import llm_provider, vnext_question_reader as reader


@pytest.fixture(autouse=True)
def reset_q2_embedding_cache():
    reader._reset_q2_embedding_cache_for_tests()
    yield
    reader._reset_q2_embedding_cache_for_tests()


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


def test_reader_derives_all_ranges_from_exact_model_clause_text(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    first = "张敏负责提交接口文档，"
    second = "截止时间是周五。"
    answer = first + second
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": first,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }, {
            "clause_id": "c2",
            "text": second,
            "citations": [{
                "citation_id": "cite-2",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(_payload(text))
    assert result["clauses"][0]["answer_start_utf8"] == 0
    assert result["clauses"][0]["answer_end_utf8"] == len(first.encode("utf-8"))
    assert result["clauses"][1]["answer_start_utf8"] == len(first.encode("utf-8"))
    assert result["clauses"][1]["answer_end_utf8"] == len(answer.encode("utf-8"))
    assert result["clauses"][0]["citations"][0]["source_start_utf8"] == 0


def test_reader_derives_ranges_across_punctuation_only_clause_gaps():
    first = "使用李亚普诺夫优化保证约束满足"
    second = "路径构造算法形成初始点"
    answer = first + "，" + second + "。"

    ranges = reader._answer_text_clause_ranges(answer, [
        {"text": first},
        {"text": second},
    ])

    assert ranges is not None
    assert ranges[0][0] == 0
    assert ranges[0][1] == len((first + "，").encode("utf-8"))
    assert ranges[1][1] == len(answer.encode("utf-8"))


def test_reader_normalizes_bounded_fixed_slot_provider_response(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    first = "张敏负责提交接口文档，"
    second = "截止时间是周五。"
    answer = first + second
    call_options = {}

    def fake_call(*args, **kwargs):
        call_options.update(kwargs)
        return json.dumps({
            "answer_kind": "answer",
            "answer": answer,
            "clauses": {
                "c1": {
                    "clause_id": "c1",
                    "text": first,
                    "citations": {
                        "e1": {
                            "citation_id": "cite-1",
                            "source_id": "s0",
                            "quote": text,
                        },
                    },
                },
                "c2": {
                    "clause_id": "c2",
                    "text": second,
                    "citations": {
                        "e1": {
                            "citation_id": "cite-2",
                            "source_id": "s0",
                            "quote": text,
                        },
                    },
                },
            },
        }, ensure_ascii=False)

    monkeypatch.setattr(reader, "call_llm", fake_call)
    result = reader.read_q2(_payload(text))

    assert [item["clause_id"] for item in result["clauses"]] == ["c1", "c2"]
    assert result["clauses"][1]["answer_end_utf8"] == len(answer.encode("utf-8"))
    assert call_options["max_tokens"] == 768
    schema = call_options["response_format"]
    assert schema["properties"]["clauses"]["type"] == "object"
    assert set(schema["properties"]["clauses"]["properties"]) == {"c1", "c2", "c3", "c4"}
    citation_slots = schema["properties"]["clauses"]["properties"]["c1"]["properties"]["citations"]
    assert set(citation_slots["properties"]) == {"e1", "e2"}
    assert "责任主体可表述为“发言人本人”" in reader._system_prompt()
    assert "并列对象或成对概念" in reader._system_prompt()


def test_reader_rejects_gapped_fixed_slots(monkeypatch):
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": "张敏负责提交接口文档。",
        "clauses": {
            "c2": {
                "clause_id": "c2",
                "text": "张敏负责提交接口文档。",
                "citations": {
                    "e1": {
                        "citation_id": "cite-1",
                        "source_id": "s0",
                        "quote": "周五前由张敏提交接口文档。",
                    },
                },
            },
        },
    }, ensure_ascii=False))

    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload())
    assert captured.value.code == "Q2_READER_FORMAT_INVALID"


def test_reader_accepts_only_redundant_closing_json_suffix(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    answer = "张敏负责提交接口文档。"
    payload = {
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }
    monkeypatch.setattr(
        reader,
        "call_llm",
        lambda *args, **kwargs: json.dumps(payload, ensure_ascii=False) + "}",
    )

    result = reader.read_q2(_payload(text))

    assert result["answer_kind"] == "answer"
    assert result["clauses"][0]["citations"][0]["quote"] == text


def test_reader_normalizes_fixed_citations_inside_legacy_clause_array(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    answer = "张敏负责提交接口文档。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": {
                "e1": {
                    "citation_id": "cite-1",
                    "source_id": "s0",
                    "quote": text,
                },
            },
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert result["clauses"][0]["citations"][0]["source_id"] == "line-1"


def test_reader_normalizes_bounded_noncontiguous_citation_slot(monkeypatch):
    text = "周五前由张敏提交接口文档。"
    answer = "张敏负责提交接口文档。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": {
                "e2": {
                    "citation_id": "cite-2",
                    "source_id": "s0",
                    "quote": text,
                },
            },
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert len(result["clauses"][0]["citations"]) == 1
    assert result["clauses"][0]["citations"][0]["quote"] == text


def test_reader_recovers_only_strong_unique_verbatim_quote(monkeypatch):
    text = "我将从工作总结、个人不足和工作计划三个方面来展开我的汇报。"
    answer = "汇报从工作总结、个人不足和工作计划三个方面展开。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": "我将从工作总结个人不足和工作计划三个方面来展开我的汇报",
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    quote = result["clauses"][0]["citations"][0]["quote"]
    assert quote in text
    assert "工作总结、个人不足和工作计划" in quote


def test_reader_recovers_exact_numeric_tail_from_cross_row_quote(monkeypatch):
    text = "400分左右啊"
    answer = "建议收集约400份数据。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": "希望大家每个人都可以收到400分左右啊",
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert result["clauses"][0]["citations"][0]["quote"] == text


def test_reader_preserves_percent_suffix_when_recovering_cross_row_quote(monkeypatch):
    texts = ["您方占了65%", "方占35%是十分合理的呃"]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "管理公司最后讨论到的股权比例是多少？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "管理公司最后讨论到的股权比例是对方占65%，我方占35%。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": "在管理公司当中呢 我方也认为呃 您方占了65%",
            }, {
                "citation_id": "cite-2",
                "source_id": "s1",
                "quote": texts[1],
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert {citation["quote"] for citation in result["clauses"][0]["citations"]} == set(texts)


def test_reader_drops_uncovered_items_in_enumerated_clause(monkeypatch):
    text = "核污染可能对沿海地区的水循环产生影响。"
    answer = "核污染影响水循环、食物链、人体健康、农业灌溉。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert result["answer"] == "核污染影响水循环。"
    assert len(result["clauses"]) == 1
    assert result["clauses"][0]["answer_start_utf8"] == 0
    assert result["clauses"][0]["answer_end_utf8"] == len(result["answer"].encode("utf-8"))


def test_reader_grounds_each_enumerated_detail_instead_of_trusting_an_umbrella(monkeypatch):
    texts = [
        "会议汇报了镍基氧化物超导研究进展。",
        "将镍基氧化物超导温度提高到90K以上。",
        "介绍了关键科学问题。",
    ]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "这次会议主要讨论了什么？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = (
        "会议主要讨论了镍基氧化物超导研究进展，包括常压下制备高质量单晶、"
        "将超导温度提高到90K以上、提出提升转变温度策略，以及回顾镍基氧化物"
        "探索历史、关键科学问题（如氧含量影响、不同层数结构竞争）和理论合作情况。"
    )
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": f"cite-{index}",
                "source_id": f"s{index}",
                "quote": text,
            } for index, text in enumerate(texts)],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert result["answer"] == (
        "会议主要讨论了镍基氧化物超导研究进展、"
        "将超导温度提高到90K以上、关键科学问题。"
    )
    assert {
        citation["quote"]
        for citation in result["clauses"][0]["citations"]
    } == set(texts)
    citation_ids = [
        citation["citation_id"]
        for citation in result["clauses"][0]["citations"]
    ]
    assert len(citation_ids) == len(set(citation_ids))
    assert "单晶" not in result["answer"]
    assert "策略" not in result["answer"]
    assert "氧含量" not in result["answer"]
    assert "理论合作" not in result["answer"]


def test_reader_keeps_short_exact_entities_in_enumerated_clause(monkeypatch):
    text = "参会者包括张敏、李强。"
    answer = "参会者包括张敏、李强。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert result["answer"] == answer
    assert result["clauses"][0]["citations"][0]["quote"] == text


def test_reader_does_not_rebind_positive_enumeration_to_negated_sources(monkeypatch):
    text = "任务尚未完成，接口没有上线。"
    answer = "任务已经完成、接口已经上线。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))

    with pytest.raises(reader.Q2ReaderError) as captured:
        reader.read_q2(_payload(text))

    assert captured.value.code == "Q2_GROUNDING_INVALID"
    assert "枚举项" in str(captured.value)


def test_reader_rebuilds_answer_from_grounded_clause_text(monkeypatch):
    text = "张敏负责提交接口文档。"
    top_answer = "张敏负责提交接口文档，还需要电话联系。"
    clause_text = "张敏负责提交接口文档"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": top_answer,
        "clauses": [{
            "clause_id": "c1",
            "text": clause_text,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": text,
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(_payload(text))

    assert result["answer"] == "张敏负责提交接口文档。"
    assert "电话" not in result["answer"]
    assert result["clauses"][0]["answer_end_utf8"] == len(result["answer"].encode("utf-8"))


def test_reader_rebinds_wrong_alias_to_unique_lexical_evidence(monkeypatch):
    texts = [
        "同时负责管理集团的科技信息管理平台",
        "同时我也有幸参与到免模技术",
    ]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "谁负责科技信息平台？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "发言人本人负责科技信息平台。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-wrong",
                "source_id": "s1",
                "quote": texts[1],
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    citation = result["clauses"][0]["citations"][0]
    assert citation["source_id"] == "line-0"
    assert citation["quote"] == texts[0]


def test_reader_count_question_keeps_only_count_bearing_clause(monkeypatch):
    texts = ["这次主要是分为五个部分", "总共要分为两个大部分"]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "这次汇报提纲分为几个部分？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "汇报提纲分为五个部分；总共要分为两个大部分。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": "汇报提纲分为五个部分；",
            "citations": [{"citation_id": "e1", "source_id": "s0", "quote": texts[0]}],
        }, {
            "clause_id": "c2",
            "text": "总共要分为两个大部分。",
            "citations": [{"citation_id": "e1", "source_id": "s1", "quote": texts[1]}],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert result["answer"] == "汇报提纲分为五个部分。"
    assert len(result["clauses"]) == 1


def test_reader_improvement_question_drops_unfocused_branches(monkeypatch):
    texts = ["输出改为Excel文件", "同时考虑多种目标函数"]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "后续准备怎样改进输入输出界面？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "支持文件导入导出；同时考虑多种目标函数。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": "支持文件导入导出；",
            "citations": [{"citation_id": "e1", "source_id": "s0", "quote": texts[0]}],
        }, {
            "clause_id": "c2",
            "text": "同时考虑多种目标函数。",
            "citations": [{"citation_id": "e1", "source_id": "s1", "quote": texts[1]}],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert result["answer"] == "支持文件导入导出。"
    assert len(result["clauses"]) == 1


def test_retrieval_small_increment_uses_cpu_embedding(monkeypatch):
    calls = []
    monkeypatch.setattr(reader, "embed_texts", lambda texts, **kwargs: (
        calls.append(kwargs) or [(1.0, 0.0) for _text in texts]
    ))

    vectors = reader._embed_retrieval_units([{"text": "一条补充笔记"}])

    assert vectors == [(1.0, 0.0)]
    assert calls[0]["num_gpu"] == 0
    assert calls[0]["num_ctx"] == 2048


def test_retrieval_cold_meeting_keeps_shared_cpu_embedding_runner(monkeypatch):
    calls = []
    monkeypatch.setattr(reader, "embed_texts", lambda texts, **kwargs: (
        calls.append(kwargs) or [(1.0, 0.0) for _text in texts]
    ))
    units = [{"text": f"完整会议片段{index}" * 40} for index in range(16)]

    vectors = reader._embed_retrieval_units(units)

    assert len(vectors) == 16
    assert calls[0]["num_gpu"] == 0
    assert calls[0]["num_ctx"] == 2048


def test_reader_splits_cross_row_quote_into_exact_adjacent_citations(monkeypatch):
    texts = ["我将从工作总结", "个人不足和工作计划三个方面来展开我的汇报"]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["question"] = "汇报从哪几个方面展开？"
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "汇报从工作总结、个人不足和工作计划三个方面展开。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s1",
                "quote": "我将从工作总结个人不足和工作计划三个方面来展开我的汇报",
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert {item["source_id"] for item in result["clauses"][0]["citations"]} == {
        "line-0",
        "line-1",
    }


def test_reader_drops_auxiliary_clause_absent_from_top_level_answer(monkeypatch):
    texts = ["周五前由张敏提交接口文档。", "办公室准备了饮用水。"]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = _payload(texts[0])
    payload["sources"] = sources
    payload["source_fingerprint"] = reader._source_fingerprint(sources)
    answer = "张敏负责提交接口文档。"
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "text": answer,
            "citations": [{
                "citation_id": "cite-1",
                "source_id": "s0",
                "quote": texts[0],
            }],
        }, {
            "clause_id": "c2",
            "text": "办公室准备了饮用水。",
            "citations": [{
                "citation_id": "cite-2",
                "source_id": "s1",
                "quote": texts[1],
            }],
        }],
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert [item["source_id"] for item in result["clauses"][0]["citations"]] == ["line-0"]


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


def test_reader_replaces_conflicting_percentage_with_exact_entity_evidence(monkeypatch):
    texts = [
        "管理公司中方占35%",
        "华特迪士尼占65%",
        "华特迪士尼在另一家公司占44%",
    ]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    payload = {
        "schema_version": 2,
        "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION,
        "snapshot_id": "q2-percentage-grounding",
        "source_fingerprint": reader._source_fingerprint(sources),
        "question": "管理公司最后讨论到的股权比例是多少？",
        "sources": sources,
    }
    answer = "管理公司最后确定中方占35%，华特迪士尼占65%。"
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
                    "source_end_utf8": len(texts[0].encode("utf-8")),
                    "quote": texts[0],
                }, {
                    "citation_id": "cite-2",
                    "source_id": "s2",
                    "source_start_utf8": 0,
                    "source_end_utf8": len(texts[2].encode("utf-8")),
                    "quote": texts[2],
                }],
            }],
        }, ensure_ascii=False),
    )

    result = reader.read_q2(payload)

    quotes = [citation["quote"] for citation in result["clauses"][0]["citations"]]
    assert texts[0] in quotes
    assert texts[1] in quotes
    assert texts[2] not in quotes


def test_quantitative_grounding_prefers_adjacent_context_over_distant_overlap() -> None:
    texts = [
        "目标主体甲方占35%",
        "目标主体乙方占65%",
        "中间的其他讨论",
        "又一段无关讨论",
        "另一主体占到65%的股权比例",
    ]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    citations = [{
        "citation_id": "cite-1",
        "source_type": "transcript",
        "source_id": "line-0",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(texts[0]),
        "source_start_utf8": 0,
        "source_end_utf8": len(texts[0].encode("utf-8")),
        "quote": texts[0],
    }]

    grounded = reader._ground_quantitative_citations(
        "目标主体最后的股权比例是多少？",
        "目标主体甲方占35%，乙方占65%。",
        sources,
        citations,
        0,
    )

    quotes = [citation["quote"] for citation in grounded]
    assert texts[1] in quotes
    assert texts[4] not in quotes


def test_quantitative_grounding_rejects_distant_same_value() -> None:
    texts = [
        "目标主体甲方占35%",
        "第一段无关内容",
        "第二段无关内容",
        "第三段无关内容",
        "另一主体乙方占65%的股权比例",
    ]
    sources = [{
        "source_type": "transcript",
        "source_id": f"line-{index}",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(text),
        "text": text,
    } for index, text in enumerate(texts)]
    citations = [{
        "citation_id": "cite-1",
        "source_type": "transcript",
        "source_id": "line-0",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(texts[0]),
        "source_start_utf8": 0,
        "source_end_utf8": len(texts[0].encode("utf-8")),
        "quote": texts[0],
    }]

    with pytest.raises(reader.Q2ReaderError, match="数字缺少逐字依据"):
        reader._ground_quantitative_citations(
            "目标主体最后的股权比例是多少？",
            "目标主体甲方占35%，乙方占65%。",
            sources,
            citations,
            0,
        )


def test_quote_window_accepts_whitespace_inside_numeric_value() -> None:
    source = "目标主体乙方占 65 %，其余内容不变。"

    window = reader._quote_window(source, "65%")

    assert window is not None
    assert "65 %" in window[2]


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


def test_method_question_adds_only_generic_retrieval_intent_terms() -> None:
    terms = reader._retrieval_intent_terms("文中使用什么方法得到最终方案？")

    assert {"方法", "算法", "采用", "使用", "方案"}.issubset(terms)
    assert "模拟退火" not in terms


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
                    "source_end_utf8": len("开场明确列出的国家有中国、美国和法国".encode("utf-8")),
                    "quote": "美国和法国",
                }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert result["clauses"][0]["answer_end_utf8"] == len(answer.encode("utf-8"))
    assert {item["quote"] for item in result["clauses"][0]["citations"]} == {
        "开场明确列出的国家有中国",
        "美国和法国",
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

    first_source_embedding_count = len(source_vectors)
    replay = reader.read_q2(payload)
    assert replay["clauses"][0]["citations"][0]["source_id"] == "line-217"
    assert len(source_vectors) == first_source_embedding_count
    assert all(
        len(key) == 64 and set(key) <= set("0123456789abcdef")
        for key in llm_provider._embedding_cache_keys_for_tests()
    )


def test_reader_does_not_claim_not_stated_from_partial_retrieval(monkeypatch):
    payload = _large_payload()

    def fake_embed(texts, **_kwargs):
        return [(1.0, 0.0) for _text in texts]

    monkeypatch.setattr(reader, "embed_texts", fake_embed)
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "not_stated",
        "answer": "当前会议记录没有提及。",
        "clauses": {},
    }, ensure_ascii=False))

    result = reader.read_q2(payload)

    assert result["answer_kind"] == "cannot_confirm"
    assert result["clauses"] == []


def test_reader_accepts_verified_stream_source_larger_than_direct_item_limit(monkeypatch):
    target = "周五前由张敏提交接口文档。"
    text = "背景说明。" * 1_800 + target
    assert len(text) > reader.MAX_SOURCE_TEXT
    payload = _payload(text)
    payload["source_fingerprint"] = _hash("stream-task-fingerprint")
    payload["source_stream_verified"] = True
    monkeypatch.setattr(reader, "embed_texts", lambda texts, **_kwargs: [
        (1.0, 0.0) if len(texts) == 1 or target in value else (0.0, 1.0)
        for value in texts
    ])

    def fake_call(_config, _system, model_payload, **_kwargs):
        selected = next(
            item for item in json.loads(model_payload)["sources"]
            if target in item["text"]
        )
        answer = "张敏负责提交接口文档。"
        return json.dumps({
            "answer_kind": "answer",
            "answer": answer,
            "clauses": {
                "c1": {
                    "clause_id": "c1",
                    "text": answer,
                    "citations": {
                        "e1": {
                            "citation_id": "cite-1",
                            "source_id": selected["source_id"],
                            "quote": target,
                        },
                    },
                },
            },
        }, ensure_ascii=False)

    monkeypatch.setattr(reader, "call_llm", fake_call)
    result = reader.read_q2(payload)
    citation = result["clauses"][0]["citations"][0]
    assert result["answer_kind"] == "answer"
    assert citation["source_start_utf8"] == len(text[:text.index(target)].encode("utf-8"))


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


def test_reader_discards_extra_unrelated_quote_when_clause_remains_grounded(monkeypatch):
    supported = "会议讨论了基于最小化成本的任务卸载算法。"
    background = "接下来进入另一个环节。"
    answer = "会议主要讨论了基于最小化成本的任务卸载算法。"
    payload = _payload(supported)
    payload["sources"].append({
        "source_type": "transcript",
        "source_id": "line-2",
        "source_revision_id": "revision-1",
        "content_sha256": _hash(background),
        "text": background,
    })
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": len(answer.encode("utf-8")),
            "citations": [{
                "citation_id": "cite-supported",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len(supported.encode("utf-8")),
                "quote": supported,
            }, {
                "citation_id": "cite-background",
                "source_id": "s1",
                "source_start_utf8": 0,
                "source_end_utf8": len(background.encode("utf-8")),
                "quote": background,
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert [item["quote"] for item in result["clauses"][0]["citations"]] == [supported]


def test_reader_discards_extra_fabricated_quote_when_clause_remains_grounded(monkeypatch):
    text = "会议讨论了数字化转型和科技项目。"
    answer = "会议讨论了数字化转型和科技项目研发。"
    payload = _payload(text)
    monkeypatch.setattr(reader, "call_llm", lambda *args, **kwargs: json.dumps({
        "answer_kind": "answer",
        "answer": answer,
        "clauses": [{
            "clause_id": "c1",
            "answer_start_utf8": 0,
            "answer_end_utf8": len(answer.encode("utf-8")),
            "citations": [{
                "citation_id": "cite-supported",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len(text.encode("utf-8")),
                "quote": text,
            }, {
                "citation_id": "cite-fabricated",
                "source_id": "s0",
                "source_start_utf8": 0,
                "source_end_utf8": len("科技项目研发".encode("utf-8")),
                "quote": "科技项目研发",
            }],
        }],
    }, ensure_ascii=False))
    result = reader.read_q2(payload)
    assert [item["quote"] for item in result["clauses"][0]["citations"]] == [text]


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
