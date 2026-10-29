from __future__ import annotations

import base64
import hashlib
import sqlite3
import uuid

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api import device_v2_speakers
from app.api.device_v2 import require_device_v2
from app.config import settings
from app.services import device_identity, vnext_speaker_store
from app.services.device_v2_identity import DeviceV2Context


@pytest.fixture
def speaker_api(tmp_path, monkeypatch):
    database = tmp_path / "speaker-api.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "SECRET_KEY", "speaker-api-test-secret-at-least-32-bytes")
    monkeypatch.setattr(settings, "VNEXT_SPEAKER_SPOOL_PATH", str(tmp_path / "spool"))
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    vnext_speaker_store.ensure_vnext_speaker_schema()
    app = FastAPI()
    app.include_router(device_v2_speakers.router, prefix="/api")
    app.dependency_overrides[require_device_v2] = lambda: context
    return TestClient(app), database


def test_speaker_profile_sample_is_ephemeral_and_revocable(speaker_api, monkeypatch) -> None:
    client, database = speaker_api

    async def fake_embedding(_pcm: bytes):
        return np.array([1.0, 0.0], dtype=np.float32), "campplus-test"

    monkeypatch.setattr(
        device_v2_speakers.vnext_speaker_pipeline,
        "extract_embedding_from_pcm",
        fake_embedding,
    )
    created = client.post("/api/device/v2/speakers", json={
        "schema_version": 2,
        "speaker_id": "speaker-zhang-min",
        "display_name": "张敏",
    })
    assert created.status_code == 201
    pcm = (np.ones(19_200, dtype="<i2") * 100).tobytes()
    sample = client.post("/api/device/v2/speakers/speaker-zhang-min/samples", json={
        "schema_version": 2,
        "sample_rate": 16_000,
        "pcm_base64": base64.b64encode(pcm).decode("ascii"),
        "content_sha256": "sha256:" + hashlib.sha256(pcm).hexdigest(),
    })
    assert sample.status_code == 200
    assert sample.json()["profile"]["status"] == "active"
    assert client.get("/api/device/v2/speakers").json()["profiles"][0]["display_name"] == "张敏"
    assert "张敏".encode("utf-8") not in database.read_bytes()

    deleted = client.delete("/api/device/v2/speakers/speaker-zhang-min")
    assert deleted.status_code == 204
    assert client.get("/api/device/v2/speakers").json()["profiles"] == []


def test_speaker_sample_checksum_fails_closed(speaker_api) -> None:
    client, _database = speaker_api
    client.post("/api/device/v2/speakers", json={
        "schema_version": 2,
        "speaker_id": "speaker-one",
        "display_name": "讲话人",
    })
    pcm = b"\x00\x01" * 19_200
    response = client.post("/api/device/v2/speakers/speaker-one/samples", json={
        "schema_version": 2,
        "sample_rate": 16_000,
        "pcm_base64": base64.b64encode(pcm).decode("ascii"),
        "content_sha256": "sha256:" + "0" * 64,
    })
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "SPEAKER_SAMPLE_CHECKSUM_INVALID"
