import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_occurrence import (
    MeetingOccurrenceLink,
    MeetingOccurrenceOperation,
    MeetingScheduleSnapshotV2,
)


def mutation(
    *,
    source_event_id: str = "calendar-event-42",
    occurrence_date: str = "2026-07-24",
    link_state: str = "active",
    updated_at_ms: int = 1_785_000_000_000,
    title: str = "项目同步",
):
    return app_meeting_v2.OccurrenceLinkV2Upsert(
        schema_version=2,
        source_event_id=source_event_id,
        occurrence_date=occurrence_date,
        calendar_revision=7,
        recurrence_segment_id="segment-1",
        series_key="user:7:calendar-event-42",
        link_state=link_state,
        client_updated_at_ms=updated_at_ms,
        schedule_snapshot={
            "event_title": title,
            "planned_start_ms": 1_785_000_100_000,
            "planned_end_ms": 1_785_003_700_000,
            "all_day": False,
            "timezone_id": "Asia/Shanghai",
            "location": "会议室 A",
            "participants": ["张三", "李四"],
            "description": "周会",
            "captured_event_revision": 7,
            "captured_at_ms": 1_785_000_000_000,
        },
    )


@pytest.mark.asyncio
async def test_occurrence_v2_create_replay_lookup_update_and_conflict(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add_all([
                Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"),
                Meeting(id="meeting-2", user_id=7, app_owned=1, title="重复创建"),
            ])
            await db.commit()

            created = await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-1",
                mutation(),
                idempotency_key="occurrence-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            created_body = json.loads(created.body)
            assert created.status_code == 201
            assert created_body["meeting_id"] == "meeting-1"
            assert created_body["revision"] == 1
            assert created_body["schedule_snapshot"]["event_title"] == "项目同步"

            replay = await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-1",
                mutation(),
                idempotency_key="occurrence-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == created_body
            assert replay.headers["x-idempotent-replay"] == "true"

            lookup = await app_meeting_v2.get_occurrence_binding_v2(
                source_event_id="calendar-event-42",
                occurrence_date="2026-07-24",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(lookup.body)["meeting_id"] == "meeting-1"

            duplicate = await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-2",
                mutation(),
                idempotency_key="occurrence-create-2",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            assert duplicate.status_code == 409
            duplicate_body = json.loads(duplicate.body)
            assert duplicate_body["error"]["code"] == "occurrence_already_bound"
            assert duplicate_body["current"]["meeting_id"] == "meeting-1"

            updated = await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-1",
                mutation(link_state="orphaned", updated_at_ms=1_785_000_000_001),
                idempotency_key="occurrence-update-1",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            updated_body = json.loads(updated.body)
            assert updated_body["revision"] == 2
            assert updated_body["link_state"] == "orphaned"
            assert await db.scalar(select(func.count(MeetingOccurrenceLink.id))) == 1
            assert await db.scalar(select(func.count(MeetingScheduleSnapshotV2.id))) == 1
            assert await db.scalar(select(func.count(MeetingOccurrenceOperation.id))) == 2
            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["occurrence_links_v2"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_occurrence_v2_keeps_snapshot_immutable_and_hides_foreign_meeting(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()
            await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-1",
                mutation(),
                idempotency_key="occurrence-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()

            immutable = await app_meeting_v2.put_meeting_occurrence_v2(
                "meeting-1",
                mutation(title="被修改的计划", updated_at_ms=1_785_000_000_001),
                idempotency_key="occurrence-update-immutable",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            assert immutable.status_code == 409
            assert json.loads(immutable.body)["error"]["code"] == "schedule_snapshot_immutable"

            with pytest.raises(HTTPException) as hidden:
                await app_meeting_v2.get_meeting_occurrence_v2(
                    "meeting-1",
                    current_user={"id": 8},
                    db=db,
                )
            assert hidden.value.status_code == 404
            foreign_lookup = await app_meeting_v2.get_occurrence_binding_v2(
                source_event_id="calendar-event-42",
                occurrence_date="2026-07-24",
                current_user={"id": 8},
                db=db,
            )
            assert json.loads(foreign_lookup.body)["exists"] is False
    finally:
        await engine.dispose()
