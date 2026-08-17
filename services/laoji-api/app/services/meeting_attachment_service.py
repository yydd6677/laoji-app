from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.meeting_attachment import (
    MeetingAttachmentOperationV1,
    MeetingAttachmentV1,
)
from app.services.meeting_recording_asset_service import owned_active_meeting


@dataclass(frozen=True)
class MeetingAttachmentMutationResult:
    status_code: int
    payload: dict
    cleanup_path: str | None = None


class MeetingAttachmentConflict(Exception):
    def __init__(self, code: str, current: dict | None = None, *, status_code: int = 409):
        super().__init__(code)
        self.code = code
        self.current = current
        self.status_code = status_code


def meeting_attachment_request_hash(kind: str, identity: str, payload: dict) -> str:
    encoded = json.dumps(
        {"kind": kind, "identity": identity, "payload": payload},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _server_time(value: datetime | None) -> str | None:
    return value.isoformat(timespec="microseconds") + "Z" if value is not None else None


def meeting_attachment_payload(attachment: MeetingAttachmentV1) -> dict:
    content_ready = (
        attachment.kind == "image"
        and attachment.lifecycle == "ready"
        and bool(attachment.storage_path)
    )
    return {
        "schema_version": 1,
        "id": attachment.id,
        "meeting_id": attachment.meeting_id,
        "client_attachment_id": attachment.client_attachment_id,
        "revision": attachment.revision,
        "lifecycle": attachment.lifecycle,
        "position_ms": attachment.position_ms,
        "kind": attachment.kind,
        "text_content": attachment.text_content,
        "mime_type": attachment.mime_type,
        "file_name": attachment.file_name,
        "byte_size": attachment.byte_size,
        "checksum_sha256": attachment.checksum_sha256,
        "content_url": (
            f"/api/laoji/v1/meeting-attachments/{attachment.id}/content"
            if content_ready else None
        ),
        "requires_auth": True,
        "client_created_at_ms": attachment.client_created_at_ms,
        "client_updated_at_ms": attachment.client_updated_at_ms,
        "created_at": _server_time(attachment.created_at),
        "updated_at": _server_time(attachment.updated_at),
        "deleted_at": _server_time(attachment.deleted_at),
    }


async def find_meeting_attachment(
    db: AsyncSession,
    *,
    user_id: int,
    attachment_id: str,
) -> MeetingAttachmentV1 | None:
    return (
        await db.execute(
            select(MeetingAttachmentV1).where(
                MeetingAttachmentV1.id == attachment_id,
                MeetingAttachmentV1.user_id == user_id,
            )
        )
    ).scalar_one_or_none()


async def list_meeting_attachments(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> list[MeetingAttachmentV1]:
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if meeting is None:
        raise LookupError("meeting_missing")
    return list(
        (
            await db.execute(
                select(MeetingAttachmentV1)
                .where(
                    MeetingAttachmentV1.user_id == user_id,
                    MeetingAttachmentV1.meeting_id == meeting_id,
                )
                .order_by(MeetingAttachmentV1.created_at, MeetingAttachmentV1.id)
            )
        ).scalars().all()
    )


def _immutable_registration(attachment: MeetingAttachmentV1) -> dict:
    return {
        "meeting_id": attachment.meeting_id,
        "client_attachment_id": attachment.client_attachment_id,
        "position_ms": attachment.position_ms,
        "kind": attachment.kind,
        "text_content": attachment.text_content,
        "mime_type": attachment.mime_type,
        "file_name": attachment.file_name,
        "byte_size": attachment.byte_size,
        "checksum_sha256": attachment.checksum_sha256,
        "client_created_at_ms": attachment.client_created_at_ms,
        "client_updated_at_ms": attachment.client_updated_at_ms,
    }


async def register_meeting_attachment(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
) -> MeetingAttachmentMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if meeting is None:
        raise LookupError("meeting_missing")
    existing = (
        await db.execute(
            select(MeetingAttachmentV1).where(
                MeetingAttachmentV1.user_id == user_id,
                MeetingAttachmentV1.client_attachment_id
                == mutation["client_attachment_id"],
            )
        )
    ).scalar_one_or_none()
    expected = {"meeting_id": meeting_id, **mutation}
    expected.pop("schema_version", None)
    if existing is not None:
        if _immutable_registration(existing) != expected:
            raise MeetingAttachmentConflict(
                "attachment_identity_mismatch",
                meeting_attachment_payload(existing),
            )
        result = MeetingAttachmentMutationResult(200, meeting_attachment_payload(existing))
        await _save_operation(
            db,
            user_id=user_id,
            attachment_id=existing.id,
            operation_kind="register",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            result=result,
        )
        return result
    now = datetime.utcnow()
    attachment = MeetingAttachmentV1(
        id=str(uuid.uuid4()),
        meeting_id=meeting_id,
        user_id=user_id,
        client_attachment_id=mutation["client_attachment_id"],
        revision=1,
        lifecycle="ready" if mutation["kind"] == "text" else "registered",
        position_ms=mutation["position_ms"],
        kind=mutation["kind"],
        text_content=mutation["text_content"],
        mime_type=mutation["mime_type"],
        file_name=mutation["file_name"],
        byte_size=mutation["byte_size"],
        checksum_sha256=mutation["checksum_sha256"],
        storage_path=None,
        client_created_at_ms=mutation["client_created_at_ms"],
        client_updated_at_ms=mutation["client_updated_at_ms"],
        created_at=now,
        updated_at=now,
        deleted_at=None,
    )
    db.add(attachment)
    await db.flush()
    result = MeetingAttachmentMutationResult(201, meeting_attachment_payload(attachment))
    await _save_operation(
        db,
        user_id=user_id,
        attachment_id=attachment.id,
        operation_kind="register",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def prepare_meeting_attachment_content_upload(
    db: AsyncSession,
    *,
    user_id: int,
    attachment_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> tuple[MeetingAttachmentV1, MeetingAttachmentMutationResult | None]:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    attachment = await find_meeting_attachment(
        db,
        user_id=user_id,
        attachment_id=attachment_id,
    )
    if attachment is None:
        raise LookupError("attachment_missing")
    meeting = await owned_active_meeting(
        db,
        user_id=user_id,
        meeting_id=attachment.meeting_id,
    )
    if meeting is None:
        raise LookupError("attachment_missing")
    if replay is not None:
        return attachment, replay
    if attachment.revision != expected_revision:
        raise MeetingAttachmentConflict(
            "revision_conflict",
            meeting_attachment_payload(attachment),
            status_code=412,
        )
    if attachment.lifecycle == "deleted":
        raise MeetingAttachmentConflict(
            "attachment_deleted",
            meeting_attachment_payload(attachment),
        )
    if attachment.kind != "image":
        raise MeetingAttachmentConflict(
            "attachment_content_unavailable",
            meeting_attachment_payload(attachment),
        )
    if attachment.lifecycle == "ready":
        raise MeetingAttachmentConflict(
            "attachment_content_immutable",
            meeting_attachment_payload(attachment),
        )
    if attachment.lifecycle != "registered":
        raise MeetingAttachmentConflict(
            "attachment_state_invalid",
            meeting_attachment_payload(attachment),
        )
    return attachment, None


async def complete_meeting_attachment_content_upload(
    db: AsyncSession,
    *,
    user_id: int,
    attachment_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
    storage_path: str,
    actual_byte_size: int,
    actual_checksum: str,
) -> MeetingAttachmentMutationResult:
    attachment = await find_meeting_attachment(
        db,
        user_id=user_id,
        attachment_id=attachment_id,
    )
    if attachment is None:
        raise LookupError("attachment_missing")
    if attachment.revision != expected_revision or attachment.lifecycle != "registered":
        raise MeetingAttachmentConflict(
            "revision_conflict",
            meeting_attachment_payload(attachment),
            status_code=412,
        )
    if attachment.byte_size != actual_byte_size:
        raise MeetingAttachmentConflict(
            "attachment_size_mismatch",
            meeting_attachment_payload(attachment),
        )
    if attachment.checksum_sha256 != actual_checksum:
        raise MeetingAttachmentConflict(
            "attachment_checksum_mismatch",
            meeting_attachment_payload(attachment),
        )
    now = datetime.utcnow()
    attachment.storage_path = storage_path
    attachment.lifecycle = "ready"
    attachment.revision += 1
    attachment.updated_at = now
    await db.flush()
    result = MeetingAttachmentMutationResult(200, meeting_attachment_payload(attachment))
    await _save_operation(
        db,
        user_id=user_id,
        attachment_id=attachment.id,
        operation_kind="content",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def delete_meeting_attachment(
    db: AsyncSession,
    *,
    user_id: int,
    attachment_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> MeetingAttachmentMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay
    attachment = await find_meeting_attachment(
        db,
        user_id=user_id,
        attachment_id=attachment_id,
    )
    if attachment is None:
        raise LookupError("attachment_missing")
    meeting = await owned_active_meeting(
        db,
        user_id=user_id,
        meeting_id=attachment.meeting_id,
    )
    if meeting is None:
        raise LookupError("attachment_missing")
    if attachment.lifecycle == "deleted":
        result = MeetingAttachmentMutationResult(200, meeting_attachment_payload(attachment))
        await _save_operation(
            db,
            user_id=user_id,
            attachment_id=attachment.id,
            operation_kind="delete",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            result=result,
        )
        return result
    if attachment.revision != expected_revision:
        raise MeetingAttachmentConflict(
            "revision_conflict",
            meeting_attachment_payload(attachment),
            status_code=412,
        )
    cleanup_path = attachment.storage_path
    now = datetime.utcnow()
    attachment.lifecycle = "deleted"
    attachment.revision += 1
    attachment.deleted_at = now
    attachment.updated_at = now
    await db.flush()
    result = MeetingAttachmentMutationResult(
        200,
        meeting_attachment_payload(attachment),
        cleanup_path=cleanup_path,
    )
    await _save_operation(
        db,
        user_id=user_id,
        attachment_id=attachment.id,
        operation_kind="delete",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def _operation_replay(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
) -> MeetingAttachmentMutationResult | None:
    operation = (
        await db.execute(
            select(MeetingAttachmentOperationV1).where(
                MeetingAttachmentOperationV1.user_id == user_id,
                MeetingAttachmentOperationV1.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if operation is None:
        return None
    if operation.request_hash != request_hash:
        raise MeetingAttachmentConflict("idempotency_key_reused")
    return MeetingAttachmentMutationResult(
        operation.response_status,
        json.loads(operation.response_json),
    )


async def _save_operation(
    db: AsyncSession,
    *,
    user_id: int,
    attachment_id: str,
    operation_kind: str,
    idempotency_key: str,
    request_hash: str,
    result: MeetingAttachmentMutationResult,
) -> None:
    db.add(MeetingAttachmentOperationV1(
        id=str(uuid.uuid4()),
        user_id=user_id,
        attachment_id=attachment_id,
        operation_kind=operation_kind,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        response_status=result.status_code,
        response_json=json.dumps(
            result.payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ),
        created_at=datetime.utcnow(),
    ))
    await db.flush()


def meeting_attachment_storage_path(
    *,
    user_id: int,
    meeting_id: str,
    attachment_id: str,
    extension: str,
) -> Path:
    directory = (
        Path(settings.audio_storage_abs_path)
        / "app-meeting-attachments-v1"
        / f"user-{user_id}"
        / meeting_id
    )
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{attachment_id}{extension}"
