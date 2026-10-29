import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("review_comparison", Path(__file__).with_name("compare_question_reviews.py"))
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def test_only_captured_reviews_are_compared_without_replaying_generation(tmp_path):
    payload = {"question": "有哪些后续工作？", "claims": [{"id": "c1", "text": "笔记作者整理清单。",
        "evidence": {"e1": {"source_type": "manual_note", "quote": "我整理清单。"}}}],
        "context_in_source_order": [{"source_type": "manual_note", "text": "我整理清单。"}]}
    source = tmp_path / "captured.jsonl"
    source.write_text(json.dumps({"calls": [
        {"phase": "reader", "input": {"not": "a review"}},
        {"phase": "review", "input": payload}]}))
    cases = comparison.captured_cases(source)
    assert len(cases) == 1
    assert cases[0]["question"] == payload["question"]
    assert cases[0]["context"] == payload["context_in_source_order"]
    assert cases[0]["claims"] == [{"text": "笔记作者整理清单。", "citations": [
        {"source_type": "manual_note", "quote": "我整理清单。"}]}]
    assert "expected_retained" not in cases[0]  # A saved response is not a quality oracle.


def test_missing_review_input_is_not_silently_dropped(tmp_path):
    source = tmp_path / "captured.jsonl"
    source.write_text(json.dumps({"calls": [{"phase": "review", "raw": "{}"}]}))
    with pytest.raises(ValueError, match="captured_review_input_required"):
        comparison.captured_cases(source)


def test_refusal_without_a_review_is_not_counted_as_a_review_call(tmp_path):
    source = tmp_path / "captured.jsonl"
    source.write_text(json.dumps({"calls": [{"phase": "reader", "raw": "{}"}]}))
    assert comparison.captured_cases(source) == []
