from __future__ import annotations

import json
import stat

import pytest

from evaluate_facts_v3_full_source_review import (
    HUMAN_REVIEW_CONTRACT,
    WORKTREE_ROOT,
    build_review_row,
    human_review_packet,
    load_resume_state,
    resolve_private_review_path,
    review_id,
    write_json_atomic,
)


def _row() -> dict:
    return build_review_row(
        sample_sha256="sha256:" + "a" * 64,
        items=[{"start_ms": 0, "end_ms": 1000, "speaker": None, "content": "来源正文"}],
        document={
            "schema_version": 3,
            "overview": {"text": "概述"},
            "facts": [{"fact_id": "f1", "content": "事实"}],
            "relations": [],
            "action_candidates": [{"action_id": "a1", "content": "提交材料"}],
        },
    )


def test_private_path_rejects_git_worktree() -> None:
    with pytest.raises(ValueError, match="outside the Git worktree"):
        resolve_private_review_path(WORKTREE_ROOT / "facts-review.json")


def test_packet_is_private_blind_and_has_per_item_review_fields(tmp_path) -> None:
    destination = tmp_path / "facts-review.json"
    row = _row()
    packet = human_review_packet([row], in_progress=True, sample_count=1)
    body = write_json_atomic(destination, packet, mode=0o600)

    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert destination.read_bytes() == body
    wire = json.loads(body)
    assert wire["contract"] == HUMAN_REVIEW_CONTRACT
    assert "sample" not in wire["rows"][0]
    assert "passed" not in wire["rows"][0]
    assert wire["rows"][0]["review"]["facts"][0]["supported"] is None
    assert wire["rows"][0]["review"]["actions"][0]["is_real_commitment"] is None


def test_resume_requires_matching_private_packet(tmp_path) -> None:
    report_path = tmp_path / "report.json"
    review_path = tmp_path / "review.json"
    row = _row()
    result = {
        "sample": "one.srt",
        "review_id": row["review_id"],
        "passed": True,
    }
    write_json_atomic(report_path, {
        "selected_samples": ["one.srt", "two.srt"],
        "auth_refresh_count": 2,
        "results": [result],
    })
    write_json_atomic(review_path, human_review_packet(
        [row],
        in_progress=True,
        sample_count=2,
    ), mode=0o600)

    results, rows, reviewer, refreshes = load_resume_state(
        report_path,
        review_path,
        sample_names=("one.srt", "two.srt"),
    )

    assert results == [result]
    assert rows == [row]
    assert reviewer == {"reviewer_id": "", "completed_at": ""}
    assert refreshes == 2


def test_review_id_is_stable_and_content_free() -> None:
    value = review_id("sha256:" + "b" * 64)

    assert value == review_id("sha256:" + "b" * 64)
    assert value.startswith("facts-")
    assert "b" * 16 not in value
