from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

from media_human_review_evidence import (
    PACK_CONTRACT,
    ReviewEvidenceError,
    make_templates,
    score_evidence,
)
from media_quality_evidence import verify_quality_report


def _write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _pack(tmp_path: Path) -> dict[str, Path]:
    digest = lambda value: "sha256:" + format(value, "064x")
    manifest_cases = []
    review_cases = []
    adjudication_cases = []
    prediction_cases = []
    for index in range(30):
        case_id = f"case-{index:02d}"
        manifest_cases.append({
            "case_id": case_id,
            "audio_sha256": digest(index + 1),
            "consent_reference": f"consent-{index:02d}",
            "duration_ms": 1_000,
            "include_asr": True,
        })
        review_cases.append({
            "case_id": case_id,
            "speech_present": True,
            "transcript": f"会议{index}三点开始",
            "speaker_segments": (
                [{"start_ms": 0, "end_ms": 1_000, "speaker_label": "voice-a"}]
                if index < 20
                else []
            ),
        })
        reference_segments = []
        prediction_segments = []
        if index < 10:
            reference_segments = [{
                "start_ms": 0,
                "end_ms": 1_000,
                "speaker_status": "registered",
                "registered_name": "已登记甲",
            }]
            prediction_segments = [{
                "start_ms": 0,
                "end_ms": 1_000,
                "speaker_name": "已登记甲",
            }]
        elif index < 20:
            reference_segments = [{
                "start_ms": 0,
                "end_ms": 1_000,
                "speaker_status": "unknown",
                "registered_name": None,
            }]
            prediction_segments = [{
                "start_ms": 0,
                "end_ms": 1_000,
                "speaker_name": None,
            }]
        adjudication_cases.append({
            "case_id": case_id,
            "reason_code": "agree",
            "transcript": f"会议{index}三点开始",
            "speaker_segments": reference_segments,
        })
        prediction_cases.append({
            "case_id": case_id,
            "transcript": f"会议{index}三点开始",
            "speaker_segments": prediction_segments,
        })

    paths = {name: tmp_path / f"{name}.json" for name in (
        "manifest", "review_a", "review_b", "adjudication", "predictions", "development"
    )}
    _write(paths["manifest"], {
        "schema_version": 1,
        "review_contract": PACK_CONTRACT,
        "source_policy": "first_party_human_reference",
        "cases": manifest_cases,
    })
    manifest_sha = _sha(paths["manifest"])
    for name, reviewer_id, completed_at in (
        ("review_a", "reviewer-a", "2026-08-21T10:00:00+08:00"),
        ("review_b", "reviewer-b", "2026-08-21T10:01:00+08:00"),
    ):
        _write(paths[name], {
            "schema_version": 1,
            "review_contract": PACK_CONTRACT,
            "source_manifest_sha256": manifest_sha,
            "reviewer": {
                "anonymous_id": reviewer_id,
                "native_chinese_human": True,
                "independent": True,
                "prediction_blind": True,
            },
            "completed_at": completed_at,
            "cases": review_cases,
        })
    _write(paths["adjudication"], {
        "schema_version": 1,
        "review_contract": PACK_CONTRACT,
        "review_a_sha256": _sha(paths["review_a"]),
        "review_b_sha256": _sha(paths["review_b"]),
        "adjudicator_id": "adjudicator-c",
        "completed_at": "2026-08-21T10:02:00+08:00",
        "cases": adjudication_cases,
    })
    _write(paths["predictions"], {
        "schema_version": 1,
        "review_contract": PACK_CONTRACT,
        "reference_freeze_sha256": _sha(paths["adjudication"]),
        "model_revision": "candidate-r1",
        "generated_at": "2026-08-21T10:03:00+08:00",
        "cases": prediction_cases,
    })
    _write(paths["development"], {"audio_sha256": []})
    return paths


def _score(paths: dict[str, Path]) -> dict:
    return score_evidence(
        manifest_path=paths["manifest"],
        review_a_path=paths["review_a"],
        review_b_path=paths["review_b"],
        adjudication_path=paths["adjudication"],
        predictions_path=paths["predictions"],
        development_manifest_path=paths["development"],
    )


