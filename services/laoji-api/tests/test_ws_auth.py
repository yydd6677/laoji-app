from types import SimpleNamespace

import pytest

from app.api import ws_auth


class FakeResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class FakeSession:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, _query):
        return FakeResult(self.value)


class FakeWebSocket:
    def __init__(self, query_params=None, headers=None):
        self.query_params = query_params or {}
        self.headers = headers or {}
        self.closed = []

    async def close(self, code):
        self.closed.append(code)


def _authenticate(monkeypatch):
    monkeypatch.setattr(
        ws_auth.device_identity,
        "parse_bearer",
        lambda _authorization: ("device-a", "secret-a"),
    )
    monkeypatch.setattr(
        ws_auth.device_identity,
        "authenticate",
        lambda *_args: SimpleNamespace(
            principal_id=7,
            device_id="device-a",
            epoch_id="epoch-a",
        ),
    )


@pytest.mark.asyncio
async def test_websocket_rejects_missing_header_and_ignores_query_token():
    websocket = FakeWebSocket(query_params={"token": "dv1.device.secret"})
    assert await ws_auth.authorize_app_meeting_ws(websocket, "meeting-a") is False
    assert websocket.closed == [1008]


@pytest.mark.asyncio
async def test_schedule_websocket_uses_device_epoch_without_meeting_binding(monkeypatch):
    _authenticate(monkeypatch)
    websocket = FakeWebSocket(headers={
        "authorization": "Bearer dv1.device-a.secret-a",
        "x-laoji-data-epoch": "epoch-a",
    })
    context = await ws_auth.authorize_app_meeting_ws_context(
        websocket,
        "schedule-session",
        require_binding=False,
    )
    assert context == ws_auth.MeetingWsAuthContext(
        user_id=7,
        device_id="device-a",
        epoch_id="epoch-a",
    )
    assert websocket.closed == []


@pytest.mark.asyncio
async def test_meeting_websocket_requires_matching_device_binding(monkeypatch):
    _authenticate(monkeypatch)
    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession("meeting-a"))
    headers = {
        "authorization": "Bearer dv1.device-a.secret-a",
        "x-laoji-data-epoch": "epoch-a",
    }
    valid = FakeWebSocket(headers=headers)
    assert await ws_auth.authorize_app_meeting_ws(valid, "meeting-a") is True
    assert valid.closed == []

    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession(None))
    missing = FakeWebSocket(headers=headers)
    assert await ws_auth.authorize_app_meeting_ws(missing, "meeting-missing") is False
    assert missing.closed == [1008]
