from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
from typing import Literal

from anyio import open_file, to_thread
from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.laoji.auth_router import get_current_user
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_attachment_service import (
    MeetingAttachmentConflict,
    complete_meeting_attachment_content_upload,
    delete_meeting_attachment,
    find_meeting_attachment,
    list_meeting_attachments,
    meeting_attachment_payload,
    meeting_attachment_request_hash,
    meeting_attachment_storage_path,
    prepare_meeting_attachment_content_upload,
    register_meeting_attachment,
)


router = APIRouter()

_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_UPLOAD_CHUNK_BYTES = 1024 * 1024
_IDENTIFIER_RE = re.compile(r"^[^\x00-\x1f\x7f]+$")
_CHECKSUM_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ALLOWED_IMAGE_MIME_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}


class MeetingAttachmentV1Register(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    client_attachment_id: str = Field(min_length=1, max_length=512)
    position_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    kind: Literal["text", "image"]
    text_content: str | None = Field(default=None, max_length=500)
    mime_type: str | None = Field(default=None, min_length=1, max_length=160)
    file_name: str | None = Field(default=None, min_length=1, max_length=255)
    byte_size: int | None = Field(default=None, ge=1, le=_MAX_IMAGE_BYTES)
    checksum_sha256: str | None = Field(default=None, pattern=_CHECKSUM_RE.pattern)
    client_created_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)
    client_updated_at_ms: int = Field(ge=0, le=_MAX_SAFE_INTEGER)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.client_updated_at_ms < self.client_created_at_ms:
            raise ValueError("附件更新时间不能早于创建时间")
        if self.kind == "text":
            if (
                not (self.text_content or "").strip()
                or self.mime_type is not None
                or self.file_name is not None
                or self.byte_size is not None
                or self.checksum_sha256 is not None
            ):
                raise ValueError("文字附件内容无效")
        elif (
            self.text_content is not None
            or self.mime_type is None
            or self.file_name is None
            or self.byte_size is None
            or self.checksum_sha256 is None
        ):
            raise ValueError("照片附件内容无效")
        return self


def _identifier(value: str | None, label: str, maximum: int = 512) -> str:
    normalized = (value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or not _IDENTIFIER_RE.fullmatch(normalized)
    ):
        raise HTTPException(status_code=422, detail=f"{label}无效")
    return normalized


def _safe_file_name(value: str | None) -> str:
    normalized = _identifier(value, "附件文件名", 255)
    if Path(normalized).name != normalized or "/" in normalized or "\\" in normalized:
        raise HTTPException(status_code=422, detail="附件文件名无效")
    return normalized


def _revision(value: str | None) -> int:
    if value is None:
        raise HTTPException(status_code=428, detail="缺少附件版本条件")
    normalized = value.strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    if len(normalized) >= 2 and normalized[0] == normalized[-1] == '"':
        normalized = normalized[1:-1]
    if not normalized.isdigit():
        raise HTTPException(status_code=400, detail="附件版本条件无效")
    revision = int(normalized)
    if revision < 1 or revision > _MAX_SAFE_INTEGER:
        raise HTTPException(status_code=400, detail="附件版本条件无效")
    return revision


def _conflict_response(error: MeetingAttachmentConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他附件操作",
        "attachment_identity_mismatch": "附件身份与已登记内容不一致",
        "revision_conflict": "附件云端版本已变化",
        "attachment_deleted": "附件已经删除",
        "attachment_content_unavailable": "当前附件不接受文件上传",
        "attachment_content_immutable": "附件内容已经上传，不能直接覆盖",
        "attachment_state_invalid": "附件当前状态不能上传",
        "attachment_size_mismatch": "照片大小与登记信息不一致",
        "attachment_checksum_mismatch": "照片校验失败，请重新选择文件",
    }
    revision = error.current.get("revision") if isinstance(error.current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "附件状态已变化，请刷新后重试"),
            },
            "current": error.current,
        },
    )


def _normalize_registration(data: MeetingAttachmentV1Register) -> dict:
    mutation = data.model_dump()
    mutation["client_attachment_id"] = _identifier(
        data.client_attachment_id,
        "附件本机标识",
    )
    mutation["text_content"] = (
        data.text_content.strip() if data.kind == "text" and data.text_content else None
    )
    if data.kind == "image":
        mime_type = _identifier(data.mime_type, "附件格式", 160).lower()
        if mime_type not in _ALLOWED_IMAGE_MIME_TYPES:
            raise HTTPException(status_code=415, detail="仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片")
        mutation["mime_type"] = mime_type
        mutation["file_name"] = _safe_file_name(data.file_name)
        mutation["checksum_sha256"] = (data.checksum_sha256 or "").lower()
    return mutation


def _image_mime_from_magic(header: bytes) -> str | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brand = header[8:12]
        if brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
        if brand in {b"mif1", b"msf1"}:
            return "image/heif"
    return None


def _delete_storage_file(value: str) -> None:
    root = Path(settings.audio_storage_abs_path).resolve()
    source = Path(value).resolve(strict=False)
    if source == root or root not in source.parents:
        raise ValueError("附件文件不在受管存储中")
    if source.exists():
        if not source.is_file():
            raise ValueError("附件存储目标不是文件")
        source.unlink()


