import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_action import MeetingActionItem, MeetingActionOperation


def mutation(
    content: str,
    remote_id: str | None = None,
    action_id: str = "action-local-1",
    updated_at_ms: int = 1_784_900_000_000,
):
    return app_meeting_v2.ActionItemV2Upsert(
        schema_version=2,
        client_action_id=action_id,
        remote_id=remote_id,
        client_created_at_ms=1_784_899_000_000,
        client_updated_at_ms=updated_at_ms,
        user_edited_at_ms=updated_at_ms,
        completed_at_ms=None,
        content=content,
        status="pending",
        assignee="小陈",
        due_at_ms=None,
        reminder_at_ms=None,
        followup_event_source_id=None,
        source_kind="manual",
        source_summary_version_id=None,
        source_segment_id=None,
        source_start_ms=None,
        generation_fingerprint=None,
    )


@pytest.mark.asyncio
async def test_action_v2_create_replay_update_and_stale_conflict(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()

            created = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                mutation("整理验收清单"),
                idempotency_key="operation-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            created_body = json.loads(created.body)
            assert created.status_code == 201
            assert created.headers["etag"] == '"1"'
            assert created_body["client_action_id"] == "action-local-1"
            assert created_body["revision"] == 1
            assert created_body["client_created_at_ms"] == 1_784_899_000_000
            assert created_body["user_edited_at_ms"] == 1_784_900_000_000

            replay = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                mutation("整理验收清单"),
                idempotency_key="operation-create-1",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == created_body
            assert replay.headers["x-idempotent-replay"] == "true"

            updated = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                mutation(
                    "整理验收清单并发给项目组",
                    created_body["id"],
                    updated_at_ms=1_784_900_000_001,
                ),
                idempotency_key="operation-update-2",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            updated_body = json.loads(updated.body)
            assert updated.status_code == 200
            assert updated_body["revision"] == 2
            assert updated_body["content"] == "整理验收清单并发给项目组"

            stale = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                mutation("陈旧修改", created_body["id"], updated_at_ms=1_784_900_000_002),
                idempotency_key="operation-stale-3",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["revision"] == 2
            assert await db.scalar(select(func.count(MeetingActionItem.id))) == 1
            assert await db.scalar(select(func.count(MeetingActionOperation.id))) == 2
            assert (await app_meeting_v2.get_laoji_capabilities(db))["action_items_v2"] is True
            assert (await app_meeting_v2.get_laoji_capabilities(db))["action_items_pull_v2"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_action_v2_meeting_list_cursor_is_owned_and_observes_later_updates(monkeypatch):
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

            created = {}
            for index in (1, 2):
                action_id = f"action-local-{index}"
                response = await app_meeting_v2.put_meeting_action_v2(
                    "meeting-1",
                    action_id,
                    mutation(f"任务 {index}", action_id=action_id),
                    idempotency_key=f"operation-create-{index}",
                    if_match=None,
                    if_none_match="*",
                    current_user={"id": 7},
                    db=db,
                )
                created[action_id] = json.loads(response.body)
            await db.commit()

            first = await app_meeting_v2.get_meeting_actions_v2(
                "meeting-1", cursor=None, limit=1, current_user={"id": 7}, db=db,
            )
            assert first["schema_version"] == 2
            assert first["meeting_id"] == "meeting-1"
            assert len(first["items"]) == 1
            assert first["has_more"] is True
            assert isinstance(first["next_cursor"], str)

            second = await app_meeting_v2.get_meeting_actions_v2(
                "meeting-1",
                cursor=first["next_cursor"],
                limit=1,
                current_user={"id": 7},
                db=db,
            )
            assert second["has_more"] is False
            assert {first["items"][0]["client_action_id"], second["items"][0]["client_action_id"]} == {
                "action-local-1", "action-local-2",
            }

            updated = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                mutation(
                    "任务 1 已更新",
                    created["action-local-1"]["id"],
                    updated_at_ms=1_784_900_000_001,
                ),
                idempotency_key="operation-update-after-cursor",
                if_match='"1"',
                if_none_match=None,
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert json.loads(updated.body)["revision"] == 2

            delta = await app_meeting_v2.get_meeting_actions_v2(
                "meeting-1",
                cursor=second["next_cursor"],
                limit=100,
                current_user={"id": 7},
                db=db,
            )
            assert [(item["client_action_id"], item["revision"]) for item in delta["items"]] == [
                ("action-local-1", 2),
            ]
            assert delta["has_more"] is False

            with pytest.raises(HTTPException) as forbidden:
                await app_meeting_v2.get_meeting_actions_v2(
                    "meeting-1", cursor=None, limit=100, current_user={"id": 8}, db=db,
                )
            assert forbidden.value.status_code == 404
            with pytest.raises(HTTPException) as invalid_cursor:
                await app_meeting_v2.get_meeting_actions_v2(
                    "meeting-1", cursor="not-a-real-cursor", limit=100,
                    current_user={"id": 7}, db=db,
                )
            assert invalid_cursor.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_action_v2_if_none_match_never_overwrites_existing_action(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()
            await app_meeting_v2.put_meeting_action_v2(
                "meeting-1", "action-local-1", mutation("原内容"),
                idempotency_key="operation-create-1", if_match=None, if_none_match="*",
                current_user={"id": 7}, db=db,
            )
            await db.commit()
            conflict = await app_meeting_v2.put_meeting_action_v2(
                "meeting-1", "action-local-1", mutation("不能覆盖"),
                idempotency_key="operation-create-2", if_match=None, if_none_match="*",
                current_user={"id": 7}, db=db,
            )
            assert conflict.status_code == 412
            assert json.loads(conflict.body)["current"]["content"] == "原内容"
    finally:
        await engine.dispose()
