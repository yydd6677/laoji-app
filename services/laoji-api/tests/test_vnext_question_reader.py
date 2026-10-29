from __future__ import annotations

import hashlib
import json

import pytest

from app.services import llm_provider, vnext_question_reader as reader


@pytest.fixture(autouse=True)
def reset_q2_embedding_cache(monkeypatch):
    # Attribution contract only; semantic quality is tested on the real model.
    monkeypatch.setattr(reader, "verify_claims", lambda question, claims, sources: [
        {**claim, "citations": [member for cite in claim["citations"] for member in cite.get("_members", [cite])]}
        for claim in claims])
    reader._reset_q2_embedding_cache_for_tests()
    yield
    reader._reset_q2_embedding_cache_for_tests()


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_single_chinese_numeral_inside_word_is_not_a_quantity_claim():
    assert not reader._fact_values("双方统一意见，一致认可。")
    assert reader._fact_values("一批货物。") == {"number:1"}
    assert reader._fact_values("十二批，百分之五十。") == reader._fact_values("12批，50%。")


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


def test_followup_context_is_questions_only_and_not_a_fact_source(monkeypatch):
    payload = _payload()
    payload['previous_questions'] = ['接口文档由谁提交？']
    payload['question'] = '什么时候完成？'
    observed = []
    def llm(*args, **kwargs):
        observed.extend(args[1:])
        return json.dumps({'answer_kind': 'not_stated', 'answer': '未提及。', 'clauses': {}})
    monkeypatch.setattr(reader, 'call_llm', llm)
    monkeypatch.setattr(reader, 'model_revision', lambda: 'test-revision')
    reader.read_q2(payload)
    content = '\n'.join(str(item) for item in observed)
    assert '接口文档由谁提交' in content
    assert 'previous_questions' in content


def test_followup_context_is_bounded():
    payload = _payload()
    payload['previous_questions'] = ['问题'] * 3
    with pytest.raises(reader.Q2ReaderError, match='追问上下文无效'):
        reader.read_q2(payload)


def _reply(text="张敏负责提交接口文档。", source_id="w0", first=0, last=0):
    return json.dumps({"answer_kind": "answer", "answer": text, "clauses": {"c1": {
        "text": text, "citations": {"e1": {
            "source_id": source_id, "first_part": first, "last_part": last}}}}}, ensure_ascii=False)


def test_exact_quote_returns_original_identity_and_server_owned_utf8_ranges(monkeypatch):
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply())
    result = reader.read_q2(_payload())
    assert result["answer"] == "张敏负责提交接口文档。"
    clause = result["clauses"][0]
    assert clause["answer_end_utf8"] == len(result["answer"].encode())
    citation = clause["citations"][0]
    assert citation["source_id"] == "line-1" and citation["source_revision_id"] == "revision-1"
    assert citation["content_sha256"] == _hash(citation["quote"])
    assert citation["source_end_utf8"] == len(citation["quote"].encode())


def test_natural_paraphrase_is_never_cropped_to_shared_keywords(monkeypatch):
    text = "图像编码独立运行，并使用有界队列传递结果。"
    original = "图像编码放到独立进程，结果通过有界队列传给写入任务。"
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply(text))
    result = reader.read_q2(_payload(original))
    assert result["answer"] == text


def test_cross_row_quote_keeps_all_and_only_its_literal_members(monkeypatch):
    texts = ["先评审接口，", "再提交清单。", "茶水已经准备好了。"]
    payload = _payload()
    payload["sources"] = [{"source_type": "transcript", "source_id": f"line-{i}",
        "source_revision_id": "r", "content_sha256": _hash(text), "text": text}
        for i, text in enumerate(texts)]
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply("先评审接口，再提交清单。", last=1))
    result = reader.read_q2(payload)
    cites = result["clauses"][0]["citations"]
    assert [c["source_id"] for c in cites] == ["line-0", "line-1"]
    assert [c["quote"] for c in cites] == texts[:2]