def test_exact_independent_pack_derives_passing_quality_report(tmp_path: Path) -> None:
    report = _score(_pack(tmp_path))

    assert report["gate_eligible"] is True
    assert report["asr_sample_count"] == 30
    assert report["registered_speaker_sample_count"] == 10
    assert report["unknown_speaker_sample_count"] == 10
    assert report["metrics"] == {
        "cer_median": 0.0,
        "cer_p95": 0.0,
        "numeric_time_accuracy": 1.0,
        "registered_attribution_f1": 1.0,
        "unknown_forced_name_rate": 0.0,
    }
    assert verify_quality_report(report) == (True, "verified")


def test_private_templates_preserve_opaque_case_order(tmp_path: Path) -> None:
    paths = _pack(tmp_path)
    output_dir = tmp_path / "private-review"

    result = make_templates(paths["manifest"], output_dir)

    assert result["case_count"] == 30
    review = json.loads((output_dir / "review-a.json").read_text(encoding="utf-8"))
    assert [case["case_id"] for case in review["cases"]] == [
        f"case-{index:02d}" for index in range(30)
    ]
    assert review["reviewer"]["prediction_blind"] is False
    for name in result["output_files"]:
        assert (output_dir / name).stat().st_mode & 0o777 == 0o600


def test_development_overlap_cannot_be_promoted(tmp_path: Path) -> None:
    paths = _pack(tmp_path)
    manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
    _write(paths["development"], {"audio_sha256": [manifest["cases"][0]["audio_sha256"]]})

    with pytest.raises(ReviewEvidenceError, match="first_party_source_overlaps_development"):
        _score(paths)


def test_predictions_must_follow_adjudicated_reference(tmp_path: Path) -> None:
    paths = _pack(tmp_path)
    predictions = json.loads(paths["predictions"].read_text(encoding="utf-8"))
    predictions["generated_at"] = "2026-08-21T10:01:30+08:00"
    _write(paths["predictions"], predictions)

    with pytest.raises(ReviewEvidenceError, match="predictions_must_follow_reference_freeze"):
        _score(paths)


def test_missing_numeric_reference_fails_accuracy_closed(tmp_path: Path) -> None:
    paths = _pack(tmp_path)
    for name in ("review_a", "review_b", "adjudication", "predictions"):
        payload = json.loads(paths[name].read_text(encoding="utf-8"))
        for case in payload["cases"]:
            case["transcript"] = "会议开始"
        _write(paths[name], payload)
    adjudication = json.loads(paths["adjudication"].read_text(encoding="utf-8"))
    adjudication["review_a_sha256"] = _sha(paths["review_a"])
    adjudication["review_b_sha256"] = _sha(paths["review_b"])
    _write(paths["adjudication"], adjudication)
    predictions = json.loads(paths["predictions"].read_text(encoding="utf-8"))
    predictions["reference_freeze_sha256"] = _sha(paths["adjudication"])
    _write(paths["predictions"], predictions)

    assert _score(paths)["metrics"]["numeric_time_accuracy"] == 0.0


def test_cli_generates_private_templates_and_compact_report(tmp_path: Path) -> None:
    paths = _pack(tmp_path)
    script = Path(__file__).with_name("media_human_review_evidence.py")
    private_dir = tmp_path / "private-cli-review"

    templates = subprocess.run(
        [
            sys.executable,
            str(script),
            "make-templates",
            "--manifest",
            str(paths["manifest"]),
            "--output-dir",
            str(private_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    template_result = json.loads(templates.stdout)
    assert template_result["case_count"] == 30
    assert private_dir.stat().st_mode & 0o777 == 0o700

    report_path = tmp_path / "quality-report.json"
    scored = subprocess.run(
        [
            sys.executable,
            str(script),
            "score",
            "--manifest",
            str(paths["manifest"]),
            "--review-a",
            str(paths["review_a"]),
            "--review-b",
            str(paths["review_b"]),
            "--adjudication",
            str(paths["adjudication"]),
            "--predictions",
            str(paths["predictions"]),
            "--development-manifest",
            str(paths["development"]),
            "--output",
            str(report_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    score_result = json.loads(scored.stdout)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert score_result["gate_eligible"] is True
    assert score_result["report_sha256"] == report["report_sha256"]
    assert "transcript" not in report
    assert verify_quality_report(report) == (True, "verified")
