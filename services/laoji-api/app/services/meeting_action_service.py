from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_action import MeetingActionItem, MeetingActionOperation


@dataclass(frozen=True)
class ActionUpsertResult:
    payload: dict
    status_code: int
    replayed: bool


class ActionContractConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


_MUTABLE_FIELDS = (
    "content",
    "status",
    "assignee",
    "due_at_ms",
    "reminder_at_ms",
    "followup_event_source_id",
    "client_updated_at_ms",
    "user_edited_at_ms",
    "completed_at_ms",
)

_IMMUTABLE_FIELDS = (
    "client_created_at_ms",
    "source_kind",
    "source_summary_version_id",
    "source_segment_id",
    "source_start_ms",
    "generation_fingerprint",
)


def action_request_hash(
    meeting_id: str,
    client_action_id: str,
    mutation: dict,
    *,
    precondition: str,
    expected_revision: int | None,
) -> str:
    value = {
        "meeting_id": meeting_id,
        "client_action_id": client_action_id,
        "mutation": mutation,
        "precondition": precondition,
        "expected_revision": expected_revision,
    }
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def action_payload(action: MeetingActionItem) -> dict:
    return {
        "id": action.id,
        "meeting_id": action.meeting_id,
        "client_action_id": action.client_action_id,
        "revision": action.revision,
        "client_created_at_ms": action.client_created_at_ms,
        "client_updated_at_ms": action.client_updated_at_ms,
        "user_edited_at_ms": action.user_edited_at_ms,
        "completed_at_ms": action.completed_at_ms,
        "content": action.content,
        "status": action.status,
        "assignee": action.assignee,
        "due_at_ms": action.due_at_ms,
        "reminder_at_ms": action.reminder_at_ms,
        "followup_event_source_id": action.followup_event_source_id,
        "source_kind": action.source_kind,
        "source_summary_version_id": action.source_summary_version_id,
        "source_segment_id": action.source_segment_id,
        "source_start_ms": action.source_start_ms,
        "generation_fingerprint": action.generation_fingerprint,
        "created_at": _utc_iso(action.created_at),
        "updated_at": _utc_iso(action.updated_at),
    }


def next_action_updated_at(previous: datetime | None = None) -> datetime:
    """Returns a cursor-safe UTC timestamp that advances for one entity."""
    now = datetime.utcnow()
    if previous is not None and now <= previous:
        return previous + timedelta(microseconds=1)
    return now


async def _find_action(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    client_action_id: str,
) -> MeetingActionItem | None:
    return (await db.execute(
        select(MeetingActionItem).where(
            MeetingActionItem.user_id == user_id,
            MeetingActionItem.meeting_id == meeting_id,
            MeetingActionItem.client_action_id == client_action_id,
        )
    )).scalar_one_or_none()


async def _find_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> MeetingActionOperation | None:
    return (await db.execute(
        select(MeetingActionOperation).where(
            MeetingActionOperation.user_id == user_id,
            MeetingActionOperation.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _operation_result(
    db: AsyncSession,
    operation: MeetingActionOperation,
    request_hash: str,
) -> ActionUpsertResult:
    if operation.request_hash != request_hash:
        current = await _find_action(
            db,
            user_id=operation.user_id,
            meeting_id=operation.meeting_id,
            client_action_id=operation.client_action_id,
        )
        raise ActionContractConflict(
            409,
            "idempotency_key_reused",
            action_payload(current) if current else json.loads(operation.response_json),
        )
    return ActionUpsertResult(
        payload=json.loads(operation.response_json),
        status_code=operation.response_status,
        replayed=True,
    )


async def upsert_meeting_action(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    client_action_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
    precondition: str,
    expected_revision: int | None,
) -> ActionUpsertResult:
    operation = await _find_operation(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
    )
    if operation is not None:
        return await _operation_result(db, operation, request_hash)

    action = await _find_action(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
        client_action_id=client_action_id,
    )
    if precondition == "create":
        if action is not None:
            raise ActionContractConflict(412, "action_already_exists", action_payload(action))
        if mutation.get("remote_id") is not None:
            raise ActionContractConflict(409, "remote_identity_mismatch", None)
        now = next_action_updated_at()
        action = MeetingActionItem(
            user_id=user_id,
            meeting_id=meeting_id,
            client_action_id=client_action_id,
            revision=1,
            created_at=now,
            updated_at=now,
            **{
                field: mutation.get(field)
                for field in (*_MUTABLE_FIELDS, *_IMMUTABLE_FIELDS)
            },
        )
        db.add(action)
        response_status = 201
    else:
        if action is None:
            raise ActionContractConflict(412, "action_missing", None)
        if expected_revision != action.revision:
            raise ActionContractConflict(412, "revision_conflict", action_payload(action))
        remote_id = mutation.get("remote_id")
        if remote_id is not None and remote_id != action.id:
            raise ActionContractConflict(409, "remote_identity_mismatch", action_payload(action))
        metadata_enriched = False
        if action.client_created_at_ms == 0 and mutation.get("client_created_at_ms", 0) > 0:
            action.client_created_at_ms = mutation["client_created_at_ms"]
            metadata_enriched = True
        if action.generation_fingerprint is None and mutation.get("generation_fingerprint"):
            action.generation_fingerprint = mutation["generation_fingerprint"]
            metadata_enriched = True
        if any(getattr(action, field) != mutation.get(field) for field in _IMMUTABLE_FIELDS):
            raise ActionContractConflict(409, "action_identity_mismatch", action_payload(action))
        mutable_changed = any(
            getattr(action, field) != mutation.get(field) for field in _MUTABLE_FIELDS
        )
        if mutation.get("client_updated_at_ms", 0) < action.client_updated_at_ms:
            raise ActionContractConflict(409, "action_clock_regression", action_payload(action))
        if mutable_changed and mutation.get("client_updated_at_ms") == action.client_updated_at_ms:
            raise ActionContractConflict(409, "action_clock_not_advanced", action_payload(action))
        changed = metadata_enriched or mutable_changed
        if changed:
            for field in _MUTABLE_FIELDS:
                setattr(action, field, mutation.get(field))
            action.revision += 1
            action.updated_at = next_action_updated_at(action.updated_at)
        response_status = 200

    try:
        await db.flush()
        payload = action_payload(action)
        db.add(MeetingActionOperation(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            meeting_id=meeting_id,
            client_action_id=client_action_id,
            action_id=action.id,
            response_status=response_status,
            response_revision=action.revision,
            response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ))
        await db.flush()
        return ActionUpsertResult(payload=payload, status_code=response_status, replayed=False)
    except IntegrityError:
        await db.rollback()
        replay = await _find_operation(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
        )
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current = await _find_action(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            client_action_id=client_action_id,
        )
        raise ActionContractConflict(
            412,
            "action_already_exists" if precondition == "create" else "revision_conflict",
            action_payload(current) if current else None,
        )