def _fragment_payload(texts, source_types=None, revisions=None):
    payload = _payload()
    payload['sources'] = [
        {'source_type': source_types[i] if source_types else 'transcript',
         'source_id': f'fragment-{i}', 'source_revision_id': revisions[i] if revisions else 'r',
         'content_sha256': _hash(text), 'text': text}
        for i, text in enumerate(texts)]
    payload['source_fingerprint'] = reader._source_fingerprint(payload['sources'])
    return payload


@pytest.mark.parametrize('texts,answer', [
    (['安排在四。', '月底结束。'], '安排在4月底结束。'),
    (['预计需要三.', '小时。'], '预计需要3小时。'),
    (['先交付给两。', '家单位。'], '先交付给2家单位。'),
])
def test_adjacent_cited_asr_number_and_measure_survive_without_rewriting_quotes(monkeypatch, texts, answer):
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: _reply(answer, last=1))
    result = reader.read_q2(_fragment_payload(texts))
    assert result['answer'] == answer
    assert [c['quote'] for c in result['clauses'][0]['citations']] == texts


@pytest.mark.parametrize('keep', [0, 1, None])
def test_asr_number_measure_proof_must_survive_evidence_review(monkeypatch, keep):
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: _reply('预计需要3小时。', last=1))
    monkeypatch.setattr(reader, 'verify_claims', lambda question, claims, context: [
        {**claims[0], 'citations': claims[0]['citations'][0]['_members']
         if keep is None else [claims[0]['citations'][0]['_members'][keep]]}] if claims else [])
    result = reader.read_q2(_fragment_payload(['预计需要三。', '小时。']))
    assert result['answer_kind'] == ('answer' if keep is None else 'cannot_confirm')


@pytest.mark.parametrize('texts,answer,types,revisions', [
    (['到六。', '另外先处理材料。', '月中结束。'], '到6月中结束。', None, None),
    (['到六。', '月中结束。'], '到7月中结束。', None, None),
    (['到六。', '月中结束。'], '到6月中结束。', ['transcript', 'manual_note'], None),
    (['到六。', '月中结束。'], '到6月中结束。', None, ['old', 'new']),
    (['预算二十。', '三元。'], '预算23元。', None, None),
    (['预算三。', '万元。'], '预算30000元。', None, None),
    (['意见已经统一。', '稍后讨论月份。'], '安排在1月。', None, None),
])
def test_numeric_seam_cannot_borrow_missing_or_unrelated_evidence(monkeypatch, texts, answer, types, revisions):
    response = json.loads(_reply(answer))
    response['clauses']['c1']['citations']['e2'] = {
        'source_id': 'w1' if types or revisions else 'w0',
        'first_part': 0 if types or revisions else len(texts) - 1,
        'last_part': 0 if types or revisions else len(texts) - 1}
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    result = reader.read_q2(_fragment_payload(texts, types, revisions))
    assert result['answer_kind'] == 'cannot_confirm'


def test_retrieval_gap_cannot_be_mistaken_for_an_asr_seam(monkeypatch):
    payload = _fragment_payload(['到六。', '另一个议题。', '月中结束。'])
    monkeypatch.setattr(reader, '_select_model_sources', lambda q, fingerprint, sources, **kw: (
        [{**sources[i], '_original_index': i} for i in (0, 2)], False))
    response = json.loads(_reply('到6月中结束。'))
    response['clauses']['c1']['citations']['e2'] = {'source_id': 'w1', 'first_part': 0, 'last_part': 0}
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    assert reader.read_q2(payload)['answer_kind'] == 'cannot_confirm'


def test_disconnected_quotes_cannot_complete_a_numeral_even_without_punctuation(monkeypatch):
    payload = _fragment_payload(['到六', '另一个议题。', '月中结束。'])
    response = json.loads(_reply('到6月中结束。'))
    response['clauses']['c1']['citations']['e2'] = {'source_id': 'w0', 'first_part': 2, 'last_part': 2}
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    assert reader.read_q2(payload)['answer_kind'] == 'cannot_confirm'


