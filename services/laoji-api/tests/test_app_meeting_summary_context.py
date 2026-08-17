from datetime import datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fastapi import HTTPException

from app.api import app_meetings
from app.api.app_meetings import GuestSummaryRequest, _meeting_local_date, _summary_template_or_422


def test_naive_cloud_timestamp_is_converted_from_utc_to_china_date():
    meeting = SimpleNamespace(created_at=datetime(2026, 7, 9, 17, 30))
    assert _meeting_local_date(meeting) == "2026-07-10"


def test_guest_summary_date_requires_iso_calendar_shape():
    valid = GuestSummaryRequest(
        meeting_id="guest-1",
        title="评审会",
        meeting_date="2026-07-10",
        transcript_lines=[{"speaker_label": "甲", "text": "确认方案"}],
    )
    assert valid.meeting_date == "2026-07-10"
    assert valid.template_id == "general"
    assert valid.template_revision == 1

    with pytest.raises(ValidationError):
        GuestSummaryRequest(
            meeting_id="guest-1",
            meeting_date="2026-7-10",
            transcript_lines=[{"speaker_label": "甲", "text": "确认方案"}],
        )


def test_guest_summary_preserves_client_transcript_segment_identity():
    request = GuestSummaryRequest(
        meeting_id="guest-1",
        transcript_lines=[{
            "id": "native:guest-1:segment-7",
            "speaker_label": "甲",
            "text": "确认方案",
        }],
    )
    assert request.transcript_lines[0].id == "native:guest-1:segment-7"


@pytest.mark.asyncio
async def test_guest_summary_submission_passes_client_segment_identity_to_worker(monkeypatch):
    captured = {}

    def fake_submit(meeting_id, transcript_lines, **kwargs):
        captured["meeting_id"] = meeting_id
        captured["transcript_lines"] = transcript_lines
        captured["kwargs"] = kwargs
        return type("Task", (), {"id": "task-1", "reused": False})()

    monkeypatch.setattr(app_meetings, "submit_guest_summary", fake_submit)
    response = await app_meetings.generate_guest_meeting_summary(GuestSummaryRequest(
        meeting_id="guest-1",
        transcript_lines=[{
            "id": "native:guest-1:segment-7",
            "speaker_label": "甲",
            "text": "确认方案",
            "start_time": 1.5,
            "end_time": 3.0,
        }],
    ))

    assert response["task_id"] == "task-1"
    assert captured["meeting_id"] == "guest-1"
    assert captured["transcript_lines"][0]["id"] == "native:guest-1:segment-7"


def test_api_template_validation_returns_chinese_422():
    assert _summary_template_or_422("project_sync", 1)["id"] == "project_sync"
    with pytest.raises(HTTPException) as error:
        _summary_template_or_422("project_sync", 2)
    assert error.value.status_code == 422
    assert "版本" in str(error.value.detail)
