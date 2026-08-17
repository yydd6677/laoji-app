import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2, app_summary_v1
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_summary_sync import (
    MeetingSummaryCurrentV1,
    MeetingSummaryOperationV1,
    MeetingSummarySectionStateV1,
    MeetingSummaryVersionV1,
)
from app.models.summary import FinalSummary
from app.services import meeting_summary_sync_service


def document(meeting_id: str, version_id: str, content: str) -> dict:
    section_id = f"{version_id}:section:overview"
    return {
        "schema_version": 2,
        "version_id": version_id,
        "meeting_id": meeting_id,
        "template_id": "general",
        "template_revision": 1,
        "status": "ready",
        "generated_by": "test",
        "generated_at": "2026-07-29T00:00:00Z",
        "sections": [
            {
                "id": section_id,
                "key": "overview",
                "kind": "paragraph",
                "title": "概述",
                "content": content,
                "citations": [
                    {
                        "id": f"{section_id}:citation:0",
                        "segment_id": "segment-1",
                        "start_ms": 0,
                        "end_ms": 1000,
                        "quote_hash": "sha256:" + "1" * 64,
                    }
                ],
            }
        ],
        "action_item_candidates": [],
    }


def override(user_text: str | None, visible: list[str], updated_at_ms: int):
    return app_summary_v1.SummarySectionOverrideV1(
        schema_version=1,
        user_text=user_text,
        visible_citation_ids=visible,
        client_updated_at_ms=updated_at_ms,
    )


def test_legacy_summary_projection_uses_current_template_revision():
    summary = FinalSummary(
        id="legacy-summary-1",
        meeting_id="legacy-meeting-1",
        overview="历史整理内容",
        key_decisions_json="[]",
        action_items_json="[]",
        generated_at=datetime(2026, 7, 28, 0, 0, 0),
    )

    payload = meeting_summary_sync_service._summary_document(summary)

    assert payload["template_id"] == "general"
    assert payload["template_revision"] == 2
    assert payload["sections"]


@pytest.mark.asyncio
async def test_summary_versions_override_replay_conflict_and_protected_candidate(monkeypatch):
    monkeypatch.setattr(app_summary_v1, "is_user_meeting_tombstoned", lambda _user_id: False)
    documents: dict[str, dict] = {}
    monkeypatch.setattr(
        meeting_summary_sync_service,
        "_summary_document",
        lambda summary: documents[summary.id],
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            generated_at = datetime(2026, 7, 29, 0, 0, 0)
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="项目同步"))
            first = FinalSummary(
                id="summary-1",
                meeting_id="meeting-1",
                overview="生成内容一",
                key_decisions_json="[]",
                action_items_json="[]",
                generated_at=generated_at,
            )
            documents[first.id] = document(first.meeting_id, first.id, "生成内容一")
            db.add(first)
            await db.commit()

            catalog = await app_summary_v1.get_summary_versions_v1(
                "meeting-1", current_user={"id": 7}, db=db,
            )
            await db.commit()
            assert catalog["current"]["version_id"] == "summary-1"
            assert catalog["current"]["revision"] == 1
            section = catalog["items"][0]["sections"][0]
            citation_id = section["visible_citation_ids"][0]

            edited = await app_summary_v1.put_summary_section_override_v1(
                "summary-1",
                section["section_id"],
                override("人工修改", [], 1_785_283_200_000),
                if_match='"1"',
                idempotency_key="summary-section-edit-0001",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            edited_body = json.loads(edited.body)
            assert edited_body["revision"] == 2
            assert edited_body["user_text"] == "人工修改"
            assert edited_body["visible_citation_ids"] == []

            replay = await app_summary_v1.put_summary_section_override_v1(
                "summary-1",
                section["section_id"],
                override("人工修改", [], 1_785_283_200_000),
                if_match='"1"',
                idempotency_key="summary-section-edit-0001",
                current_user={"id": 7},
                db=db,
            )
            assert json.loads(replay.body) == edited_body

            stale = await app_summary_v1.put_summary_section_override_v1(
                "summary-1",
                section["section_id"],
                override("陈旧修改", [citation_id], 1_785_283_200_001),
                if_match='"1"',
                idempotency_key="summary-section-edit-stale-0002",
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert json.loads(stale.body)["current"]["user_text"] == "人工修改"

            second = FinalSummary(
                id="summary-2",
                meeting_id="meeting-1",
                overview="生成内容二",
                key_decisions_json="[]",
                action_items_json="[]",
                generated_at=generated_at + timedelta(minutes=1),
            )
            documents[second.id] = document(second.meeting_id, second.id, "生成内容二")
            db.add(second)
            await db.commit()
            protected_catalog = await app_summary_v1.get_summary_versions_v1(
                "meeting-1", current_user={"id": 7}, db=db,
            )
            await db.commit()
            assert protected_catalog["current"]["version_id"] == "summary-1"
            assert [item["id"] for item in protected_catalog["items"]] == ["summary-2", "summary-1"]

            selected = await app_summary_v1.put_summary_current_v1(
                "meeting-1",
                app_summary_v1.SummaryCurrentSelectionV1(
                    schema_version=1,
                    version_id="summary-2",
                    client_updated_at_ms=1_785_283_200_002,
                ),
                if_match='"1"',
                idempotency_key="summary-select-0001",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            selected_body = json.loads(selected.body)
            assert selected_body["version_id"] == "summary-2"
            assert selected_body["revision"] == 2

            effective = await meeting_summary_sync_service.get_effective_current_summary_document(
                db, user_id=7, meeting_id="meeting-1",
            )
            assert effective is not None
            assert effective[1]["version_id"] == "summary-2"
            assert await db.scalar(select(func.count(MeetingSummaryVersionV1.id))) == 2
            assert await db.scalar(select(func.count(MeetingSummarySectionStateV1.id))) == 2
            assert await db.scalar(select(func.count(MeetingSummaryCurrentV1.meeting_id))) == 1
            assert await db.scalar(select(func.count(MeetingSummaryOperationV1.id))) == 2
            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["summary_versions_v1"] is True
    finally:
        await engine.dispose()
