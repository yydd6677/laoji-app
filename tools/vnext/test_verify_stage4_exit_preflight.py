from __future__ import annotations

import hashlib
import json
from pathlib import Path

from schedule_holdout_evidence import EVIDENCE_CONTRACT, _seal_report
from product_owner_risk_waiver import (
    ACTIVE_PATH_POLICY,
    EVIDENCE_CONTRACT as WAIVER_CONTRACT,
    OWNER_DECISION,
    OWNER_ROLE,
    REQUIRED_SCOPES,
    RISK_ACKNOWLEDGEMENTS,
    seal_waiver,
)
from verify_stage4_exit_preflight import VOICE_EVIDENCE_CONTRACT, _verified_voice_report, inspect


ROOT = Path(__file__).resolve().parents[2]


def _owner_waiver() -> dict:
    return seal_waiver({
        "schema_version": 1,
        "evidence_contract": WAIVER_CONTRACT,
        "owner_role": OWNER_ROLE,
        "decision": OWNER_DECISION,
        "issued_at": "2026-08-21T14:00:00+00:00",
        "authorization_reference": "codex-thread:test",
        "baseline_revision": "test",
        "applies_to": sorted(REQUIRED_SCOPES),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "physical_legacy_deletion_authorized": False,
        "production_release_authorized": False,
        "risk_acknowledgements": list(RISK_ACKNOWLEDGEMENTS),
    })


def _quality_report() -> dict:
    digest = "sha256:" + "1" * 64
    return _seal_report({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "holdout_id": "test-holdout",
        "source_policy": "first_party_opt_in",
        "source_promotion_eligible": True,
        "gate_eligible": True,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "source_row_count": 40,
        "sample_count": 40,
        "excluded_count": 0,
        "adjudicated_conflict_count": 1,
        "metrics": {
            "field_exact_accuracy": 0.97,
            "key_field_recall": 0.99,
            "save_error_count": 0,
        },
        "development_overlap": {
            "development_manifest_sha256": digest,
            "source_text_overlap_count": 0,
            "speaker_group_overlap_count": 0,
            "semantic_event_group_overlap_count": 0,
        },
        "lineage": {
            "source_manifest_sha256": digest,
            "review_a_sha256": digest,
            "review_b_sha256": digest,
            "adjudication_sha256": digest,
            "predictions_sha256": digest,
            "development_manifest_sha256": digest,
        },
        "producer_revision": "test-producer",
        "promotion_blockers": [],
    })


