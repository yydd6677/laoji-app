#!/usr/bin/env python3
"""Seal and verify the sole product-owner vNext risk waiver.

The waiver is deliberately separate from quality evidence.  It allows a
personal, pre-user candidate to proceed without manufacturing human metrics or
public-cycle observations, while preserving the fact that those gates were not
validated.  It never authorizes production release or physical legacy removal.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
EVIDENCE_CONTRACT = "vnext-product-owner-risk-waiver-v1"
OWNER_ROLE = "sole_product_owner"
OWNER_DECISION = "accept_unverified_quality_and_observation_risk"
ACTIVE_PATH_POLICY = "single-owner-no-dual-write-no-silent-fallback"

STAGE2_MEDIA_QUALITY = "stage2.media_quality"
STAGE2_PUBLIC_CYCLE = "stage2.public_cycle"
STAGE3_HUMAN_QUALITY = "stage3.human_quality"
STAGE3_PUBLIC_CYCLE = "stage3.public_cycle"
STAGE4_SCHEDULE_QUALITY = "stage4.schedule_quality"
STAGE4_PUBLIC_CYCLE = "stage4.public_cycle"
STAGE5_LEGACY_RETENTION = "stage5.legacy_retention"

REQUIRED_SCOPES = frozenset({
    STAGE2_MEDIA_QUALITY,
    STAGE2_PUBLIC_CYCLE,
    STAGE3_HUMAN_QUALITY,
    STAGE3_PUBLIC_CYCLE,
    STAGE4_SCHEDULE_QUALITY,
    STAGE4_PUBLIC_CYCLE,
    STAGE5_LEGACY_RETENTION,
})

RISK_ACKNOWLEDGEMENTS = (
    "quality_metrics_are_unverified",
    "legacy_zero_cycle_was_not_observed",
    "legacy_assets_are_cold_rollback_only",
    "physical_legacy_deletion_requires_later_owner_authorization",
    "production_release_requires_separate_owner_authorization",
)


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def seal_waiver(value: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload.pop("report_sha256", None)
    payload["report_sha256"] = "sha256:" + hashlib.sha256(_canonical(payload)).hexdigest()
    return payload


def verify_waiver(value: object) -> tuple[bool, str, frozenset[str]]:
    if not isinstance(value, Mapping):
        return False, "waiver_not_object", frozenset()
    waiver = dict(value)
    claimed = waiver.pop("report_sha256", None)
    if waiver.get("schema_version") != SCHEMA_VERSION:
        return False, "waiver_schema_version_invalid", frozenset()
    if waiver.get("evidence_contract") != EVIDENCE_CONTRACT:
        return False, "waiver_contract_invalid", frozenset()
    if waiver.get("owner_role") != OWNER_ROLE or waiver.get("decision") != OWNER_DECISION:
        return False, "waiver_owner_decision_invalid", frozenset()
    if waiver.get("active_path_policy") != ACTIVE_PATH_POLICY:
        return False, "waiver_active_path_policy_invalid", frozenset()
    if waiver.get("physical_legacy_deletion_authorized") is not False:
        return False, "waiver_must_not_authorize_legacy_deletion", frozenset()
    if waiver.get("production_release_authorized") is not False:
        return False, "waiver_must_not_authorize_production_release", frozenset()
    if not isinstance(waiver.get("issued_at"), str) or not waiver["issued_at"].strip():
        return False, "waiver_issued_at_required", frozenset()
    if not isinstance(waiver.get("authorization_reference"), str) or not waiver["authorization_reference"].strip():
        return False, "waiver_authorization_reference_required", frozenset()
    if not isinstance(waiver.get("baseline_revision"), str) or not waiver["baseline_revision"].strip():
        return False, "waiver_baseline_revision_required", frozenset()
    scopes_value = waiver.get("applies_to")
    if not isinstance(scopes_value, list) or any(not isinstance(item, str) for item in scopes_value):
        return False, "waiver_scopes_invalid", frozenset()
    scopes = frozenset(scopes_value)
    if scopes != REQUIRED_SCOPES or len(scopes_value) != len(scopes):
        return False, "waiver_scopes_incomplete", frozenset()
    acknowledgements = waiver.get("risk_acknowledgements")
    if acknowledgements != list(RISK_ACKNOWLEDGEMENTS):
        return False, "waiver_risk_acknowledgements_invalid", frozenset()
    actual = "sha256:" + hashlib.sha256(_canonical(waiver)).hexdigest()
    if not isinstance(claimed, str) or claimed != actual:
        return False, "waiver_report_sha256_mismatch", frozenset()
    return True, "verified", scopes


def waiver_projection(value: object) -> dict[str, Any]:
    verified, reason, scopes = verify_waiver(value)
    report = value if isinstance(value, Mapping) else {}
    return {
        "verified": verified,
        "reason": reason,
        "contract": report.get("evidence_contract"),
        "report_sha256": report.get("report_sha256"),
        "scopes": sorted(scopes),
        "physical_legacy_deletion_authorized": report.get(
            "physical_legacy_deletion_authorized"
        ),
        "production_release_authorized": report.get("production_release_authorized"),
    }


def apply_waiver_to_gates(
    gates: list[dict[str, Any]],
    waiver: object,
    scope_gate_names: Mapping[str, Sequence[str]],
) -> dict[str, Any]:
    """Mark only explicitly scoped blocked gates as waived.

    Passing evidence remains passing; a waiver never overwrites a measured
    result.  The original blocked evidence is retained under
    ``underlying_evidence`` so reports remain honest about what was skipped.
    """
    projection = waiver_projection(waiver)
    if projection["verified"] is not True:
        projection["waived_gate_names"] = []
        return projection
    scopes = set(projection["scopes"])
    targets = {
        name
        for scope, names in scope_gate_names.items()
        if scope in scopes
        for name in names
    }
    waived: list[str] = []
    for gate in gates:
        if gate.get("name") not in targets or gate.get("status") == "passed":
            continue
        underlying = gate.get("evidence")
        gate["status"] = "waived"
        gate["evidence"] = {
            "waiver_contract": projection["contract"],
            "waiver_report_sha256": projection["report_sha256"],
            "underlying_evidence": underlying,
        }
        gate["reason"] = "product_owner_explicit_risk_waiver"
        waived.append(str(gate["name"]))
    projection["waived_gate_names"] = waived
    return projection
