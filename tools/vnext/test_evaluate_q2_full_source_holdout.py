from __future__ import annotations

import json
import stat

import pytest

from evaluate_q2_full_source_holdout import (
    FULL_SOURCE_EXPECTATION_OVERRIDES,
    HUMAN_REVIEW_CONTRACT,
    WORKTREE_ROOT,
    human_review_packet,
    load_resume_state,
    resolve_private_review_path,
    review_id,
    write_json_atomic,
)


def _review_row(run: int, case_id: str) -> dict[str, object]:
    return {
        "review_id": review_id(run, case_id),
        "question": "问题",
        "answer_kind": "answer",
        "answer": "回答",
        "clauses": [],
        "citation_source_context": ["来源"],
        "review": {
            "answer_correct": None,
            "answer_complete": None,
            "citations_relevant": None,
            "refusal_appropriate": None,
            "critical_error": None,
            "notes": "",
        },
    }


def test_private_review_path_rejects_git_worktree() -> None:
    with pytest.raises(ValueError, match="outside the Git worktree"):
        resolve_private_review_path(WORKTREE_ROOT / "private-review.json")


def test_private_review_packet_is_atomic_private_and_blind(tmp_path) -> None:
    destination = tmp_path / "review.json"
    packet = human_review_packet(
        [_review_row(1, "case-a")],
        in_progress=True,
        requested_runs=1,
        case_count=1,
    )
    body = write_json_atomic(destination, packet, mode=0o600)

    assert destination.read_bytes() == body
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    wire = json.loads(body)
    assert wire["contract"] == HUMAN_REVIEW_CONTRACT
    assert wire["in_progress"] is True
    assert "case-a" not in destination.read_text(encoding="utf-8")
    assert "passed" not in wire["rows"][0]
    assert not destination.with_suffix(".json.tmp").exists()


def test_resume_restores_results_and_private_rows(tmp_path) -> None:
    report_path = tmp_path / "report.json"
    review_path = tmp_path / "review.json"
    row = _review_row(1, "case-a")
    report = {
        "requested_runs": 1,
        "case_count": 2,
        "selected_case_ids": ["case-a", "case-b"],
        "auth_refresh_count": 3,
        "human_review": {"row_count": 1},
        "results": [{
            "run": 1,
            "case_id": "case-a",
            "review_id": row["review_id"],
            "passed": True,
        }],
    }
    packet = human_review_packet(
        [row],
        in_progress=True,
        requested_runs=1,
        case_count=2,
    )
    write_json_atomic(report_path, report)
    write_json_atomic(review_path, packet, mode=0o600)

    results, rows, reviewer, refreshes = load_resume_state(
        report_path,
        review_path,
        requested_runs=1,
        case_ids=("case-a", "case-b"),
    )

    assert results == report["results"]
    assert rows == [row]
    assert reviewer == {"reviewer_id": "", "completed_at": ""}
    assert refreshes == 3


def test_resume_refuses_missing_private_packet(tmp_path) -> None:
    report_path = tmp_path / "report.json"
    report = {
        "requested_runs": 1,
        "case_count": 1,
        "selected_case_ids": ["case-a"],
        "human_review": {"row_count": 1},
        "results": [],
    }
    write_json_atomic(report_path, report)

    with pytest.raises(ValueError, match="original --human-review-out"):
        load_resume_state(
            report_path,
            None,
            requested_runs=1,
            case_ids=("case-a",),
        )


def test_full_source_survey_threshold_accepts_both_grounded_phrasings() -> None:
    expectation = FULL_SOURCE_EXPECTATION_OVERRIDES["survey-threshold"]

    assert "三四百" in expectation["required_any"]
    assert "400" in expectation["required_any"]
    assert "400" in expectation["citation_any"]
