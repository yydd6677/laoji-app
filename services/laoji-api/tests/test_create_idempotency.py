import sqlite3

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meetings
from app.models import Base
from app.models.meeting import Meeting
from app.services import app_meeting_schema


@pytest.mark.asyncio
async def test_app_meeting_create_is_idempotent_per_user_and_rejects_payload_change(monkeypatch):
    monkeypatch.setattr(app_meetings, "_assert_user_meeting_writable", lambda _user_id: None)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with session_factory() as db:
            request = app_meetings.AppMeetingCreate(
                title="幂等会议",
                participants=["甲", "乙"],
                mode="realtime",
                client_request_id="meeting:test:1:abcdefghij",
            )
            first = await app_meetings.create_app_meeting(request, {"id": 7}, db)
            await db.commit()
            retry = await app_meetings.create_app_meeting(request, {"id": 7}, db)

            assert retry["id"] == first["id"]
            assert retry["client_request_id"] == request.client_request_id
            count = await db.scalar(
                select(func.count(Meeting.id)).where(
                    Meeting.user_id == 7,
                    Meeting.client_request_id == request.client_request_id,
                )
            )
            assert count == 1

            changed = request.model_copy(update={"title": "同键但不同标题"})
            with pytest.raises(HTTPException) as exc_info:
                await app_meetings.create_app_meeting(changed, {"id": 7}, db)
            assert exc_info.value.status_code == 409
    finally:
        await engine.dispose()


def test_existing_meeting_table_migration_adds_idempotency_column_and_unique_index(tmp_path, monkeypatch):
    db_path = tmp_path / "meeting.db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE meetings (id VARCHAR(36) PRIMARY KEY, user_id INTEGER)")
    conn.commit()
    conn.close()
    monkeypatch.setattr(
        app_meeting_schema.settings,
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{db_path}",
    )

    app_meeting_schema.ensure_app_meeting_schema()

    conn = sqlite3.connect(db_path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(meetings)")}
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(meetings)")}
        assert "client_request_id" in columns
        assert "idx_meetings_user_client_request" in indexes
    finally:
        conn.close()
