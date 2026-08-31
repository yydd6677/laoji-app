"""Device authentication for the realtime schedule/meeting WebSocket."""

from dataclasses import dataclass

from fastapi import WebSocket
from sqlalchemy import select

from app.database import async_session
from app.models.meeting import Meeting
from app.services import device_identity
from app.services.device_identity import DeviceIdentityError


@dataclass(frozen=True)
class MeetingWsAuthContext:
    mode: str = "device"
    user_id: int | None = None
    device_id: str | None = None
    epoch_id: str | None = None


async def authorize_app_meeting_ws_context(
    websocket: WebSocket,
    meeting_id: str,
    *,
    require_binding: bool = True,
) -> MeetingWsAuthContext | None:
    """Authenticate one device/epoch and optionally its meeting binding.

    Tokens are accepted only from the Authorization header so proxies never
    retain a credential in the URL. Schedule dictation uses the same device
    credential but does not create a meeting binding.
    """
    authorization = websocket.headers.get("authorization") or ""
    if not authorization.lower().startswith("bearer dv1."):
        await websocket.close(code=1008)
        return None
    try:
        device_id, device_secret = device_identity.parse_bearer(authorization)
        epoch_id = websocket.headers.get("x-laoji-data-epoch") or ""
        if not epoch_id:
            raise DeviceIdentityError("EPOCH_REQUIRED", "缺少本机数据域", 401)
        context = device_identity.authenticate(device_id, device_secret, epoch_id)
    except DeviceIdentityError:
        await websocket.close(code=1008)
        return None

    if require_binding:
        try:
            async with async_session() as database:
                result = await database.execute(
                    select(Meeting.id).where(
                        Meeting.id == meeting_id,
                        Meeting.user_id == context.principal_id,
                        Meeting.data_epoch_id == context.epoch_id,
                    )
                )
                if result.scalar_one_or_none() is None:
                    await websocket.close(code=1008)
                    return None
        except Exception:
            await websocket.close(code=1011)
            return None
    return MeetingWsAuthContext(
        user_id=context.principal_id,
        device_id=context.device_id,
        epoch_id=context.epoch_id,
    )


async def authorize_app_meeting_ws(websocket: WebSocket, meeting_id: str) -> bool:
    return await authorize_app_meeting_ws_context(websocket, meeting_id) is not None
