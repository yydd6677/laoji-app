import sqlite3
from pathlib import Path

import numpy as np
import pytest
from fastapi import HTTPException

from app.api import app_speakers
from app.services.speaker_db_service import SpeakerDatabase


def _embedding(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    value = rng.normal(size=192).astype(np.float32)
    return value / np.linalg.norm(value)


def _save(db: SpeakerDatabase, speaker_id: str, name: str, owner_user_id=None) -> None:
    embedding = _embedding(abs(hash(speaker_id)) % 10000)
    assert db.save_speaker(
        speaker_id=speaker_id,
        embedding=embedding,
        embedding_mean=embedding,
        name=name,
        owner_user_id=owner_user_id,
    )


def test_schema_migration_preserves_legacy_profiles_and_adds_owner_scope(tmp_path: Path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE speaker_profiles (
                speaker_id TEXT PRIMARY KEY, name TEXT, role TEXT, department TEXT,
                sample_count INTEGER DEFAULT 0, quality REAL DEFAULT 0.0,
                registered_at TEXT, updated_at TEXT, is_active INTEGER DEFAULT 1
            );
            CREATE TABLE speaker_embeddings (
                speaker_id TEXT PRIMARY KEY, embedding BLOB,
                embedding_mean BLOB, embedding_std BLOB, embedding_count INTEGER DEFAULT 1
            );
            CREATE TABLE speaker_identification_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, speaker_id TEXT,
                session_id TEXT, confidence REAL, recognized_at TEXT
            );
            INSERT INTO speaker_profiles(speaker_id, name, is_active) VALUES ('legacy', '旧原型', 1);
        """)
    db = SpeakerDatabase(str(path))
    assert db.load_speaker("legacy")["name"] == "旧原型"
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(speaker_profiles)")}
        assert "owner_user_id" in columns
        assert "capture_profile" in columns
        assert conn.execute(
            "SELECT capture_profile FROM speaker_profiles WHERE speaker_id = 'legacy'"
        ).fetchone()[0] == "legacy"


def test_legacy_and_app_voiceprints_are_isolated_for_every_mutation(tmp_path: Path):
    db = SpeakerDatabase(str(tmp_path / "speaker.db"))
    _save(db, "legacy", "旧原型")
    _save(db, "u7_private", "用户七", owner_user_id=7)
    _save(db, "u8_private", "用户八", owner_user_id=8)

    assert [item["speaker_id"] for item in db.load_all()] == ["legacy"]
    assert [item["speaker_id"] for item in db.search_by_name("用户")] == []
    assert [item["speaker_id"] for item in db.load_for_owner(7)] == ["u7_private"]
    assert db.load_speaker("u7_private") is None
    assert db.load_speaker_for_owner(8, "u7_private") is None

    assert not db.update_speaker_for_owner(8, "u7_private", name="越权修改")
    assert not db.deactivate_speaker_for_owner(8, "u7_private")
    assert not db.supplement_audio_for_owner(8, "u7_private", _embedding(4), quality=0.8)
    assert db.load_speaker_for_owner(7, "u7_private")["name"] == "用户七"

    assert db.update_speaker_for_owner(7, "u7_private", name="本人修改")
    assert db.supplement_audio_for_owner(7, "u7_private", _embedding(5), quality=0.8)
    assert db.load_speaker_for_owner(7, "u7_private")["sample_count"] == 2
    assert db.deactivate_speaker_for_owner(7, "u7_private")
    assert db.load_speaker_for_owner(7, "u7_private") is None
    assert db.load_speaker("legacy") is not None


def test_account_cleanup_only_deletes_owned_voiceprints(tmp_path: Path):
    db = SpeakerDatabase(str(tmp_path / "speaker.db"))
    _save(db, "legacy", "旧原型")
    _save(db, "u7_a", "七甲", owner_user_id=7)
    _save(db, "u7_b", "七乙", owner_user_id=7)
    _save(db, "u8_a", "八甲", owner_user_id=8)
    db.log_identification("u7_a", "meeting-1", 0.9)

    assert db.delete_owned_speakers(7) == 2
    assert db.load_for_owner(7, active_only=False) == []
    assert [item["speaker_id"] for item in db.load_for_owner(8)] == ["u8_a"]
    assert [item["speaker_id"] for item in db.load_all()] == ["legacy"]
    with sqlite3.connect(db.db_path) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM speaker_identification_log WHERE speaker_id = 'u7_a'"
        ).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_app_registration_assigns_owner_and_never_lists_another_user(tmp_path: Path, monkeypatch):
    db = SpeakerDatabase(str(tmp_path / "speaker.db"))
    audio_data = np.full(16000 * 4, 0.1, dtype=np.float32)
    embedding = _embedding(9)

    async def fake_read_audio(_audio):
        return audio_data

    async def fake_features(_audio):
        return embedding, 0.88, "优秀", "声纹特征明显", [], []

    monkeypatch.setattr(app_speakers, "get_speaker_db", lambda: db)
    monkeypatch.setattr(app_speakers, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_speakers, "_read_audio", fake_read_audio)
    monkeypatch.setattr(app_speakers, "_voiceprint_features", fake_features)

    created = await app_speakers.register_app_speaker(
        name="  张 三  ",
        audio=object(),
        capture_profile=app_speakers.CURRENT_CAPTURE_PROFILE,
        voiceprint_consent_accepted=True,
        voiceprint_consent_version=app_speakers.VOICEPRINT_CONSENT_VERSION,
        current_user={"id": 7},
    )
    speaker_id = created["speaker"]["speaker_id"]
    assert speaker_id.startswith("u7_")
    assert created["speaker"]["name"] == "张 三"
    assert db.load_speaker_for_owner(7, speaker_id)["capture_profile"] == (
        app_speakers.CURRENT_CAPTURE_PROFILE
    )
    assert (await app_speakers.list_app_speakers({"id": 7}))["total"] == 1
    assert (await app_speakers.list_app_speakers({"id": 8}))["total"] == 0

    with pytest.raises(HTTPException) as denied:
        await app_speakers.rename_app_speaker(
            speaker_id,
            app_speakers.SpeakerNameUpdate(name="越权"),
            {"id": 8},
        )
    assert denied.value.status_code == 404


@pytest.mark.asyncio
async def test_app_audio_rejects_silence_before_loading_voiceprint_model(monkeypatch):
    class SilentUpload:
        filename = "silent.wav"
        content_type = "audio/wav"

        async def read(self, _limit):
            import io
            import soundfile as sf

            output = io.BytesIO()
            sf.write(output, np.zeros(16000 * 3, dtype=np.float32), 16000, format="WAV")
            return output.getvalue()

        async def close(self):
            return None

    with pytest.raises(HTTPException) as rejected:
        await app_speakers._read_audio(SilentUpload())
    assert rejected.value.status_code == 400
    assert "清晰人声" in str(rejected.value.detail)


@pytest.mark.asyncio
async def test_current_capture_replaces_legacy_domain_before_future_supplements(
    tmp_path: Path,
    monkeypatch,
):
    db = SpeakerDatabase(str(tmp_path / "speaker.db"))
    legacy_embedding = _embedding(20)
    current_embedding = _embedding(21)
    assert db.save_speaker(
        speaker_id="u7_legacy",
        embedding=legacy_embedding,
        embedding_mean=legacy_embedding,
        name="张三",
        sample_count=2,
        owner_user_id=7,
        capture_profile=app_speakers.LEGACY_CAPTURE_PROFILE,
    )

    async def fake_read_audio(_audio):
        return np.full(16000 * 4, 0.1, dtype=np.float32)

    async def fake_features(_audio):
        return current_embedding, 0.8, "优秀", "声纹特征明显", [], []

    monkeypatch.setattr(app_speakers, "get_speaker_db", lambda: db)
    monkeypatch.setattr(app_speakers, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_speakers, "_read_audio", fake_read_audio)
    monkeypatch.setattr(app_speakers, "_voiceprint_features", fake_features)

    result = await app_speakers.supplement_app_speaker(
        "u7_legacy",
        audio=object(),
        capture_profile=app_speakers.CURRENT_CAPTURE_PROFILE,
        voiceprint_consent_accepted=True,
        voiceprint_consent_version=app_speakers.VOICEPRINT_CONSENT_VERSION,
        current_user={"id": 7},
    )

    stored = db.load_speaker_for_owner(7, "u7_legacy")
    assert result["profile_replaced"] is True
    assert stored["capture_profile"] == app_speakers.CURRENT_CAPTURE_PROFILE
    assert stored["sample_count"] == 1
    assert stored["embedding_count"] == 1
    np.testing.assert_allclose(stored["embedding"], current_embedding)


@pytest.mark.asyncio
async def test_same_capture_profile_rejects_a_different_voice(tmp_path: Path, monkeypatch):
    db = SpeakerDatabase(str(tmp_path / "speaker.db"))
    existing_embedding = _embedding(30)
    assert db.save_speaker(
        speaker_id="u7_current",
        embedding=existing_embedding,
        embedding_mean=existing_embedding,
        name="张三",
        owner_user_id=7,
        capture_profile=app_speakers.CURRENT_CAPTURE_PROFILE,
    )

    async def fake_read_audio(_audio):
        return np.full(16000 * 4, 0.1, dtype=np.float32)

    async def fake_features(_audio):
        return -existing_embedding, 0.8, "优秀", "声纹特征明显", [], []

    monkeypatch.setattr(app_speakers, "get_speaker_db", lambda: db)
    monkeypatch.setattr(app_speakers, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_speakers, "_read_audio", fake_read_audio)
    monkeypatch.setattr(app_speakers, "_voiceprint_features", fake_features)

    with pytest.raises(HTTPException) as rejected:
        await app_speakers.supplement_app_speaker(
            "u7_current",
            audio=object(),
            capture_profile=app_speakers.CURRENT_CAPTURE_PROFILE,
            voiceprint_consent_accepted=True,
            voiceprint_consent_version=app_speakers.VOICEPRINT_CONSENT_VERSION,
            current_user={"id": 7},
        )

    assert rejected.value.status_code == 400
    assert "同一人" in str(rejected.value.detail)
    assert db.load_speaker_for_owner(7, "u7_current")["sample_count"] == 1
