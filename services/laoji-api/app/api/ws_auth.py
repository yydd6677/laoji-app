from dataclasses import dataclass
from typing import Literal

from fastapi import WebSocket
from sqlalchemy import select

from app.database import async_session
from app.laoji import auth_router
from app.models.meeting import Meeting
from app.services.account_deletion_service import (
    is_meeting_tombstoned,
    is_user_meeting_tombstoned,
)
from app.services.guest_meeting_session_service import (
    authorize_guest_meeting_session,
    is_guest_meeting_id,
)
from app.services import device_identity
from app.services.device_identity import DeviceIdentityError


@dataclass(frozen=True)
class MeetingWsAuthContext:
    mode: Literal["prototype", "guest", "user", "device"]
    user_id: int | None = None
    device_id: str | None = None
    epoch_id: str | None = None


async def authorize_app_meeting_ws_context(
    websocket: WebSocket,
    meeting_id: str,
    *,
    require_binding: bool = True,
) -> MeetingWsAuthContext | None:
    """Authorize a meeting socket and retain the scope needed for voiceprints."""
    if is_meeting_tombstoned(meeting_id):
        await websocket.close(code=1008)
        return None
    guest_token = (
        websocket.headers.get('x-guest-session-token')
        or websocket.query_params.get('guest_token')
        or ''
    )
    if authorize_guest_meeting_session(meeting_id, guest_token):
        return MeetingWsAuthContext(mode="guest")
    if is_guest_meeting_id(meeting_id):
        await websocket.close(code=1008)
        return None

    # Device-primary clients authenticate the same way as the HTTP device
    # API: ``Authorization: Bearer dv1.<device-id>.<secret>`` plus the active
    # data epoch.  Never accept the credential in a query string because it
    # would be retained by proxies and tunnel access logs.
    authorization = websocket.headers.get('authorization') or ''
    if authorization.lower().startswith('bearer dv1.'):
        try:
            device_id, device_secret = device_identity.parse_bearer(authorization)
            epoch_id = websocket.headers.get('x-laoji-data-epoch') or ''
            if not epoch_id:
                raise DeviceIdentityError('EPOCH_REQUIRED', '缺少本机数据域', 401)
            device_context = device_identity.authenticate(device_id, device_secret, epoch_id)
        except DeviceIdentityError:
            await websocket.close(code=1008)
            return None
        if require_binding:
            try:
                async with async_session() as db:
                    result = await db.execute(
                        select(Meeting.id).where(
                            Meeting.id == meeting_id,
                            Meeting.user_id == device_context.principal_id,
                            Meeting.data_epoch_id == device_context.epoch_id,
                        )
                    )
                    if result.scalar_one_or_none() is None:
                        await websocket.close(code=1008)
                        return None
            except Exception:
                await websocket.close(code=1011)
                return None
        return MeetingWsAuthContext(
            mode="device",
            user_id=device_context.principal_id,
            device_id=device_context.device_id,
            epoch_id=device_context.epoch_id,
        )
    try:
        async with async_session() as db:
            result = await db.execute(
                select(Meeting.user_id, Meeting.app_owned).where(Meeting.id == meeting_id)
            )
            row = result.one_or_none()
    except Exception:
        await websocket.close(code=1011)
        return None

    if row is None:
        await websocket.close(code=1008)
        return None

    owner_id, app_owned = row
    if owner_id is None and not app_owned:
        return MeetingWsAuthContext(mode="prototype")
    if owner_id is None:
        await websocket.close(code=1008)
        return None
    if is_user_meeting_tombstoned(int(owner_id)):
        await websocket.close(code=1008)
        return None

    bearer_token = authorization[7:].strip() if authorization.lower().startswith('bearer ') else ''
    token = (
        bearer_token
        or websocket.query_params.get('access_token')
        or websocket.query_params.get('token')
        or ''
    )
    user = auth_router.auth.get_user_by_token(token) if token else None
    if not user or int(user['id']) != int(owner_id):
        await websocket.close(code=1008)
        return None
    return MeetingWsAuthContext(mode="user", user_id=int(owner_id))


async def authorize_app_meeting_ws(websocket: WebSocket, meeting_id: str) -> bool:
    """Compatibility wrapper used by endpoints that only need allow/deny."""
    return await authorize_app_meeting_ws_context(websocket, meeting_id) is not None
