import json

import pytest

from app.api import qwen_ws


def test_qwen_vad_policy_matches_schedule_and_meeting_latency_contract():
    meeting = qwen_ws._vad_settings_for_purpose("meeting")
    schedule = qwen_ws._vad_settings_for_purpose("schedule")

    assert meeting == {
        "silence_ms": 400.0,
        "pre_roll_ms": 400.0,
        "initial_pre_roll_ms": 200.0,
        "max_speech_ms": 6000.0,
        "energy_threshold": 0.0002,
    }
    assert schedule == {
        "silence_ms": 800.0,
        "pre_roll_ms": 400.0,
        "initial_pre_roll_ms": 400.0,
        "max_speech_ms": 6000.0,
        "energy_threshold": 0.0002,
    }


@pytest.mark.asyncio
async def test_qwen_schedule_route_omits_speakers_and_persistence(monkeypatch):
    captured = {}

    async def serve(websocket, session_id, **options):
        captured.update(websocket=websocket, session_id=session_id, **options)

    monkeypatch.setattr(qwen_ws, "_serve_qwen", serve)
    websocket = object()

    await qwen_ws.qwen_schedule_websocket_endpoint(websocket, "schedule-session")

    assert captured == {
        "websocket": websocket,
        "session_id": "schedule-session",
        "purpose": "schedule",
        "enable_speaker_recognition": False,
        "persist_transcript": False,
    }


@pytest.mark.asyncio
async def test_qwen_meeting_route_keeps_speakers_and_persistence(monkeypatch):
    captured = {}

    async def serve(websocket, session_id, **options):
        captured.update(websocket=websocket, session_id=session_id, **options)

    monkeypatch.setattr(qwen_ws, "_serve_qwen", serve)
    websocket = object()

    await qwen_ws.qwen_meeting_websocket_endpoint(websocket, "meeting-1")

    assert captured == {
        "websocket": websocket,
        "session_id": "meeting-1",
        "purpose": "meeting",
        "enable_speaker_recognition": True,
        "persist_transcript": True,
    }


def test_qwen_speaker_profiles_remain_user_scoped():
    class SpeakerDb:
        def load_for_owner(self, owner_id, **_kwargs):
            return ["user-%s" % owner_id]

        def load_all(self, **_kwargs):
            return ["prototype"]

    database = SpeakerDb()
    user = type("Context", (), {"mode": "user", "user_id": 7})()
    guest = type("Context", (), {"mode": "guest", "user_id": None})()
    prototype = type("Context", (), {"mode": "prototype", "user_id": None})()

    assert qwen_ws._speaker_profiles_for_context(database, user) == ["user-7"]
    assert qwen_ws._speaker_profiles_for_context(database, guest) == []
    assert qwen_ws._speaker_profiles_for_context(database, prototype) == ["prototype"]


def test_qwen_guest_final_transcript_is_cached_with_stable_id(monkeypatch):
    captured = {}

    def append(meeting_id, **line):
        captured.update(meeting_id=meeting_id, **line)
        return {"id": "guest-line-1"}

    monkeypatch.setattr(qwen_ws, "append_guest_transcript", append)
    guest = type("Context", (), {"mode": "guest", "user_id": None})()
    message = {
        "type": "transcript.completed",
        "speaker_id": "speaker_1",
        "speaker_name": "发言人 1",
        "text": "项目进度正常",
        "start_time": 0.5,
        "end_time": 1.5,
        "speaker_confidence": 0.8,
    }

    result = qwen_ws._cache_guest_transcript(guest, "guest-session-1", message)

    assert result["id"] == "guest-line-1"
    assert captured == {
        "meeting_id": "guest-session-1",
        "speaker_id": "speaker_1",
        "speaker_label": "发言人 1",
        "text": "项目进度正常",
        "start_time": 0.5,
        "end_time": 1.5,
        "confidence": 0.8,
    }


def test_qwen_user_transcript_does_not_enter_guest_cache(monkeypatch):
    monkeypatch.setattr(
        qwen_ws,
        "append_guest_transcript",
        lambda *_args, **_kwargs: pytest.fail("user transcript entered guest cache"),
    )
    user = type("Context", (), {"mode": "user", "user_id": 7})()
    message = {"type": "transcript.completed", "text": "用户字幕"}

    assert qwen_ws._cache_guest_transcript(user, "meeting-1", message) is message


def test_qwen_transcribe_url_encodes_language(monkeypatch):
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"text": "测试", "language": "Chinese"}).encode()

    def open_request(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(qwen_ws.urllib.request, "urlopen", open_request)

    result = qwen_ws._qwen_transcribe(
        b"\x00\x00",
        "Chinese Simplified",
        "schedule",
    )

    assert result["text"] == "测试"
    assert captured["url"].endswith(
        "language=Chinese+Simplified&priority=schedule"
    )
    assert captured["timeout"] == qwen_ws.QWEN_ASR_REQUEST_TIMEOUT_SECONDS


def test_flush_vad_emits_tail_and_stops_when_idle():
    segment = object()

    class Vad:
        state = "speech"

        def __init__(self):
            self.calls = 0

        def feed(self, frame):
            assert frame.shape == (512,)
            self.calls += 1
            if self.calls == 3:
                self.state = "idle"
                return segment
            return None

    vad = Vad()

    assert qwen_ws._flush_vad(vad) == [segment]
    assert vad.calls == 3


def test_identify_exposes_internal_id_and_raw_score_below_acceptance_threshold():
    match = type(
        "Match",
        (),
        {"speaker_id": "u7_voice", "name": "张三", "cosine_score": 0.31},
    )()
    engine = type(
        "Engine",
        (),
        {"identify": lambda _self, _audio: type("Result", (), {"matches": [match]})()},
    )()

    result = qwen_ws._identify(engine, object())

    assert result == {
        "speaker_id": "u7_voice",
        "name": "张三",
        "cos": 0.31,
        "gap": 0.31,
    }
