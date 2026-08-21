#!/usr/bin/env python3
"""Build and score independent Stage 3 Facts/action/Q2 human evidence.

The candidate outputs are already frozen inside a private source pack.  This
tool creates two content-free judgment sheets, requires two independent human
reviews plus a third adjudicator, and emits only aggregate metrics and hashes.
It never copies meeting, question, answer, fact, action, or citation text into
the public report.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = 1
SUBMISSION_CONTRACT = "stage3-human-review-submission-v1"
ADJUDICATION_CONTRACT = "stage3-human-review-adjudication-v1"
REPORT_CONTRACT = "stage3-human-quality-v1"
DOMAIN_FACTS = "facts_actions"
DOMAIN_Q2 = "q2"
DOMAINS = {DOMAIN_FACTS, DOMAIN_Q2}
ADJUDICATION_REASONS = {"agree", "resolved_disagreement", "ambiguous", "reviewer_error"}
SOURCE_CONTRACTS = {
    DOMAIN_FACTS: "stage3-facts-actions-human-review-v1",
    DOMAIN_Q2: "stage3-q2-human-review-v1",
}


class Stage3EvidenceError(ValueError):
    """Raised when private review evidence cannot support a quality claim."""


def _mapping(value: object, code: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise Stage3EvidenceError(code)
    return value


def _list(value: object, code: str) -> list[Any]:
    if not isinstance(value, list):
        raise Stage3EvidenceError(code)
    return value


def _text(value: object, code: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise Stage3EvidenceError(code)
    normalized = value.strip()
    if not normalized and not allow_empty:
        raise Stage3EvidenceError(code)
    return normalized


def _boolean(value: object, code: str) -> bool:
    if not isinstance(value, bool):
        raise Stage3EvidenceError(code)
    return value


def _timestamp(value: object, code: str) -> datetime:
    raw = _text(value, code)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise Stage3EvidenceError(code) from error
    if parsed.tzinfo is None:
        raise Stage3EvidenceError(code)
    return parsed


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _object_sha256(value: object) -> str:
    body = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(body).hexdigest()


def _digest(value: object, code: str) -> str:
    raw = _text(value, code)
    if len(raw) != 71 or not raw.startswith("sha256:"):
        raise Stage3EvidenceError(code)
    try:
        int(raw[7:], 16)
    except ValueError as error:
        raise Stage3EvidenceError(code) from error
    return raw


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise Stage3EvidenceError(f"invalid_json:{path.name}") from error


def _write_private(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def _mkdir_private(path: Path) -> None:
    created: list[Path] = []
    cursor = path
    while not cursor.exists():
        created.append(cursor)
        cursor = cursor.parent
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in reversed(created):
        os.chmod(directory, 0o700)
    os.chmod(path, 0o700)


def _rows(value: object, code: str) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for raw in _list(value, code):
        row = _mapping(raw, code)
        review_id = _text(row.get("review_id"), f"{code}:review_id")
        if review_id in result:
            raise Stage3EvidenceError(f"{code}:duplicate_review_id")
        result[review_id] = row
    return result


def _source_rows(source: Mapping[str, Any], domain: str) -> dict[str, Mapping[str, Any]]:
    if source.get("schema_version") != SCHEMA_VERSION:
        raise Stage3EvidenceError("source_schema_version_invalid")
    if source.get("contract") != SOURCE_CONTRACTS[domain]:
        raise Stage3EvidenceError("source_contract_invalid")
    if source.get("blind") is not True or source.get("in_progress") is not False:
        raise Stage3EvidenceError("source_pack_not_frozen")
    rows = _rows(source.get("rows"), "source_rows")
    if not rows:
        raise Stage3EvidenceError("source_rows_empty")
    return rows


def _id_rows(value: object, code: str, id_field: str) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for raw in _list(value, code):
        row = _mapping(raw, code)
        item_id = _text(row.get(id_field), f"{code}:{id_field}")
        if item_id in result:
            raise Stage3EvidenceError(f"{code}:duplicate_{id_field}")
        result[item_id] = row
    return result


def _facts_review(
    value: object,
    source_row: Mapping[str, Any],
    code: str,
) -> dict[str, Any]:
    review = _mapping(value, f"{code}:review")
    result: dict[str, Any] = {
        field: _boolean(review.get(field), f"{code}:{field}")
        for field in (
            "overview_accurate",
            "important_fact_omitted",
            "conflicts_preserved",
            "critical_error",
        )
    }
    result["omission_notes"] = _text(
        review.get("omission_notes"),
        f"{code}:omission_notes",
        allow_empty=True,
    )
    result["notes"] = _text(review.get("notes"), f"{code}:notes", allow_empty=True)

    expected_review = _mapping(source_row.get("review"), f"{code}:source_review")
    expected_facts = _id_rows(expected_review.get("facts"), f"{code}:source_facts", "fact_id")
    actual_facts = _id_rows(review.get("facts"), f"{code}:facts", "fact_id")
    if set(actual_facts) != set(expected_facts):
        raise Stage3EvidenceError(f"{code}:fact_set_mismatch")
    result["facts"] = {
        fact_id: {
            field: _boolean(row.get(field), f"{code}:fact:{fact_id}:{field}")
            for field in ("supported", "materially_accurate", "certainty_correct", "important")
        }
        for fact_id, row in actual_facts.items()
    }

    expected_actions = _id_rows(
        expected_review.get("actions"),
        f"{code}:source_actions",
        "action_id",
    )
    actual_actions = _id_rows(review.get("actions"), f"{code}:actions", "action_id")
    if set(actual_actions) != set(expected_actions):
        raise Stage3EvidenceError(f"{code}:action_set_mismatch")
    normalized_actions: dict[str, dict[str, Any]] = {}
    for action_id, row in actual_actions.items():
        duplicate_of = _text(
            row.get("duplicate_of"),
            f"{code}:action:{action_id}:duplicate_of",
            allow_empty=True,
        )
        if duplicate_of and (duplicate_of == action_id or duplicate_of not in expected_actions):
            raise Stage3EvidenceError(f"{code}:action:{action_id}:duplicate_target_invalid")
        normalized_actions[action_id] = {
            field: _boolean(row.get(field), f"{code}:action:{action_id}:{field}")
            for field in (
                "is_real_commitment",
                "specific_and_useful",
                "owner_supported",
                "due_supported",
                "schedule_fit_appropriate",
            )
        }
        normalized_actions[action_id]["duplicate_of"] = duplicate_of
    result["actions"] = normalized_actions
    return result


def _q2_review(value: object, _source_row: Mapping[str, Any], code: str) -> dict[str, Any]:
    review = _mapping(value, f"{code}:review")
    result = {
        field: _boolean(review.get(field), f"{code}:{field}")
        for field in (
            "answer_correct",
            "answer_complete",
            "citations_relevant",
            "refusal_appropriate",
            "critical_error",
        )
    }
    result["notes"] = _text(review.get("notes"), f"{code}:notes", allow_empty=True)
    return result


def _normalized_review(
    domain: str,
    value: object,
    source_row: Mapping[str, Any],
    code: str,
) -> dict[str, Any]:
    if domain == DOMAIN_FACTS:
        return _facts_review(value, source_row, code)
    return _q2_review(value, source_row, code)


def _judgment_signature(review: Mapping[str, Any]) -> dict[str, Any]:
    """Exclude free-form reviewer notes from the disagreement decision."""
    result = dict(review)
    result.pop("notes", None)
    result.pop("omission_notes", None)
    return result


def _review_submission(
    value: object,
    *,
    domain: str,
    source_hash: str,
    source_rows: Mapping[str, Mapping[str, Any]],
    code: str,
) -> tuple[str, datetime, dict[str, dict[str, Any]]]:
    submission = _mapping(value, code)
    if submission.get("schema_version") != SCHEMA_VERSION:
        raise Stage3EvidenceError(f"{code}:schema_version_invalid")
    if submission.get("evidence_contract") != SUBMISSION_CONTRACT:
        raise Stage3EvidenceError(f"{code}:contract_invalid")
    if submission.get("domain") != domain:
        raise Stage3EvidenceError(f"{code}:domain_mismatch")
    if submission.get("source_pack_sha256") != source_hash:
        raise Stage3EvidenceError(f"{code}:source_hash_mismatch")
    reviewer = _mapping(submission.get("reviewer"), f"{code}:reviewer")
    reviewer_id = _text(reviewer.get("anonymous_id"), f"{code}:reviewer_id")
    for field in ("native_chinese_human", "independent", "automated_result_blind"):
        if _boolean(reviewer.get(field), f"{code}:{field}") is not True:
            raise Stage3EvidenceError(f"{code}:{field}_required")
    completed = _timestamp(reviewer.get("completed_at"), f"{code}:completed_at")
    rows = _rows(submission.get("rows"), f"{code}:rows")
    if set(rows) != set(source_rows):
        raise Stage3EvidenceError(f"{code}:row_set_mismatch")
    normalized = {
        review_id: _normalized_review(
            domain,
            row.get("review"),
            source_rows[review_id],
            f"{code}:{review_id}",
        )
        for review_id, row in rows.items()
    }
    return reviewer_id, completed, normalized


def _adjudicated_reviews(
    value: object,
    *,
    domain: str,
    source_hash: str,
    review_a_hash: str,
    review_b_hash: str,
    source_rows: Mapping[str, Mapping[str, Any]],
    normalized_a: Mapping[str, dict[str, Any]],
    normalized_b: Mapping[str, dict[str, Any]],
    reviewer_ids: set[str],
    reviews_completed_at: tuple[datetime, datetime],
) -> tuple[datetime, int, dict[str, dict[str, Any]]]:
    adjudication = _mapping(value, "adjudication")
    if adjudication.get("schema_version") != SCHEMA_VERSION:
        raise Stage3EvidenceError("adjudication_schema_version_invalid")
    if adjudication.get("evidence_contract") != ADJUDICATION_CONTRACT:
        raise Stage3EvidenceError("adjudication_contract_invalid")
    if adjudication.get("domain") != domain:
        raise Stage3EvidenceError("adjudication_domain_mismatch")
    if adjudication.get("source_pack_sha256") != source_hash:
        raise Stage3EvidenceError("adjudication_source_hash_mismatch")
    if adjudication.get("review_a_sha256") != review_a_hash:
        raise Stage3EvidenceError("adjudication_review_a_hash_mismatch")
    if adjudication.get("review_b_sha256") != review_b_hash:
        raise Stage3EvidenceError("adjudication_review_b_hash_mismatch")
    adjudicator = _mapping(adjudication.get("adjudicator"), "adjudicator")
    adjudicator_id = _text(adjudicator.get("anonymous_id"), "adjudicator_id")
    if adjudicator_id in reviewer_ids:
        raise Stage3EvidenceError("adjudicator_must_be_independent")
    for field in ("native_chinese_human", "independent"):
        if _boolean(adjudicator.get(field), f"adjudicator_{field}") is not True:
            raise Stage3EvidenceError(f"adjudicator_{field}_required")
    completed = _timestamp(adjudicator.get("completed_at"), "adjudicator_completed_at")
    if any(reviewed > completed for reviewed in reviews_completed_at):
        raise Stage3EvidenceError("adjudication_precedes_review")
    rows = _rows(adjudication.get("rows"), "adjudication_rows")
    if set(rows) != set(source_rows):
        raise Stage3EvidenceError("adjudication_row_set_mismatch")
    conflict_count = 0
    normalized: dict[str, dict[str, Any]] = {}
    for review_id, row in rows.items():
        reason = _text(row.get("reason_code"), f"adjudication:{review_id}:reason_code")
        if reason not in ADJUDICATION_REASONS:
            raise Stage3EvidenceError(f"adjudication:{review_id}:reason_code_invalid")
        signature_a = _judgment_signature(normalized_a[review_id])
        signature_b = _judgment_signature(normalized_b[review_id])
        disagreement = signature_a != signature_b
        if disagreement:
            conflict_count += 1
            if reason == "agree":
                raise Stage3EvidenceError(
                    f"adjudication:{review_id}:disagreement_not_resolved"
                )
        elif reason != "agree":
            raise Stage3EvidenceError(f"adjudication:{review_id}:false_disagreement")
        decision = _normalized_review(
            domain,
            row.get("review"),
            source_rows[review_id],
            f"adjudication:{review_id}",
        )
        if not disagreement and _judgment_signature(decision) != signature_a:
            raise Stage3EvidenceError(f"adjudication:{review_id}:agree_decision_changed")
        normalized[review_id] = decision
    return completed, conflict_count, normalized


def _rate(values: list[bool]) -> float:
    return sum(int(value) for value in values) / len(values) if values else 0.0


def _facts_metrics(reviews: Mapping[str, dict[str, Any]]) -> tuple[dict[str, Any], bool]:
    rows = list(reviews.values())
    facts = [fact for row in rows for fact in row["facts"].values()]
    actions = [action for row in rows for action in row["actions"].values()]
    metrics = {
        "meeting_count": len(rows),
        "fact_count": len(facts),
        "action_count": len(actions),
        "overview_accuracy": _rate([row["overview_accurate"] for row in rows]),
        "fact_support_rate": _rate([fact["supported"] for fact in facts]),
        "fact_accuracy_rate": _rate([fact["materially_accurate"] for fact in facts]),
        "fact_certainty_rate": _rate([fact["certainty_correct"] for fact in facts]),
        "conflict_preservation_rate": _rate([row["conflicts_preserved"] for row in rows]),
        "important_omission_rate": _rate([row["important_fact_omitted"] for row in rows]),
        "critical_error_rate": _rate([row["critical_error"] for row in rows]),
        "action_real_commitment_rate": _rate(
            [action["is_real_commitment"] for action in actions]
        ),
        "action_specific_useful_rate": _rate(
            [action["specific_and_useful"] for action in actions]
        ),
        "action_owner_support_rate": _rate([action["owner_supported"] for action in actions]),
        "action_due_support_rate": _rate([action["due_supported"] for action in actions]),
        "action_schedule_fit_rate": _rate(
            [action["schedule_fit_appropriate"] for action in actions]
        ),
        "duplicate_action_count": sum(bool(action["duplicate_of"]) for action in actions),
    }
    minimum_rates = (
        "overview_accuracy",
        "fact_support_rate",
        "fact_accuracy_rate",
        "fact_certainty_rate",
        "conflict_preservation_rate",
        "action_real_commitment_rate",
        "action_specific_useful_rate",
        "action_owner_support_rate",
        "action_due_support_rate",
        "action_schedule_fit_rate",
    )
    passed = (
        bool(rows)
        and bool(facts)
        and bool(actions)
        and all(float(metrics[name]) >= 0.95 for name in minimum_rates)
        and float(metrics["important_omission_rate"]) <= 0.05
        and float(metrics["critical_error_rate"]) == 0.0
        and int(metrics["duplicate_action_count"]) == 0
    )
    return metrics, passed


def _q2_metrics(reviews: Mapping[str, dict[str, Any]]) -> tuple[dict[str, Any], bool]:
    rows = list(reviews.values())
    metrics = {
        "question_count": len(rows),
        "answer_correct_rate": _rate([row["answer_correct"] for row in rows]),
        "answer_complete_rate": _rate([row["answer_complete"] for row in rows]),
        "citation_relevance_rate": _rate([row["citations_relevant"] for row in rows]),
        "refusal_appropriateness_rate": _rate(
            [row["refusal_appropriate"] for row in rows]
        ),
        "critical_error_rate": _rate([row["critical_error"] for row in rows]),
    }
    passed = (
        bool(rows)
        and all(
            float(metrics[name]) >= 0.95
            for name in (
                "answer_correct_rate",
                "answer_complete_rate",
                "citation_relevance_rate",
                "refusal_appropriateness_rate",
            )
        )
        and float(metrics["critical_error_rate"]) == 0.0
    )
    return metrics, passed


def _seal(report: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(report)
    result.pop("report_sha256", None)
    result["report_sha256"] = _object_sha256(result)
    return result


def score_evidence(
    *,
    domain: str,
    source_path: Path,
    review_a_path: Path,
    review_b_path: Path,
    adjudication_path: Path,
) -> dict[str, Any]:
    if domain not in DOMAINS:
        raise Stage3EvidenceError("domain_invalid")
    source = _mapping(_load(source_path), "source")
    source_rows = _source_rows(source, domain)
    source_hash = _sha256_file(source_path)
    review_a = _load(review_a_path)
    review_b = _load(review_b_path)
    reviewer_a, completed_a, normalized_a = _review_submission(
        review_a,
        domain=domain,
        source_hash=source_hash,
        source_rows=source_rows,
        code="review_a",
    )
    reviewer_b, completed_b, normalized_b = _review_submission(
        review_b,
        domain=domain,
        source_hash=source_hash,
        source_rows=source_rows,
        code="review_b",
    )
    if reviewer_a == reviewer_b:
        raise Stage3EvidenceError("reviewers_must_be_distinct")
    review_a_hash = _sha256_file(review_a_path)
    review_b_hash = _sha256_file(review_b_path)
    _completed, conflicts, adjudicated = _adjudicated_reviews(
        _load(adjudication_path),
        domain=domain,
        source_hash=source_hash,
        review_a_hash=review_a_hash,
        review_b_hash=review_b_hash,
        source_rows=source_rows,
        normalized_a=normalized_a,
        normalized_b=normalized_b,
        reviewer_ids={reviewer_a, reviewer_b},
        reviews_completed_at=(completed_a, completed_b),
    )
    metrics, quality_passed = (
        _facts_metrics(adjudicated)
        if domain == DOMAIN_FACTS
        else _q2_metrics(adjudicated)
    )
    return _seal({
        "schema_version": SCHEMA_VERSION,
        "evidence_contract": REPORT_CONTRACT,
        "domain": domain,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "source_row_count": len(source_rows),
        "adjudicated_conflict_count": conflicts,
        "quality_passed": quality_passed,
        "metrics": metrics,
        "lineage": {
            "source_pack_sha256": source_hash,
            "review_a_sha256": review_a_hash,
            "review_b_sha256": review_b_hash,
            "adjudication_sha256": _sha256_file(adjudication_path),
        },
    })


def verify_report(value: object) -> tuple[bool, str]:
    try:
        report = _mapping(value, "report_not_object")
        if report.get("schema_version") != SCHEMA_VERSION:
            raise Stage3EvidenceError("report_schema_version_invalid")
        if report.get("evidence_contract") != REPORT_CONTRACT:
            raise Stage3EvidenceError("report_contract_invalid")
        if report.get("domain") not in DOMAINS:
            raise Stage3EvidenceError("report_domain_invalid")
        claimed = _digest(report.get("report_sha256"), "report_hash_invalid")
        unsigned = dict(report)
        unsigned.pop("report_sha256", None)
        if claimed != _object_sha256(unsigned):
            raise Stage3EvidenceError("report_hash_mismatch")
        if report.get("independent_human_adjudication") is not True:
            raise Stage3EvidenceError("report_adjudication_required")
        if report.get("blind_reviewer_count") != 2:
            raise Stage3EvidenceError("report_two_reviewers_required")
        if not isinstance(report.get("quality_passed"), bool):
            raise Stage3EvidenceError("report_quality_result_invalid")
        count = report.get("source_row_count")
        conflicts = report.get("adjudicated_conflict_count")
        if any(
            isinstance(number, bool) or not isinstance(number, int) or number < 0
            for number in (count, conflicts)
        ):
            raise Stage3EvidenceError("report_counts_invalid")
        if count == 0 or conflicts > count:
            raise Stage3EvidenceError("report_counts_inconsistent")
        metrics = _mapping(report.get("metrics"), "report_metrics_required")
        if report.get("domain") == DOMAIN_FACTS:
            count_names = ("meeting_count", "fact_count", "action_count")
            rate_names = (
                "overview_accuracy",
                "fact_support_rate",
                "fact_accuracy_rate",
                "fact_certainty_rate",
                "conflict_preservation_rate",
                "important_omission_rate",
                "critical_error_rate",
                "action_real_commitment_rate",
                "action_specific_useful_rate",
                "action_owner_support_rate",
                "action_due_support_rate",
                "action_schedule_fit_rate",
            )
            duplicate_count = metrics.get("duplicate_action_count")
            if (
                isinstance(duplicate_count, bool)
                or not isinstance(duplicate_count, int)
                or duplicate_count < 0
            ):
                raise Stage3EvidenceError("report_duplicate_count_invalid")
        else:
            count_names = ("question_count",)
            rate_names = (
                "answer_correct_rate",
                "answer_complete_rate",
                "citation_relevance_rate",
                "refusal_appropriateness_rate",
                "critical_error_rate",
            )
        for name in count_names:
            number = metrics.get(name)
            if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
                raise Stage3EvidenceError(f"report_metric_count_invalid:{name}")
        primary_count = (
            metrics["meeting_count"]
            if report.get("domain") == DOMAIN_FACTS
            else metrics["question_count"]
        )
        if primary_count != count:
            raise Stage3EvidenceError("report_source_count_mismatch")
        for name in rate_names:
            number = metrics.get(name)
            if isinstance(number, bool) or not isinstance(number, (int, float)):
                raise Stage3EvidenceError(f"report_metric_invalid:{name}")
            if not 0.0 <= float(number) <= 1.0:
                raise Stage3EvidenceError(f"report_metric_range_invalid:{name}")
        if report.get("domain") == DOMAIN_FACTS:
            expected_pass = (
                all(float(metrics[name]) >= 0.95 for name in rate_names[:5])
                and float(metrics["important_omission_rate"]) <= 0.05
                and float(metrics["critical_error_rate"]) == 0.0
                and all(float(metrics[name]) >= 0.95 for name in rate_names[7:])
                and duplicate_count == 0
            )
        else:
            expected_pass = (
                all(float(metrics[name]) >= 0.95 for name in rate_names[:4])
                and float(metrics["critical_error_rate"]) == 0.0
            )
        if report.get("quality_passed") is not expected_pass:
            raise Stage3EvidenceError("report_quality_result_inconsistent")
        lineage = _mapping(report.get("lineage"), "report_lineage_required")
        for key in (
            "source_pack_sha256",
            "review_a_sha256",
            "review_b_sha256",
            "adjudication_sha256",
        ):
            _digest(lineage.get(key), f"report_lineage_invalid:{key}")
        return True, "verified"
    except Stage3EvidenceError as error:
        return False, str(error)


def make_templates(source_path: Path, domain: str, output_dir: Path) -> dict[str, Any]:
    if domain not in DOMAINS:
        raise Stage3EvidenceError("domain_invalid")
    source = _mapping(_load(source_path), "source")
    source_rows = _source_rows(source, domain)
    source_hash = _sha256_file(source_path)
    _mkdir_private(output_dir)

    blank_rows = [
        {
            "review_id": review_id,
            "review": row.get("review"),
        }
        for review_id, row in source_rows.items()
    ]
    for label in ("a", "b"):
        _write_private(output_dir / f"review-{label}.json", {
            "schema_version": SCHEMA_VERSION,
            "evidence_contract": SUBMISSION_CONTRACT,
            "domain": domain,
            "source_pack_sha256": source_hash,
            "reviewer": {
                "anonymous_id": "",
                "native_chinese_human": False,
                "independent": False,
                "automated_result_blind": False,
                "completed_at": "",
            },
            "rows": blank_rows,
        })
    _write_private(output_dir / "adjudication.json", {
        "schema_version": SCHEMA_VERSION,
        "evidence_contract": ADJUDICATION_CONTRACT,
        "domain": domain,
        "source_pack_sha256": source_hash,
        "review_a_sha256": "",
        "review_b_sha256": "",
        "adjudicator": {
            "anonymous_id": "",
            "native_chinese_human": False,
            "independent": False,
            "completed_at": "",
        },
        "rows": [
            {
                "review_id": review_id,
                "reason_code": "",
                "review": row.get("review"),
            }
            for review_id, row in source_rows.items()
        ],
    })
    return {
        "domain": domain,
        "source_pack_sha256": source_hash,
        "row_count": len(source_rows),
        "output_files": ["review-a.json", "review-b.json", "adjudication.json"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    templates = commands.add_parser("make-templates")
    templates.add_argument("--domain", choices=sorted(DOMAINS), required=True)
    templates.add_argument("--source", type=Path, required=True)
    templates.add_argument("--output-dir", type=Path, required=True)
    score = commands.add_parser("score")
    score.add_argument("--domain", choices=sorted(DOMAINS), required=True)
    score.add_argument("--source", type=Path, required=True)
    score.add_argument("--review-a", type=Path, required=True)
    score.add_argument("--review-b", type=Path, required=True)
    score.add_argument("--adjudication", type=Path, required=True)
    score.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "make-templates":
        result = make_templates(args.source, args.domain, args.output_dir)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    report = score_evidence(
        domain=args.domain,
        source_path=args.source,
        review_a_path=args.review_a,
        review_b_path=args.review_b,
        adjudication_path=args.adjudication,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "domain": report["domain"],
        "quality_passed": report["quality_passed"],
        "metrics": report["metrics"],
        "report_sha256": report["report_sha256"],
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
