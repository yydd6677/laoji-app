import json
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_action_share import MeetingActionCollaborationEvent


def action_mutation():
    return app_meeting_v2.ActionItemV2Upsert(
        schema_version=2,
        client_action_id="action-local-1",
        remote_id=None,
        client_created_at_ms=1_784_899_000_000,
        client_updated_at_ms=1_784_900_000_000,
        user_edited_at_ms=1_784_900_000_000,
        completed_at_ms=None,
        content="确认交付范围",
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
async def test_action_collaboration_is_action_only_revisioned_and_revocable(monkeypatch):
    monkeypatch.setattr(app_meeting_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setenv("LAOJI_ACTION_SHARE_SECRET", "test-only-action-share-secret-32-bytes-minimum")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()
            await app_meeting_v2.put_meeting_action_v2(
                "meeting-1",
                "action-local-1",
                action_mutation(),
                idempotency_key="operation-action-create",
                if_match=None,
                if_none_match="*",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()

            created = await app_meeting_v2.post_meeting_action_share_v1(
                "meeting-1",
                "action-local-1",
                app_meeting_v2.ActionShareV1Create(
                    schema_version=1,
                    client_share_id="share-local-editor",
                    permission="action_editor",
                ),
                idempotency_key="operation-share-create",
                if_match='"1"',
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            created_body = json.loads(created.body)
            assert created.status_code == 201
            assert created_body["permission"] == "action_editor"
            token = parse_qs(urlparse(created_body["invite_url"]).query)["token"][0]

            opened = await app_meeting_v2.get_shared_action_v1(token, db=db)
            opened_body = json.loads(opened.body)
            assert set(opened_body) == {
                "schema_version", "share_id", "share_revision", "permission", "status", "action",
            }
            assert set(opened_body["action"]) == {
                "id", "revision", "content", "status", "assignee", "due_at_ms",
                "updated_at_ms", "actor_label",
            }
            serialized = json.dumps(opened_body).lower()
            assert "meeting_id" not in serialized
            assert "transcript" not in serialized

            updated = await app_meeting_v2.put_shared_action_v1(
                token,
                app_meeting_v2.SharedActionV1Update(
                    schema_version=1,
                    actor_id="device-collaborator-0001",
                    status="completed",
                    assignee="王芳",
                    due_at_ms=1_785_000_000_000,
                ),
                idempotency_key="operation-collaborator-update",
                if_match='"1"',
                db=db,
            )
            await db.commit()
            updated_body = json.loads(updated.body)
            assert updated_body["action"]["revision"] == 2
            assert updated_body["action"]["status"] == "completed"
            assert updated_body["action"]["assignee"] == "王芳"
            assert await db.scalar(select(func.count(MeetingActionCollaborationEvent.id))) == 1

            stale = await app_meeting_v2.put_shared_action_v1(
                token,
                app_meeting_v2.SharedActionV1Update(
                    schema_version=1,
                    actor_id="device-collaborator-0001",
                    status="pending",
                    assignee="小陈",
                    due_at_ms=None,
                ),
                idempotency_key="operation-collaborator-stale",
                if_match='"1"',
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["revision"] == 2

            revoked = await app_meeting_v2.delete_meeting_action_share_v1(
                "meeting-1",
                "action-local-1",
                "share-local-editor",
                idempotency_key="operation-share-revoke",
                if_match='"1"',
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert json.loads(revoked.body)["status"] == "revoked"
            with pytest.raises(HTTPException) as gone:
                await app_meeting_v2.get_shared_action_v1(token, db=db)
            assert gone.value.status_code == 410
            assert (await app_meeting_v2.get_laoji_capabilities(db))["action_collaboration_v1"] is True
    finally:
        await engine.dispose()
