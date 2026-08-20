#!/usr/bin/env python3
"""Build and verify fail-closed evidence for LaoJi schedule quality.

The tool deliberately separates four artifacts:

1. an immutable source manifest;
2. two blind, independent human reviews;
3. a post-reveal adjudication;
4. parser predictions produced only after the gold set is frozen.

It never asks the parser, a model, or an authored fixture to create gold labels.
Public/localized corpora may be reviewed for diagnostics, but only explicitly
opted-in first-party utterances that are isolated from development data can
produce a Stage 4 promotion-eligible report.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
EVIDENCE_CONTRACT = "schedule-human-holdout-v1"
SHA256_PREFIX = "sha256:"

INTENTS = {"create", "query", "delete", "clarify", "reject", "context_edit"}
STATES = {"complete", "needs_clarification", "operation", "reject", "incomplete"}
SLOT_FIELDS = (
    "title",
    "start_date",
    "end_date",
    "start_time",
    "end_time",
    "time_period",
    "event_type",
    "location",
    "recurrence",
    "reminder",
)
SOURCE_BACKED_FIELDS = {
    "title",
    "start_date",
    "end_date",
    "start_time",
    "end_time",
    "time_period",
    "location",
    "recurrence",
    "reminder",
}
EXCLUSION_REASONS = {
    "not_natural",
    "translation_artifact",
    "ambiguous_without_context",
    "duplicate",
    "not_schedule",
    "privacy",
    "other",
}
SOURCE_POLICIES = {"first_party_opt_in", "public_localized", "authored_diagnostic"}


class EvidenceError(ValueError):
    """Raised when an evidence artifact cannot support the claimed result."""


def _mapping(value: object, code: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvidenceError(code)
    return value


def _sequence(value: object, code: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise EvidenceError(code)
    return value


def _nonempty(value: object, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError(code)
    return value.strip()


def _parse_timestamp(value: object, code: str) -> datetime:
    text = _nonempty(value, code)
    try:
        result = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError(code) from error
    if result.tzinfo is None:
        raise EvidenceError(code)
    return result


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def object_sha256(value: object) -> str:
    return SHA256_PREFIX + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return SHA256_PREFIX + digest.hexdigest()


def _text_sha256(text: str) -> str:
    return SHA256_PREFIX + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceError(f"invalid_json:{path.name}") from error


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        handle = path.open("r", encoding="utf-8")
    except OSError as error:
        raise EvidenceError(f"unreadable_jsonl:{path.name}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise EvidenceError(f"invalid_jsonl:{path.name}:{line_number}") from error
            if not isinstance(value, dict):
                raise EvidenceError(f"jsonl_row_not_object:{path.name}:{line_number}")
            rows.append(value)
    return rows


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _stable_case_id(source_id: str, text_hash: str) -> str:
    digest = hashlib.sha256(f"{source_id}|{text_hash}".encode("utf-8")).hexdigest()
    return "schedule-holdout:" + digest[:24]


def _source_value(row: Mapping[str, Any], key: str) -> object:
    source = row.get("source")
    if isinstance(source, Mapping) and source.get(key) not in (None, ""):
        return source.get(key)
    return row.get(key)


def _prepare_source_row(
    row: Mapping[str, Any],
    *,
    source_policy: str,
    consent_reference: str | None,
) -> dict[str, Any]:
    text = _nonempty(row.get("text"), "source_text_required")
    source_id = _nonempty(
        row.get("source_id") or _source_value(row, "source_id") or row.get("replay_id"),
        "source_id_required",
    )
    reference_datetime = _nonempty(row.get("reference_datetime"), "reference_datetime_required")
    _parse_timestamp(reference_datetime, "reference_datetime_invalid")
    timezone = _nonempty(row.get("timezone"), "timezone_required")
    text_hash = _text_sha256(text)

    source_kind = str(_source_value(row, "kind") or _source_value(row, "source_kind") or source_policy)
    license_name = str(_source_value(row, "license") or "private")
    consent = str(row.get("consent_reference") or consent_reference or "").strip() or None
    speaker_group = str(row.get("speaker_group") or "").strip() or None
    semantic_group = str(row.get("semantic_event_group") or "").strip() or None

    if source_policy == "first_party_opt_in":
        if not consent:
            raise EvidenceError("first_party_consent_reference_required")
        if not speaker_group:
            raise EvidenceError("first_party_speaker_group_required")
        if not semantic_group:
            raise EvidenceError("first_party_semantic_event_group_required")

    return {
        "case_id": _stable_case_id(source_id, text_hash),
        "source_id": source_id,
        "text": text,
        "text_sha256": text_hash,
        "reference_datetime": reference_datetime,
        "timezone": timezone,
        "provenance": {
            "source_policy": source_policy,
            "source_kind": source_kind,
            "dataset": str(_source_value(row, "dataset") or "private"),
            "license": license_name,
            "consent_reference": consent,
            "speaker_group": speaker_group,
            "semantic_event_group": semantic_group,
        },
    }


def _blank_review(holdout_id: str, manifest_hash: str, rows: Sequence[Mapping[str, Any]], label: str) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "holdout_id": holdout_id,
        "source_manifest_sha256": manifest_hash,
        "reviewer": {
            "reviewer_id": f"FILL_DISTINCT_HUMAN_{label}",
            "human": True,
            "native_locale": "zh-CN",
            "independent": True,
            "parser_outputs_seen": False,
            "completed_at": "FILL_ISO8601_AFTER_REVIEW",
        },
        "annotations": [
            {
                "case_id": row["case_id"],
                "text_sha256": row["text_sha256"],
                "review_status": "FILL_accept_OR_exclude",
                "naturalness": None,
                "gold": None,
                "field_evidence": {},
                "exclusion_reason": None,
            }
            for row in rows
        ],
    }


def _blank_adjudication(holdout_id: str, manifest_hash: str, rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "holdout_id": holdout_id,
        "source_manifest_sha256": manifest_hash,
        "review_a_sha256": "FILL_AFTER_BLIND_REVIEW",
        "review_b_sha256": "FILL_AFTER_BLIND_REVIEW",
        "blind_review_revealed_at": "FILL_ISO8601_AFTER_BOTH_REVIEWS",
        "adjudicator_id": "FILL_HUMAN_ADJUDICATOR",
        "completed_at": "FILL_ISO8601_AFTER_ADJUDICATION",
        "decisions": [
            {
                "case_id": row["case_id"],
                "text_sha256": row["text_sha256"],
                "status": "FILL_accept_OR_exclude",
                "resolution": "FILL_agreement_OR_adjudicated",
                "gold": None,
                "field_evidence": {},
                "exclusion_reason": None,
                "rationale_code": None,
            }
            for row in rows
        ],
    }


def make_pack(
    rows: Iterable[Mapping[str, Any]],
    *,
    holdout_id: str,
    source_policy: str,
    consent_reference: str | None = None,
    limit: int | None = None,
) -> dict[str, object]:
    if source_policy not in SOURCE_POLICIES:
        raise EvidenceError("source_policy_invalid")
    source_rows = [
        _prepare_source_row(
            row,
            source_policy=source_policy,
            consent_reference=consent_reference,
        )
        for row in rows
    ]
    if limit is not None:
        if limit <= 0:
            raise EvidenceError("limit_must_be_positive")
        source_rows = source_rows[:limit]
    if not source_rows:
        raise EvidenceError("source_manifest_empty")
    case_ids = [str(row["case_id"]) for row in source_rows]
    text_hashes = [str(row["text_sha256"]) for row in source_rows]
    if len(case_ids) != len(set(case_ids)):
        raise EvidenceError("source_case_id_duplicate")
    if len(text_hashes) != len(set(text_hashes)):
        raise EvidenceError("source_text_duplicate")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "evidence_contract": EVIDENCE_CONTRACT,
        "holdout_id": _nonempty(holdout_id, "holdout_id_required"),
        "source_policy": source_policy,
        "promotion_eligible_source": source_policy == "first_party_opt_in",
        "rows": source_rows,
    }
    manifest_hash = object_sha256(manifest)
    return {
        "manifest": manifest,
        "review_a": _blank_review(holdout_id, manifest_hash, source_rows, "A"),
        "review_b": _blank_review(holdout_id, manifest_hash, source_rows, "B"),
        "adjudication": _blank_adjudication(holdout_id, manifest_hash, source_rows),
    }


def _validate_manifest(value: object) -> tuple[Mapping[str, Any], dict[str, Mapping[str, Any]]]:
    manifest = _mapping(value, "manifest_not_object")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError("manifest_schema_version_invalid")
    if manifest.get("evidence_contract") != EVIDENCE_CONTRACT:
        raise EvidenceError("manifest_contract_invalid")
    holdout_id = _nonempty(manifest.get("holdout_id"), "manifest_holdout_id_required")
    del holdout_id
    source_policy = _nonempty(manifest.get("source_policy"), "manifest_source_policy_required")
    if source_policy not in SOURCE_POLICIES:
        raise EvidenceError("manifest_source_policy_invalid")
    rows = _sequence(manifest.get("rows"), "manifest_rows_not_array")
    by_id: dict[str, Mapping[str, Any]] = {}
    text_hashes: set[str] = set()
    for index, item in enumerate(rows):
        row = _mapping(item, f"manifest_row_not_object:{index}")
        case_id = _nonempty(row.get("case_id"), f"manifest_case_id_required:{index}")
        text = _nonempty(row.get("text"), f"manifest_text_required:{case_id}")
        text_hash = _nonempty(row.get("text_sha256"), f"manifest_text_hash_required:{case_id}")
        if text_hash != _text_sha256(text):
            raise EvidenceError(f"manifest_text_hash_mismatch:{case_id}")
        if case_id in by_id:
            raise EvidenceError(f"manifest_case_duplicate:{case_id}")
        if text_hash in text_hashes:
            raise EvidenceError(f"manifest_text_duplicate:{case_id}")
        _parse_timestamp(row.get("reference_datetime"), f"manifest_reference_datetime_invalid:{case_id}")
        _nonempty(row.get("timezone"), f"manifest_timezone_required:{case_id}")
        provenance = _mapping(row.get("provenance"), f"manifest_provenance_required:{case_id}")
        if provenance.get("source_policy") != source_policy:
            raise EvidenceError(f"manifest_source_policy_mismatch:{case_id}")
        if source_policy == "first_party_opt_in":
            _nonempty(provenance.get("consent_reference"), f"manifest_consent_required:{case_id}")
            _nonempty(provenance.get("speaker_group"), f"manifest_speaker_required:{case_id}")
            _nonempty(provenance.get("semantic_event_group"), f"manifest_event_group_required:{case_id}")
        by_id[case_id] = row
        text_hashes.add(text_hash)
    if not by_id:
        raise EvidenceError("manifest_empty")
    expected_eligibility = source_policy == "first_party_opt_in"
    if manifest.get("promotion_eligible_source") is not expected_eligibility:
        raise EvidenceError("manifest_promotion_eligibility_mismatch")
    return manifest, by_id


def _validate_gold(value: object, case_id: str) -> Mapping[str, Any]:
    gold = _mapping(value, f"gold_required:{case_id}")
    if set(gold) != {"intent", "state", "slots"}:
        raise EvidenceError(f"gold_fields_invalid:{case_id}")
    if gold.get("intent") not in INTENTS:
        raise EvidenceError(f"gold_intent_invalid:{case_id}")
    if gold.get("state") not in STATES:
        raise EvidenceError(f"gold_state_invalid:{case_id}")
    slots = _mapping(gold.get("slots"), f"gold_slots_required:{case_id}")
    if set(slots) != set(SLOT_FIELDS):
        raise EvidenceError(f"gold_slots_fields_invalid:{case_id}")
    for key in ("title", "start_date", "end_date", "start_time", "end_time", "time_period", "location"):
        if slots.get(key) is not None and not isinstance(slots.get(key), str):
            raise EvidenceError(f"gold_slot_type_invalid:{case_id}:{key}")
    if not isinstance(slots.get("event_type"), str) or not str(slots.get("event_type")).strip():
        raise EvidenceError(f"gold_event_type_invalid:{case_id}")
    for key in ("recurrence", "reminder"):
        if slots.get(key) is not None and not isinstance(slots.get(key), Mapping):
            raise EvidenceError(f"gold_slot_type_invalid:{case_id}:{key}")
    intent = str(gold["intent"])
    state = str(gold["state"])
    if intent == "create" and state == "complete" and not slots.get("start_date"):
        raise EvidenceError(f"gold_saveable_without_start_date:{case_id}")
    if intent in {"query", "delete", "context_edit"} and state != "operation":
        raise EvidenceError(f"gold_operation_state_invalid:{case_id}")
    if intent == "reject" and state != "reject":
        raise EvidenceError(f"gold_reject_state_invalid:{case_id}")
    return gold


def _validate_evidence(
    value: object,
    *,
    row: Mapping[str, Any],
    gold: Mapping[str, Any],
    case_id: str,
) -> Mapping[str, Any]:
    evidence = _mapping(value, f"field_evidence_required:{case_id}")
    text = str(row["text"])
    for field, spans_value in evidence.items():
        if field not in SOURCE_BACKED_FIELDS:
            raise EvidenceError(f"field_evidence_unknown_field:{case_id}:{field}")
        spans = _sequence(spans_value, f"field_evidence_not_array:{case_id}:{field}")
        for span_index, span_value in enumerate(spans):
            span = _mapping(span_value, f"field_evidence_span_invalid:{case_id}:{field}:{span_index}")
            if set(span) != {"text", "start", "end"}:
                raise EvidenceError(f"field_evidence_span_fields_invalid:{case_id}:{field}:{span_index}")
            start, end = span.get("start"), span.get("end")
            span_text = span.get("text")
            if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
                raise EvidenceError(f"field_evidence_offsets_invalid:{case_id}:{field}:{span_index}")
            if not isinstance(span_text, str) or start < 0 or end <= start or text[start:end] != span_text:
                raise EvidenceError(f"field_evidence_not_grounded:{case_id}:{field}:{span_index}")
    slots = _mapping(gold.get("slots"), f"gold_slots_required:{case_id}")
    for field in SOURCE_BACKED_FIELDS:
        if slots.get(field) is not None and not evidence.get(field):
            raise EvidenceError(f"field_evidence_missing:{case_id}:{field}")
    return evidence


def _validate_annotation(
    value: object,
    *,
    source_rows: Mapping[str, Mapping[str, Any]],
    label: str,
) -> Mapping[str, Any]:
    annotation = _mapping(value, f"annotation_not_object:{label}")
    case_id = _nonempty(annotation.get("case_id"), f"annotation_case_id_required:{label}")
    if case_id not in source_rows:
        raise EvidenceError(f"annotation_unknown_case:{label}:{case_id}")
    row = source_rows[case_id]
    if annotation.get("text_sha256") != row.get("text_sha256"):
        raise EvidenceError(f"annotation_text_hash_mismatch:{label}:{case_id}")
    status = annotation.get("review_status")
    if status not in {"accept", "exclude"}:
        raise EvidenceError(f"annotation_status_invalid:{label}:{case_id}")
    naturalness = annotation.get("naturalness")
    if not isinstance(naturalness, int) or isinstance(naturalness, bool) or not 1 <= naturalness <= 5:
        raise EvidenceError(f"annotation_naturalness_invalid:{label}:{case_id}")
    if status == "exclude":
        if annotation.get("exclusion_reason") not in EXCLUSION_REASONS:
            raise EvidenceError(f"annotation_exclusion_reason_invalid:{label}:{case_id}")
        if annotation.get("gold") is not None:
            raise EvidenceError(f"annotation_excluded_gold_present:{label}:{case_id}")
        return annotation
    if naturalness < 3:
        raise EvidenceError(f"annotation_accepted_not_natural:{label}:{case_id}")
    if annotation.get("exclusion_reason") is not None:
        raise EvidenceError(f"annotation_accepted_exclusion_reason_present:{label}:{case_id}")
    gold = _validate_gold(annotation.get("gold"), case_id)
    _validate_evidence(annotation.get("field_evidence"), row=row, gold=gold, case_id=case_id)
    return annotation


def _validate_review(
    value: object,
    *,
    manifest: Mapping[str, Any],
    source_rows: Mapping[str, Mapping[str, Any]],
    label: str,
) -> tuple[Mapping[str, Any], dict[str, Mapping[str, Any]], datetime, str]:
    review = _mapping(value, f"review_not_object:{label}")
    if review.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError(f"review_schema_version_invalid:{label}")
    if review.get("holdout_id") != manifest.get("holdout_id"):
        raise EvidenceError(f"review_holdout_id_mismatch:{label}")
    if review.get("source_manifest_sha256") != object_sha256(manifest):
        raise EvidenceError(f"review_manifest_hash_mismatch:{label}")
    reviewer = _mapping(review.get("reviewer"), f"reviewer_required:{label}")
    reviewer_id = _nonempty(reviewer.get("reviewer_id"), f"reviewer_id_required:{label}")
    if reviewer.get("human") is not True or reviewer.get("independent") is not True:
        raise EvidenceError(f"reviewer_independence_declaration_required:{label}")
    if reviewer.get("native_locale") != "zh-CN":
        raise EvidenceError(f"reviewer_native_zh_required:{label}")
    if reviewer.get("parser_outputs_seen") is not False:
        raise EvidenceError(f"reviewer_must_be_blind_to_predictions:{label}")
    completed_at = _parse_timestamp(reviewer.get("completed_at"), f"review_completed_at_invalid:{label}")
    annotations = _sequence(review.get("annotations"), f"review_annotations_not_array:{label}")
    by_id: dict[str, Mapping[str, Any]] = {}
    for item in annotations:
        checked = _validate_annotation(item, source_rows=source_rows, label=label)
        case_id = str(checked["case_id"])
        if case_id in by_id:
            raise EvidenceError(f"review_case_duplicate:{label}:{case_id}")
        by_id[case_id] = checked
    if set(by_id) != set(source_rows):
        raise EvidenceError(f"review_case_set_mismatch:{label}")
    return review, by_id, completed_at, reviewer_id


def _decision_equivalent(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return (
        left.get("review_status") == right.get("review_status")
        and left.get("gold") == right.get("gold")
        and left.get("field_evidence") == right.get("field_evidence")
        and left.get("exclusion_reason") == right.get("exclusion_reason")
    )


def _validate_adjudication(
    value: object,
    *,
    manifest: Mapping[str, Any],
    source_rows: Mapping[str, Mapping[str, Any]],
    review_a: Mapping[str, Any],
    review_b: Mapping[str, Any],
    annotations_a: Mapping[str, Mapping[str, Any]],
    annotations_b: Mapping[str, Mapping[str, Any]],
    review_a_completed: datetime,
    review_b_completed: datetime,
) -> tuple[Mapping[str, Any], dict[str, Mapping[str, Any]], int, datetime]:
    adjudication = _mapping(value, "adjudication_not_object")
    if adjudication.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError("adjudication_schema_version_invalid")
    if adjudication.get("holdout_id") != manifest.get("holdout_id"):
        raise EvidenceError("adjudication_holdout_id_mismatch")
    if adjudication.get("source_manifest_sha256") != object_sha256(manifest):
        raise EvidenceError("adjudication_manifest_hash_mismatch")
    if adjudication.get("review_a_sha256") != object_sha256(review_a):
        raise EvidenceError("adjudication_review_a_hash_mismatch")
    if adjudication.get("review_b_sha256") != object_sha256(review_b):
        raise EvidenceError("adjudication_review_b_hash_mismatch")
    revealed_at = _parse_timestamp(adjudication.get("blind_review_revealed_at"), "adjudication_reveal_time_invalid")
    completed_at = _parse_timestamp(adjudication.get("completed_at"), "adjudication_completed_at_invalid")
    _nonempty(adjudication.get("adjudicator_id"), "adjudicator_id_required")
    if review_a_completed > revealed_at or review_b_completed > revealed_at:
        raise EvidenceError("blind_reviews_completed_after_reveal")
    if completed_at < revealed_at:
        raise EvidenceError("adjudication_completed_before_reveal")
    decisions = _sequence(adjudication.get("decisions"), "adjudication_decisions_not_array")
    by_id: dict[str, Mapping[str, Any]] = {}
    conflict_count = 0
    for item in decisions:
        decision = _mapping(item, "adjudication_decision_not_object")
        case_id = _nonempty(decision.get("case_id"), "adjudication_case_id_required")
        if case_id not in source_rows:
            raise EvidenceError(f"adjudication_unknown_case:{case_id}")
        if case_id in by_id:
            raise EvidenceError(f"adjudication_case_duplicate:{case_id}")
        row = source_rows[case_id]
        if decision.get("text_sha256") != row.get("text_sha256"):
            raise EvidenceError(f"adjudication_text_hash_mismatch:{case_id}")
        status = decision.get("status")
        if status not in {"accept", "exclude"}:
            raise EvidenceError(f"adjudication_status_invalid:{case_id}")
        resolution = decision.get("resolution")
        equivalent = _decision_equivalent(annotations_a[case_id], annotations_b[case_id])
        if equivalent:
            if resolution not in {"agreement", "adjudicated"}:
                raise EvidenceError(f"adjudication_resolution_invalid:{case_id}")
        else:
            conflict_count += 1
            if resolution != "adjudicated" or not str(decision.get("rationale_code") or "").strip():
                raise EvidenceError(f"adjudication_conflict_unresolved:{case_id}")
        if resolution == "agreement":
            expected_status = annotations_a[case_id]["review_status"]
            if status != expected_status:
                raise EvidenceError(f"adjudication_agreement_status_changed:{case_id}")
        if status == "exclude":
            if decision.get("exclusion_reason") not in EXCLUSION_REASONS:
                raise EvidenceError(f"adjudication_exclusion_reason_invalid:{case_id}")
            if decision.get("gold") is not None:
                raise EvidenceError(f"adjudication_excluded_gold_present:{case_id}")
        else:
            if decision.get("exclusion_reason") is not None:
                raise EvidenceError(f"adjudication_accepted_exclusion_reason_present:{case_id}")
            gold = _validate_gold(decision.get("gold"), case_id)
            _validate_evidence(decision.get("field_evidence"), row=row, gold=gold, case_id=case_id)
            if resolution == "agreement":
                if gold != annotations_a[case_id].get("gold"):
                    raise EvidenceError(f"adjudication_agreement_gold_changed:{case_id}")
                if decision.get("field_evidence") != annotations_a[case_id].get("field_evidence"):
                    raise EvidenceError(f"adjudication_agreement_evidence_changed:{case_id}")
        by_id[case_id] = decision
    if set(by_id) != set(source_rows):
        raise EvidenceError("adjudication_case_set_mismatch")
    return adjudication, by_id, conflict_count, completed_at


def _validate_development_manifest(
    value: object,
    source_rows: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    manifest = _mapping(value, "development_manifest_not_object")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError("development_manifest_schema_version_invalid")
    _nonempty(manifest.get("corpus_id"), "development_manifest_corpus_id_required")
    _parse_timestamp(manifest.get("created_at"), "development_manifest_created_at_invalid")
    rows = _sequence(manifest.get("rows"), "development_rows_not_array")
    if not rows:
        raise EvidenceError("development_manifest_empty")
    development_texts: set[str] = set()
    development_speakers: set[str] = set()
    development_events: set[str] = set()
    for index, item in enumerate(rows):
        row = _mapping(item, f"development_row_not_object:{index}")
        text_hash = row.get("text_sha256")
        if isinstance(text_hash, str) and text_hash:
            development_texts.add(text_hash)
        speaker = row.get("speaker_group")
        event = row.get("semantic_event_group")
        if isinstance(speaker, str) and speaker:
            development_speakers.add(speaker)
        if isinstance(event, str) and event:
            development_events.add(event)
    source_texts = {str(row["text_sha256"]) for row in source_rows.values()}
    source_speakers = {
        str(_mapping(row.get("provenance"), "source_provenance_required").get("speaker_group"))
        for row in source_rows.values()
        if _mapping(row.get("provenance"), "source_provenance_required").get("speaker_group")
    }
    source_events = {
        str(_mapping(row.get("provenance"), "source_provenance_required").get("semantic_event_group"))
        for row in source_rows.values()
        if _mapping(row.get("provenance"), "source_provenance_required").get("semantic_event_group")
    }
    return {
        "development_manifest_sha256": object_sha256(value),
        "source_text_overlap_count": len(source_texts & development_texts),
        "speaker_group_overlap_count": len(source_speakers & development_speakers),
        "semantic_event_group_overlap_count": len(source_events & development_events),
    }


def _validate_predictions(
    value: object,
    *,
    manifest: Mapping[str, Any],
    source_rows: Mapping[str, Mapping[str, Any]],
    accepted_ids: set[str],
    adjudication_completed: datetime,
) -> tuple[Mapping[str, Any], dict[str, Mapping[str, Any]]]:
    predictions = _mapping(value, "predictions_not_object")
    if predictions.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError("predictions_schema_version_invalid")
    if predictions.get("holdout_id") != manifest.get("holdout_id"):
        raise EvidenceError("predictions_holdout_id_mismatch")
    if predictions.get("source_manifest_sha256") != object_sha256(manifest):
        raise EvidenceError("predictions_manifest_hash_mismatch")
    _nonempty(predictions.get("producer_revision"), "predictions_producer_revision_required")
    generated_at = _parse_timestamp(predictions.get("generated_at"), "predictions_generated_at_invalid")
    if generated_at < adjudication_completed:
        raise EvidenceError("predictions_generated_before_gold_frozen")
    rows = _sequence(predictions.get("predictions"), "predictions_rows_not_array")
    by_id: dict[str, Mapping[str, Any]] = {}
    for item in rows:
        prediction = _mapping(item, "prediction_not_object")
        case_id = _nonempty(prediction.get("case_id"), "prediction_case_id_required")
        if case_id not in source_rows:
            raise EvidenceError(f"prediction_unknown_case:{case_id}")
        if case_id in by_id:
            raise EvidenceError(f"prediction_case_duplicate:{case_id}")
        if prediction.get("text_sha256") != source_rows[case_id].get("text_sha256"):
            raise EvidenceError(f"prediction_text_hash_mismatch:{case_id}")
        _validate_gold(prediction.get("output"), case_id)
        by_id[case_id] = prediction
    if not accepted_ids.issubset(by_id):
        raise EvidenceError("prediction_missing_accepted_case")
    return predictions, by_id


def _critical_paths(gold: Mapping[str, Any]) -> list[str]:
    slots = _mapping(gold.get("slots"), "gold_slots_required")
    paths = ["intent", "state"]
    for field in ("start_date", "end_date", "start_time", "end_time", "time_period"):
        if slots.get(field) is not None:
            paths.append("slots." + field)
    return paths


def _path_value(value: Mapping[str, Any], path: str) -> object:
    current: object = value
    for key in path.split("."):
        current = _mapping(current, f"path_not_object:{path}").get(key)
    return current


def _is_saveable(value: Mapping[str, Any]) -> bool:
    slots = _mapping(value.get("slots"), "slots_required")
    return value.get("intent") == "create" and value.get("state") == "complete" and bool(slots.get("start_date"))


def _seal_report(report: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(report)
    result.pop("report_sha256", None)
    result["report_sha256"] = object_sha256(result)
    return result


def verify_quality_report(value: object) -> tuple[bool, str]:
    """Verify the sealed, self-contained quality report consumed by preflight."""
    try:
        report = _mapping(value, "quality_report_not_object")
        if report.get("schema_version") != SCHEMA_VERSION:
            raise EvidenceError("quality_report_schema_version_invalid")
        if report.get("evidence_contract") != EVIDENCE_CONTRACT:
            raise EvidenceError("quality_report_contract_invalid")
        claimed = _nonempty(report.get("report_sha256"), "quality_report_hash_required")
        unsigned = dict(report)
        unsigned.pop("report_sha256", None)
        if claimed != object_sha256(unsigned):
            raise EvidenceError("quality_report_hash_mismatch")
        if report.get("independent_human_adjudication") is not True:
            raise EvidenceError("quality_report_human_adjudication_required")
        if report.get("blind_reviewer_count") != 2:
            raise EvidenceError("quality_report_two_reviewers_required")
        sample_count = report.get("sample_count")
        source_row_count = report.get("source_row_count")
        excluded_count = report.get("excluded_count")
        if any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in (sample_count, source_row_count, excluded_count)):
            raise EvidenceError("quality_report_counts_invalid")
        if sample_count + excluded_count != source_row_count:
            raise EvidenceError("quality_report_counts_inconsistent")
        lineage = _mapping(report.get("lineage"), "quality_report_lineage_required")
        for key in (
            "source_manifest_sha256",
            "review_a_sha256",
            "review_b_sha256",
            "adjudication_sha256",
            "predictions_sha256",
            "development_manifest_sha256",
        ):
            digest = _nonempty(lineage.get(key), f"quality_report_lineage_missing:{key}")
            if not digest.startswith(SHA256_PREFIX) or len(digest) != len(SHA256_PREFIX) + 64:
                raise EvidenceError(f"quality_report_lineage_hash_invalid:{key}")
        metrics = _mapping(report.get("metrics"), "quality_report_metrics_required")
        for key in ("field_exact_accuracy", "key_field_recall", "save_error_count"):
            value_number = metrics.get(key)
            if isinstance(value_number, bool) or not isinstance(value_number, (int, float)):
                raise EvidenceError(f"quality_report_metric_invalid:{key}")
        exact = float(metrics["field_exact_accuracy"])
        recall = float(metrics["key_field_recall"])
        save_errors = float(metrics["save_error_count"])
        if not 0.0 <= exact <= 1.0 or not 0.0 <= recall <= 1.0 or save_errors < 0 or not save_errors.is_integer():
            raise EvidenceError("quality_report_metric_range_invalid")
        overlap = _mapping(report.get("development_overlap"), "quality_report_overlap_required")
        for key in ("source_text_overlap_count", "speaker_group_overlap_count", "semantic_event_group_overlap_count"):
            value_number = overlap.get(key)
            if isinstance(value_number, bool) or not isinstance(value_number, int) or value_number < 0:
                raise EvidenceError(f"quality_report_overlap_invalid:{key}")
        source_policy = report.get("source_policy")
        source_eligible = report.get("source_promotion_eligible")
        gate_eligible = report.get("gate_eligible")
        if source_eligible is not (source_policy == "first_party_opt_in"):
            raise EvidenceError("quality_report_source_eligibility_inconsistent")
        zero_overlap = all(
            overlap[key] == 0
            for key in ("source_text_overlap_count", "speaker_group_overlap_count", "semantic_event_group_overlap_count")
        )
        expected_gate_eligible = source_eligible is True and zero_overlap and sample_count >= 30
        if gate_eligible is not expected_gate_eligible:
            raise EvidenceError("quality_report_gate_eligibility_inconsistent")
        return True, "verified"
    except EvidenceError as error:
        return False, str(error)


def score(
    *,
    manifest_value: object,
    review_a_value: object,
    review_b_value: object,
    adjudication_value: object,
    predictions_value: object,
    development_manifest_value: object,
) -> dict[str, Any]:
    manifest, source_rows = _validate_manifest(manifest_value)
    review_a, annotations_a, completed_a, reviewer_a = _validate_review(
        review_a_value,
        manifest=manifest,
        source_rows=source_rows,
        label="a",
    )
    review_b, annotations_b, completed_b, reviewer_b = _validate_review(
        review_b_value,
        manifest=manifest,
        source_rows=source_rows,
        label="b",
    )
    if reviewer_a == reviewer_b:
        raise EvidenceError("reviewers_must_be_distinct")
    adjudication, decisions, conflict_count, adjudication_completed = _validate_adjudication(
        adjudication_value,
        manifest=manifest,
        source_rows=source_rows,
        review_a=review_a,
        review_b=review_b,
        annotations_a=annotations_a,
        annotations_b=annotations_b,
        review_a_completed=completed_a,
        review_b_completed=completed_b,
    )
    accepted_ids = {case_id for case_id, decision in decisions.items() if decision.get("status") == "accept"}
    predictions, prediction_rows = _validate_predictions(
        predictions_value,
        manifest=manifest,
        source_rows=source_rows,
        accepted_ids=accepted_ids,
        adjudication_completed=adjudication_completed,
    )
    overlap = _validate_development_manifest(development_manifest_value, source_rows)

    exact_count = 0
    critical_total = 0
    critical_correct = 0
    save_errors = 0
    for case_id in sorted(accepted_ids):
        gold = _mapping(decisions[case_id].get("gold"), f"gold_required:{case_id}")
        observed = _mapping(prediction_rows[case_id].get("output"), f"prediction_output_required:{case_id}")
        exact_count += int(gold == observed)
        critical_paths = _critical_paths(gold)
        row_critical_correct = all(_path_value(gold, path) == _path_value(observed, path) for path in critical_paths)
        critical_total += len(critical_paths)
        critical_correct += sum(
            int(_path_value(gold, path) == _path_value(observed, path))
            for path in critical_paths
        )
        if _is_saveable(observed) and (not _is_saveable(gold) or not row_critical_correct):
            save_errors += 1

    sample_count = len(accepted_ids)
    field_exact_accuracy = exact_count / sample_count if sample_count else 0.0
    key_field_recall = critical_correct / critical_total if critical_total else 0.0
    zero_overlap = all(
        overlap[key] == 0
        for key in ("source_text_overlap_count", "speaker_group_overlap_count", "semantic_event_group_overlap_count")
    )
    source_policy = str(manifest.get("source_policy"))
    source_eligible = manifest.get("promotion_eligible_source") is True and source_policy == "first_party_opt_in"
    gate_eligible = source_eligible and zero_overlap and sample_count >= 30
    report = {
        "schema_version": SCHEMA_VERSION,
        "evidence_contract": EVIDENCE_CONTRACT,
        "holdout_id": manifest.get("holdout_id"),
        "source_policy": source_policy,
        "source_promotion_eligible": source_eligible,
        "gate_eligible": gate_eligible,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "source_row_count": len(source_rows),
        "sample_count": sample_count,
        "excluded_count": len(source_rows) - sample_count,
        "adjudicated_conflict_count": conflict_count,
        "metrics": {
            "field_exact_accuracy": field_exact_accuracy,
            "key_field_recall": key_field_recall,
            "save_error_count": save_errors,
            "field_exact_correct": exact_count,
            "critical_field_correct": critical_correct,
            "critical_field_total": critical_total,
        },
        "development_overlap": overlap,
        "lineage": {
            "source_manifest_sha256": object_sha256(manifest),
            "review_a_sha256": object_sha256(review_a),
            "review_b_sha256": object_sha256(review_b),
            "adjudication_sha256": object_sha256(adjudication),
            "predictions_sha256": object_sha256(predictions),
            "development_manifest_sha256": overlap["development_manifest_sha256"],
        },
        "producer_revision": predictions.get("producer_revision"),
        "promotion_blockers": [
            reason
            for condition, reason in (
                (source_eligible, "first_party_opt_in_source_required"),
                (zero_overlap, "development_overlap_must_be_zero"),
                (sample_count >= 30, "at_least_30_accepted_rows_required"),
            )
            if not condition
        ],
    }
    return _seal_report(report)


def _command_make_pack(args: argparse.Namespace) -> int:
    rows = _load_jsonl(args.input)
    pack = make_pack(
        rows,
        holdout_id=args.holdout_id,
        source_policy=args.source_policy,
        consent_reference=args.consent_reference,
        limit=args.limit,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "manifest": args.output_dir / "source-manifest.json",
        "review_a": args.output_dir / "review-a.json",
        "review_b": args.output_dir / "review-b.json",
        "adjudication": args.output_dir / "adjudication.json",
    }
    for key, path in paths.items():
        _write_json(path, pack[key])
    print(json.dumps({"rows": len(_mapping(pack["manifest"], "manifest")["rows"]), "paths": {key: str(path) for key, path in paths.items()}}, ensure_ascii=False))
    return 0


def _command_score(args: argparse.Namespace) -> int:
    report = score(
        manifest_value=_load_json(args.manifest),
        review_a_value=_load_json(args.review_a),
        review_b_value=_load_json(args.review_b),
        adjudication_value=_load_json(args.adjudication),
        predictions_value=_load_json(args.predictions),
        development_manifest_value=_load_json(args.development_manifest),
    )
    _write_json(args.output, report)
    print(json.dumps({"output": str(args.output), "gate_eligible": report["gate_eligible"], "metrics": report["metrics"]}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    pack = subparsers.add_parser("make-pack", help="create immutable source and blank blind-review artifacts")
    pack.add_argument("--input", type=Path, required=True)
    pack.add_argument("--output-dir", type=Path, required=True)
    pack.add_argument("--holdout-id", required=True)
    pack.add_argument("--source-policy", choices=sorted(SOURCE_POLICIES), required=True)
    pack.add_argument("--consent-reference")
    pack.add_argument("--limit", type=int)
    pack.set_defaults(handler=_command_make_pack)

    score_parser = subparsers.add_parser("score", help="validate blind reviews/adjudication and score predictions")
    score_parser.add_argument("--manifest", type=Path, required=True)
    score_parser.add_argument("--review-a", type=Path, required=True)
    score_parser.add_argument("--review-b", type=Path, required=True)
    score_parser.add_argument("--adjudication", type=Path, required=True)
    score_parser.add_argument("--predictions", type=Path, required=True)
    score_parser.add_argument("--development-manifest", type=Path, required=True)
    score_parser.add_argument("--output", type=Path, required=True)
    score_parser.set_defaults(handler=_command_score)

    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except EvidenceError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
