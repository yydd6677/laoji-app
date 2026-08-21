from __future__ import annotations

from product_owner_risk_waiver import (
    ACTIVE_PATH_POLICY,
    EVIDENCE_CONTRACT,
    OWNER_DECISION,
    OWNER_ROLE,
    REQUIRED_SCOPES,
    RISK_ACKNOWLEDGEMENTS,
    seal_waiver,
    verify_waiver,
)


def waiver() -> dict:
    return seal_waiver({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "owner_role": OWNER_ROLE,
        "decision": OWNER_DECISION,
        "issued_at": "2026-08-21T14:00:00+00:00",
        "authorization_reference": "codex-thread:test",
        "baseline_revision": "test-revision",
        "applies_to": sorted(REQUIRED_SCOPES),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "physical_legacy_deletion_authorized": False,
        "production_release_authorized": False,
        "risk_acknowledgements": list(RISK_ACKNOWLEDGEMENTS),
    })


def test_complete_waiver_is_verified() -> None:
    verified, reason, scopes = verify_waiver(waiver())
    assert verified is True
    assert reason == "verified"
    assert scopes == REQUIRED_SCOPES


def test_tampering_is_rejected() -> None:
    value = waiver()
    value["production_release_authorized"] = True
    verified, reason, _scopes = verify_waiver(value)
    assert verified is False
    assert reason == "waiver_must_not_authorize_production_release"


def test_partial_scope_is_rejected() -> None:
    value = waiver()
    value.pop("report_sha256")
    value["applies_to"] = value["applies_to"][:-1]
    value = seal_waiver(value)
    verified, reason, _scopes = verify_waiver(value)
    assert verified is False
    assert reason == "waiver_scopes_incomplete"