def _passing() -> dict:
    voice = {
        "evidence_contract": VOICE_EVIDENCE_CONTRACT,
        "sample_count": 30,
        "draft_success_count": 30,
        "draft_distinct_hash_count": 1,
        "capture_start_p95_ms": 80,
        "first_text_p95_ms": 1200,
        "draft_p95_ms": 2500,
        "mixed_load": {
            "duration_seconds": 600,
            "traffic_classes": {
                "realtime_asr": True,
                "upload": True,
                "import_asr_backlog": True,
                "schedule_parse": True,
                "question": True,
                "summary": True,
            },
        },
    }
    voice["report_sha256"] = "sha256:" + hashlib.sha256(
        json.dumps(
            voice,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return {
        "service_ready": {"api": True, "schedule_graph": True},
        "schedule_quality": _quality_report(),
        "voice_schedule_performance": voice,
        "projection_runtime": {
            "global_sqlite_replay": True,
            "page_recreate": True,
            "stale_action_rejected": True,
            "no_status_jump": True,
        },
        "local_features": {"fts_query_p95_ms": 40, "explicit_label_owner": True},
        "public_cycle": {"complete": True, "legacy_submit_count": 0},
    }


def test_missing_stage4_evidence_fails_closed() -> None:
    report = inspect(ROOT, {})
    assert report["passed"] is False
    assert "schedule_human_holdout" in report["blocking_gates"]
    assert "projection_page_recreate" in report["blocking_gates"]


def test_complete_stage4_envelope_passes() -> None:
    report = inspect(ROOT, _passing())
    assert report["passed"] is True
    assert report["blocking_gates"] == []


def test_quality_regression_blocks() -> None:
    evidence = _passing()
    quality = dict(evidence["schedule_quality"])
    quality.pop("report_sha256")
    quality["metrics"] = {**quality["metrics"], "field_exact_accuracy": 0.949}
    evidence["schedule_quality"] = _seal_report(quality)
    evidence["public_cycle"]["legacy_submit_count"] = 1
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "schedule_field_exact_accuracy" in report["blocking_gates"]
    assert "legacy_schedule_zero_public_cycle" in report["blocking_gates"]


def test_legacy_boolean_quality_claim_is_rejected() -> None:
    evidence = _passing()
    evidence["schedule_quality"] = {
        "independent_human_adjudication": True,
        "sample_count": 40,
        "field_exact_accuracy": 1.0,
        "key_field_recall": 1.0,
        "save_error_count": 0,
    }
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "schedule_quality_lineage" in report["blocking_gates"]
    assert "schedule_human_holdout" in report["blocking_gates"]


def test_unsealed_or_single_ability_voice_claim_is_rejected() -> None:
    evidence = _passing()
    voice = dict(evidence["voice_schedule_performance"])
    voice.pop("report_sha256")
    voice["sample_count"] = 5
    voice["mixed_load"] = {"duration_seconds": 0, "traffic_classes": {}}
    evidence["voice_schedule_performance"] = voice

    report = inspect(ROOT, evidence)

    assert report["passed"] is False
    assert "voice_performance_lineage" in report["blocking_gates"]
    assert "voice_warm_sample_count" in report["blocking_gates"]
    assert "voice_draft_success" in report["blocking_gates"]
    assert "voice_draft_determinism" in report["blocking_gates"]
    assert "voice_mixed_load_envelope" in report["blocking_gates"]


def test_voice_evidence_reference_is_repo_bounded_and_hash_verified(tmp_path: Path) -> None:
    inline = _passing()["voice_schedule_performance"]
    source = tmp_path / "voice.json"
    raw = json.dumps(inline, ensure_ascii=False, indent=2).encode("utf-8")
    source.write_bytes(raw)
    reference = {
        "evidence_file": "voice.json",
        "file_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
    }

    loaded, verified = _verified_voice_report(tmp_path, reference)

    assert verified is True
    assert loaded["sample_count"] == 30
    _, wrong_hash = _verified_voice_report(
        tmp_path,
        {**reference, "file_sha256": "sha256:" + "0" * 64},
    )
    assert wrong_hash is False
    _, escaped = _verified_voice_report(
        tmp_path,
        {"evidence_file": "../voice.json", "file_sha256": reference["file_sha256"]},
    )
    assert escaped is False


def test_owner_waiver_marks_schedule_quality_and_cycle_waived() -> None:
    evidence = _passing()
    evidence["schedule_quality"] = {}
    evidence["public_cycle"] = {"complete": False}

    report = inspect(ROOT, evidence, owner_waiver=_owner_waiver())

    assert report["passed"] is True
    assert len(report["waived_gates"]) == 6
    assert "schedule_quality_lineage" in report["waived_gates"]
    assert "legacy_schedule_zero_public_cycle" in report["waived_gates"]


def test_owner_waiver_does_not_hide_voice_failure() -> None:
    evidence = _passing()
    evidence["schedule_quality"] = {}
    evidence["public_cycle"] = {"complete": False}
    voice = dict(evidence["voice_schedule_performance"])
    voice.pop("report_sha256")
    voice["first_text_p95_ms"] = 2_000
    voice["report_sha256"] = "sha256:" + hashlib.sha256(
        json.dumps(voice, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    evidence["voice_schedule_performance"] = voice

    report = inspect(ROOT, evidence, owner_waiver=_owner_waiver())

    assert report["passed"] is False
    assert "voice_first_text" in report["blocking_gates"]
