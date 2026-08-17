import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models import Base
from app.models.meeting import Meeting
from app.services import account_deletion_service as deletion
from app.services import laoji_auth_service as auth
from app.services.account_deletion_operator import complete_account_deletion_request


async def _database(tmp_path: Path, monkeypatch):
    meeting_path = tmp_path / "meetings.db"
    url = f"sqlite+aiosqlite:///{meeting_path}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    monkeypatch.setattr(settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    monkeypatch.setattr(deletion, "_summary_root", lambda: (tmp_path / "summaries").resolve())
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _prepare_account(tmp_path: Path, monkeypatch) -> tuple[dict, str, dict]:
    auth.close_auth_db()
    monkeypatch.setenv("LAOJI_DB_PATH", str(tmp_path / "schedule.db"))
    monkeypatch.setenv("LAOJI_AVATAR_DIR", str(tmp_path / "avatars"))
    user = auth.register_user("operator@example.com", "Password123", "operator")
    session = auth.create_session(int(user["id"]))
    request_id = auth.create_account_deletion_request(
        "operator@example.com",
        "verified-contact@example.com",
    )
    return user, request_id, session


@pytest.mark.asyncio
async def test_operator_completion_requires_identity_verification(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    user, request_id, _ = _prepare_account(tmp_path, monkeypatch)
    async with sessions() as db:
        with pytest.raises(ValueError, match="身份核验"):
            await complete_account_deletion_request(
                request_id,
                db,
                identity_verified=False,
            )
        assert (await db.execute(select(Meeting))).scalars().all() == []
    assert auth.get_user_by_id(int(user["id"])) is not None
    assert auth.get_account_deletion_request_status(request_id)["status"] == "pending"
    auth.close_auth_db()
    await engine.dispose()


@pytest.mark.asyncio
async def test_operator_failure_releases_request_for_retry(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    user, request_id, session = _prepare_account(tmp_path, monkeypatch)
    async with sessions() as db:
        db.add(
            Meeting(
                id="44444444-4444-4444-4444-444444444444",
                user_id=int(user["id"]),
                app_owned=1,
                title="active",
                status="recording",
            )
        )
        await db.commit()
        with pytest.raises(deletion.AccountDeletionConflict, match="正在录制"):
            await complete_account_deletion_request(
                request_id,
                db,
                identity_verified=True,
            )

    pending = auth.list_account_deletion_requests("pending")
    assert pending[0]["request_id"] == request_id
    assert "正在录制" in pending[0]["last_error"]
    assert auth.get_user_by_id(int(user["id"])) is not None
    assert auth.get_user_by_token(session["access_token"]) is not None
    auth.close_auth_db()
    await engine.dispose()


@pytest.mark.asyncio
async def test_operator_completion_deletes_cross_store_data_and_scrubs_request(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    user, request_id, _ = _prepare_account(tmp_path, monkeypatch)
    user_id = int(user["id"])
    audio_dir = tmp_path / "audio" / "app-meetings" / f"user-{user_id}"
    audio_dir.mkdir(parents=True)
    audio_path = audio_dir / "meeting.wav"
    audio_path.write_bytes(b"RIFF-test")

    schedule_conn = sqlite3.connect(tmp_path / "schedule.db")
    schedule_conn.execute("CREATE TABLE schedule_events (id INTEGER PRIMARY KEY, user_id INTEGER)")
    schedule_conn.execute("INSERT INTO schedule_events(user_id) VALUES (?)", (user_id,))
    schedule_conn.commit()
    schedule_conn.close()

    meeting_id = "55555555-5555-5555-5555-555555555555"
    async with sessions() as db:
        db.add(
            Meeting(
                id=meeting_id,
                user_id=user_id,
                app_owned=1,
                title="owned",
                status="ended",
                audio_path=str(audio_path),
            )
        )
        await db.commit()
        report = await complete_account_deletion_request(
            request_id,
            db,
            identity_verified=True,
        )
        assert report.events_deleted == 1
        assert report.meetings_deleted == 1
        assert report.sessions_deleted == 1
        assert report.cleanup_pending == 0
        assert (await db.execute(select(Meeting).where(Meeting.id == meeting_id))).scalar_one_or_none() is None

    assert not audio_dir.exists()
    assert auth.get_user_by_id(user_id) is None
    status = auth.get_account_deletion_request_status(request_id)
    assert status is not None
    assert status["status"] == "completed"
    completed = auth.list_account_deletion_requests("completed")
    assert completed[0]["account"] is None
    assert completed[0]["contact"] is None
    assert completed[0]["reason"] is None
    auth.close_auth_db()
    await engine.dispose()
