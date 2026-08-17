from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_occurrence import (
    MeetingOccurrenceLink,
    MeetingOccurrenceOperation,
    MeetingScheduleSnapshotV2,
)


@dataclass(frozen=True)
class OccurrenceUpsertResult:
    payload: dict
    status_code: int
    replayed: bool


class OccurrenceContractConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


def occurrence_request_hash(
    meeting_id: str,
    mutation: dict,
    *,
    precondition: str,
    expected_revision: int | None,
) -> str:
    encoded = json.dumps(
        {
            "meeting_id": meeting_id,
            "mutation": mutation,
            "precondition": precondition,
            "expected_revision": expected_revision,
        },
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


def schedule_snapshot_payload(snapshot: MeetingScheduleSnapshotV2) -> dict:
    participants = json.loads(snapshot.participants_json)
    if not isinstance(participants, list) or any(not isinstance(item, str) for item in participants):
        raise RuntimeError("stored occurrence participants are invalid")
    return {
        "event_title": snapshot.event_title,
        "planned_start_ms": snapshot.planned_start_ms,
        "planned_end_ms": snapshot.planned_end_ms,
        "all_day": bool(snapshot.all_day),
        "timezone_id": snapshot.timezone_id,
        "location": snapshot.location,
        "participants": participants,
        "description": snapshot.description,
        "captured_event_revision": snapshot.captured_event_revision,
        "captured_at_ms": snapshot.captured_at_ms,
    }


def occurrence_payload(
    link: MeetingOccurrenceLink,
    snapshot: MeetingScheduleSnapshotV2,
) -> dict:
    return {
        "schema_version": 2,
        "exists": True,
        "id": link.id,
        "meeting_id": link.meeting_id,
        "revision": link.revision,
        "source_event_id": link.source_event_id,
        "occurrence_date": link.occurrence_date,
        "calendar_revision": link.calendar_revision,
        "recurrence_segment_id": link.recurrence_segment_id,
        "series_key": link.series_key,
        "link_state": link.link_state,
        "client_updated_at_ms": link.client_updated_at_ms,
        "schedule_snapshot": schedule_snapshot_payload(snapshot),
        "created_at": _utc_iso(link.created_at),
        "updated_at": _utc_iso(link.updated_at),
    }


def missing_occurrence_payload(
    *,
    meeting_id: str | None,
    source_event_id: str | None,
    occurrence_date: str | None,
) -> dict:
    return {
        "schema_version": 2,
        "exists": False,
        "id": None,
        "meeting_id": meeting_id,
        "revision": 0,
        "source_event_id": source_event_id,
        "occurrence_date": occurrence_date,
        "calendar_revision": None,
        "recurrence_segment_id": None,
        "series_key": None,
        "link_state": None,
        "client_updated_at_ms": 0,
        "schedule_snapshot": None,
        "created_at": None,
        "updated_at": None,
    }


async def find_occurrence_by_meeting(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> MeetingOccurrenceLink | None:
    return (await db.execute(
        select(MeetingOccurrenceLink).where(
            MeetingOccurrenceLink.user_id == user_id,
            MeetingOccurrenceLink.meeting_id == meeting_id,
        )
    )).scalar_one_or_none()


async def find_occurrence_by_identity(
    db: AsyncSession,
    *,
    user_id: int,
    source_event_id: str,
    occurrence_date: str,
) -> MeetingOccurrenceLink | None:
    return (await db.execute(
        select(MeetingOccurrenceLink).where(
            MeetingOccurrenceLink.user_id == user_id,
            MeetingOccurrenceLink.source_event_id == source_event_id,
            MeetingOccurrenceLink.occurrence_date == occurrence_date,
        )
    )).scalar_one_or_none()


async def find_occurrence_snapshot(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> MeetingScheduleSnapshotV2 | None:
    return (await db.execute(
        select(MeetingScheduleSnapshotV2).where(
            MeetingScheduleSnapshotV2.user_id == user_id,
            MeetingScheduleSnapshotV2.meeting_id == meeting_id,
        )
    )).scalar_one_or_none()


async def occurrence_payload_for_link(
    db: AsyncSession,
    link: MeetingOccurrenceLink,
) -> dict:
    snapshot = await find_occurrence_snapshot(
        db,
        user_id=link.user_id,
        meeting_id=link.meeting_id,
    )
    if snapshot is None:
        raise RuntimeError("occurrence schedule snapshot is missing")
    return occurrence_payload(link, snapshot)


async def _find_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> MeetingOccurrenceOperation | None:
    return (await db.execute(
        select(MeetingOccurrenceOperation).where(
            MeetingOccurrenceOperation.user_id == user_id,
            MeetingOccurrenceOperation.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _operation_result(
    db: AsyncSession,
    operation: MeetingOccurrenceOperation,
    request_hash: str,
) -> OccurrenceUpsertResult:
    if operation.request_hash != request_hash:
        current = await find_occurrence_by_meeting(
            db,
            user_id=operation.user_id,
            meeting_id=operation.meeting_id,
        )
        raise OccurrenceContractConflict(
            409,
            "idempotency_key_reused",
            await occurrence_payload_for_link(db, current)
            if current is not None
            else json.loads(operation.response_json),
        )
    return OccurrenceUpsertResult(
        payload=json.loads(operation.response_json),
        status_code=operation.response_status,
        replayed=True,
    )


def _snapshot_matches(snapshot: MeetingScheduleSnapshotV2, mutation: dict) -> bool:
    return schedule_snapshot_payload(snapshot) == mutation["schedule_snapshot"]


async def upsert_meeting_occurrence(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
    precondition: str,
    expected_revision: int | None,
) -> OccurrenceUpsertResult:
    operation = await _find_operation(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
    )
    if operation is not None:
        return await _operation_result(db, operation, request_hash)

    link = await find_occurrence_by_meeting(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
    )
    identity_link = await find_occurrence_by_identity(
        db,
        user_id=user_id,
        source_event_id=mutation["source_event_id"],
        occurrence_date=mutation["occurrence_date"],
    )
    if precondition == "create":
        if identity_link is not None:
            raise OccurrenceContractConflict(
                409,
                "occurrence_already_bound",
                await occurrence_payload_for_link(db, identity_link),
            )
        if link is not None:
            raise OccurrenceContractConflict(
                409,
                "meeting_already_bound",
                await occurrence_payload_for_link(db, link),
            )
        now = _next_updated_at()
        link = MeetingOccurrenceLink(
            user_id=user_id,
            meeting_id=meeting_id,
            revision=1,
            source_event_id=mutation["source_event_id"],
            occurrence_date=mutation["occurrence_date"],
            calendar_revision=mutation.get("calendar_revision"),
            recurrence_segment_id=mutation.get("recurrence_segment_id"),
            series_key=mutation.get("series_key"),
            link_state=mutation["link_state"],
            client_updated_at_ms=mutation["client_updated_at_ms"],
            created_at=now,
            updated_at=now,
        )
        snapshot_data = mutation["schedule_snapshot"]
        snapshot = MeetingScheduleSnapshotV2(
            user_id=user_id,
            meeting_id=meeting_id,
            event_title=snapshot_data["event_title"],
            planned_start_ms=snapshot_data.get("planned_start_ms"),
            planned_end_ms=snapshot_data.get("planned_end_ms"),
            all_day=1 if snapshot_data["all_day"] else 0,
            timezone_id=snapshot_data.get("timezone_id"),
            location=snapshot_data.get("location"),
            participants_json=json.dumps(
                snapshot_data["participants"],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            description=snapshot_data.get("description"),
            captured_event_revision=snapshot_data.get("captured_event_revision"),
            captured_at_ms=snapshot_data["captured_at_ms"],
            created_at=now,
        )
        db.add_all([link, snapshot])
        response_status = 201
    else:
        if link is None:
            raise OccurrenceContractConflict(412, "occurrence_missing", None)
        if expected_revision != link.revision:
            raise OccurrenceContractConflict(
                412,
                "revision_conflict",
                await occurrence_payload_for_link(db, link),
            )
        if (
            link.source_event_id != mutation["source_event_id"]
            or link.occurrence_date != mutation["occurrence_date"]
        ):
            raise OccurrenceContractConflict(
                409,
                "occurrence_identity_mismatch",
                await occurrence_payload_for_link(db, link),
            )
        snapshot = await find_occurrence_snapshot(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
        )
        if snapshot is None:
            raise RuntimeError("occurrence schedule snapshot is missing")
        if not _snapshot_matches(snapshot, mutation):
            raise OccurrenceContractConflict(
                409,
                "schedule_snapshot_immutable",
                occurrence_payload(link, snapshot),
            )
        next_clock = mutation["client_updated_at_ms"]
        if next_clock < link.client_updated_at_ms:
            raise OccurrenceContractConflict(
                409,
                "occurrence_clock_regression",
                occurrence_payload(link, snapshot),
            )
        meaningful_change = any((
            link.calendar_revision != mutation.get("calendar_revision"),
            link.recurrence_segment_id != mutation.get("recurrence_segment_id"),
            link.series_key != mutation.get("series_key"),
            link.link_state != mutation["link_state"],
        ))
        if meaningful_change and next_clock == link.client_updated_at_ms:
            raise OccurrenceContractConflict(
                409,
                "occurrence_clock_not_advanced",
                occurrence_payload(link, snapshot),
            )
        changed = meaningful_change or next_clock != link.client_updated_at_ms
        if changed:
            link.calendar_revision = mutation.get("calendar_revision")
            link.recurrence_segment_id = mutation.get("recurrence_segment_id")
            link.series_key = mutation.get("series_key")
            link.link_state = mutation["link_state"]
            link.client_updated_at_ms = next_clock
            link.revision += 1
            link.updated_at = _next_updated_at(link.updated_at)
        response_status = 200

    try:
        await db.flush()
        payload = occurrence_payload(link, snapshot)
        db.add(MeetingOccurrenceOperation(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            meeting_id=meeting_id,
            link_id=link.id,
            response_status=response_status,
            response_revision=link.revision,
            response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ))
        await db.flush()
        return OccurrenceUpsertResult(
            payload=payload,
            status_code=response_status,
            replayed=False,
        )
    except IntegrityError:
        await db.rollback()
        replay = await _find_operation(
            db,
            user_id=user_id,
            idempotency_key=idempotency_key,
        )
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current = await find_occurrence_by_identity(
            db,
            user_id=user_id,
            source_event_id=mutation["source_event_id"],
            occurrence_date=mutation["occurrence_date"],
        )
        if current is None:
            current = await find_occurrence_by_meeting(
                db,
                user_id=user_id,
                meeting_id=meeting_id,
            )
        raise OccurrenceContractConflict(
            409 if current is not None and current.meeting_id != meeting_id else 412,
            "occurrence_already_bound" if current is not None else "revision_conflict",
            await occurrence_payload_for_link(db, current) if current is not None else None,
        )
