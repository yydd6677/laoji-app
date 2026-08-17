from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_tag_catalog import MeetingTagCatalogOperationV1, MeetingTagCatalogV1


@dataclass(frozen=True)
class MeetingTagCatalogResult:
    payload: dict
    status_code: int
    replayed: bool


class MeetingTagCatalogConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


def meeting_tag_catalog_request_hash(
    mutation: dict,
    *,
    precondition: str,
    expected_revision: int | None,
) -> str:
    encoded = json.dumps(
        {
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


def meeting_tag_catalog_payload(catalog: MeetingTagCatalogV1) -> dict:
    snapshot = json.loads(catalog.snapshot_json)
    if not isinstance(snapshot, dict):
        raise RuntimeError("stored meeting tag catalog is invalid")
    return {
        "schema_version": 1,
        "exists": True,
        "revision": catalog.revision,
        "client_updated_at_ms": catalog.client_updated_at_ms,
        "tags": snapshot.get("tags", []),
        "assignments": snapshot.get("assignments", []),
        "updated_at": _utc_iso(catalog.updated_at),
    }


def missing_meeting_tag_catalog_payload() -> dict:
    return {
        "schema_version": 1,
        "exists": False,
        "revision": 0,
        "client_updated_at_ms": 0,
        "tags": [],
        "assignments": [],
        "updated_at": None,
    }


async def find_meeting_tag_catalog(
    db: AsyncSession,
    *,
    user_id: int,
) -> MeetingTagCatalogV1 | None:
    return (await db.execute(
        select(MeetingTagCatalogV1).where(MeetingTagCatalogV1.user_id == user_id)
    )).scalar_one_or_none()


async def _find_operation(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
) -> MeetingTagCatalogOperationV1 | None:
    return (await db.execute(
        select(MeetingTagCatalogOperationV1).where(
            MeetingTagCatalogOperationV1.user_id == user_id,
            MeetingTagCatalogOperationV1.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _operation_result(
    db: AsyncSession,
    operation: MeetingTagCatalogOperationV1,
    request_hash: str,
) -> MeetingTagCatalogResult:
    if operation.request_hash != request_hash:
        current = await find_meeting_tag_catalog(db, user_id=operation.user_id)
        raise MeetingTagCatalogConflict(
            409,
            "idempotency_key_reused",
            meeting_tag_catalog_payload(current) if current else None,
        )
    return MeetingTagCatalogResult(
        payload=json.loads(operation.response_json),
        status_code=operation.response_status,
        replayed=True,
    )


async def replace_meeting_tag_catalog(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
    precondition: str,
    expected_revision: int | None,
) -> MeetingTagCatalogResult:
    operation = await _find_operation(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
    )
    if operation is not None:
        return await _operation_result(db, operation, request_hash)

    catalog = await find_meeting_tag_catalog(db, user_id=user_id)
    snapshot_json = json.dumps(
        {
            "tags": mutation["tags"],
            "assignments": mutation["assignments"],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if precondition == "create":
        if catalog is not None:
            raise MeetingTagCatalogConflict(
                412,
                "catalog_already_exists",
                meeting_tag_catalog_payload(catalog),
            )
        now = _next_updated_at()
        catalog = MeetingTagCatalogV1(
            user_id=user_id,
            revision=1,
            client_updated_at_ms=mutation["client_updated_at_ms"],
            snapshot_json=snapshot_json,
            created_at=now,
            updated_at=now,
        )
        db.add(catalog)
        response_status = 201
    else:
        if catalog is None:
            raise MeetingTagCatalogConflict(
                412,
                "catalog_missing",
                missing_meeting_tag_catalog_payload(),
            )
        if expected_revision != catalog.revision:
            raise MeetingTagCatalogConflict(
                412,
                "revision_conflict",
                meeting_tag_catalog_payload(catalog),
            )
        changed = (
            catalog.client_updated_at_ms != mutation["client_updated_at_ms"]
            or catalog.snapshot_json != snapshot_json
        )
        if changed:
            catalog.client_updated_at_ms = mutation["client_updated_at_ms"]
            catalog.snapshot_json = snapshot_json
            catalog.revision += 1
            catalog.updated_at = _next_updated_at(catalog.updated_at)
        response_status = 200

    try:
        await db.flush()
        payload = meeting_tag_catalog_payload(catalog)
        db.add(MeetingTagCatalogOperationV1(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            response_status=response_status,
            response_revision=catalog.revision,
            response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ))
        await db.flush()
        return MeetingTagCatalogResult(
            payload=payload,
            status_code=response_status,
            replayed=False,
        )
    except IntegrityError:
        await db.rollback()
        replay = await _find_operation(db, user_id=user_id, idempotency_key=idempotency_key)
        if replay is not None:
            return await _operation_result(db, replay, request_hash)
        current = await find_meeting_tag_catalog(db, user_id=user_id)
        raise MeetingTagCatalogConflict(
            412,
            "catalog_already_exists" if precondition == "create" else "revision_conflict",
            meeting_tag_catalog_payload(current) if current else missing_meeting_tag_catalog_payload(),
        )
