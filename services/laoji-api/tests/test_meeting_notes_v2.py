import json
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2, app_meetings
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_note_root import MeetingNoteRootOperationV2, MeetingNoteRootV2
from app.models.meeting_occurrence import MeetingOccurrenceLink


def calendar_meeting(client_note_id: str, source_event_id: str = "event-42"):
    return app_meeting_v2.MeetingNoteV2Create(
        schema_version=2,
        client_note_id=client_note_id,
        client_request_id=client_note_id,
        origin="calendar",
        entry_point="calendar_detail",
        title="",
        description=None,
        participants=["张三", "李四"],
        location="会议室 A",
        mode="realtime",
        recorded_at="2026-07-25T06:30:00Z",
        occurrence_ref={
            "source_event_id": source_event_id,
            "occurrence_date": "2026-07-25",
            "calendar_revision": 8,
            "recurrence_segment_id": "segment-1",
            "series_key": f"calendar:user:7:{source_event_id}",
        },
        schedule_snapshot={
            "event_title": "项目同步",
            "planned_start_ms": 1_785_000_100_000,
            "planned_end_ms": 1_785_003_700_000,
            "all_day": False,
            "timezone_id": "Asia/Shanghai",
            "location": "会议室 A",
            "participants": ["张三", "李四"],
            "description": "周会",
            "captured_event_revision": 8,
            "captured_at_ms": 1_785_000_000_000,
        },
    )


