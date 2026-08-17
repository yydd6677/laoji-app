import httpx
import numpy as np
import pytest

from app.api import qwen_ws
from app.services import schedule_parser_service
from app.services.schedule_parser_service import transcribe_schedule_audio


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("failed", request=None, response=None)

    def json(self):
        return self._payload


def fake_client(monkeypatch, response=None, error=None):
    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, json):
            if error:
                raise error
            assert url == "http://127.0.0.1:18020/api/laoji/asr/transcribe"
            assert json["filename"] == "sample.mp3"
            return response

    monkeypatch.setattr(httpx, "AsyncClient", Client)


@pytest.mark.asyncio
async def test_schedule_asr_does_not_use_legacy_proxy_and_rejects_invalid_audio(monkeypatch):
    monkeypatch.setenv("SCHEDULE_ASR_PROXY_BASE_URL", "http://127.0.0.1:18020")
    # The unified service no longer performs an HTTP proxy hop. Invalid audio
    # is rejected before any provider request and returns a normal empty
    # result.
    fake_client(monkeypatch, error=AssertionError("legacy proxy must not be called"))
    assert await transcribe_schedule_audio("AA==", "sample.mp3") is None


@pytest.mark.asyncio
async def test_proxy_422_is_a_normal_empty_transcript(monkeypatch):
    monkeypatch.setenv("SCHEDULE_ASR_PROXY_BASE_URL", "http://127.0.0.1:18020")
    fake_client(monkeypatch, FakeResponse(422))
    assert await transcribe_schedule_audio("AA==", "sample.mp3") is None


@pytest.mark.asyncio
async def test_proxy_failure_does_not_load_a_second_gpu_model(monkeypatch):
    monkeypatch.setenv("SCHEDULE_ASR_PROXY_BASE_URL", "http://127.0.0.1:18020")
    monkeypatch.setenv("SCHEDULE_ASR_PROXY_FALLBACK_LOCAL", "0")
    fake_client(monkeypatch, error=httpx.ConnectError("offline"))
    assert await transcribe_schedule_audio("AA==", "sample.mp3") is None


@pytest.mark.asyncio
async def test_meeting_backend_transcribes_schedule_audio_with_qwen(monkeypatch):
    monkeypatch.delenv("SCHEDULE_ASR_PROXY_BASE_URL", raising=False)
    monkeypatch.setattr(
        schedule_parser_service,
        "_read_schedule_audio_bytes",
        lambda *_args: (np.full(3200, 0.1, dtype=np.float32), 16000),
    )
    monkeypatch.setattr(
        qwen_ws,
        "_qwen_transcribe",
        lambda pcm, language, priority: {
            "text": "明天下午三点开会。",
            "audio_ms": len(pcm) * 1000 // 2 // 16000,
            "model": "Qwen3-ASR-1.7B",
        },
    )

    result = await transcribe_schedule_audio("AA==", "sample.mp3")

    assert result == {
        "text": "明天下午三点开会。",
        "duration_sec": 0.2,
        "provider": "qwen3-asr",
    }
