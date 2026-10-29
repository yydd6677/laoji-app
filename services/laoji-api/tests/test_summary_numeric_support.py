import pytest

from app.services.summary_v3_generator import _numeric_claims_supported


@pytest.mark.parametrize("claim,quote", [
    ("4人", "40人"), ("4", "40人"), ("40人", "4人"),
    ("2.5元", "12.5元"), ("100%", "1100%"),
    ("2026年", "12026年"), ("24人", "24元"),
    ("24元", "24万元"), ("20%", "20元"),
])
def test_different_complete_values_or_explicit_units_are_not_proof(claim, quote):
    assert not _numeric_claims_supported(claim, quote)


@pytest.mark.parametrize("claim,quote", [
    ("24人", "人数24人"), ("24", "人数24人"),
    ("2.5元", "2.5 元"), ("20%", "20 %"),
    ("0.2元", "0.20元"), ("20%", "20％"),
    ("2026年10月3日", "2026 年 10 月 3 日"),
    ("统一处理", "由对应人员处理"),
])
def test_complete_values_and_existing_optional_units_remain_supported(claim, quote):
    before = quote.encode("utf-8")
    assert _numeric_claims_supported(claim, quote)
    assert quote.encode("utf-8") == before


def test_spoken_form_does_not_silently_remove_explicit_unit_requirement():
    assert not _numeric_claims_supported("24人", "二十四元")


def test_unrelated_larger_value_cannot_survive_document_verification():
    from app.schemas.meeting_facts_v3 import MeetingFactsModelResponseV3
    from app.services.summary_v3_evidence import build_evidence_package
    from app.services.summary_v3_generator import verify_model_response
    package = build_evidence_package([
        {"id": "attendance", "text": "本次到场40人。"},
        {"id": "venue", "text": "场地尚待确认。"},
    ], None, [])
    response = MeetingFactsModelResponseV3.model_validate({
        "schema_version": 3,
        "overview": {"text": "场地尚待确认。", "fact_ids": ["f2"]},
        "facts": [{"fact_id": f"f{i + 1}", "fact_type": "context", "certainty": "confirmed",
                   "content": content, "sources": [{"source_id": source.source_id,
                        "source_type": source.source_type, "quote": source.text}]}
                  for i, (source, content) in enumerate(zip(package.sources, ["本次到场4人。", "场地尚待确认。"]))],
        "relations": [], "action_candidates": [],
    })
    document = verify_model_response(response, package)
    assert [fact.fact_id for fact in document.facts] == ["f2"]