def test_contiguous_spoken_ratio_fragments_still_supply_the_same_value(monkeypatch):
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: _reply('预付50%。', last=1))
    assert reader.read_q2(_fragment_payload(['预付百分之', '五十。']))['answer'] == '预付50%。'


def test_source_time_gap_is_not_a_numeric_seam(monkeypatch):
    payload = _fragment_payload(['到六。', '月中结束。'])
    payload['sources'][0].update(start_ms=0, end_ms=1000)
    payload['sources'][1].update(start_ms=8000, end_ms=9000)
    response = json.loads(_reply('到6月中结束。'))
    response['clauses']['c1']['citations']['e2'] = {'source_id': 'w1', 'first_part': 0, 'last_part': 0}
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    assert reader.read_q2(payload)['answer_kind'] == 'cannot_confirm'


def test_exact_same_source_utf8_slices_can_span_model_windows(monkeypatch):
    text = '说明' * 127 + '两。家单位。'
    response = json.loads(_reply('2家单位。'))
    response['clauses']['c1']['citations']['e2'] = {'source_id': 'w1', 'first_part': 0, 'last_part': 0}
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    result = reader.read_q2(_fragment_payload([text]))
    assert result['answer'] == '2家单位。'
    assert ''.join(c['quote'] for c in result['clauses'][0]['citations']) == text


@pytest.mark.parametrize("first,last", [(-1, 0), (1, 1), (0, 8), (True, 0)])
def test_invalid_part_range_cannot_scavenge_nearby_words(monkeypatch, first, last):
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply(first=first, last=last))
    result = reader.read_q2(_payload())
    assert result["answer_kind"] == "cannot_confirm" and result["clauses"] == []


def test_citation_alias_cannot_rebind_to_missing_source(monkeypatch):
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply(source_id="foreign"))
    with pytest.raises(reader.Q2ReaderError, match="不属于当前来源"):
        reader.read_q2(_payload())


def test_missing_number_is_not_supplied_from_another_source(monkeypatch):
    payload = _payload("预付款为50%。")
    payload["sources"].append({**payload["sources"][0], "source_id": "line-2",
                               "text": "此前曾讨论60%。", "content_sha256": _hash("此前曾讨论60%。")})
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply("预付款为60%。"))
    result = reader.read_q2(payload)
    assert result["answer_kind"] == "cannot_confirm"


@pytest.mark.parametrize("keep_numeric", [False, True])
def test_reviewed_claim_must_keep_its_numeric_proof(monkeypatch, keep_numeric):
    payload = _payload("预付款为50%。")
    text = "同意继续合作。"
    payload['sources'].append({**payload['sources'][0], 'source_id': 'other', 'text': text,
                              'content_sha256': _hash(text)})
    payload['source_fingerprint'] = reader._source_fingerprint(payload['sources'])
    response = json.loads(_reply("预付款为50%。", last=1))
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: json.dumps(response))
    monkeypatch.setattr(reader, 'verify_claims', lambda question, claims, sources: [
        {**claims[0], 'citations': [claims[0]['citations'][0]['_members'][0 if keep_numeric else 1]]}])
    result = reader.read_q2(payload)
    assert result['answer_kind'] == ('answer' if keep_numeric else 'cannot_confirm')
    assert result['answer']
    assert bool(result['clauses']) is keep_numeric


@pytest.mark.parametrize("answer,quote", [
    ("预付50%。", "每批预付百分之五十的货款。"),
    ("单价20元，共12批。", "二十元每个，一共十二批。"),
    ("每批4万件。", "每批四万件。"),
    ("数量40000件。", "四万件。"),
    ("比例3.5%。", "百分之三点五。"),
    ("变化-20%。", "百分之负二十。"),
    ("重量2千克。", "两公斤。"),
    ("距离五公里。", "5千米。"),
])
def test_spoken_and_written_numerals_are_not_different_facts(answer, quote):
    assert reader._fact_values(answer).issubset(reader._fact_values(quote))


