import pytest
from fastapi import HTTPException

from app.api.app_meetings import get_guest_realtime_transcripts
from app.services import guest_meeting_session_service as sessions


def setup_function() -> None:
    sessions._reset_guest_meeting_sessions_for_tests()


@pytest.mark.asyncio
async def test_guest_transcript_endpoint_requires_matching_session_token() -> None:
    session = sessions.create_guest_meeting_session()
    sessions.append_guest_transcript(
        session.meeting_id,
        speaker_id='speaker_1',
        speaker_label='发言人 1',
        text='可恢复字幕',
        start_time=0.0,
        end_time=1.0,
        confidence=0.9,
    )

    page = await get_guest_realtime_transcripts(
        meeting_id=session.meeting_id,
        limit=1000,
        offset=0,
        guest_token=session.token,
    )
    assert page['total'] == 1
    assert page['items'][0]['text'] == '可恢复字幕'

    with pytest.raises(HTTPException) as error:
        await get_guest_realtime_transcripts(
            meeting_id=session.meeting_id,
            limit=1000,
            offset=0,
            guest_token='wrong-token',
        )
    assert error.value.status_code == 404
