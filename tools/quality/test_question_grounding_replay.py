import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "laoji-api"))
from app.services import vnext_question_reader as reader, question_evidence_verifier as verifier

spec = importlib.util.spec_from_file_location("grounding_replay", Path(__file__).with_name("replay_question_grounding.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def source(index):
    text = "核对记录。"
    return {"source_type": "transcript", "source_id": f"row-{index}",
        "source_revision_id": "r", "content_sha256": "sha256:" + hashlib.sha256(text.encode()).hexdigest(), "text": text}


def refusal():
    return {"schema_version": 2, "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION, "model_revision": "captured-model",
        "snapshot_id": "quality-probe", "answer_kind": "cannot_confirm",
        "answer": "当前记录不足以可靠确认这个问题。", "clauses": []}


def captured_ranges(members):
    cites = {"e1": {"source_id": "w0", "first_part": 0, "last_part": min(members, 5) - 1}}
    if members > 5:
        cites["e2"] = {"source_id": "w0", "first_part": 5, "last_part": members - 1}
    return [{"phase": "reader", "raw": json.dumps({"answer_kind": "answer", "answer": "占位",
        "clauses": {"c1": {"text": "核对记录。", "citations": cites}}}, ensure_ascii=False)},
        {"phase": "review", "raw": json.dumps({"c1": {"assessment": "逐字支持。", "duplicate_of": None,
            "supported": True, "citations": dict.fromkeys(cites, True)}}, ensure_ascii=False)}]


def test_refusal_replays_without_any_live_provider(monkeypatch):
    monkeypatch.setattr(reader, "call_llm", lambda *a, **k: pytest.fail("live provider called"))
    expected = {**refusal(), "answer_kind": "not_stated", "answer": "未提及。"}
    row = {"question": "何时交付？", "result": expected, "calls": [{"phase": "reader", "raw":
        json.dumps({"answer_kind": "not_stated", "answer": "未提及。", "clauses": {}})}]}
    result = probe.replay_row(reader, verifier, [source(0)], row)
    assert result["envelope_matches_saved"] and result["saved_call_count"] == 1
    assert "何时交付" not in json.dumps(result, ensure_ascii=False)


def test_supported_nine_members_reveals_bound_loss_not_model_rejection():
    row = {"question": "核对什么？", "result": refusal(), "calls": captured_ranges(9)}
    result = probe.replay_row(reader, verifier, [source(i) for i in range(9)], row)
    assert result["envelope_matches_saved"]
    assert result["before_review_clauses"] == 1 and result["after_review_clauses"] == 0
    assert result["review_rejections"] == [{"clause_id": "c1", "model_supported": True,
        "selected_member_count": 9, "over_public_citation_bound": True, "duplicate_of": None}]


def test_eight_members_are_not_reported_as_bound_rejection():
    row = {"question": "核对什么？", "result": refusal(), "calls": captured_ranges(8)}
    result = probe.replay_row(reader, verifier, [source(i) for i in range(8)], row)
    # Deliberately wrong saved refusal: replay equality must fail, not become a
    # semantic pass just because parsing/grounding succeeded.
    assert not result["envelope_matches_saved"]
    assert result["final_clauses"] == 1 and result["review_rejections"] == []


def test_uncaptured_model_call_fails_closed_and_restores_owners():
    original_call, original_review = reader.call_llm, reader.verify_claims
    row = {"question": "核对什么？", "result": refusal(), "calls": captured_ranges(8)[:1]}
    with pytest.raises(RuntimeError, match="uncaptured_model_call"):
        probe.replay_row(reader, verifier, [source(i) for i in range(8)], row)
    assert reader.call_llm is original_call and reader.verify_claims is original_review


def test_unused_captured_call_cannot_be_ignored():
    raw = json.dumps({"answer_kind": "cannot_confirm", "answer": refusal()["answer"], "clauses": {}})
    row = {"question": "核对什么？", "result": refusal(), "calls": [
        {"phase": "reader", "raw": raw}, {"phase": "review", "raw": "{}"}]}
    with pytest.raises(RuntimeError, match="not_consumed"):
        probe.replay_row(reader, verifier, [source(0)], row)


def test_oversized_input_cannot_silently_make_embedding_requests():
    text = "核对记录。" * 10000
    large = {**source(0), "text": text,
             "content_sha256": "sha256:" + hashlib.sha256(text.encode()).hexdigest()}
    row = {"question": "核对什么？", "result": refusal(), "calls": []}
    with pytest.raises(RuntimeError, match="uncaptured_embedding_or_provider_call"):
        probe.replay_row(reader, verifier, [large], row)