@pytest.mark.parametrize("answer,quote", [("预付55%。", "预付百分之五十。"),
    ("单价25元。", "二十元每个。"), ("比例50%。", "数量五十个。")])
def test_numeral_equivalence_does_not_approve_different_values_or_ratios(answer, quote):
    assert not reader._fact_values(answer).issubset(reader._fact_values(quote))


def test_numeric_check_must_not_veto_a_reviewed_correction_of_the_questions_amount(monkeypatch):
    payload = _payload("现场共有24人，停车费总共30元。")
    payload['question'] = '停车费是24元吗？'
    answer = '停车费不是24元，而是30元。'
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: _reply(answer))
    result = reader.read_q2(payload)
    assert result['answer'] == answer


@pytest.mark.parametrize("text,values", [
    ('2千克', {'number:2'}), ('两千克', {'number:2'}),
    ('2.5千克', {'number:2.5'}), ('两点五千克', {'number:2.5'}),
    ('五公里', {'number:5'}), ('5千米', {'number:5'}),
    ('五千米', {'number:5'}), ('三小时', {'number:3'}),
    ('两公斤', {'number:2'}), ('一钟头', {'number:1'}),
    ('一千元', {'number:1E+3'}), ('2千人', {'number:2E+3'}),
    ('3千件', {'number:3E+3'}), ('五千万元', {'number:5E+7'}),
    ('统一意见，一致认可', set()), ('第一版', set()),
])
def test_numeric_token_boundary_preserves_units_and_real_multipliers(text, values):
    assert reader._fact_values(text) == values


@pytest.mark.parametrize("answer,quote", [
    ('资料箱重2公斤。', '资料箱重2千克。'),
    ('距离五公里。', '距离5千米。'),
    ('预计需要3小时。', '预计需要三小时。'),
])
def test_reviewed_unit_paraphrase_is_not_dropped_as_a_different_number(monkeypatch, answer, quote):
    monkeypatch.setattr(reader, 'call_llm', lambda *a, **kw: _reply(answer))
    result = reader.read_q2(_payload(quote))
    assert result['answer'] == answer
    assert result['clauses'][0]['citations'][0]['quote'] == quote


def test_entailment_review_rejects_entire_claim_without_keyword_salvage(monkeypatch):
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply())
    monkeypatch.setattr(reader, "verify_claims", lambda *a: [])
    result = reader.read_q2(_payload())
    assert result["answer_kind"] == "cannot_confirm" and result["clauses"] == []


def test_semantic_review_filters_unrelated_quote_at_its_evidence_owner(monkeypatch):
    payload = _payload()
    payload["sources"].append({**payload["sources"][0], "source_id": "line-2",
                               "text": "茶水已备好。", "content_sha256": _hash("茶水已备好。")})
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    response = json.loads(_reply())
    response["clauses"]["c1"]["citations"]["e2"] = {"source_id": "w0", "first_part": 1, "last_part": 1}
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: json.dumps(response))
    received = []
    def review(question, claims, sources):
        received.extend(claims[0]["citations"])
        return [{**claims[0], "citations": claims[0]["citations"][0]["_members"]}]
    monkeypatch.setattr(reader, "verify_claims", review)
    result = reader.read_q2(payload)
    assert len(received) == 2
    assert [c["quote"] for c in result["clauses"][0]["citations"]] == ["周五前由张敏提交接口文档。"]


def test_source_offset_is_restored_without_changing_content_hash(monkeypatch):
    payload = _payload()
    row = payload["sources"][0]
    row.update(source_start_utf8=321, source_end_utf8=321 + len(row["text"].encode()))
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply())
    result = reader.read_q2(payload)
    assert result["clauses"][0]["citations"][0]["source_start_utf8"] == 321


