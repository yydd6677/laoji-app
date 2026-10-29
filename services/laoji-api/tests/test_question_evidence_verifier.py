import json

import pytest

from app.services import question_evidence_verifier as verifier
from app.services.llm_provider import LlmProviderError
from app.services.question_source_windows import pack_sources, ground_parts


def claims():
    return [{"clause_id": "original-id", "text": "采用队列解耦采集和写入，减少阻塞。",
             "citations": [{"source_type": "transcript", "quote": "采集先放队列，再由写入任务处理。"},
                           {"source_type": "transcript", "quote": "今天大家都到了。"}]}]


def test_review_returns_only_supported_whole_claims_and_relevant_citations(monkeypatch):
    original = claims()
    observed = []
    def llm(config, system, data, **kwargs):
        observed.append(json.loads(data))
        assert kwargs["telemetry_operation"] == "question.q2.evidence.v3"
        return json.dumps({"c1": {"assessment": "首条证据支持机制，第二条无关。", "duplicate_of": None, "supported": True, "citations": {"e1": True, "e2": False}}})
    monkeypatch.setattr(verifier, "call_llm", llm)
    retained = verifier.verify_claims("怎样减少采集阻塞？", original, [])
    assert retained[0]["text"] == original[0]["text"]
    assert retained[0]["citations"] == original[0]["citations"][:1]
    assert len(original[0]["citations"]) == 2
    assert observed[0]["claims"][0]["evidence"]["e1"]["quote"] == original[0]["citations"][0]["quote"]


def test_rejected_claim_is_not_salvaged_by_cutting_out_unmatched_words(monkeypatch):
    original = claims()
    monkeypatch.setattr(verifier, "call_llm", lambda *a, **k: json.dumps({
        "c1": {"assessment": "只支持部分内容。", "duplicate_of": None, "supported": False, "citations": {"e1": True, "e2": False}}}))
    assert verifier.verify_claims("怎样改进？", original, []) == []


@pytest.mark.parametrize("raw", ["not JSON", '{}', '{"c1":true}',
    '{"c1":{"supported":"true","citations":{"e1":true,"e2":false}}}',
    '{"c1":{"supported":true,"citations":{"e1":true}}}',
    '{"c1":{"supported":true,"citations":{"e1":true,"e2":false},"answer":"rewrite"}}'])
def test_malformed_review_cannot_silently_bypass_evidence_check(monkeypatch, raw):
    monkeypatch.setattr(verifier, "call_llm", lambda *a, **k: raw)
    with pytest.raises(LlmProviderError, match="format_invalid"):
        verifier.verify_claims("如何？", claims(), [])


def test_true_without_any_accepted_citation_is_not_a_supported_claim(monkeypatch):
    monkeypatch.setattr(verifier, "call_llm", lambda *a, **k: json.dumps({
        "c1": {"assessment": "没有有效引用。", "duplicate_of": None, "supported": True, "citations": {"e1": False, "e2": False}}}))
    assert verifier.verify_claims("如何？", claims(), []) == []


def test_empty_input_never_calls_model(monkeypatch):
    monkeypatch.setattr(verifier, "call_llm", lambda *a, **k: pytest.fail("No review needed"))
    assert verifier.verify_claims("如何？", [], []) == []


def test_short_asr_windows_return_exact_members_not_a_synthetic_source(monkeypatch):
    sources = [{"source_type": "transcript", "source_id": f"s{i}", "source_revision_id": "r1",
        "content_sha256": f"hash-{i}", "text": text, "source_start_utf8": 0,
        "start_ms": i * 4000, "end_ms": (i + 1) * 4000}
        for i, text in enumerate(["由李明负责，", "先评审接口，", "再提交清单。"])]
    window = pack_sources(sources)[0]
    quote = "\n".join(row["text"] for row in sources)
    cite = ground_parts(window, 0, 2, "test")
    observed = []
    def llm(config, system, data, **kw):
        observed.append(json.loads(data))
        return json.dumps({"c1": {"assessment": "相邻片段共同支撑先评审再提交。", "duplicate_of": None, "supported": True, "citations": {"e1": True}}})
    monkeypatch.setattr(verifier, "call_llm", llm)
    result = verifier.verify_claims("流程是什么？", [{"text": "李明先评审接口，再提交清单。", "citations": [cite]}], sources)
    assert observed[0]["claims"][0]["evidence"]["e1"]["quote"] == quote
    assert [row["source_id"] for row in result[0]["citations"]] == ["s0", "s1", "s2"]
    for row in result[0]["citations"]:
        source = next(s for s in sources if s["source_id"] == row["source_id"])
        assert row["quote"] == source["text"]
        assert row["source_end_utf8"] == len(source["text"].encode())


@pytest.mark.parametrize("boundary", ["revision", "retrieval_gap", "audio_gap", "type"])
def test_context_window_never_crosses_an_unrelated_source_boundary(boundary):
    sources = [{"source_type": "transcript", "source_id": f"s{i}", "source_revision_id": "r1",
        "content_sha256": f"hash-{i}", "text": text, "start_ms": i * 4000,
        "end_ms": (i + 1) * 4000, "_original_index": i}
        for i, text in enumerate(["先评审接口，", "再提交清单。"])]
    if boundary == "revision": sources[1]["source_revision_id"] = "r2"
    if boundary == "type": sources[1]["source_type"] = "manual_note"
    if boundary == "retrieval_gap": sources[1]["_original_index"] = 8
    if boundary == "audio_gap": sources[1]["start_ms"] = 100000
    cite = {key: value for key, value in sources[0].items() if key != "text"}
    cite["quote"] = sources[0]["text"]
    windows = pack_sources(sources)
    assert len(windows) == 2
    assert windows[0]["text"] == sources[0]["text"]


@pytest.mark.parametrize("first_supported", [True, False])
def test_semantic_duplicate_only_removes_a_claim_if_its_predecessor_survives(monkeypatch, first_supported):
    original = claims()
    original.append({**original[0], "text": "通过队列分离采集和写入，避免互相阻塞。"})
    row = {"assessment": "同一事实的不同措辞。", "duplicate_of": None,
           "supported": first_supported, "citations": {"e1": True, "e2": False}}
    monkeypatch.setattr(verifier, "call_llm", lambda *a, **k: json.dumps({
        "c1": row, "c2": {**row, "supported": True, "duplicate_of": "c1"}}))
    result = verifier.verify_claims("怎样减少阻塞？", original, [])
    assert len(result) == 1
    assert result[0]["text"] == original[0 if first_supported else 1]["text"]
