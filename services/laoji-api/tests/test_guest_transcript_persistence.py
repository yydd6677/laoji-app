import pytest

from app.api import qwen_ws


class FakeSession:
    def __init__(self, meeting_exists: bool):
        self.meeting_exists = meeting_exists
        self.added = []
        self.commits = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, _model, _meeting_id):
        return object() if self.meeting_exists else None

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        self.commits += 1


@pytest.mark.asyncio
async def test_unknown_guest_meeting_transcript_is_not_persisted(monkeypatch):
    session = FakeSession(meeting_exists=False)
    monkeypatch.setattr(qwen_ws, "async_session", lambda: session)

    await qwen_ws._persist_transcript(
        meeting_id="guest-meeting-local-only",
        speaker_id="unknown",
        text="游客转写",
        start_ms=0,
        end_ms=1000,
        confidence=0.9,
    )

    assert session.added == []
    assert session.commits == 0


@pytest.mark.asyncio
async def test_existing_meeting_transcript_remains_persisted(monkeypatch):
    session = FakeSession(meeting_exists=True)
    monkeypatch.setattr(qwen_ws, "async_session", lambda: session)

    await qwen_ws._persist_transcript(
        meeting_id="existing-meeting",
        speaker_id="speaker-1",
        text="正常转写",
        start_ms=0,
        end_ms=1000,
        confidence=0.9,
    )

    assert len(session.added) == 1
    assert session.commits == 1