def test_changed_source_body_is_rejected_before_model_call(monkeypatch):
    payload = _payload()
    payload["sources"][0]["text"] = "另一个会议的内容。"
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: pytest.fail("hash fence must run first"))
    with pytest.raises(reader.Q2ReaderError, match="内容校验失败"):
        reader.read_q2(payload)


def test_source_body_and_quoted_whitespace_are_not_trimmed_before_hash_validation(monkeypatch):
    text = "  第一行\n第二行😀  "
    payload = _payload(text)
    monkeypatch.setattr(reader, "call_llm", lambda *a, **kw: _reply("记录有两行内容。"))
    result = reader.read_q2(payload)
    cite = result["clauses"][0]["citations"][0]
    assert cite["quote"] == text and cite["content_sha256"] == _hash(text)


def test_different_final_values_are_evidence_for_model_review_not_a_keyword_veto(monkeypatch):
    payload = _payload("最终提交时间为6月5日，评审安排另行说明。")
    payload["question"] = "最终提交日期和评审日期分别是哪天？"
    text = "最终评审日期为6月6日。"
    payload["sources"].append({"source_type": "manual_note", "source_id": "note", "source_revision_id": "n1",
                               "text": text, "content_sha256": _hash(text)})
    payload["source_fingerprint"] = reader._source_fingerprint(payload["sources"])
    calls = []
    def model(config, prompt, data, **kwargs):
        calls.append(json.loads(data))
        return json.dumps({"answer_kind": "cannot_confirm", "answer": "需要核对来源。", "clauses": {}})
    monkeypatch.setattr(reader, "call_llm", model)
    reader.read_q2(payload)
    assert len(calls) == 1
    assert {row["source_type"] for row in calls[0]["sources"]} == {"transcript", "manual_note"}


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


def test_retrieval_small_increment_uses_cpu_embedding(monkeypatch):
    calls = []
    monkeypatch.setattr(reader, "embed_texts", lambda texts, **kwargs: (
        calls.append(kwargs) or [(1.0, 0.0) for _text in texts]
    ))

    vectors = reader._embed_retrieval_units([{"text": "一条补充笔记"}])

    assert vectors == [(1.0, 0.0)]
    assert calls[0]["num_gpu"] == 0
    assert calls[0]["num_ctx"] == 2048


def test_complete_packed_evidence_is_budgeted_before_deciding_to_retrieve(monkeypatch):
    from app.services.question_source_windows import pack_sources
    from app.services.summary_v3_evidence import estimate_tokens
    sources = [{"source_type": "transcript", "source_id": f"part-{i}",
        "source_revision_id": "revision", "content_sha256": _hash("这是连续的一段会议原文。"),
        "text": "这是连续的一段会议原文。"} for i in range(90)]
    question, fingerprint = "主要内容是什么？", reader._source_fingerprint(sources)
    raw_cost = estimate_tokens(json.dumps(reader._model_payload(question, fingerprint, sources),
        ensure_ascii=False, separators=(",", ":")))
    packed_cost = estimate_tokens(json.dumps(reader._model_payload(question, fingerprint, pack_sources(sources)),
        ensure_ascii=False, separators=(",", ":")))
    assert packed_cost < raw_cost
    monkeypatch.setattr(reader, "embed_texts_cached", lambda *a, **k: pytest.fail("full input already fits"))
    selected, complete = reader._select_model_sources(question, fingerprint, sources, input_token_budget=packed_cost)
    assert complete is True and selected == sources


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


def test_mobile_distinct_segment_ids_do_not_disable_lossless_retrieval_packing():
    rows = [{"source_type": "transcript", "source_id": f"canonical-segment-{i}",
        "source_revision_id": "one-active-transcript", "content_sha256": _hash(str(i)),
        "text": f"第{i}段相邻的原始文字。", "start_ms": i * 4000, "end_ms": (i + 1) * 4000}
        for i in range(100)]
    units = reader._retrieval_units(rows)
    assert len(units) < len(rows) / 4
    assert [i for u in units for i in u["member_indexes"]] == list(range(100))


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
