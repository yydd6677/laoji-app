from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.laoji.auth_router import get_current_user
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_marker_service import (
    MeetingMarkerConflict,
    delete_meeting_marker,
    list_meeting_markers,
    meeting_marker_payload,
    meeting_marker_request_hash,
    register_meeting_marker,
)


router = APIRouter()


class MeetingMarkerV1Register(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1]
    client_marker_id: str = Field(min_length=1, max_length=512)
    position_ms: int = Field(ge=0, le=9_007_199_254_740_991)
    label: str | None = Field(default=None, max_length=500)
    kind: Literal["important"]
    client_created_at_ms: int = Field(ge=0, le=9_007_199_254_740_991)
    client_updated_at_ms: int = Field(ge=0, le=9_007_199_254_740_991)

    @model_validator(mode="after")
    def validate_times(self):
        if self.client_updated_at_ms < self.client_created_at_ms:
            raise ValueError("标记更新时间不能早于创建时间")
        return self


def _identifier(value: str | None, label: str, maximum: int = 512) -> str:
    if value is None:
        raise HTTPException(status_code=428, detail=f"缺少{label}")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise HTTPException(status_code=400, detail=f"{label}无效")
    return normalized


def _revision(value: str | None) -> int:
    if value is None:
        raise HTTPException(status_code=428, detail="缺少标记版本")
    normalized = value.strip().removeprefix("W/").strip('"')
    try:
        revision = int(normalized)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="标记版本无效") from error
    if revision < 1:
        raise HTTPException(status_code=400, detail="标记版本无效")
    return revision


def _conflict_response(error: MeetingMarkerConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "标记请求标识已被其他操作使用",
        "marker_identity_mismatch": "标记本机标识已对应不同内容",
        "revision_conflict": "标记云端版本已变化",
    }
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "标记状态已变化，请刷新后重试"),
            },
            "current": error.current,
        },
    )


def _normalize_registration(data: MeetingMarkerV1Register) -> dict:
    mutation = data.model_dump()
    mutation["client_marker_id"] = _identifier(data.client_marker_id, "标记本机标识")
    if data.label is not None and "\x00" in data.label:
        raise HTTPException(status_code=400, detail="标记名称无效")
    return mutation


@router.post("/v1/meeting-notes/{meeting_id}/markers")
async def post_meeting_marker_v1(
    meeting_id: str,
    data: MeetingMarkerV1Register,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能添加标记")
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    idempotency_key = _identifier(idempotency_key, "标记请求标识")
    mutation = _normalize_registration(data)
    request_hash = meeting_marker_request_hash("register", meeting_id, mutation)
    try:
        result = await register_meeting_marker(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    except MeetingMarkerConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v1/meeting-notes/{meeting_id}/markers")
async def get_meeting_markers_v1(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    try:
        markers = await list_meeting_markers(
            db,
            user_id=int(current_user["id"]),
            meeting_id=meeting_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "items": [meeting_marker_payload(item) for item in markers],
    }


@router.delete("/v1/meeting-markers/{marker_id}")
async def delete_meeting_marker_v1(
    marker_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改标记")
    marker_id = _identifier(marker_id, "标记标识", 160)
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "标记请求标识")
    request_hash = meeting_marker_request_hash(
        "delete",
        marker_id,
        {"expected_revision": expected_revision},
    )
    try:
        result = await delete_meeting_marker(
            db,
            user_id=user_id,
            marker_id=marker_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="标记不存在或无权访问") from error
    except MeetingMarkerConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )
