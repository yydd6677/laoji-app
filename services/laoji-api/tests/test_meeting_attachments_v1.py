import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_attachment_v1, app_meeting_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_attachment import (
    MeetingAttachmentOperationV1,
    MeetingAttachmentV1,
)


def text_attachment(content: str = "现场确认预算上限"):
    return app_attachment_v1.MeetingAttachmentV1Register(
        schema_version=1,
        client_attachment_id="local-attachment-1",
        position_ms=12_000,
        kind="text",
        text_content=content,
        client_created_at_ms=1_785_000_000_000,
        client_updated_at_ms=1_785_000_000_000,
    )


@pytest.mark.asyncio
async def test_attachment_register_replay_list_delete_and_scope(monkeypatch):
    monkeypatch.setattr(
        app_attachment_v1,
        "is_user_meeting_tombstoned",
        lambda _user_id: False,
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            await db.commit()

            created = await app_attachment_v1.post_meeting_attachment_v1(
                "meeting-1",
                text_attachment(),
                idempotency_key="attachment-register-0001",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            body = json.loads(created.body)
            assert created.status_code == 201
            assert body["kind"] == "text"
            assert body["lifecycle"] == "ready"
            assert body["revision"] == 1

            replay = await app_attachment_v1.post_meeting_attachment_v1(
                "meeting-1",
                text_attachment(),
                idempotency_key="attachment-register-0001",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == body

            listed = await app_attachment_v1.get_meeting_attachments_v1(
                "meeting-1",
                current_user={"id": 7},
                db=db,
            )
            assert listed["items"] == [body]
            with pytest.raises(HTTPException) as hidden:
                await app_attachment_v1.get_meeting_attachments_v1(
                    "meeting-1",
                    current_user={"id": 8},
                    db=db,
                )
            assert hidden.value.status_code == 404

            stale = await app_attachment_v1.delete_meeting_attachment_v1(
                body["id"],
                if_match='"2"',
                idempotency_key="attachment-delete-stale-0001",
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["lifecycle"] == "ready"

            deleted = await app_attachment_v1.delete_meeting_attachment_v1(
                body["id"],
                if_match='"1"',
                idempotency_key="attachment-delete-0001",
                current_user={"id": 7},
                db=db,
            )
            deleted_body = json.loads(deleted.body)
            assert deleted_body["lifecycle"] == "deleted"
            assert deleted_body["revision"] == 2
            assert await db.scalar(select(func.count(MeetingAttachmentV1.id))) == 1
            assert await db.scalar(
                select(func.count(MeetingAttachmentOperationV1.id))
            ) == 2
            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["meeting_attachments_v1"] is True
            assert capabilities["summary_attachments_image"] is False
    finally:
        await engine.dispose()
