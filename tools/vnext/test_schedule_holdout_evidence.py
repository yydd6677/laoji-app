from __future__ import annotations

import copy

import pytest

from schedule_holdout_evidence import (
    EvidenceError,
    _seal_report,
    make_pack,
    object_sha256,
    score,
    verify_quality_report,
)


def _source_rows(count: int = 30) -> list[dict]:
    return [
        {
            "source_id": f"first-party-{index}",
            "text": f"8月{index}日安排测试事项{index}",
            "reference_datetime": "2026-08-20T08:00:00+08:00",
            "timezone": "Asia/Shanghai",
            "speaker_group": f"speaker-{index}",
            "semantic_event_group": f"event-{index}",
            "consent_reference": "opt-in:test-only",
        }
        for index in range(1, count + 1)
    ]


def _gold(index: int) -> dict:
    return {
        "intent": "create",
        "state": "complete",
        "slots": {
            "title": f"测试事项{index}",
            "start_date": f"2026-08-{index:02d}",
            "end_date": None,
            "start_time": None,
            "end_time": None,
            "time_period": None,
            "event_type": "once",
            "location": None,
            "recurrence": None,
            "reminder": None,
        },
    }


def _field_evidence(text: str, index: int) -> dict:
    date_phrase = f"8月{index}日"
    title = f"测试事项{index}"
    date_start = text.index(date_phrase)
    title_start = text.index(title)
    return {
        "start_date": [{"text": date_phrase, "start": date_start, "end": date_start + len(date_phrase)}],
        "title": [{"text": title, "start": title_start, "end": title_start + len(title)}],
    }


def _artifacts(*, source_policy: str = "first_party_opt_in") -> tuple[dict, dict, dict, dict, dict, dict]:
    rows = _source_rows()
    if source_policy != "first_party_opt_in":
        rows = [
            {
                "source_id": row["source_id"],
                "text": row["text"],
                "reference_datetime": row["reference_datetime"],
                "timezone": row["timezone"],
                "source": {"kind": "massive", "dataset": "test-public", "license": "CC-BY-4.0"},
            }
            for row in rows
        ]
    pack = make_pack(rows, holdout_id="test-holdout", source_policy=source_policy)
    manifest = copy.deepcopy(pack["manifest"])
    review_a = copy.deepcopy(pack["review_a"])
    review_b = copy.deepcopy(pack["review_b"])
    review_a["reviewer"].update({"reviewer_id": "human-a", "completed_at": "2026-08-20T09:00:00+08:00"})
    review_b["reviewer"].update({"reviewer_id": "human-b", "completed_at": "2026-08-20T09:01:00+08:00"})

    row_by_id = {row["case_id"]: row for row in manifest["rows"]}
    for review in (review_a, review_b):
        for index, annotation in enumerate(review["annotations"], 1):
            text = row_by_id[annotation["case_id"]]["text"]
            annotation.update({
                "review_status": "accept",
                "naturalness": 5,
                "gold": _gold(index),
                "field_evidence": _field_evidence(text, index),
                "exclusion_reason": None,
            })

    adjudication = copy.deepcopy(pack["adjudication"])
    adjudication.update({
        "review_a_sha256": object_sha256(review_a),
        "review_b_sha256": object_sha256(review_b),
        "blind_review_revealed_at": "2026-08-20T09:02:00+08:00",
        "adjudicator_id": "human-a",
        "completed_at": "2026-08-20T09:05:00+08:00",
    })
    for index, decision in enumerate(adjudication["decisions"], 1):
        text = row_by_id[decision["case_id"]]["text"]
        decision.update({
            "status": "accept",
            "resolution": "agreement",
            "gold": _gold(index),
            "field_evidence": _field_evidence(text, index),
            "exclusion_reason": None,
            "rationale_code": None,
        })

    predictions = {
        "schema_version": 1,
        "holdout_id": manifest["holdout_id"],
        "source_manifest_sha256": object_sha256(manifest),
        "producer_revision": "test-producer-r1",
        "generated_at": "2026-08-20T10:00:00+08:00",
        "predictions": [
            {
                "case_id": row["case_id"],
                "text_sha256": row["text_sha256"],
                "output": _gold(index),
            }
            for index, row in enumerate(manifest["rows"], 1)
        ],
    }
    development = {
        "schema_version": 1,
        "corpus_id": "test-development-corpus",
        "created_at": "2026-08-20T08:00:00+08:00",
        "rows": [
            {
                "text_sha256": "sha256:" + "0" * 64,
                "speaker_group": "development-speaker",
                "semantic_event_group": "development-event",
            }
        ],
    }
    return manifest, review_a, review_b, adjudication, predictions, development


def _score(artifacts: tuple[dict, dict, dict, dict, dict, dict]) -> dict:
    manifest, review_a, review_b, adjudication, predictions, development = artifacts
    return score(
        manifest_value=manifest,
        review_a_value=review_a,
        review_b_value=review_b,
        adjudication_value=adjudication,
        predictions_value=predictions,
        development_manifest_value=development,
    )


def test_independent_first_party_holdout_produces_sealed_gate_evidence() -> None:
    report = _score(_artifacts())
    assert report["gate_eligible"] is True
    assert report["sample_count"] == 30
    assert report["metrics"]["field_exact_accuracy"] == 1.0
    assert report["metrics"]["key_field_recall"] == 1.0
    assert report["metrics"]["save_error_count"] == 0
    assert verify_quality_report(report) == (True, "verified")


def test_public_localized_rows_remain_diagnostic_even_after_human_review() -> None:
    report = _score(_artifacts(source_policy="public_localized"))
    assert report["gate_eligible"] is False
    assert report["source_promotion_eligible"] is False
    assert "first_party_opt_in_source_required" in report["promotion_blockers"]


def test_same_reviewer_cannot_supply_both_blind_reviews() -> None:
    artifacts = list(_artifacts())
    artifacts[2]["reviewer"]["reviewer_id"] = "human-a"
    artifacts[3]["review_b_sha256"] = object_sha256(artifacts[2])
    with pytest.raises(EvidenceError, match="reviewers_must_be_distinct"):
        _score(tuple(artifacts))


def test_wrong_saveable_date_counts_as_unsafe_save() -> None:
    artifacts = list(_artifacts())
    artifacts[4]["predictions"][0]["output"]["slots"]["start_date"] = "2026-08-31"
    report = _score(tuple(artifacts))
    assert report["metrics"]["save_error_count"] == 1
    assert report["metrics"]["field_exact_accuracy"] < 1.0
    assert report["metrics"]["key_field_recall"] < 1.0


def test_tampered_report_is_rejected() -> None:
    report = _score(_artifacts())
    report["metrics"]["field_exact_accuracy"] = 0.5
    verified, reason = verify_quality_report(report)
    assert verified is False
    assert reason == "quality_report_hash_mismatch"


def test_resealed_public_report_cannot_claim_first_party_gate() -> None:
    report = _score(_artifacts(source_policy="public_localized"))
    report.pop("report_sha256")
    report["source_promotion_eligible"] = True
    report["gate_eligible"] = True
    verified, reason = verify_quality_report(_seal_report(report))
    assert verified is False
    assert reason == "quality_report_source_eligibility_inconsistent"
