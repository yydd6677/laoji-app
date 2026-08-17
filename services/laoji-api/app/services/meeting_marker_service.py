from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_marker import MeetingMarkerOperationV1, MeetingMarkerV1
from app.services.meeting_recording_asset_service import owned_active_meeting


@dataclass(frozen=True)
class MeetingMarkerMutationResult:
    status_code: int
    payload: dict


class MeetingMarkerConflict(Exception):
    def __init__(self, code: str, current: dict | None = None, *, status_code: int = 409):
        super().__init__(code)
        self.code = code
        self.current = current
        self.status_code = status_code


def meeting_marker_request_hash(kind: str, identity: str, payload: dict) -> str:
    encoded = json.dumps(
        {"kind": kind, "identity": identity, "payload": payload},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _server_time(value: datetime | None) -> str | None:
    return value.isoformat(timespec="microseconds") + "Z" if value is not None else None


def meeting_marker_payload(marker: MeetingMarkerV1) -> dict:
    return {
        "schema_version": 1,
        "id": marker.id,
        "meeting_id": marker.meeting_id,
        "client_marker_id": marker.client_marker_id,
        "revision": marker.revision,
        "lifecycle": marker.lifecycle,
        "position_ms": marker.position_ms,
        "label": marker.label,
        "kind": marker.kind,
        "client_created_at_ms": marker.client_created_at_ms,
        "client_updated_at_ms": marker.client_updated_at_ms,
        "created_at": _server_time(marker.created_at),
        "updated_at": _server_time(marker.updated_at),
        "deleted_at": _server_time(marker.deleted_at),
    }


async def find_meeting_marker(
    db: AsyncSession,
    *,
    user_id: int,
    marker_id: str,
) -> MeetingMarkerV1 | None:
    return (
        await db.execute(
            select(MeetingMarkerV1).where(
                MeetingMarkerV1.id == marker_id,
                MeetingMarkerV1.user_id == user_id,
            )
        )
    ).scalar_one_or_none()


async def list_meeting_markers(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> list[MeetingMarkerV1]:
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if meeting is None:
        raise LookupError("meeting_missing")
    return list(
        (
            await db.execute(
                select(MeetingMarkerV1)
                .where(
                    MeetingMarkerV1.user_id == user_id,
                    MeetingMarkerV1.meeting_id == meeting_id,
                )
                .order_by(MeetingMarkerV1.created_at, MeetingMarkerV1.id)
            )
        ).scalars().all()
    )


def _immutable_registration(marker: MeetingMarkerV1) -> dict:
    return {
        "meeting_id": marker.meeting_id,
        "client_marker_id": marker.client_marker_id,
        "position_ms": marker.position_ms,
        "label": marker.label,
        "kind": marker.kind,
        "client_created_at_ms": marker.client_created_at_ms,
        "client_updated_at_ms": marker.client_updated_at_ms,
    }


async def register_meeting_marker(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
) -> MeetingMarkerMutationResult:
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
            select(MeetingMarkerV1).where(
                MeetingMarkerV1.user_id == user_id,
                MeetingMarkerV1.client_marker_id == mutation["client_marker_id"],
            )
        )
    ).scalar_one_or_none()
    expected = {"meeting_id": meeting_id, **mutation}
    expected.pop("schema_version", None)
    if existing is not None:
        if _immutable_registration(existing) != expected:
            raise MeetingMarkerConflict(
                "marker_identity_mismatch",
                meeting_marker_payload(existing),
            )
        result = MeetingMarkerMutationResult(200, meeting_marker_payload(existing))
        await _save_operation(
            db,
            user_id=user_id,
            marker_id=existing.id,
            operation_kind="register",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            result=result,
        )
        return result
    now = datetime.utcnow()
    marker = MeetingMarkerV1(
        id=str(uuid.uuid4()),
        meeting_id=meeting_id,
        user_id=user_id,
        client_marker_id=mutation["client_marker_id"],
        revision=1,
        lifecycle="active",
        position_ms=mutation["position_ms"],
        label=mutation["label"],
        kind=mutation["kind"],
        client_created_at_ms=mutation["client_created_at_ms"],
        client_updated_at_ms=mutation["client_updated_at_ms"],
        created_at=now,
        updated_at=now,
        deleted_at=None,
    )
    db.add(marker)
    await db.flush()
    result = MeetingMarkerMutationResult(201, meeting_marker_payload(marker))
    await _save_operation(
        db,
        user_id=user_id,
        marker_id=marker.id,
        operation_kind="register",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
    )
    return result


async def delete_meeting_marker(
    db: AsyncSession,
    *,
    user_id: int,
    marker_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> MeetingMarkerMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay
    marker = await find_meeting_marker(db, user_id=user_id, marker_id=marker_id)
    if marker is None:
        raise LookupError("marker_missing")
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=marker.meeting_id)
    if meeting is None:
        raise LookupError("marker_missing")
    if marker.lifecycle == "deleted":
        result = MeetingMarkerMutationResult(200, meeting_marker_payload(marker))
        await _save_operation(
            db,
            user_id=user_id,
            marker_id=marker.id,
            operation_kind="delete",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            result=result,
        )
        return result
    if marker.revision != expected_revision:
        raise MeetingMarkerConflict(
            "revision_conflict",
            meeting_marker_payload(marker),
            status_code=412,
        )
    now = datetime.utcnow()
    marker.lifecycle = "deleted"
    marker.revision += 1
    marker.updated_at = now
    marker.deleted_at = now
    await db.flush()
    result = MeetingMarkerMutationResult(200, meeting_marker_payload(marker))
    await _save_operation(
        db,
        user_id=user_id,
        marker_id=marker.id,
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
) -> MeetingMarkerMutationResult | None:
    operation = (
        await db.execute(
            select(MeetingMarkerOperationV1).where(
                MeetingMarkerOperationV1.user_id == user_id,
                MeetingMarkerOperationV1.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if operation is None:
        return None
    if operation.request_hash != request_hash:
        raise MeetingMarkerConflict("idempotency_key_reused")
    return MeetingMarkerMutationResult(
        operation.response_status,
        json.loads(operation.response_json),
    )


async def _save_operation(
    db: AsyncSession,
    *,
    user_id: int,
    marker_id: str,
    operation_kind: str,
    idempotency_key: str,
    request_hash: str,
    result: MeetingMarkerMutationResult,
) -> None:
    db.add(
        MeetingMarkerOperationV1(
            id=str(uuid.uuid4()),
            user_id=user_id,
            marker_id=marker_id,
            operation_kind=operation_kind,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            response_status=result.status_code,
            response_json=json.dumps(
                result.payload,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
            created_at=datetime.utcnow(),
        )
    )
    await db.flush()
