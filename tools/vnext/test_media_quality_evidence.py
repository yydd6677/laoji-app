from __future__ import annotations

from media_quality_evidence import EVIDENCE_CONTRACT, seal_report, verify_quality_report


def _report() -> dict:
    return seal_report({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "source_policy": "first_party_human_reference",
        "source_promotion_eligible": True,
        "gate_eligible": True,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "predictions_generated_after_reference_freeze": True,
        "asr_sample_count": 30,
        "registered_speaker_sample_count": 10,
        "unknown_speaker_sample_count": 10,
        "speaker_duration_weighted": True,
        "metrics": {
            "cer_median": 0.08,
            "cer_p95": 0.18,
            "numeric_time_accuracy": 0.95,
            "registered_attribution_f1": 0.90,
            "unknown_forced_name_rate": 0.0,
        },
        "lineage": {
            name: "sha256:" + digit * 64
            for name, digit in (
                ("source_manifest_sha256", "1"),
                ("review_a_sha256", "2"),
                ("review_b_sha256", "3"),
                ("adjudication_sha256", "4"),
                ("predictions_sha256", "5"),
                ("development_manifest_sha256", "6"),
            )
        },
    })


def test_verified_report_is_accepted() -> None:
    assert verify_quality_report(_report()) == (True, "verified")


def test_tampered_metric_is_rejected() -> None:
    report = _report()
    report["metrics"]["cer_p95"] = 0.01
    assert verify_quality_report(report)[0] is False


def test_cer_above_one_is_valid_but_not_clipped() -> None:
    report = _report()
    report.pop("report_sha256")
    report["metrics"]["cer_median"] = 1.1
    report["metrics"]["cer_p95"] = 1.4
    report = seal_report(report)

    assert verify_quality_report(report) == (True, "verified")


def test_subtitle_diagnostic_cannot_claim_gate_eligibility() -> None:
    report = _report()
    report.pop("report_sha256")
    report["source_policy"] = "weak_subtitle_diagnostic"
    report["source_promotion_eligible"] = False
    report["gate_eligible"] = True
    report = seal_report(report)
    assert verify_quality_report(report)[0] is False
