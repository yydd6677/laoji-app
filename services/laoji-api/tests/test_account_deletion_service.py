from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models import Base
from app.models.meeting import Meeting, MeetingSegment
from app.models.summary import FinalSummary
from app.models.transcript import TranscriptLine
from app.services import account_deletion_service as deletion


async def _database(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "meetings.db"
    url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    monkeypatch.setattr(settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    monkeypatch.setattr(deletion, "_summary_root", lambda: (tmp_path / "summaries").resolve())
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_meeting_deletion_removes_owned_rows_files_and_retains_tombstone(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    owned_id = "11111111-1111-1111-1111-111111111111"
    other_id = "22222222-2222-2222-2222-222222222222"
    operation_id = "owned-delete-operation"
    owned_dir = tmp_path / "audio" / "app-meetings" / "user-7"
    owned_dir.mkdir(parents=True)
    audio = owned_dir / "recording.wav"
    segment_audio = owned_dir / "segment.wav"
    audio.write_bytes(b"RIFF-owned")
    segment_audio.write_bytes(b"RIFF-segment")
    other_dir = tmp_path / "audio" / "app-meetings" / "user-8"
    other_dir.mkdir(parents=True)
    other_audio = other_dir / "other.wav"
    other_audio.write_bytes(b"RIFF-other")

    final_dir = tmp_path / "summaries" / "final"
    final_dir.mkdir(parents=True)
    full_summary = final_dir / f"final_{owned_id}_20260711.json"
    legacy_summary = final_dir / f"final_{owned_id[:8]}_20260710.md"
    full_summary.write_text("owned", encoding="utf-8")
    legacy_summary.write_text("owned legacy", encoding="utf-8")

    async with sessions() as db:
        db.add_all([
            Meeting(
                id=owned_id,
                user_id=7,
                app_owned=1,
                title="owned",
                status="completed",
                audio_path=str(audio),
            ),
            Meeting(
                id=other_id,
                user_id=8,
                app_owned=1,
                title="other",
                status="completed",
                audio_path=str(other_audio),
            ),
            MeetingSegment(
                id="segment-owned",
                meeting_id=owned_id,
                audio_path=str(segment_audio),
                start_time=0,
                end_time=1,
            ),
            TranscriptLine(
                id="line-owned",
                meeting_id=owned_id,
                speaker_id="speaker",
                speaker_label="发言人",
                text="需要删除",
                start_time=0,
                end_time=1,
                confidence=0.9,
            ),
            FinalSummary(
                id="summary-owned",
                meeting_id=owned_id,
                overview="需要删除",
                key_decisions_json="[]",
                action_items_json="[]",
            ),
        ])
        await db.commit()

        await deletion.begin_user_meeting_deletion(7, db, operation_id)
        report = await deletion.delete_user_meeting_data(7, db, operation_id)
        assert report.meetings_deleted == 1
        assert report.meeting_ids == (owned_id,)
        assert (await db.execute(select(Meeting).where(Meeting.id == owned_id))).scalar_one_or_none() is None
        assert (await db.execute(select(Meeting).where(Meeting.id == other_id))).scalar_one() is not None
        assert (await db.execute(select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == owned_id))).scalar() == 0
        assert (await db.execute(select(func.count(FinalSummary.id)).where(FinalSummary.meeting_id == owned_id))).scalar() == 0
        tombstone = (
            await db.execute(
                text("SELECT user_id, cleaned_at FROM laoji_meeting_deletion_tombstones WHERE meeting_id = :id"),
                {"id": owned_id},
            )
        ).one()
        assert tombstone.user_id == 7
        assert tombstone.cleaned_at is None

        assert not owned_dir.exists()
        assert not full_summary.exists()
        assert not legacy_summary.exists()
        assert other_audio.exists()
        assert deletion.is_meeting_tombstoned(owned_id)

        await deletion.finalize_user_meeting_deletion(7, db, operation_id)
        finalized = (
            await db.execute(
                text("SELECT user_id, artifact_paths_json, cleaned_at FROM laoji_meeting_deletion_tombstones WHERE meeting_id = :id"),
                {"id": owned_id},
            )
        ).one()
        assert finalized.user_id is None
        assert finalized.artifact_paths_json == "[]"
        assert finalized.cleaned_at is not None

    await engine.dispose()


@pytest.mark.asyncio
async def test_meeting_deletion_rejects_active_recording_without_mutation(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    meeting_id = "33333333-3333-3333-3333-333333333333"
    operation_id = "active-delete-operation"
    async with sessions() as db:
        db.add(Meeting(id=meeting_id, user_id=9, app_owned=1, title="active", status="recording"))
        await db.commit()
        await deletion.begin_user_meeting_deletion(9, db, operation_id)
        with pytest.raises(deletion.AccountDeletionConflict, match="正在录制"):
            await deletion.delete_user_meeting_data(9, db, operation_id)
        assert (await db.execute(select(Meeting).where(Meeting.id == meeting_id))).scalar_one() is not None
        tables = (
            await db.execute(
                text("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='laoji_meeting_deletion_tombstones'")
            )
        ).scalar()
        assert tables == 1
        count = (await db.execute(text("SELECT COUNT(*) FROM laoji_meeting_deletion_tombstones"))).scalar()
        assert count == 0
        await deletion.cancel_user_meeting_deletion(9, db, operation_id)
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_summary_prefix_collision_blocks_deletion(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    first = "abcdef12-1111-1111-1111-111111111111"
    second = "abcdef12-2222-2222-2222-222222222222"
    operation_id = "collision-delete-operation"
    async with sessions() as db:
        db.add_all([
            Meeting(id=first, user_id=10, app_owned=1, title="first", status="completed"),
            Meeting(id=second, user_id=11, app_owned=1, title="second", status="completed"),
        ])
        await db.commit()
        await deletion.begin_user_meeting_deletion(10, db, operation_id)
        with pytest.raises(deletion.AccountDeletionConflict, match="前缀冲突"):
            await deletion.delete_user_meeting_data(10, db, operation_id)
        assert (await db.execute(select(func.count(Meeting.id)))).scalar() == 2
        await deletion.cancel_user_meeting_deletion(10, db, operation_id)
    await engine.dispose()


@pytest.mark.asyncio
async def test_user_deletion_guard_blocks_new_and_updated_app_meetings(tmp_path, monkeypatch):
    engine, sessions = await _database(tmp_path, monkeypatch)
    existing_id = "66666666-6666-6666-6666-666666666666"
    async with sessions() as db:
        db.add(
            Meeting(
                id=existing_id,
                user_id=12,
                app_owned=1,
                title="existing",
                status="ended",
            )
        )
        await db.commit()

        operation_id = "guard-owner-operation"
        await deletion.begin_user_meeting_deletion(12, db, operation_id)
        assert deletion.is_user_meeting_tombstoned(12)
        with pytest.raises(deletion.AccountDeletionConflict, match="另一项"):
            await deletion.begin_user_meeting_deletion(12, db, "competing-operation")
        await deletion.cancel_user_meeting_deletion(12, db, "competing-operation")
        assert deletion.is_user_meeting_tombstoned(12)

        db.add(
            Meeting(
                id="77777777-7777-7777-7777-777777777777",
                user_id=12,
                app_owned=1,
                title="late insert",
                status="created",
            )
        )
        with pytest.raises(IntegrityError, match="account deletion in progress"):
            await db.commit()
        await db.rollback()

        existing = (
            await db.execute(select(Meeting).where(Meeting.id == existing_id))
        ).scalar_one()
        existing.title = "late update"
        with pytest.raises(IntegrityError, match="account deletion in progress"):
            await db.commit()
        await db.rollback()

        await deletion.cancel_user_meeting_deletion(12, db, operation_id)
        assert not deletion.is_user_meeting_tombstoned(12)
        db.add(
            Meeting(
                id="88888888-8888-8888-8888-888888888888",
                user_id=12,
                app_owned=1,
                title="after cancel",
                status="created",
            )
        )
        await db.commit()

        finalized_operation = "finalized-guard-operation"
        await deletion.begin_user_meeting_deletion(13, db, finalized_operation)
        await deletion.finalize_user_deletion_guard(13, db, finalized_operation)
        assert deletion.is_user_meeting_tombstoned(13)
        db.add(
            Meeting(
                id="99999999-9999-9999-9999-999999999999",
                user_id=13,
                app_owned=1,
                title="after finalized deletion",
                status="created",
            )
        )
        with pytest.raises(IntegrityError, match="account deletion in progress"):
            await db.commit()
        await db.rollback()

    await engine.dispose()
