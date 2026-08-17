from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_content_share import MeetingContentShare, MeetingContentShareOperation
from app.models.summary import FinalSummary
from app.services.meeting_action_service import next_action_updated_at


MAXIMUM_FROZEN_PAYLOAD_BYTES = 1_000_000


@dataclass(frozen=True)
class MeetingContentShareResult:
    payload: dict
    status_code: int
    replayed: bool


class MeetingContentShareConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


class MeetingContentShareConfigurationError(RuntimeError):
    pass


def meeting_content_share_configured() -> bool:
    return len(os.environ.get("LAOJI_ACTION_SHARE_SECRET", "").encode("utf-8")) >= 32


def _share_secret() -> bytes:
    value = os.environ.get("LAOJI_ACTION_SHARE_SECRET", "").encode("utf-8")
    if len(value) < 32:
        raise MeetingContentShareConfigurationError("meeting content share secret is unavailable")
    return value


def _share_token(owner_user_id: int, client_share_id: str, share_id: str) -> str:
    message = f"meeting-content:v1:{owner_user_id}:{client_share_id}:{share_id}".encode("utf-8")
    digest = hmac.new(_share_secret(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def meeting_content_share_request_hash(value: dict) -> str:
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


def _scope(share: MeetingContentShare) -> list[str]:
    value = json.loads(share.content_scope_json)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("meeting content share scope is invalid")
    return value


def owner_share_payload(share: MeetingContentShare, *, invite_url: str | None) -> dict:
    return {
        "schema_version": 1,
        "id": share.id,
        "client_share_id": share.client_share_id,
        "revision": share.revision,
        "status": share.status,
        "content_scope": _scope(share),
        "follow_latest_summary": share.follow_latest_summary,
        "source_summary_version_id": share.source_summary_version_id,
        "invite_url": invite_url if share.status == "active" else None,
        "created_at": _utc_iso(share.created_at),
        "updated_at": _utc_iso(share.updated_at),
    }


def owner_share_payload_with_invite(share: MeetingContentShare) -> dict:
    token = _share_token(share.owner_user_id, share.client_share_id, share.id)
    return owner_share_payload(
        share,
        invite_url=f"laoji://share/meeting?token={token}" if share.status == "active" else None,
    )


def _safe_latest_summary_text(summary: FinalSummary) -> str:
    markdown = (summary.markdown_text or "").strip()
    if markdown and not markdown.lstrip().startswith(("{", "[", "```json")):
        return markdown if len(markdown) <= 200_000 else ""
    parts: list[str] = []
    overview = (summary.overview or "").strip()
    if overview:
        parts.append(overview)
    decisions = [str(item).strip() for item in summary.key_decisions if str(item).strip()]
    if decisions:
        parts.append("关键结论\n" + "\n".join(f"- {item}" for item in decisions))
    actions: list[str] = []
    for item in summary.action_items:
        if isinstance(item, dict):
            candidate = item.get("content") or item.get("task") or item.get("action")
        else:
            candidate = item
        text = str(candidate or "").strip()
        if text:
            actions.append(text)
    if actions:
        parts.append("行动项\n" + "\n".join(f"- {item}" for item in actions))
    result = "\n\n".join(parts).strip()
    return result if len(result) <= 200_000 else ""


async def public_share_payload(db: AsyncSession, share: MeetingContentShare) -> dict:
    frozen = json.loads(share.frozen_payload_json)
    if not isinstance(frozen, dict) or frozen.get("schema_version") != 1:
        raise ValueError("meeting content share payload is invalid")
    sections = frozen.get("sections")
    if not isinstance(sections, list):
        raise ValueError("meeting content share sections are invalid")
    result_sections = [dict(item) for item in sections if isinstance(item, dict)]
    summary_version_id = share.source_summary_version_id
    if share.follow_latest_summary and "summary" in _scope(share):
        latest = (await db.execute(
            select(FinalSummary)
            .where(FinalSummary.meeting_id == share.meeting_id)
            .order_by(FinalSummary.generated_at.desc(), FinalSummary.id.desc())
            .limit(1)
        )).scalar_one_or_none()
        if latest is not None:
            latest_text = _safe_latest_summary_text(latest)
            if latest_text and len(latest_text) <= 200_000:
                result_sections = [
                    {**section, "content": latest_text}
                    if section.get("key") == "summary"
                    else section
                    for section in result_sections
                ]
                summary_version_id = latest.id
    return {
        "schema_version": 1,
        "share_id": share.id,
        "share_revision": share.revision,
        "status": share.status,
        "content_scope": _scope(share),
        "follow_latest_summary": share.follow_latest_summary,
        "summary_version_id": summary_version_id,
        "sections": result_sections,
        "created_at": _utc_iso(share.created_at),
        "updated_at": _utc_iso(share.updated_at),
    }


async def _operation(
    db: AsyncSession,
    owner_user_id: int,
    idempotency_key: str,
) -> MeetingContentShareOperation | None:
    return (await db.execute(
        select(MeetingContentShareOperation).where(
            MeetingContentShareOperation.owner_user_id == owner_user_id,
            MeetingContentShareOperation.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _replay(
    db: AsyncSession,
    operation: MeetingContentShareOperation,
    request_hash: str,
) -> MeetingContentShareResult:
    if operation.request_hash != request_hash:
        raise MeetingContentShareConflict(409, "idempotency_key_reused", None)
    share = (await db.execute(
        select(MeetingContentShare).where(MeetingContentShare.id == operation.share_id)
    )).scalar_one_or_none()
    if share is None:
        raise MeetingContentShareConflict(409, "share_missing", None)
    payload = json.loads(operation.response_json)
    if operation.operation_kind == "create_share":
        payload = owner_share_payload_with_invite(share)
    return MeetingContentShareResult(
        payload=payload,
        status_code=operation.response_status,
        replayed=True,
    )


def _record_operation(
    db: AsyncSession,
    *,
    owner_user_id: int,
    idempotency_key: str,
    request_hash: str,
    share: MeetingContentShare,
    operation_kind: str,
    status_code: int,
    payload: dict,
) -> None:
    stored_payload = dict(payload)
    stored_payload["invite_url"] = None
    db.add(MeetingContentShareOperation(
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share_id=share.id,
        operation_kind=operation_kind,
        response_status=status_code,
        response_revision=share.revision,
        response_json=json.dumps(stored_payload, ensure_ascii=False, separators=(",", ":")),
    ))


async def create_meeting_content_share(
    db: AsyncSession,
    *,
    owner_user_id: int,
    meeting_id: str,
    client_share_id: str,
    content_scope: list[str],
    frozen_payload: dict,
    follow_latest_summary: bool,
    source_summary_version_id: str | None,
    idempotency_key: str,
    request_hash: str,
) -> MeetingContentShareResult:
    existing_operation = await _operation(db, owner_user_id, idempotency_key)
    if existing_operation is not None:
        return await _replay(db, existing_operation, request_hash)
    existing = (await db.execute(
        select(MeetingContentShare).where(
            MeetingContentShare.owner_user_id == owner_user_id,
            MeetingContentShare.client_share_id == client_share_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise MeetingContentShareConflict(
            412,
            "share_already_exists",
            owner_share_payload(existing, invite_url=None),
        )
    frozen_json = json.dumps(frozen_payload, ensure_ascii=False, separators=(",", ":"))
    if len(frozen_json.encode("utf-8")) > MAXIMUM_FROZEN_PAYLOAD_BYTES:
        raise ValueError("meeting content share payload is too large")
    now = next_action_updated_at()
    share_id = str(uuid.uuid4())
    token = _share_token(owner_user_id, client_share_id, share_id)
    share = MeetingContentShare(
        id=share_id,
        owner_user_id=owner_user_id,
        meeting_id=meeting_id,
        client_share_id=client_share_id,
        token_hash=_token_hash(token),
        content_scope_json=json.dumps(content_scope, ensure_ascii=True, separators=(",", ":")),
        frozen_payload_json=frozen_json,
        follow_latest_summary=follow_latest_summary,
        source_summary_version_id=source_summary_version_id,
        status="active",
        revision=1,
        created_at=now,
        updated_at=now,
    )
    db.add(share)
    await db.flush()
    payload = owner_share_payload_with_invite(share)
    _record_operation(
        db,
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share=share,
        operation_kind="create_share",
        status_code=201,
        payload=payload,
    )
    await db.flush()
    return MeetingContentShareResult(payload=payload, status_code=201, replayed=False)


async def revoke_meeting_content_share(
    db: AsyncSession,
    *,
    owner_user_id: int,
    share: MeetingContentShare,
    expected_share_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> MeetingContentShareResult:
    existing_operation = await _operation(db, owner_user_id, idempotency_key)
    if existing_operation is not None:
        return await _replay(db, existing_operation, request_hash)
    if share.revision != expected_share_revision:
        raise MeetingContentShareConflict(
            412,
            "share_revision_conflict",
            owner_share_payload(share, invite_url=None),
        )
    if share.status != "active":
        raise MeetingContentShareConflict(
            409,
            "share_not_active",
            owner_share_payload(share, invite_url=None),
        )
    share.status = "revoked"
    share.revision += 1
    share.revoked_at = next_action_updated_at()
    share.updated_at = share.revoked_at
    payload = owner_share_payload(share, invite_url=None)
    _record_operation(
        db,
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share=share,
        operation_kind="revoke_share",
        status_code=200,
        payload=payload,
    )
    await db.flush()
    return MeetingContentShareResult(payload=payload, status_code=200, replayed=False)


async def find_meeting_content_share_by_token(
    db: AsyncSession,
    token: str,
) -> MeetingContentShare | None:
    return (await db.execute(
        select(MeetingContentShare).where(MeetingContentShare.token_hash == _token_hash(token))
    )).scalar_one_or_none()
