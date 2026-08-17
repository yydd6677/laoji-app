import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_manual_note import MeetingManualNote, MeetingManualNoteOperation


def mutation(content: str, local_revision: int, updated_at_ms: int):
    return app_meeting_v2.ManualNoteV2Upsert(
        schema_version=2,
        client_note_revision=local_revision,
        client_updated_at_ms=updated_at_ms,
        user_edited_at_ms=updated_at_ms,
        content=content,
    )


@pytest.mark.asyncio
async def test_manual_note_v2_create_replay_read_update_and_conflict(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()

            missing = await app_meeting_v2.get_meeting_manual_note_v2(
                "meeting-1", current_user={"id": 7}, db=db,
            )
            missing_body = json.loads(missing.body)
            assert missing.headers["etag"] == '"0"'
            assert missing_body["exists"] is False
            assert missing_body["content"] == ""

            created = await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("第一行\r\n第二行", 1, 1_784_900_000_000),
                idempotency_key="manual-note-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            created_body = json.loads(created.body)
            assert created.status_code == 201
            assert created_body["revision"] == 1
            assert created_body["content"] == "第一行\n第二行"

            replay = await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("第一行\r\n第二行", 1, 1_784_900_000_000),
                idempotency_key="manual-note-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == created_body
            assert replay.headers["x-idempotent-replay"] == "true"

            updated = await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("第一行\n第二行\n结论", 2, 1_784_900_000_001),
                idempotency_key="manual-note-update-2",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            updated_body = json.loads(updated.body)
            assert updated_body["revision"] == 2
            assert updated_body["client_note_revision"] == 2

            stale = await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("陈旧内容", 3, 1_784_900_000_002),
                idempotency_key="manual-note-stale-3",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["content"].endswith("结论")
            assert await db.scalar(select(func.count(MeetingManualNote.id))) == 1
            assert await db.scalar(select(func.count(MeetingManualNoteOperation.id))) == 2
            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["manual_notes_v2"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_manual_note_v2_never_overwrites_on_create_and_hides_foreign_meeting(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add_all([
                Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"),
                Meeting(id="meeting-2", user_id=8, app_owned=1, title="其他账号"),
            ])
            await db.commit()
            await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("原始内容", 1, 1_784_900_000_000),
                idempotency_key="manual-note-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            conflict = await app_meeting_v2.put_meeting_manual_note_v2(
                "meeting-1",
                mutation("不能覆盖", 2, 1_784_900_000_001),
                idempotency_key="manual-note-create-2",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            assert conflict.status_code == 412
            assert json.loads(conflict.body)["current"]["content"] == "原始内容"
            with pytest.raises(HTTPException) as forbidden:
                await app_meeting_v2.get_meeting_manual_note_v2(
                    "meeting-1", current_user={"id": 8}, db=db,
                )
            assert forbidden.value.status_code == 404
    finally:
        await engine.dispose()
