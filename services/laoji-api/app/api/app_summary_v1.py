from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.laoji.auth_router import get_current_user
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_recording_asset_service import owned_active_meeting
from app.services.meeting_summary_sync_service import (
    MAX_SAFE_INTEGER,
    MeetingSummaryContractConflict,
    get_meeting_summary_catalog,
    meeting_summary_request_hash,
    select_current_summary_version,
    update_summary_section_state,
)


router = APIRouter()


class SummarySectionOverrideV1(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1]
    user_text: str | None = Field(default=None, max_length=20_000)
    visible_citation_ids: list[str] = Field(max_length=100)
    client_updated_at_ms: int = Field(ge=0, le=MAX_SAFE_INTEGER)


class SummaryCurrentSelectionV1(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1]
    version_id: str = Field(min_length=1, max_length=160)
    client_updated_at_ms: int = Field(ge=0, le=MAX_SAFE_INTEGER)


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
        raise HTTPException(status_code=428, detail="缺少整理结果版本")
    normalized = value.strip().removeprefix("W/").strip('"')
    try:
        revision = int(normalized)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="整理结果版本无效") from error
    if revision < 1:
        raise HTTPException(status_code=400, detail="整理结果版本无效")
    return revision


def _conflict_response(error: MeetingSummaryContractConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "整理结果请求标识已被其他操作使用",
        "revision_conflict": "整理结果云端版本已变化",
    }
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "整理结果已变化，请刷新后重试"),
            },
            "current": error.current,
        },
    )


async def _owned_meeting(db: AsyncSession, user_id: int, meeting_id: str) -> None:
    if await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id) is None:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问")


@router.get("/v1/meeting-notes/{meeting_id}/summary-versions")
async def get_summary_versions_v1(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    await _owned_meeting(db, user_id, meeting_id)
    return await get_meeting_summary_catalog(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
    )


@router.put("/v1/meeting-summary-versions/{version_id}/sections/{section_id}")
async def put_summary_section_override_v1(
    version_id: str,
    section_id: str,
    data: SummarySectionOverrideV1,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改整理结果")
    version_id = _identifier(version_id, "整理结果标识", 160)
    section_id = _identifier(section_id, "整理内容标识")
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "整理结果请求标识")
    mutation = data.model_dump()
    mutation["visible_citation_ids"] = [
        _identifier(value, "整理结果引用标识")
        for value in data.visible_citation_ids
    ]
    request_hash = meeting_summary_request_hash(
        "section_override",
        f"{version_id}:{section_id}",
        {"expected_revision": expected_revision, **mutation},
    )
    try:
        result = await update_summary_section_state(
            db,
            user_id=user_id,
            version_id=version_id,
            section_id=section_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="整理内容不存在或无权访问") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail="整理内容修改无效") from error
    except MeetingSummaryContractConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.put("/v1/meeting-notes/{meeting_id}/summary-current")
async def put_summary_current_v1(
    meeting_id: str,
    data: SummaryCurrentSelectionV1,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能切换整理结果")
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    await _owned_meeting(db, user_id, meeting_id)
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "整理结果请求标识")
    mutation = data.model_dump()
    mutation["version_id"] = _identifier(data.version_id, "整理结果标识", 160)
    request_hash = meeting_summary_request_hash(
        "select_version",
        meeting_id,
        {"expected_revision": expected_revision, **mutation},
    )
    try:
        result = await select_current_summary_version(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="整理结果版本不存在或无权访问") from error
    except MeetingSummaryContractConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )
