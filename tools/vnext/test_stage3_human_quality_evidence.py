from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from stage3_human_quality_evidence import (
    ADJUDICATION_CONTRACT,
    DOMAIN_FACTS,
    DOMAIN_Q2,
    SUBMISSION_CONTRACT,
    Stage3EvidenceError,
    make_templates,
    score_evidence,
    verify_report,
)


def _write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _facts_review(*, supported: bool | None) -> dict:
    return {
        "overview_accurate": supported,
        "important_fact_omitted": False if supported is not None else None,
        "conflicts_preserved": supported,
        "critical_error": False if supported is not None else None,
        "omission_notes": "",
        "notes": "",
        "facts": [{
            "fact_id": "fact-1",
            "supported": supported,
            "materially_accurate": supported,
            "certainty_correct": supported,
            "important": supported,
            "notes": "",
        }],
        "actions": [{
            "action_id": "action-1",
            "is_real_commitment": supported,
            "specific_and_useful": supported,
            "owner_supported": supported,
            "due_supported": supported,
            "schedule_fit_appropriate": supported,
            "duplicate_of": "",
            "notes": "",
        }],
    }


def _q2_review(*, correct: bool | None) -> dict:
    return {
        "answer_correct": correct,
        "answer_complete": correct,
        "citations_relevant": correct,
        "refusal_appropriate": correct,
        "critical_error": False if correct is not None else None,
        "notes": "",
    }


def _source(tmp_path: Path, domain: str) -> Path:
    path = tmp_path / f"{domain}-source.json"
    if domain == DOMAIN_FACTS:
        value = {
            "schema_version": 1,
            "contract": "stage3-facts-actions-human-review-v1",
            "blind": True,
            "in_progress": False,
            "reviewer": {"reviewer_id": "", "completed_at": ""},
            "rows": [{
                "review_id": "meeting-opaque-1",
                "source_context": [{"content": "仅存在于私有来源的会议句子"}],
                "facts_document": {
                    "facts": [{"fact_id": "fact-1", "content": "私有事实"}],
                    "action_candidates": [{"action_id": "action-1", "content": "私有行动"}],
                },
                "review": _facts_review(supported=None),
            }],
        }
    else:
        value = {
            "schema_version": 1,
            "contract": "stage3-q2-human-review-v1",
            "blind": True,
            "in_progress": False,
            "reviewer": {"reviewer_id": "", "completed_at": ""},
            "rows": [{
                "review_id": "question-opaque-1",
                "question": "仅存在于私有来源的问题",
                "answer": "仅存在于私有来源的回答",
                "citation_source_context": [{"content": "私有引用"}],
                "review": _q2_review(correct=None),
            }],
        }
    _write(path, value)
    return path


def _completed_pack(tmp_path: Path, domain: str) -> dict[str, Path]:
    source = _source(tmp_path, domain)
    output = tmp_path / f"{domain}-review"
    make_templates(source, domain, output)
    review_value = (
        _facts_review(supported=True)
        if domain == DOMAIN_FACTS
        else _q2_review(correct=True)
    )
    for label, reviewer_id, completed_at in (
        ("a", "reviewer-a", "2026-08-21T10:00:00+08:00"),
        ("b", "reviewer-b", "2026-08-21T10:01:00+08:00"),
    ):
        path = output / f"review-{label}.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["reviewer"] = {
            "anonymous_id": reviewer_id,
            "native_chinese_human": True,
            "independent": True,
            "automated_result_blind": True,
            "completed_at": completed_at,
        }
        value["rows"][0]["review"] = review_value
        _write(path, value)
    adjudication = output / "adjudication.json"
    value = json.loads(adjudication.read_text(encoding="utf-8"))
    value["review_a_sha256"] = _sha(output / "review-a.json")
    value["review_b_sha256"] = _sha(output / "review-b.json")
    value["adjudicator"] = {
        "anonymous_id": "adjudicator-c",
        "native_chinese_human": True,
        "independent": True,
        "completed_at": "2026-08-21T10:02:00+08:00",
    }
    value["rows"][0]["reason_code"] = "agree"
    value["rows"][0]["review"] = review_value
    _write(adjudication, value)
    return {
        "source": source,
        "review_a": output / "review-a.json",
        "review_b": output / "review-b.json",
        "adjudication": adjudication,
    }


def _score(paths: dict[str, Path], domain: str) -> dict:
    return score_evidence(
        domain=domain,
        source_path=paths["source"],
        review_a_path=paths["review_a"],
        review_b_path=paths["review_b"],
        adjudication_path=paths["adjudication"],
    )


@pytest.mark.parametrize("domain", [DOMAIN_FACTS, DOMAIN_Q2])
def test_two_reviews_and_adjudication_emit_content_free_report(
    tmp_path: Path,
    domain: str,
) -> None:
    report = _score(_completed_pack(tmp_path, domain), domain)

    assert report["quality_passed"] is True
    assert verify_report(report) == (True, "verified")
    serialized = json.dumps(report, ensure_ascii=False)
    assert "仅存在于私有来源" not in serialized
    assert "私有事实" not in serialized
    assert "私有引用" not in serialized


def test_templates_are_private_and_intentionally_incomplete(tmp_path: Path) -> None:
    source = _source(tmp_path, DOMAIN_FACTS)
    private_root = tmp_path / "private-root"
    output = private_root / "templates"

    result = make_templates(source, DOMAIN_FACTS, output)

    assert result["row_count"] == 1
    assert private_root.stat().st_mode & 0o777 == 0o700
    assert output.stat().st_mode & 0o777 == 0o700
    for name in result["output_files"]:
        assert (output / name).stat().st_mode & 0o777 == 0o600
    review = json.loads((output / "review-a.json").read_text(encoding="utf-8"))
    assert review["evidence_contract"] == SUBMISSION_CONTRACT
    assert review["reviewer"]["automated_result_blind"] is False


def test_disagreement_cannot_be_adjudicated_as_agreement(tmp_path: Path) -> None:
    paths = _completed_pack(tmp_path, DOMAIN_Q2)
    review_b = json.loads(paths["review_b"].read_text(encoding="utf-8"))
    review_b["rows"][0]["review"]["answer_correct"] = False
    _write(paths["review_b"], review_b)
    adjudication = json.loads(paths["adjudication"].read_text(encoding="utf-8"))
    adjudication["review_b_sha256"] = _sha(paths["review_b"])
    _write(paths["adjudication"], adjudication)

    with pytest.raises(Stage3EvidenceError, match="disagreement_not_resolved"):
        _score(paths, DOMAIN_Q2)


def test_adjudication_must_bind_exact_review_files(tmp_path: Path) -> None:
    paths = _completed_pack(tmp_path, DOMAIN_FACTS)
    adjudication = json.loads(paths["adjudication"].read_text(encoding="utf-8"))
    adjudication["review_a_sha256"] = "sha256:" + "0" * 64
    _write(paths["adjudication"], adjudication)

    with pytest.raises(Stage3EvidenceError, match="review_a_hash_mismatch"):
        _score(paths, DOMAIN_FACTS)


def test_adjudication_contract_is_explicit(tmp_path: Path) -> None:
    paths = _completed_pack(tmp_path, DOMAIN_Q2)
    value = json.loads(paths["adjudication"].read_text(encoding="utf-8"))

    assert value["evidence_contract"] == ADJUDICATION_CONTRACT
