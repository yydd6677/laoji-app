from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services import storage_admission


def test_storage_admission_warns_before_rejecting(monkeypatch, tmp_path):
    monkeypatch.setattr(storage_admission.settings, "AUDIO_STORAGE_PATH", str(tmp_path))
    monkeypatch.setattr(
        storage_admission.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(
            total=100 * 1024**3,
            used=65 * 1024**3,
            free=35 * 1024**3,
        ),
    )

    assert storage_admission.storage_state() == {
        "free_bytes": 35 * 1024**3,
        "warning": True,
        "accepting_new_audio": True,
    }
    storage_admission.ensure_audio_upload_allowed()


def test_storage_admission_keeps_audio_local_below_hard_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(storage_admission.settings, "AUDIO_STORAGE_PATH", str(tmp_path))
    monkeypatch.setattr(
        storage_admission.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(
            total=100 * 1024**3,
            used=81 * 1024**3,
            free=19 * 1024**3,
        ),
    )

    with pytest.raises(HTTPException) as error:
        storage_admission.ensure_audio_upload_allowed()

    assert error.value.status_code == 507
    assert error.value.detail == "云端存储空间不足，录音已保留在本机，稍后会自动重试上传"
