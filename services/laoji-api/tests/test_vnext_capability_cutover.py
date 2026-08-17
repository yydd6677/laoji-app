from __future__ import annotations

import sqlite3

import pytest

from app.config import settings
from app.services import device_identity, vnext_capability_cutover


@pytest.fixture
def cutover_database(tmp_path, monkeypatch):
    database = tmp_path / "vnext-cutover.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    return database


def test_legacy_counter_closes_monotonically(cutover_database) -> None:
    capability = vnext_capability_cutover.MEDIA_UPLOAD_CAPABILITY
    revision = vnext_capability_cutover.MEDIA_UPLOAD_CONTRACT_REVISION
    vnext_capability_cutover.guard_legacy_submit(capability, revision)
    vnext_capability_cutover.guard_legacy_submit(capability, revision)
    before = vnext_capability_cutover.get_cutover(capability)
    assert before is not None
    assert before["legacy_submit_count"] == 2
    assert before["closed"] is False

    activated = vnext_capability_cutover.activate_cutover(
        capability,
        revision,
        barrier_id="stage2-test-barrier",
    )
    assert activated["closed"] is True
    assert activated["barrier_id"] == "stage2-test-barrier"
    replay = vnext_capability_cutover.activate_cutover(
        capability,
        revision,
        barrier_id="different-replay-id",
    )
    assert replay["barrier_id"] == "stage2-test-barrier"
    assert replay["legacy_submit_count"] == 2

    with pytest.raises(vnext_capability_cutover.VNextCapabilityCutoverError) as raised:
        vnext_capability_cutover.guard_legacy_submit(capability, revision)
    assert raised.value.code == "UPGRADE_REQUIRED"
    assert raised.value.status_code == 426
    assert vnext_capability_cutover.get_cutover(capability)["legacy_submit_count"] == 2


def test_media_upload_activation_requires_explicit_ready_config(
    cutover_database,
    monkeypatch,
) -> None:
    monkeypatch.delenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED", raising=False)
    assert vnext_capability_cutover.media_upload_cutover_enabled(prerequisites_ready=True) is False
    monkeypatch.setenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED", "1")
    monkeypatch.setenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ID", "stage2-configured-barrier")
    assert vnext_capability_cutover.media_upload_cutover_enabled(prerequisites_ready=False) is False
    assert vnext_capability_cutover.media_upload_cutover_enabled(prerequisites_ready=True) is True

    # Removing the deployment flag or temporarily losing a dependency cannot
    # reopen a closed ingress and send clients back to v1.
    monkeypatch.delenv("LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED")
    assert vnext_capability_cutover.media_upload_cutover_enabled(prerequisites_ready=False) is True
