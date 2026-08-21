#!/usr/bin/env python3
"""Validate the sealed Stage 2 ASR/speaker quality evidence summary.

The preflight consumes only the compact report, while the report keeps hashes
of the immutable source, two blind reviews, adjudication, predictions and the
development corpus.  This module intentionally does not turn subtitles or an
automatic score into promotion evidence: only a first-party, human-corrected
reference frozen before predictions can set ``gate_eligible=true``.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping


SCHEMA_VERSION = 1
EVIDENCE_CONTRACT = "media-human-quality-v1"
SHA256_PREFIX = "sha256:"
SOURCE_POLICIES = {
    "first_party_human_reference",
    "weak_subtitle_diagnostic",
    "authored_diagnostic",
}


class EvidenceError(ValueError):
    """Raised when a report cannot support a Stage 2 quality claim."""


def _mapping(value: object, code: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvidenceError(code)
    return value


def _number(value: object, code: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvidenceError(code)
    return float(value)


def _integer(value: object, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EvidenceError(code)
    return value


def _digest(value: object, code: str) -> str:
    if not isinstance(value, str) or not value.startswith(SHA256_PREFIX):
        raise EvidenceError(code)
    if len(value) != len(SHA256_PREFIX) + 64:
        raise EvidenceError(code)
    try:
        int(value[len(SHA256_PREFIX):], 16)
    except ValueError as error:
        raise EvidenceError(code) from error
    return value


def object_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return SHA256_PREFIX + hashlib.sha256(encoded).hexdigest()


def seal_report(value: Mapping[str, Any]) -> dict[str, Any]:
    """Return a canonical checksum-sealed report for external pack builders."""
    report = dict(value)
    report.pop("report_sha256", None)
    report["report_sha256"] = object_sha256(report)
    return report


def verify_quality_report(value: object) -> tuple[bool, str]:
    """Verify lineage, metric ranges and promotion eligibility consistency."""
    try:
        report = _mapping(value, "media_quality_report_not_object")
        if report.get("schema_version") != SCHEMA_VERSION:
            raise EvidenceError("media_quality_schema_version_invalid")
        if report.get("evidence_contract") != EVIDENCE_CONTRACT:
            raise EvidenceError("media_quality_contract_invalid")
        claimed = _digest(report.get("report_sha256"), "media_quality_hash_required")
        unsigned = dict(report)
        unsigned.pop("report_sha256", None)
        if claimed != object_sha256(unsigned):
            raise EvidenceError("media_quality_hash_mismatch")

        source_policy = report.get("source_policy")
        if source_policy not in SOURCE_POLICIES:
            raise EvidenceError("media_quality_source_policy_invalid")
        if report.get("independent_human_adjudication") is not True:
            raise EvidenceError("media_quality_human_adjudication_required")
        if report.get("blind_reviewer_count") != 2:
            raise EvidenceError("media_quality_two_reviewers_required")
        if report.get("predictions_generated_after_reference_freeze") is not True:
            raise EvidenceError("media_quality_prediction_order_invalid")

        asr_count = _integer(report.get("asr_sample_count"), "media_quality_asr_count_invalid")
        registered_count = _integer(
            report.get("registered_speaker_sample_count"),
            "media_quality_registered_count_invalid",
        )
        unknown_count = _integer(
            report.get("unknown_speaker_sample_count"),
            "media_quality_unknown_count_invalid",
        )
        if report.get("speaker_duration_weighted") is not True:
            raise EvidenceError("media_quality_speaker_weighting_required")

        lineage = _mapping(report.get("lineage"), "media_quality_lineage_required")
        for key in (
            "source_manifest_sha256",
            "review_a_sha256",
            "review_b_sha256",
            "adjudication_sha256",
            "predictions_sha256",
            "development_manifest_sha256",
        ):
            _digest(lineage.get(key), f"media_quality_lineage_invalid:{key}")

        metrics = _mapping(report.get("metrics"), "media_quality_metrics_required")
        cer_median = _number(metrics.get("cer_median"), "media_quality_cer_median_invalid")
        cer_p95 = _number(metrics.get("cer_p95"), "media_quality_cer_p95_invalid")
        numeric_time_accuracy = _number(
            metrics.get("numeric_time_accuracy"),
            "media_quality_numeric_time_invalid",
        )
        attribution_f1 = _number(
            metrics.get("registered_attribution_f1"),
            "media_quality_attribution_f1_invalid",
        )
        unknown_forced_name_rate = _number(
            metrics.get("unknown_forced_name_rate"),
            "media_quality_unknown_rate_invalid",
        )
        for name, metric in (
            ("cer_median", cer_median),
            ("cer_p95", cer_p95),
            ("numeric_time_accuracy", numeric_time_accuracy),
            ("registered_attribution_f1", attribution_f1),
            ("unknown_forced_name_rate", unknown_forced_name_rate),
        ):
            if not 0.0 <= metric <= 1.0:
                raise EvidenceError(f"media_quality_metric_range_invalid:{name}")
        if cer_median > cer_p95:
            raise EvidenceError("media_quality_cer_percentile_order_invalid")

        source_eligible = source_policy == "first_party_human_reference"
        if report.get("source_promotion_eligible") is not source_eligible:
            raise EvidenceError("media_quality_source_eligibility_inconsistent")
        expected_gate_eligible = (
            source_eligible
            and asr_count >= 30
            and registered_count >= 10
            and unknown_count >= 10
        )
        if report.get("gate_eligible") is not expected_gate_eligible:
            raise EvidenceError("media_quality_gate_eligibility_inconsistent")
        return True, "verified"
    except EvidenceError as error:
        return False, str(error)
