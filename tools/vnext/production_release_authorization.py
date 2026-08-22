#!/usr/bin/env python3
"""Seal and verify an explicit vNext production release authorization.

This contract is deliberately separate from the product-owner quality waiver.
The waiver can close skipped quality/observation gates, while this document is
the authority for mutating the production control database and switching the
public APK manifest.  It never authorizes physical removal of the retained
legacy implementation.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping


SCHEMA_VERSION = 1
EVIDENCE_CONTRACT = "vnext-production-release-authorization-v1"
OWNER_ROLE = "sole_product_owner"
OWNER_DECISION = "authorize_vnext_production_release"
ACTIVE_PATH_POLICY = "single-owner-no-dual-write-no-silent-fallback"
LEGACY_RETENTION_MODE = "cold_rollback"
RISK_ACKNOWLEDGEMENTS = (
    "human_quality_and_normal_use_gates_were_owner_waived",
    "release_uses_single_vnext_owner_per_capability",
    "rollback_is_whole_release_not_request_fallback",
    "legacy_assets_remain_cold_rollback_only",
    "physical_legacy_deletion_requires_later_owner_authorization",
)


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def seal_authorization(value: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload.pop("report_sha256", None)
    payload["report_sha256"] = "sha256:" + hashlib.sha256(_canonical(payload)).hexdigest()
    return payload


def verify_authorization(value: object) -> tuple[bool, str]:
    if not isinstance(value, Mapping):
        return False, "release_authorization_not_object"
    authorization = dict(value)
    claimed = authorization.pop("report_sha256", None)
    exact = {
        "schema_version": SCHEMA_VERSION,
        "evidence_contract": EVIDENCE_CONTRACT,
        "owner_role": OWNER_ROLE,
        "decision": OWNER_DECISION,
        "active_path_policy": ACTIVE_PATH_POLICY,
        "legacy_retention_mode": LEGACY_RETENTION_MODE,
        "production_release_authorized": True,
        "public_traffic_switch_authorized": True,
        "physical_legacy_deletion_authorized": False,
    }
    for field, expected in exact.items():
        if authorization.get(field) != expected:
            return False, f"release_authorization_{field}_invalid"
    for field in (
        "issued_at",
        "authorization_reference",
        "baseline_revision",
        "target_version_name",
        "production_database",
    ):
        if not isinstance(authorization.get(field), str) or not authorization[field].strip():
            return False, f"release_authorization_{field}_required"
    version_code = authorization.get("target_version_code")
    if not isinstance(version_code, int) or isinstance(version_code, bool) or version_code < 1:
        return False, "release_authorization_target_version_code_invalid"
    if authorization.get("risk_acknowledgements") != list(RISK_ACKNOWLEDGEMENTS):
        return False, "release_authorization_risk_acknowledgements_invalid"
    actual = "sha256:" + hashlib.sha256(_canonical(authorization)).hexdigest()
    if not isinstance(claimed, str) or claimed != actual:
        return False, "release_authorization_report_sha256_mismatch"
    return True, "verified"

