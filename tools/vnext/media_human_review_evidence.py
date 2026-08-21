#!/usr/bin/env python3
"""Build and score independent Stage 2 ASR/speaker human evidence.

The scorer derives every promotion metric from two prediction-blind reviews,
an adjudicated reference frozen afterwards, and predictions generated only
after that freeze.  It emits the compact ``media-human-quality-v1`` report
consumed by the Stage 2 exit preflight and never copies transcript text into
that report.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping

from evaluate_asr_srt_diagnostic import levenshtein, normalize_text, numeric_tokens
from media_quality_evidence import EVIDENCE_CONTRACT, seal_report


PACK_CONTRACT = "media-human-review-pack-v1"


class ReviewEvidenceError(ValueError):
    pass


def _mapping(value: object, code: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ReviewEvidenceError(code)
    return value


def _list(value: object, code: str) -> list[Any]:
    if not isinstance(value, list):
        raise ReviewEvidenceError(code)
    return value


def _text(value: object, code: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ReviewEvidenceError(code)
    normalized = value.strip()
    if not normalized and not allow_empty:
        raise ReviewEvidenceError(code)
    return normalized


def _boolean(value: object, code: str) -> bool:
    if not isinstance(value, bool):
        raise ReviewEvidenceError(code)
    return value


def _integer(value: object, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ReviewEvidenceError(code)
    return value


def _timestamp(value: object, code: str) -> datetime:
    raw = _text(value, code)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReviewEvidenceError(code) from error
    if parsed.tzinfo is None:
        raise ReviewEvidenceError(code)
    return parsed


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _digest(value: object, code: str) -> str:
    raw = _text(value, code)
    if not raw.startswith("sha256:") or len(raw) != 71:
        raise ReviewEvidenceError(code)
    try:
        int(raw[7:], 16)
    except ValueError as error:
        raise ReviewEvidenceError(code) from error
    return raw


def _case_map(value: object, code: str) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for raw in _list(value, code):
        case = _mapping(raw, code)
        case_id = _text(case.get("case_id"), f"{code}:case_id")
        if case_id in result:
            raise ReviewEvidenceError(f"{code}:duplicate_case_id")
        result[case_id] = case
    return result


def _review_identity(review: Mapping[str, Any], code: str) -> tuple[str, datetime]:
    if review.get("schema_version") != 1 or review.get("review_contract") != PACK_CONTRACT:
        raise ReviewEvidenceError(f"{code}:contract_invalid")
    reviewer = _mapping(review.get("reviewer"), f"{code}:reviewer_required")
    reviewer_id = _text(reviewer.get("anonymous_id"), f"{code}:reviewer_id")
    for field in ("native_chinese_human", "independent", "prediction_blind"):
        if _boolean(reviewer.get(field), f"{code}:{field}") is not True:
            raise ReviewEvidenceError(f"{code}:{field}_required")
    return reviewer_id, _timestamp(review.get("completed_at"), f"{code}:completed_at")


def _review_signature(case: Mapping[str, Any], code: str) -> dict[str, Any]:
    speech = _boolean(case.get("speech_present"), f"{code}:speech_present")
    transcript = _text(case.get("transcript"), f"{code}:transcript", allow_empty=True)
    if speech and not transcript:
        raise ReviewEvidenceError(f"{code}:speech_transcript_required")
    segments = []
    for index, raw in enumerate(_list(case.get("speaker_segments", []), f"{code}:segments")):
        segment = _mapping(raw, f"{code}:segment:{index}")
        segments.append({
            "start_ms": _integer(segment.get("start_ms"), f"{code}:segment_start"),
            "end_ms": _integer(segment.get("end_ms"), f"{code}:segment_end"),
            "speaker_label": _text(segment.get("speaker_label"), f"{code}:speaker_label"),
        })
    return {"speech_present": speech, "transcript": transcript, "speaker_segments": segments}


def _reference_segments(
    case: Mapping[str, Any],
    duration_ms: int,
    code: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    previous_end = 0
    for index, raw in enumerate(_list(case.get("speaker_segments", []), f"{code}:segments")):
        segment = _mapping(raw, f"{code}:segment:{index}")
        start = _integer(segment.get("start_ms"), f"{code}:segment_start")
        end = _integer(segment.get("end_ms"), f"{code}:segment_end")
        if start < previous_end or end <= start or end > duration_ms:
            raise ReviewEvidenceError(f"{code}:segment_range_invalid")
        status = _text(segment.get("speaker_status"), f"{code}:speaker_status")
        if status not in {"registered", "unknown"}:
            raise ReviewEvidenceError(f"{code}:speaker_status_invalid")
        name = segment.get("registered_name")
        if status == "registered":
            name = _text(name, f"{code}:registered_name")
        elif name not in (None, ""):
            raise ReviewEvidenceError(f"{code}:unknown_name_must_be_empty")
        result.append({
            "start_ms": start,
            "end_ms": end,
            "speaker_status": status,
            "registered_name": name or None,
        })
        previous_end = end
    return result


def _prediction_segments(
    case: Mapping[str, Any],
    duration_ms: int,
    code: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    previous_end = 0
    for index, raw in enumerate(_list(case.get("speaker_segments", []), f"{code}:segments")):
        segment = _mapping(raw, f"{code}:segment:{index}")
        start = _integer(segment.get("start_ms"), f"{code}:segment_start")
        end = _integer(segment.get("end_ms"), f"{code}:segment_end")
        if start < previous_end or end <= start or end > duration_ms:
            raise ReviewEvidenceError(f"{code}:segment_range_invalid")
        name = segment.get("speaker_name")
        if name not in (None, ""):
            name = _text(name, f"{code}:speaker_name")
        result.append({"start_ms": start, "end_ms": end, "speaker_name": name or None})
        previous_end = end
    return result


def _speaker_durations(
    references: list[dict[str, Any]],
    predictions: list[dict[str, Any]],
) -> tuple[int, int, int, int, int]:
    """Return registered TP/FP/FN and unknown forced/total durations."""
    boundaries = sorted({
        value
        for segment in references + predictions
        for value in (int(segment["start_ms"]), int(segment["end_ms"]))
    })
    tp = fp = fn = unknown_forced = unknown_total = 0
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        reference = next(
            (
                segment
                for segment in references
                if segment["start_ms"] <= start and segment["end_ms"] >= end
            ),
            None,
        )
        if reference is None:
            continue
        prediction = next(
            (
                segment
                for segment in predictions
                if segment["start_ms"] <= start and segment["end_ms"] >= end
            ),
            None,
        )
        predicted_name = prediction.get("speaker_name") if prediction else None
        duration = end - start
        if reference["speaker_status"] == "registered":
            if predicted_name == reference["registered_name"]:
                tp += duration
            else:
                fn += duration
                if predicted_name:
                    fp += duration
        else:
            unknown_total += duration
            if predicted_name:
                unknown_forced += duration
    return tp, fp, fn, unknown_forced, unknown_total


def score_evidence(
    *,
    manifest_path: Path,
    review_a_path: Path,
    review_b_path: Path,
    adjudication_path: Path,
    predictions_path: Path,
    development_manifest_path: Path,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    review_a = json.loads(review_a_path.read_text(encoding="utf-8"))
    review_b = json.loads(review_b_path.read_text(encoding="utf-8"))
    adjudication = json.loads(adjudication_path.read_text(encoding="utf-8"))
    predictions = json.loads(predictions_path.read_text(encoding="utf-8"))
    development = json.loads(development_manifest_path.read_text(encoding="utf-8"))

    if manifest.get("schema_version") != 1 or manifest.get("review_contract") != PACK_CONTRACT:
        raise ReviewEvidenceError("manifest_contract_invalid")
    source_policy = _text(manifest.get("source_policy"), "manifest_source_policy")
    if source_policy not in {
        "first_party_human_reference",
        "weak_subtitle_diagnostic",
        "authored_diagnostic",
    }:
        raise ReviewEvidenceError("manifest_source_policy_invalid")
    manifest_cases = _case_map(manifest.get("cases"), "manifest_cases")
    if not manifest_cases:
        raise ReviewEvidenceError("manifest_cases_empty")
    for case_id, case in manifest_cases.items():
        _digest(case.get("audio_sha256"), f"manifest:{case_id}:audio_sha256")
        _text(case.get("consent_reference"), f"manifest:{case_id}:consent_reference")
        _integer(case.get("duration_ms"), f"manifest:{case_id}:duration_ms")
        _boolean(case.get("include_asr", True), f"manifest:{case_id}:include_asr")

    reviewer_a, completed_a = _review_identity(review_a, "review_a")
    reviewer_b, completed_b = _review_identity(review_b, "review_b")
    if reviewer_a == reviewer_b:
        raise ReviewEvidenceError("reviewers_must_be_distinct")
    manifest_sha = _sha256_file(manifest_path)
    for review, code in ((review_a, "review_a"), (review_b, "review_b")):
        if review.get("source_manifest_sha256") != manifest_sha:
            raise ReviewEvidenceError(f"{code}:manifest_hash_mismatch")
    review_a_cases = _case_map(review_a.get("cases"), "review_a_cases")
    review_b_cases = _case_map(review_b.get("cases"), "review_b_cases")
    expected_ids = set(manifest_cases)
    if set(review_a_cases) != expected_ids or set(review_b_cases) != expected_ids:
        raise ReviewEvidenceError("review_case_set_mismatch")

    if (
        adjudication.get("schema_version") != 1
        or adjudication.get("review_contract") != PACK_CONTRACT
    ):
        raise ReviewEvidenceError("adjudication_contract_invalid")
    adjudicated_at = _timestamp(adjudication.get("completed_at"), "adjudication_completed_at")
    if completed_a > adjudicated_at or completed_b > adjudicated_at:
        raise ReviewEvidenceError("adjudication_precedes_review")
    if adjudication.get("review_a_sha256") != _sha256_file(review_a_path):
        raise ReviewEvidenceError("adjudication_review_a_hash_mismatch")
    if adjudication.get("review_b_sha256") != _sha256_file(review_b_path):
        raise ReviewEvidenceError("adjudication_review_b_hash_mismatch")
    adjudicator_id = _text(adjudication.get("adjudicator_id"), "adjudicator_id")
    if adjudicator_id in {reviewer_a, reviewer_b}:
        raise ReviewEvidenceError("adjudicator_must_be_independent")
    adjudicated_cases = _case_map(adjudication.get("cases"), "adjudication_cases")
    if set(adjudicated_cases) != expected_ids:
        raise ReviewEvidenceError("adjudication_case_set_mismatch")

    for case_id in expected_ids:
        left = _review_signature(review_a_cases[case_id], f"review_a:{case_id}")
        right = _review_signature(review_b_cases[case_id], f"review_b:{case_id}")
        reason = _text(
            adjudicated_cases[case_id].get("reason_code"),
            f"adjudication:{case_id}:reason_code",
        )
        if left != right and reason == "agree":
            raise ReviewEvidenceError(f"adjudication:{case_id}:disagreement_not_resolved")

    if (
        predictions.get("schema_version") != 1
        or predictions.get("review_contract") != PACK_CONTRACT
    ):
        raise ReviewEvidenceError("predictions_contract_invalid")
    generated_at = _timestamp(predictions.get("generated_at"), "predictions_generated_at")
    adjudication_sha = _sha256_file(adjudication_path)
    if generated_at <= adjudicated_at:
        raise ReviewEvidenceError("predictions_must_follow_reference_freeze")
    if predictions.get("reference_freeze_sha256") != adjudication_sha:
        raise ReviewEvidenceError("predictions_reference_hash_mismatch")
    _text(predictions.get("model_revision"), "predictions_model_revision")
    prediction_cases = _case_map(predictions.get("cases"), "prediction_cases")
    if set(prediction_cases) != expected_ids:
        raise ReviewEvidenceError("prediction_case_set_mismatch")

    development_hashes = {
        _digest(value, "development_audio_hash")
        for value in _list(development.get("audio_sha256", []), "development_audio_hashes")
    }
    source_hashes = {str(case["audio_sha256"]) for case in manifest_cases.values()}
    development_overlap = bool(source_hashes & development_hashes)
    if source_policy == "first_party_human_reference" and development_overlap:
        raise ReviewEvidenceError("first_party_source_overlaps_development")

    cers: list[float] = []
    numeric_total = numeric_correct = 0
    registered_cases = unknown_cases = 0
    tp = fp = fn = unknown_forced = unknown_total = 0
    for case_id, manifest_case in manifest_cases.items():
        adjudicated = adjudicated_cases[case_id]
        predicted = prediction_cases[case_id]
        reference_text = _text(
            adjudicated.get("transcript"),
            f"adjudication:{case_id}:transcript",
            allow_empty=True,
        )
        prediction_text = _text(
            predicted.get("transcript"),
            f"prediction:{case_id}:transcript",
            allow_empty=True,
        )
        if bool(manifest_case.get("include_asr", True)):
            normalized_reference = normalize_text(reference_text)
            normalized_prediction = normalize_text(prediction_text)
            cers.append(
                levenshtein(normalized_reference, normalized_prediction)
                / max(len(normalized_reference), 1)
            )
            reference_numbers = numeric_tokens(reference_text)
            prediction_numbers = numeric_tokens(prediction_text)
            numeric_total += sum(reference_numbers.values())
            numeric_correct += sum(
                min(count, prediction_numbers[token])
                for token, count in reference_numbers.items()
            )
        duration_ms = int(manifest_case["duration_ms"])
        references = _reference_segments(adjudicated, duration_ms, f"adjudication:{case_id}")
        candidate_segments = _prediction_segments(predicted, duration_ms, f"prediction:{case_id}")
        if any(segment["speaker_status"] == "registered" for segment in references):
            registered_cases += 1
        if any(segment["speaker_status"] == "unknown" for segment in references):
            unknown_cases += 1
        row_tp, row_fp, row_fn, row_unknown_forced, row_unknown_total = _speaker_durations(
            references,
            candidate_segments,
        )
        tp += row_tp
        fp += row_fp
        fn += row_fn
        unknown_forced += row_unknown_forced
        unknown_total += row_unknown_total

    ordered_cer = sorted(cers)
    percentile_index = max(0, (95 * len(ordered_cer) + 99) // 100 - 1)
    registered_f1 = (2 * tp / (2 * tp + fp + fn)) if (2 * tp + fp + fn) else 0.0
    unknown_rate = unknown_forced / unknown_total if unknown_total else 0.0
    source_eligible = source_policy == "first_party_human_reference" and not development_overlap
    gate_eligible = (
        source_eligible
        and len(cers) >= 30
        and registered_cases >= 10
        and unknown_cases >= 10
    )

    return seal_report({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "source_policy": source_policy,
        "source_promotion_eligible": source_eligible,
        "gate_eligible": gate_eligible,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "predictions_generated_after_reference_freeze": True,
        "asr_sample_count": len(cers),
        "registered_speaker_sample_count": registered_cases,
        "unknown_speaker_sample_count": unknown_cases,
        "speaker_duration_weighted": True,
        "metrics": {
            "cer_median": ordered_cer[(len(ordered_cer) - 1) // 2] if ordered_cer else 0.0,
            "cer_p95": ordered_cer[percentile_index] if ordered_cer else 0.0,
            # A numeric/time quality gate without any reference token must fail
            # closed instead of receiving a vacuous perfect score.
            "numeric_time_accuracy": numeric_correct / numeric_total if numeric_total else 0.0,
            "registered_attribution_f1": registered_f1,
            "unknown_forced_name_rate": unknown_rate,
        },
        "lineage": {
            "source_manifest_sha256": manifest_sha,
            "review_a_sha256": _sha256_file(review_a_path),
            "review_b_sha256": _sha256_file(review_b_path),
            "adjudication_sha256": adjudication_sha,
            "predictions_sha256": _sha256_file(predictions_path),
            "development_manifest_sha256": _sha256_file(development_manifest_path),
        },
    })


def _write_private(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def make_templates(manifest_path: Path, output_dir: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or manifest.get("review_contract") != PACK_CONTRACT:
        raise ReviewEvidenceError("manifest_contract_invalid")
    cases = _case_map(manifest.get("cases"), "manifest_cases")
    if not cases:
        raise ReviewEvidenceError("manifest_cases_empty")
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    manifest_sha = _sha256_file(manifest_path)
    review_rows = [
        {
            "case_id": case_id,
            "audio_ref": case.get("review_audio_ref"),
            "speech_present": False,
            "transcript": "",
            "speaker_segments": [],
        }
        for case_id, case in cases.items()
    ]
    for name in ("review-a", "review-b"):
        _write_private(output_dir / f"{name}.json", {
            "schema_version": 1,
            "review_contract": PACK_CONTRACT,
            "source_manifest_sha256": manifest_sha,
            "reviewer": {
                "anonymous_id": "",
                "native_chinese_human": False,
                "independent": False,
                "prediction_blind": False,
            },
            "completed_at": "",
            "cases": review_rows,
        })
    _write_private(output_dir / "adjudication.json", {
        "schema_version": 1,
        "review_contract": PACK_CONTRACT,
        "review_a_sha256": "",
        "review_b_sha256": "",
        "adjudicator_id": "",
        "completed_at": "",
        "cases": [
            {
                "case_id": case_id,
                "reason_code": "",
                "transcript": "",
                "speaker_segments": [],
            }
            for case_id in cases
        ],
    })
    _write_private(output_dir / "predictions.json", {
        "schema_version": 1,
        "review_contract": PACK_CONTRACT,
        "reference_freeze_sha256": "",
        "model_revision": "",
        "generated_at": "",
        "cases": [
            {"case_id": case_id, "transcript": "", "speaker_segments": []}
            for case_id in cases
        ],
    })
    _write_private(output_dir / "development-manifest.json", {"audio_sha256": []})
    return {
        "source_manifest_sha256": manifest_sha,
        "case_count": len(cases),
        "output_files": [
            "review-a.json",
            "review-b.json",
            "adjudication.json",
            "predictions.json",
            "development-manifest.json",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    templates = commands.add_parser("make-templates")
    templates.add_argument("--manifest", type=Path, required=True)
    templates.add_argument("--output-dir", type=Path, required=True)
    score = commands.add_parser("score")
    score.add_argument("--manifest", type=Path, required=True)
    score.add_argument("--review-a", type=Path, required=True)
    score.add_argument("--review-b", type=Path, required=True)
    score.add_argument("--adjudication", type=Path, required=True)
    score.add_argument("--predictions", type=Path, required=True)
    score.add_argument("--development-manifest", type=Path, required=True)
    score.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "make-templates":
        result = make_templates(args.manifest, args.output_dir)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    report = score_evidence(
        manifest_path=args.manifest,
        review_a_path=args.review_a,
        review_b_path=args.review_b,
        adjudication_path=args.adjudication,
        predictions_path=args.predictions,
        development_manifest_path=args.development_manifest,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "gate_eligible": report["gate_eligible"],
        "asr_sample_count": report["asr_sample_count"],
        "registered_speaker_sample_count": report["registered_speaker_sample_count"],
        "unknown_speaker_sample_count": report["unknown_speaker_sample_count"],
        "metrics": report["metrics"],
        "report_sha256": report["report_sha256"],
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