@router.post("/v1/meeting-notes/{meeting_id}/attachments")
async def post_meeting_attachment_v1(
    meeting_id: str,
    data: MeetingAttachmentV1Register,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能添加附件")
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    idempotency_key = _identifier(idempotency_key, "附件请求标识")
    mutation = _normalize_registration(data)
    request_hash = meeting_attachment_request_hash("register", meeting_id, mutation)
    try:
        result = await register_meeting_attachment(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    except MeetingAttachmentConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v1/meeting-notes/{meeting_id}/attachments")
async def get_meeting_attachments_v1(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    try:
        attachments = await list_meeting_attachments(
            db,
            user_id=int(current_user["id"]),
            meeting_id=meeting_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "items": [meeting_attachment_payload(item) for item in attachments],
    }


@router.put("/v1/meeting-attachments/{attachment_id}/content")
async def put_meeting_attachment_content_v1(
    attachment_id: str,
    file: UploadFile = File(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        await file.close()
        raise HTTPException(status_code=409, detail="账号正在删除，不能上传附件")
    attachment_id = _identifier(attachment_id, "附件标识", 160)
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "附件请求标识")
    request_hash = meeting_attachment_request_hash("content", attachment_id, {})
    try:
        attachment, replay = await prepare_meeting_attachment_content_upload(
            db,
            user_id=user_id,
            attachment_id=attachment_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except LookupError as error:
        await file.close()
        raise HTTPException(status_code=404, detail="附件不存在或无权访问") from error
    except MeetingAttachmentConflict as error:
        await file.close()
        return _conflict_response(error)
    if replay is not None:
        await file.close()
        return JSONResponse(
            status_code=replay.status_code,
            headers={
                "ETag": f'"{replay.payload["revision"]}"',
                "X-Idempotent-Replay": "true",
            },
            content=replay.payload,
        )
    extension = _ALLOWED_IMAGE_MIME_TYPES.get(attachment.mime_type or "")
    if extension is None:
        await file.close()
        raise HTTPException(status_code=415, detail="附件登记格式不受支持")
    target = meeting_attachment_storage_path(
        user_id=user_id,
        meeting_id=attachment.meeting_id,
        attachment_id=attachment.id,
        extension=extension,
    )
    operation_suffix = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:16]
    temporary = target.with_name(f".{target.name}.{operation_suffix}.part")
    temporary.unlink(missing_ok=True)
    total_bytes = 0
    digest = hashlib.sha256()
    header = bytearray()
    try:
        async with await open_file(temporary, "xb") as output:
            while chunk := await file.read(_UPLOAD_CHUNK_BYTES):
                total_bytes += len(chunk)
                if total_bytes > _MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="照片不能超过 25 MB")
                if len(header) < 32:
                    header.extend(chunk[:32 - len(header)])
                digest.update(chunk)
                await output.write(chunk)
            await output.flush()
        await file.close()
        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="照片文件为空")
        actual_mime_type = _image_mime_from_magic(bytes(header))
        if actual_mime_type is None or actual_mime_type != attachment.mime_type:
            raise HTTPException(status_code=415, detail="照片实际格式与登记格式不一致")
        actual_checksum = f"sha256:{digest.hexdigest()}"
        if attachment.byte_size != total_bytes:
            raise MeetingAttachmentConflict(
                "attachment_size_mismatch",
                meeting_attachment_payload(attachment),
            )
        if attachment.checksum_sha256 != actual_checksum:
            raise MeetingAttachmentConflict(
                "attachment_checksum_mismatch",
                meeting_attachment_payload(attachment),
            )
        await to_thread.run_sync(os.replace, temporary, target)
        result = await complete_meeting_attachment_content_upload(
            db,
            user_id=user_id,
            attachment_id=attachment_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            storage_path=str(target),
            actual_byte_size=total_bytes,
            actual_checksum=actual_checksum,
        )
    except MeetingAttachmentConflict as error:
        temporary.unlink(missing_ok=True)
        if target.exists() and attachment.lifecycle != "ready":
            target.unlink(missing_ok=True)
        return _conflict_response(error)
    except BaseException:
        temporary.unlink(missing_ok=True)
        if target.exists() and attachment.lifecycle != "ready":
            target.unlink(missing_ok=True)
        raise
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v1/meeting-attachments/{attachment_id}/content")
async def get_meeting_attachment_content_v1(
    attachment_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attachment_id = _identifier(attachment_id, "附件标识", 160)
    attachment = await find_meeting_attachment(
        db,
        user_id=int(current_user["id"]),
        attachment_id=attachment_id,
    )
    if (
        attachment is None
        or attachment.kind != "image"
        or attachment.lifecycle != "ready"
        or not attachment.storage_path
        or not Path(attachment.storage_path).is_file()
    ):
        raise HTTPException(status_code=404, detail="照片附件不存在或无权访问")
    return FileResponse(
        attachment.storage_path,
        media_type=attachment.mime_type,
        filename=attachment.file_name,
    )


@router.delete("/v1/meeting-attachments/{attachment_id}")
async def delete_meeting_attachment_v1(
    attachment_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能修改附件")
    attachment_id = _identifier(attachment_id, "附件标识", 160)
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "附件请求标识")
    request_hash = meeting_attachment_request_hash(
        "delete",
        attachment_id,
        {"expected_revision": expected_revision},
    )
    try:
        result = await delete_meeting_attachment(
            db,
            user_id=user_id,
            attachment_id=attachment_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="附件不存在或无权访问") from error
    except MeetingAttachmentConflict as error:
        return _conflict_response(error)
    await db.commit()
    current = await find_meeting_attachment(
        db,
        user_id=user_id,
        attachment_id=attachment_id,
    )
    cleanup_path = result.cleanup_path or (current.storage_path if current is not None else None)
    if cleanup_path:
        try:
            await to_thread.run_sync(_delete_storage_file, cleanup_path)
            if current is not None and current.lifecycle == "deleted" and current.storage_path == cleanup_path:
                current.storage_path = None
                await db.commit()
        except Exception as error:
            # Keep storage_path on the tombstone so this request can retry the
            # cleanup and meeting retention can still collect the file.
            raise HTTPException(status_code=500, detail="附件已删除，但文件清理尚未完成") from error
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )
