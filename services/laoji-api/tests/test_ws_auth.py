import pytest

from app.api import ws_auth


class FakeResult:
    def __init__(self, row):
        self.row = row

    def one_or_none(self):
        return self.row


class FakeSession:
    def __init__(self, row):
        self.row = row

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, _query):
        return FakeResult(self.row)


class FakeWebSocket:
    def __init__(self, query_params=None, headers=None):
        self.query_params = query_params or {}
        self.headers = headers or {}
        self.closed = []

    async def close(self, code):
        self.closed.append(code)


@pytest.mark.asyncio
async def test_missing_or_tombstoned_meeting_cannot_open_public_websocket(monkeypatch):
    monkeypatch.setattr(ws_auth, "is_meeting_tombstoned", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "authorize_guest_meeting_session", lambda _meeting_id, _token: False)
    monkeypatch.setattr(ws_auth, "is_guest_meeting_id", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession(None))
    missing = FakeWebSocket()
    assert await ws_auth.authorize_app_meeting_ws(missing, "missing") is False
    assert missing.closed == [1008]

    monkeypatch.setattr(ws_auth, "is_meeting_tombstoned", lambda _meeting_id: True)
    tombstoned = FakeWebSocket()
    assert await ws_auth.authorize_app_meeting_ws(tombstoned, "deleted") is False
    assert tombstoned.closed == [1008]


@pytest.mark.asyncio
async def test_existing_prototype_remains_public_but_app_meeting_requires_owner(monkeypatch):
    monkeypatch.setattr(ws_auth, "is_meeting_tombstoned", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "authorize_guest_meeting_session", lambda _meeting_id, _token: False)
    monkeypatch.setattr(ws_auth, "is_guest_meeting_id", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession((None, 0)))
    prototype = FakeWebSocket()
    assert await ws_auth.authorize_app_meeting_ws(prototype, "prototype") is True
    assert prototype.closed == []

    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession((7, 1)))
    monkeypatch.setattr(
        ws_auth.auth_router.auth,
        "get_user_by_token",
        lambda token: {"id": 7} if token == "owner-token" else {"id": 8} if token else None,
    )
    owner = FakeWebSocket(headers={"authorization": "Bearer owner-token"})
    assert await ws_auth.authorize_app_meeting_ws(owner, "owned") is True

    stranger = FakeWebSocket({"access_token": "stranger-token"})
    assert await ws_auth.authorize_app_meeting_ws(stranger, "owned") is False
    assert stranger.closed == [1008]

    missing_owner = FakeWebSocket()
    assert await ws_auth.authorize_app_meeting_ws(missing_owner, "owned") is False
    assert missing_owner.closed == [1008]


@pytest.mark.asyncio
async def test_guest_websocket_requires_matching_transient_token(monkeypatch):
    monkeypatch.setattr(ws_auth, "is_meeting_tombstoned", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "is_guest_meeting_id", lambda meeting_id: meeting_id.startswith("guest-session-"))
    monkeypatch.setattr(
        ws_auth,
        "authorize_guest_meeting_session",
        lambda meeting_id, token: meeting_id == "guest-session-1" and token == "valid-token",
    )

    valid = FakeWebSocket(headers={"x-guest-session-token": "valid-token"})
    assert await ws_auth.authorize_app_meeting_ws(valid, "guest-session-1") is True
    assert valid.closed == []

    invalid = FakeWebSocket({"guest_token": "wrong-token"})
    assert await ws_auth.authorize_app_meeting_ws(invalid, "guest-session-1") is False
    assert invalid.closed == [1008]


@pytest.mark.asyncio
async def test_auth_context_distinguishes_prototype_guest_and_owned_user(monkeypatch):
    monkeypatch.setattr(ws_auth, "is_meeting_tombstoned", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "is_guest_meeting_id", lambda meeting_id: meeting_id == "guest")
    monkeypatch.setattr(
        ws_auth,
        "authorize_guest_meeting_session",
        lambda meeting_id, token: meeting_id == "guest" and token == "guest-token",
    )
    guest = await ws_auth.authorize_app_meeting_ws_context(
        FakeWebSocket(headers={"x-guest-session-token": "guest-token"}),
        "guest",
    )
    assert guest == ws_auth.MeetingWsAuthContext(mode="guest")

    monkeypatch.setattr(ws_auth, "authorize_guest_meeting_session", lambda _meeting_id, _token: False)
    monkeypatch.setattr(ws_auth, "is_guest_meeting_id", lambda _meeting_id: False)
    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession((None, 0)))
    prototype = await ws_auth.authorize_app_meeting_ws_context(FakeWebSocket(), "prototype")
    assert prototype == ws_auth.MeetingWsAuthContext(mode="prototype")

    monkeypatch.setattr(ws_auth, "async_session", lambda: FakeSession((7, 1)))
    monkeypatch.setattr(
        ws_auth.auth_router.auth,
        "get_user_by_token",
        lambda token: {"id": 7} if token == "owner-token" else None,
    )
    owner = await ws_auth.authorize_app_meeting_ws_context(
        FakeWebSocket(headers={"authorization": "Bearer owner-token"}),
        "owned",
    )
    assert owner == ws_auth.MeetingWsAuthContext(mode="user", user_id=7)
