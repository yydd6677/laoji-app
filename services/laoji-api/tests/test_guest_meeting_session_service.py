from app.services import guest_meeting_session_service as sessions


def setup_function() -> None:
    sessions._reset_guest_meeting_sessions_for_tests()


def test_guest_session_requires_matching_token_and_can_be_revoked() -> None:
    session = sessions.create_guest_meeting_session()

    assert sessions.is_guest_meeting_id(session.meeting_id)
    assert sessions.authorize_guest_meeting_session(session.meeting_id, session.token) is True
    assert sessions.authorize_guest_meeting_session(session.meeting_id, "wrong-token") is False
    assert sessions.revoke_guest_meeting_session(session.meeting_id, "wrong-token") is False
    assert sessions.revoke_guest_meeting_session(session.meeting_id, session.token) is True
    assert sessions.authorize_guest_meeting_session(session.meeting_id, session.token) is False


def test_guest_session_expires_without_database_cleanup(monkeypatch) -> None:
    now = 1000.0
    monkeypatch.setattr(sessions, "_now", lambda: now)
    session = sessions.create_guest_meeting_session(ttl_seconds=10)

    now = 1011.0
    assert sessions.authorize_guest_meeting_session(session.meeting_id, session.token) is False
    assert sessions.revoke_guest_meeting_session(session.meeting_id, session.token) is False


def test_guest_transcripts_are_token_scoped_paginated_deduplicated_and_revoked() -> None:
    session = sessions.create_guest_meeting_session()
    first = sessions.append_guest_transcript(
        session.meeting_id,
        speaker_id='speaker_1',
        speaker_label='发言人 1',
        text='第一句',
        start_time=0.0,
        end_time=1.0,
        confidence=0.8,
    )
    duplicate = sessions.append_guest_transcript(
        session.meeting_id,
        speaker_id='speaker_1',
        speaker_label='发言人 1',
        text='第一句',
        start_time=0.0,
        end_time=1.0,
        confidence=0.9,
    )
    sessions.append_guest_transcript(
        session.meeting_id,
        speaker_id='speaker_2',
        speaker_label='发言人 2',
        text='第二句',
        start_time=1.0,
        end_time=2.0,
        confidence=0.7,
    )

    assert first is not None
    assert duplicate is not None
    assert duplicate['id'] == first['id']
    assert sessions.list_guest_transcripts(session.meeting_id, 'wrong-token') is None
    page = sessions.list_guest_transcripts(session.meeting_id, session.token, offset=1, limit=1)
    assert page is not None
    assert page['total'] == 2
    assert [line['text'] for line in page['items']] == ['第二句']

    assert sessions.revoke_guest_meeting_session(session.meeting_id, session.token) is True
    assert sessions.list_guest_transcripts(session.meeting_id, session.token) is None


def test_expired_guest_session_purges_transcripts(monkeypatch) -> None:
    now = 2000.0
    monkeypatch.setattr(sessions, '_now', lambda: now)
    session = sessions.create_guest_meeting_session(ttl_seconds=10)
    assert sessions.append_guest_transcript(
        session.meeting_id,
        speaker_id=None,
        speaker_label=None,
        text='临时字幕',
        start_time=None,
        end_time=None,
        confidence=None,
    ) is not None

    now = 2011.0
    assert sessions.list_guest_transcripts(session.meeting_id, session.token) is None