@pytest.mark.asyncio
async def test_meeting_note_v2_root_replay_conflict_cursor_tombstone_and_legacy_bridge(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_meetings, "_assert_user_meeting_writable", lambda _user_id: None)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            created = await app_meeting_v2.post_meeting_note_v2(
                calendar_meeting("local-note-1"),
                idempotency_key="meeting-create-1",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            created_body = json.loads(created.body)
            meeting_id = created_body["id"]
            assert created.status_code == 201
            assert created_body["client_note_id"] == "local-note-1"
            assert created_body["title"] == ""
            assert created_body["revision"] == 1
            assert created_body["occurrence_ref"]["source_event_id"] == "event-42"
            assert len(created_body["processing_stages"]) == 5

            replay = await app_meeting_v2.post_meeting_note_v2(
                calendar_meeting("local-note-1"),
                idempotency_key="meeting-create-1",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == created_body

            duplicate = await app_meeting_v2.post_meeting_note_v2(
                calendar_meeting("local-note-2"),
                idempotency_key="meeting-create-2",
                current_user={"id": 7},
                db=db,
            )
            assert duplicate.status_code == 409
            duplicate_body = json.loads(duplicate.body)
            assert duplicate_body["error"]["code"] == "occurrence_already_bound"
            assert duplicate_body["current"]["id"] == meeting_id

            updated = await app_meeting_v2.patch_meeting_note_v2(
                meeting_id,
                app_meeting_v2.MeetingNoteV2Update(schema_version=2, title="项目同步记录"),
                if_match='"1"',
                idempotency_key="meeting-update-1",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            updated_body = json.loads(updated.body)
            assert updated_body["revision"] == 2
            assert updated_body["title"] == "项目同步记录"

            stale = await app_meeting_v2.patch_meeting_note_v2(
                meeting_id,
                app_meeting_v2.MeetingNoteV2Update(schema_version=2, title="陈旧写入"),
                if_match='"1"',
                idempotency_key="meeting-update-stale",
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["revision"] == 2

            first_page = await app_meeting_v2.list_meeting_notes_v2(
                cursor=None,
                limit=1,
                current_user={"id": 7},
                db=db,
            )
            assert first_page["items"][0]["id"] == meeting_id
            assert first_page["next_cursor"]

            deleted = await app_meeting_v2.delete_meeting_note_v2(
                meeting_id,
                if_match='"2"',
                idempotency_key="meeting-delete-1",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            deleted_body = json.loads(deleted.body)
            assert deleted_body["revision"] == 3
            assert deleted_body["lifecycle"] == "deleted"
            assert deleted_body["deleted_at"] is not None

            tombstone = await app_meeting_v2.get_meeting_note_v2(
                meeting_id,
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(tombstone.body)["lifecycle"] == "deleted"
            with pytest.raises(HTTPException) as hidden_child:
                await app_meeting_v2.get_meeting_occurrence_v2(
                    meeting_id,
                    current_user={"id": 7},
                    db=db,
                )
            assert hidden_child.value.status_code == 404

            restored = await app_meeting_v2.restore_meeting_note_v2(
                meeting_id,
                if_match='"3"',
                idempotency_key="meeting-restore-1",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            restored_body = json.loads(restored.body)
            assert restored_body["revision"] == 4
            assert restored_body["lifecycle"] == "active"
            assert restored_body["deleted_at"] is None
            restored_replay = await app_meeting_v2.restore_meeting_note_v2(
                meeting_id,
                if_match='"4"',
                idempotency_key="meeting-restore-1",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(restored_replay.body) == restored_body
            restored_occurrence = await app_meeting_v2.get_meeting_occurrence_v2(
                meeting_id,
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(restored_occurrence.body)["source_event_id"] == "event-42"

            deleted_again = await app_meeting_v2.delete_meeting_note_v2(
                meeting_id,
                if_match='"4"',
                idempotency_key="meeting-delete-2",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert json.loads(deleted_again.body)["revision"] == 5
            deleted_root = await db.get(MeetingNoteRootV2, meeting_id)
            assert deleted_root is not None
            deleted_root.deleted_at = datetime.utcnow() - timedelta(days=31)
            await db.commit()
            expired_restore = await app_meeting_v2.restore_meeting_note_v2(
                meeting_id,
                if_match='"5"',
                idempotency_key="meeting-restore-expired",
                current_user={"id": 7},
                db=db,
            )
            assert expired_restore.status_code == 409
            assert json.loads(expired_restore.body)["error"]["code"] == "restore_window_expired"

            legacy = await app_meetings.create_app_meeting(
                app_meetings.AppMeetingCreate(
                    title="旧接口会议",
                    client_request_id="legacy-meeting-abcdefgh",
                ),
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            legacy_root = await db.scalar(select(MeetingNoteRootV2).where(
                MeetingNoteRootV2.meeting_id == legacy["id"],
            ))
            assert legacy_root is not None
            changed_legacy = await app_meetings.update_app_meeting(
                legacy["id"],
                app_meetings.AppMeetingUpdate(title="旧接口已修改"),
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            await db.refresh(legacy_root)
            assert changed_legacy["title"] == "旧接口已修改"
            assert legacy_root.revision == 2
            await app_meetings.delete_app_meeting(
                legacy["id"],
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            await db.refresh(legacy_root)
            assert legacy_root.revision == 3
            assert legacy_root.lifecycle == "deleted"
            legacy_list = await app_meetings.list_app_meetings(
                page=1,
                size=50,
                current_user={"id": 7},
                db=db,
            )
            assert legacy_list["items"] == []
            assert await db.scalar(select(func.count(Meeting.id))) == 2
            assert await db.scalar(select(func.count(MeetingNoteRootV2.meeting_id))) == 2
            assert await db.scalar(select(func.count(MeetingNoteRootOperationV2.id))) == 5

            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["meeting_notes_v2"] is True
            assert capabilities["sync_cursor"] is False
            assert capabilities["soft_delete_days"] == 30
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_deleted_calendar_meeting_can_be_superseded_without_losing_tombstone(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            created = await app_meeting_v2.post_meeting_note_v2(
                calendar_meeting("local-note-old"),
                idempotency_key="meeting-create-old",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            old_id = json.loads(created.body)["id"]
            deleted = await app_meeting_v2.delete_meeting_note_v2(
                old_id,
                if_match='"1"',
                idempotency_key="meeting-delete-old",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert json.loads(deleted.body)["lifecycle"] == "deleted"

            replacement_request = calendar_meeting("local-note-new").model_copy(
                update={"supersedes_meeting_id": old_id},
            )
            replacement = await app_meeting_v2.post_meeting_note_v2(
                replacement_request,
                idempotency_key="meeting-create-replacement",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            replacement_body = json.loads(replacement.body)
            new_id = replacement_body["id"]
            assert replacement.status_code == 201
            assert new_id != old_id
            assert replacement_body["occurrence_ref"]["source_event_id"] == "event-42"
            assert replacement_body["occurrence_ref"]["revision"] == 2

            link = await db.scalar(select(MeetingOccurrenceLink).where(
                MeetingOccurrenceLink.user_id == 7,
                MeetingOccurrenceLink.source_event_id == "event-42",
                MeetingOccurrenceLink.occurrence_date == "2026-07-25",
            ))
            assert link is not None
            assert link.meeting_id == new_id
            old_tombstone = await app_meeting_v2.get_meeting_note_v2(
                old_id,
                current_user={"id": 7},
                db=db,
            )
            old_body = json.loads(old_tombstone.body)
            assert old_body["lifecycle"] == "deleted"
            assert old_body["revision"] == 3
            assert old_body["occurrence_ref"] is None
            assert old_body["schedule_snapshot"] is None

            restore = await app_meeting_v2.restore_meeting_note_v2(
                old_id,
                if_match='"3"',
                idempotency_key="meeting-restore-superseded",
                current_user={"id": 7},
                db=db,
            )
            assert restore.status_code == 409
            assert json.loads(restore.body)["error"]["code"] == "occurrence_superseded"

            mismatched = await app_meeting_v2.post_meeting_note_v2(
                calendar_meeting("local-note-mismatch"),
                idempotency_key="meeting-create-mismatch",
                current_user={"id": 7},
                db=db,
            )
            assert mismatched.status_code == 409
            assert json.loads(mismatched.body)["error"]["code"] == "occurrence_already_bound"
    finally:
        await engine.dispose()
