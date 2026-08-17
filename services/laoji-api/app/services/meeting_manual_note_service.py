from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_manual_note import MeetingManualNote, MeetingManualNoteOperation


@dataclass(frozen=True)
class ManualNoteUpsertResult:
    payload: dict
    status_code: int
    replayed: bool


class ManualNoteContractConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


def manual_note_request_hash(
    meeting_id: str,
    mutation: dict,
    *,
    precondition: str,
    expected_revision: int | None,
) -> str:
    value = {
        "meeting_id": meeting_id,
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


def _next_updated_at(previous: datetime | None = None) -> datetime:
    now = datetime.utcnow()
    if previous is not None and now <= previous:
        return previous + timedelta(microseconds=1)
    return now


def manual_note_payload(note: MeetingManualNote) -> dict:
    return {
        "schema_version": 2,
        "exists": True,
        "id": note.id,
        "meeting_id": note.meeting_id,
        "revision": note.revision,
        "client_note_revision": note.client_note_revision,
        "client_updated_at_ms": note.client_updated_at_ms,
        "user_edited_at_ms": note.user_edited_at_ms,
        "content": note.content,
        "created_at": _utc_iso(note.created_at),
        "updated_at": _utc_iso(note.updated_at),
    }


def missing_manual_note_payload(meeting_id: str) -> dict:
    return {
        "schema_version": 2,
        "exists": False,
        "id": None,
        "meeting_id": meeting_id,
        "revision": 0,
        "client_note_revision": 0,
        "client_updated_at_ms": 0,
        "user_edited_at_ms": None,
        "content": "",
        "created_at": None,
        "updated_at": None,
    }


async def find_manual_note(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> MeetingManualNote | None:
    return (await db.execute(
        select(MeetingManualNote).where(
            MeetingManualNote.user_id == user_id,
            MeetingManualNote.meeting_id == meeting_id,
        )
    )).scalar_one_or_none()


async def _find_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> MeetingManualNoteOperation | None:
    return (await db.execute(
        select(MeetingManualNoteOperation).where(
            MeetingManualNoteOperation.user_id == user_id,
            MeetingManualNoteOperation.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _operation_result(
    db: AsyncSession,
    operation: MeetingManualNoteOperation,
    request_hash: str,
) -> ManualNoteUpsertResult:
    if operation.request_hash != request_hash:
        current = await find_manual_note(
            db,
            user_id=operation.user_id,
            meeting_id=operation.meeting_id,
        )
        raise ManualNoteContractConflict(
            409,
            "idempotency_key_reused",
            manual_note_payload(current) if current else json.loads(operation.response_json),
        )
    return ManualNoteUpsertResult(
        payload=json.loads(operation.response_json),
        status_code=operation.response_status,
        replayed=True,
    )


async def upsert_meeting_manual_note(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
    precondition: str,
    expected_revision: int | None,
) -> ManualNoteUpsertResult:
    operation = await _find_operation(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
    )
    if operation is not None:
        return await _operation_result(db, operation, request_hash)

    note = await find_manual_note(db, user_id=user_id, meeting_id=meeting_id)
    if precondition == "create":
        if note is not None:
            raise ManualNoteContractConflict(
                412, "manual_note_already_exists", manual_note_payload(note)
            )
        now = _next_updated_at()
        note = MeetingManualNote(
            user_id=user_id,
            meeting_id=meeting_id,
            revision=1,
            created_at=now,
            updated_at=now,
            client_note_revision=mutation["client_note_revision"],
            client_updated_at_ms=mutation["client_updated_at_ms"],
            user_edited_at_ms=mutation.get("user_edited_at_ms"),
            content=mutation["content"],
        )
        db.add(note)
        response_status = 201
    else:
        if note is None:
            raise ManualNoteContractConflict(412, "manual_note_missing", None)
        if expected_revision != note.revision:
            raise ManualNoteContractConflict(
                412, "revision_conflict", manual_note_payload(note)
            )
        next_clock = mutation["client_updated_at_ms"]
        if next_clock < note.client_updated_at_ms:
            raise ManualNoteContractConflict(
                409, "manual_note_clock_regression", manual_note_payload(note)
            )
        changed = any((
            note.client_note_revision != mutation["client_note_revision"],
            note.client_updated_at_ms != next_clock,
            note.user_edited_at_ms != mutation.get("user_edited_at_ms"),
            note.content != mutation["content"],
        ))
        meaningful_change = any((
            note.client_note_revision != mutation["client_note_revision"],
            note.user_edited_at_ms != mutation.get("user_edited_at_ms"),
            note.content != mutation["content"],
        ))
        if meaningful_change and next_clock == note.client_updated_at_ms:
            raise ManualNoteContractConflict(
                409, "manual_note_clock_not_advanced", manual_note_payload(note)
            )
        if changed:
            note.client_note_revision = mutation["client_note_revision"]
            note.client_updated_at_ms = next_clock
            note.user_edited_at_ms = mutation.get("user_edited_at_ms")
            note.content = mutation["content"]
            note.revision += 1
            note.updated_at = _next_updated_at(note.updated_at)
        response_status = 200

    try:
        await db.flush()
        payload = manual_note_payload(note)
        db.add(MeetingManualNoteOperation(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            meeting_id=meeting_id,
            note_id=note.id,
            response_status=response_status,
            response_revision=note.revision,
            response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ))
        await db.flush()
        return ManualNoteUpsertResult(payload=payload, status_code=response_status, replayed=False)
    except IntegrityError:
        await db.rollback()
        replay = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current = await find_manual_note(db, user_id=user_id, meeting_id=meeting_id)
        raise ManualNoteContractConflict(
            412,
            "manual_note_already_exists" if precondition == "create" else "revision_conflict",
            manual_note_payload(current) if current else None,
        )
