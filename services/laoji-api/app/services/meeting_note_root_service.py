from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.models.meeting import Meeting
from app.models.meeting_note_root import MeetingNoteRootOperationV2, MeetingNoteRootV2
from app.models.meeting_occurrence import MeetingOccurrenceLink, MeetingScheduleSnapshotV2
from app.models.summary import FinalSummary
from app.models.transcript import TranscriptLine
from app.services.meeting_occurrence_service import (
    find_occurrence_by_identity,
    find_occurrence_by_meeting,
    find_occurrence_snapshot,
    occurrence_payload_for_link,
)


MEETING_NOTE_SOFT_DELETE_DAYS = 30


@dataclass(frozen=True)
class MeetingNoteRootResult:
    payload: dict
    status_code: int
    replayed: bool


class MeetingNoteRootConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


def meeting_note_root_request_hash(
    operation_kind: str,
    identity: str,
    mutation: dict,
) -> str:
    """Hash stable request meaning, deliberately excluding conditional headers.

    A retry may observe a newer revision after the first response was lost. The
    idempotency key must replay that first result instead of turning the same
    mutation into a different operation merely because If-Match changed.
    """

    def json_default(value):
        if isinstance(value, datetime):
            return _utc_iso(value)
        raise TypeError(f"unsupported request hash value: {type(value).__name__}")

    encoded = json.dumps(
        {
            "operation_kind": operation_kind,
            "identity": identity,
            "mutation": mutation,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _next_updated_at(previous: datetime | None = None) -> datetime:
    now = datetime.utcnow()
    if previous is not None and now <= previous:
        return previous + timedelta(microseconds=1)
    return now


def _participants(meeting: Meeting) -> list[str]:
    if not meeting.participants:
        return []
    try:
        value = json.loads(meeting.participants)
    except (TypeError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


async def find_meeting_note_root(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> MeetingNoteRootV2 | None:
    return (await db.execute(
        select(MeetingNoteRootV2).where(
            MeetingNoteRootV2.user_id == user_id,
            MeetingNoteRootV2.meeting_id == meeting_id,
        )
    )).scalar_one_or_none()


async def find_meeting_note_root_by_client_id(
    db: AsyncSession,
    *,
    user_id: int,
    client_note_id: str,
) -> MeetingNoteRootV2 | None:
    return (await db.execute(
        select(MeetingNoteRootV2).where(
            MeetingNoteRootV2.user_id == user_id,
            MeetingNoteRootV2.client_note_id == client_note_id,
        )
    )).scalar_one_or_none()


async def _owned_meeting(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> Meeting | None:
    return (await db.execute(
        select(Meeting).where(Meeting.user_id == user_id, Meeting.id == meeting_id)
    )).scalar_one_or_none()


async def _processing_stages(db: AsyncSession, meeting: Meeting) -> list[dict]:
    transcript_count = int((await db.execute(
        select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting.id)
    )).scalar() or 0)
    summary_count = int((await db.execute(
        select(func.count(FinalSummary.id)).where(FinalSummary.meeting_id == meeting.id)
    )).scalar() or 0)
    status = str(meeting.status or "").strip().lower()
    has_audio = bool(meeting.audio_path)
    failed = status in {"failed", "error"}
    processing = status in {"recording", "paused", "processing", "transcribing"}

    capture_status = (
        "failed_retryable" if failed and not has_audio and transcript_count == 0
        else "processing" if status in {"recording", "paused"}
        else "ready" if has_audio or transcript_count > 0 or status in {"completed", "ended"}
        else "idle"
    )
    upload_status = (
        "ready" if has_audio
        else "failed_retryable" if failed
        else "processing" if status in {"processing", "transcribing"}
        else "idle"
    )
    transcript_status = (
        "partial" if transcript_count > 0 and processing
        else "ready" if transcript_count > 0
        else "failed_retryable" if failed
        else "processing" if status in {"processing", "transcribing"}
        else "idle"
    )
    summary_status = "ready" if summary_count > 0 else "idle"
    statuses = {
        "capture": capture_status,
        "upload": upload_status,
        "transcript": transcript_status,
        "summary": summary_status,
        "speaker": "idle",
    }
    return [
        {
            "stage": stage,
            "status": stage_status,
            "attempt": 0,
            "progress": None,
            "error_code": "meeting_processing_failed" if stage_status == "failed_retryable" else None,
            "retryable": stage_status == "failed_retryable",
        }
        for stage, stage_status in statuses.items()
    ]


async def meeting_note_root_payload(
    db: AsyncSession,
    meeting: Meeting,
    root: MeetingNoteRootV2,
) -> dict:
    link = await find_occurrence_by_meeting(
        db,
        user_id=root.user_id,
        meeting_id=root.meeting_id,
    )
    occurrence = await occurrence_payload_for_link(db, link) if link is not None else None
    return {
        "schema_version": 2,
        "id": root.meeting_id,
        "client_note_id": root.client_note_id,
        "revision": root.revision,
        "origin": root.origin,
        "entry_point": root.entry_point,
        "title": meeting.title or "",
        "description": meeting.description,
        "participants": _participants(meeting),
        "location": meeting.location,
        "mode": meeting.mode or "realtime",
        "status": meeting.status or "created",
        "recorded_at": _utc_iso(meeting.recorded_at),
        "lifecycle": root.lifecycle,
        "deleted_at": _utc_iso(root.deleted_at),
        "occurrence_ref": None if occurrence is None else {
            "id": occurrence["id"],
            "revision": occurrence["revision"],
            "source_event_id": occurrence["source_event_id"],
            "occurrence_date": occurrence["occurrence_date"],
            "calendar_revision": occurrence["calendar_revision"],
            "recurrence_segment_id": occurrence["recurrence_segment_id"],
            "series_key": occurrence["series_key"],
            "link_state": occurrence["link_state"],
        },
        "schedule_snapshot": None if occurrence is None else occurrence["schedule_snapshot"],
        "processing_stages": await _processing_stages(db, meeting),
        "created_at": _utc_iso(root.created_at),
        "updated_at": _utc_iso(root.updated_at),
    }


async def _find_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> MeetingNoteRootOperationV2 | None:
    return (await db.execute(
        select(MeetingNoteRootOperationV2).where(
            MeetingNoteRootOperationV2.user_id == user_id,
            MeetingNoteRootOperationV2.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _operation_result(
    db: AsyncSession,
    operation: MeetingNoteRootOperationV2,
    request_hash: str,
) -> MeetingNoteRootResult:
    if operation.request_hash != request_hash:
        root = await find_meeting_note_root(
            db,
            user_id=operation.user_id,
            meeting_id=operation.meeting_id,
        )
        meeting = await _owned_meeting(
            db,
            user_id=operation.user_id,
            meeting_id=operation.meeting_id,
        )
        current = (
            await meeting_note_root_payload(db, meeting, root)
            if meeting is not None and root is not None
            else None
        )
        raise MeetingNoteRootConflict(409, "idempotency_key_reused", current)
    return MeetingNoteRootResult(
        payload=json.loads(operation.response_json),
        status_code=operation.response_status,
        replayed=True,
    )


def _add_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
    operation_kind: str,
    meeting_id: str,
    payload: dict,
    status_code: int,
    revision: int,
) -> None:
    db.add(MeetingNoteRootOperationV2(
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        operation_kind=operation_kind,
        meeting_id=meeting_id,
        response_status=status_code,
        response_revision=revision,
        response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    ))


async def create_meeting_note_root(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
) -> MeetingNoteRootResult:
    operation = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
    if operation is not None:
        return await _operation_result(db, operation, request_hash)

    current_root = await find_meeting_note_root_by_client_id(
        db,
        user_id=user_id,
        client_note_id=mutation["client_note_id"],
    )
    if current_root is not None:
        current_meeting = await _owned_meeting(
            db,
            user_id=user_id,
            meeting_id=current_root.meeting_id,
        )
        raise MeetingNoteRootConflict(
            409,
            "client_note_id_conflict",
            await meeting_note_root_payload(db, current_meeting, current_root)
            if current_meeting is not None else None,
        )

    occurrence = mutation.get("occurrence_ref")
    supersedes_meeting_id = mutation.get("supersedes_meeting_id")
    replaced_link = None
    replaced_snapshot = None
    replaced_root = None
    replaced_meeting = None
    if occurrence is not None:
        existing_link = await find_occurrence_by_identity(
            db,
            user_id=user_id,
            source_event_id=occurrence["source_event_id"],
            occurrence_date=occurrence["occurrence_date"],
        )
        if existing_link is not None:
            existing_root = await find_meeting_note_root(
                db,
                user_id=user_id,
                meeting_id=existing_link.meeting_id,
            )
            existing_meeting = await _owned_meeting(
                db,
                user_id=user_id,
                meeting_id=existing_link.meeting_id,
            )
            if (
                supersedes_meeting_id != existing_link.meeting_id
                or existing_root is None
                or existing_meeting is None
                or existing_root.lifecycle != "deleted"
            ):
                raise MeetingNoteRootConflict(
                    409,
                    "occurrence_already_bound",
                    await meeting_note_root_payload(db, existing_meeting, existing_root)
                    if existing_root is not None and existing_meeting is not None else None,
                )
            existing_snapshot = await find_occurrence_snapshot(
                db,
                user_id=user_id,
                meeting_id=existing_link.meeting_id,
            )
            if existing_snapshot is None:
                raise RuntimeError("superseded occurrence schedule snapshot is missing")
            replaced_link = existing_link
            replaced_snapshot = existing_snapshot
            replaced_root = existing_root
            replaced_meeting = existing_meeting
        elif supersedes_meeting_id is not None:
            raise MeetingNoteRootConflict(409, "occurrence_replacement_missing", None)

    now = _next_updated_at()
    meeting_id = str(uuid.uuid4())
    meeting = Meeting(
        id=meeting_id,
        user_id=user_id,
        app_owned=1,
        client_request_id=mutation.get("client_request_id"),
        title=mutation["title"],
        description=mutation.get("description"),
        location=mutation.get("location"),
        participants=json.dumps(mutation["participants"], ensure_ascii=False),
        status="created",
        mode=mutation["mode"],
        recorded_at=mutation.get("recorded_at"),
        created_at=now,
        updated_at=now,
    )
    root = MeetingNoteRootV2(
        meeting_id=meeting_id,
        user_id=user_id,
        client_note_id=mutation["client_note_id"],
        revision=1,
        origin=mutation["origin"],
        entry_point=mutation.get("entry_point"),
        lifecycle="active",
        created_at=now,
        updated_at=now,
    )
    db.add_all([meeting, root])
    if occurrence is not None:
        snapshot = mutation["schedule_snapshot"]
        if replaced_link is not None and replaced_snapshot is not None:
            # The prior root remains a recoverable tombstone, but a user who
            # explicitly starts this occurrence again gives the live calendar
            # identity to the new root. Preserve the old meeting contents while
            # moving the single occurrence row and refreshing the new recording
            # snapshot atomically.
            await db.flush()
            replaced_link.meeting_id = meeting_id
            replaced_link.revision += 1
            replaced_link.calendar_revision = occurrence.get("calendar_revision")
            replaced_link.recurrence_segment_id = occurrence.get("recurrence_segment_id")
            replaced_link.series_key = occurrence.get("series_key")
            replaced_link.link_state = "active"
            replaced_link.client_updated_at_ms = snapshot["captured_at_ms"]
            replaced_link.updated_at = now
            replaced_snapshot.meeting_id = meeting_id
            replaced_snapshot.event_title = snapshot["event_title"]
            replaced_snapshot.planned_start_ms = snapshot.get("planned_start_ms")
            replaced_snapshot.planned_end_ms = snapshot.get("planned_end_ms")
            replaced_snapshot.all_day = 1 if snapshot["all_day"] else 0
            replaced_snapshot.timezone_id = snapshot.get("timezone_id")
            replaced_snapshot.location = snapshot.get("location")
            replaced_snapshot.participants_json = json.dumps(
                snapshot["participants"], ensure_ascii=False, separators=(",", ":")
            )
            replaced_snapshot.description = snapshot.get("description")
            replaced_snapshot.captured_event_revision = snapshot.get("captured_event_revision")
            replaced_snapshot.captured_at_ms = snapshot["captured_at_ms"]
            if replaced_root is not None and replaced_meeting is not None:
                replaced_root.revision += 1
                replaced_root.updated_at = now
                replaced_meeting.updated_at = now
        else:
            db.add_all([
              MeetingOccurrenceLink(
                user_id=user_id,
                meeting_id=meeting_id,
                revision=1,
                source_event_id=occurrence["source_event_id"],
                occurrence_date=occurrence["occurrence_date"],
                calendar_revision=occurrence.get("calendar_revision"),
                recurrence_segment_id=occurrence.get("recurrence_segment_id"),
                series_key=occurrence.get("series_key"),
                link_state="active",
                client_updated_at_ms=snapshot["captured_at_ms"],
                created_at=now,
                updated_at=now,
            ),
              MeetingScheduleSnapshotV2(
                user_id=user_id,
                meeting_id=meeting_id,
                event_title=snapshot["event_title"],
                planned_start_ms=snapshot.get("planned_start_ms"),
                planned_end_ms=snapshot.get("planned_end_ms"),
                all_day=1 if snapshot["all_day"] else 0,
                timezone_id=snapshot.get("timezone_id"),
                location=snapshot.get("location"),
                participants_json=json.dumps(
                    snapshot["participants"], ensure_ascii=False, separators=(",", ":")
                ),
                description=snapshot.get("description"),
                captured_event_revision=snapshot.get("captured_event_revision"),
                captured_at_ms=snapshot["captured_at_ms"],
                created_at=now,
              ),
            ])
    try:
        await db.flush()
        payload = await meeting_note_root_payload(db, meeting, root)
        _add_operation(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            operation_kind="create",
            meeting_id=meeting_id,
            payload=payload,
            status_code=201,
            revision=root.revision,
        )
        await db.flush()
        return MeetingNoteRootResult(payload=payload, status_code=201, replayed=False)
    except (IntegrityError, StaleDataError):
        await db.rollback()
        replay = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current_root = await find_meeting_note_root_by_client_id(
            db,
            user_id=user_id,
            client_note_id=mutation["client_note_id"],
        )
        current_meeting = (
            await _owned_meeting(db, user_id=user_id, meeting_id=current_root.meeting_id)
            if current_root is not None else None
        )
        raise MeetingNoteRootConflict(
            409,
            "client_note_id_conflict",
            await meeting_note_root_payload(db, current_meeting, current_root)
            if current_root is not None and current_meeting is not None else None,
        )


async def mutate_meeting_note_root(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    operation_kind: str,
    expected_revision: int,
    mutation: dict,
) -> MeetingNoteRootResult:
    operation = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
    if operation is not None:
        return await _operation_result(db, operation, request_hash)
    root = await find_meeting_note_root(db, user_id=user_id, meeting_id=meeting_id)
    meeting = await _owned_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if root is None or meeting is None:
        raise MeetingNoteRootConflict(412, "meeting_note_missing", None)
    if root.revision != expected_revision:
        raise MeetingNoteRootConflict(
            412,
            "revision_conflict",
            await meeting_note_root_payload(db, meeting, root),
        )

    changed = False
    if operation_kind == "update":
        if root.lifecycle == "deleted":
            raise MeetingNoteRootConflict(
                409,
                "meeting_note_deleted",
                await meeting_note_root_payload(db, meeting, root),
            )
        field_map = {
            "title": "title",
            "description": "description",
            "location": "location",
            "mode": "mode",
            "status": "status",
            "recorded_at": "recorded_at",
        }
        for key, attribute in field_map.items():
            if key in mutation and getattr(meeting, attribute) != mutation[key]:
                setattr(meeting, attribute, mutation[key])
                changed = True
        if "participants" in mutation:
            encoded = json.dumps(mutation["participants"], ensure_ascii=False)
            if meeting.participants != encoded:
                meeting.participants = encoded
                changed = True
    elif operation_kind == "delete":
        if root.lifecycle != "deleted":
            root.lifecycle = "deleted"
            root.deleted_at = _next_updated_at()
            changed = True
    elif operation_kind == "restore":
        if root.lifecycle == "deleted":
            if (
                root.deleted_at is None
                or datetime.utcnow() >= root.deleted_at + timedelta(days=MEETING_NOTE_SOFT_DELETE_DAYS)
            ):
                raise MeetingNoteRootConflict(
                    409,
                    "restore_window_expired",
                    await meeting_note_root_payload(db, meeting, root),
                )
            if root.origin == "calendar" and await find_occurrence_by_meeting(
                db,
                user_id=user_id,
                meeting_id=meeting_id,
            ) is None:
                raise MeetingNoteRootConflict(
                    409,
                    "occurrence_superseded",
                    await meeting_note_root_payload(db, meeting, root),
                )
            root.lifecycle = "active"
            root.deleted_at = None
            changed = True
    else:
        raise RuntimeError("unsupported meeting root operation")

    if changed:
        root.revision += 1
        root.updated_at = _next_updated_at(root.updated_at)
        meeting.updated_at = root.updated_at
    try:
        await db.flush()
        payload = await meeting_note_root_payload(db, meeting, root)
        _add_operation(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            operation_kind=operation_kind,
            meeting_id=meeting_id,
            payload=payload,
            status_code=200,
            revision=root.revision,
        )
        await db.flush()
        return MeetingNoteRootResult(payload=payload, status_code=200, replayed=False)
    except (IntegrityError, StaleDataError):
        await db.rollback()
        replay = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current_root = await find_meeting_note_root(db, user_id=user_id, meeting_id=meeting_id)
        current_meeting = await _owned_meeting(db, user_id=user_id, meeting_id=meeting_id)
        raise MeetingNoteRootConflict(
            412,
            "revision_conflict",
            await meeting_note_root_payload(db, current_meeting, current_root)
            if current_root is not None and current_meeting is not None else None,
        )


async def ensure_legacy_meeting_root(
    db: AsyncSession,
    meeting: Meeting,
    *,
    origin: str = "ad_hoc",
    entry_point: str = "legacy_store",
) -> MeetingNoteRootV2:
    root = await find_meeting_note_root(
        db,
        user_id=int(meeting.user_id),
        meeting_id=str(meeting.id),
    )
    if root is not None:
        return root
    created_at = meeting.created_at or datetime.utcnow()
    updated_at = meeting.updated_at or created_at
    root = MeetingNoteRootV2(
        meeting_id=str(meeting.id),
        user_id=int(meeting.user_id),
        client_note_id=str(meeting.client_request_id or meeting.id)[:160],
        revision=1,
        origin=origin,
        entry_point=entry_point,
        lifecycle="active",
        created_at=created_at,
        updated_at=updated_at,
    )
    db.add(root)
    await db.flush()
    return root


async def touch_legacy_meeting_root(db: AsyncSession, meeting: Meeting) -> MeetingNoteRootV2:
    root = await ensure_legacy_meeting_root(db, meeting)
    if root.lifecycle != "deleted":
        root.revision += 1
        root.updated_at = _next_updated_at(root.updated_at)
        meeting.updated_at = root.updated_at
        await db.flush()
    return root


async def soft_delete_legacy_meeting(db: AsyncSession, meeting: Meeting) -> bool:
    root = await ensure_legacy_meeting_root(db, meeting)
    if root.lifecycle == "deleted":
        return True
    root.lifecycle = "deleted"
    root.deleted_at = _next_updated_at()
    root.revision += 1
    root.updated_at = root.deleted_at
    meeting.updated_at = root.updated_at
    await db.flush()
    return True
