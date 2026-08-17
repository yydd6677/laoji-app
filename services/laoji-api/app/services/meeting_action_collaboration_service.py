from __future__ import annotations

import hashlib
import hmac
import json
import os
import base64
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting_action import MeetingActionItem
from app.models.meeting_action_share import (
    MeetingActionCollaborationEvent,
    MeetingActionCollaborationOperation,
    MeetingActionShare,
)
from app.services.meeting_action_service import next_action_updated_at


@dataclass(frozen=True)
class CollaborationResult:
    payload: dict
    status_code: int
    replayed: bool


class CollaborationConflict(RuntimeError):
    def __init__(self, status_code: int, code: str, current: dict | None):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.current = current


class CollaborationConfigurationError(RuntimeError):
    pass


def action_collaboration_configured() -> bool:
    return len(os.environ.get("LAOJI_ACTION_SHARE_SECRET", "").encode("utf-8")) >= 32


def _share_secret() -> bytes:
    value = os.environ.get("LAOJI_ACTION_SHARE_SECRET", "").encode("utf-8")
    if len(value) < 32:
        raise CollaborationConfigurationError("action collaboration secret is unavailable")
    return value


def _share_token(owner_user_id: int, client_share_id: str, share_id: str) -> str:
    message = f"v1:{owner_user_id}:{client_share_id}:{share_id}".encode("utf-8")
    digest = hmac.new(_share_secret(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def collaboration_request_hash(value: dict) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _milliseconds(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def share_payload(
    share: MeetingActionShare,
    action: MeetingActionItem,
    *,
    invite_url: str | None,
) -> dict:
    return {
        "schema_version": 1,
        "id": share.id,
        "client_share_id": share.client_share_id,
        "revision": share.revision,
        "permission": share.permission,
        "status": share.status,
        "action_revision": action.revision,
        "invite_url": invite_url if share.status == "active" else None,
        "created_at": _utc_iso(share.created_at),
        "updated_at": _utc_iso(share.updated_at),
    }


def shared_action_payload(
    share: MeetingActionShare,
    action: MeetingActionItem,
    *,
    actor_label: str,
) -> dict:
    return {
        "schema_version": 1,
        "share_id": share.id,
        "share_revision": share.revision,
        "permission": share.permission,
        "status": share.status,
        "action": {
            "id": action.id,
            "revision": action.revision,
            "content": action.content,
            "status": action.status,
            "assignee": action.assignee,
            "due_at_ms": action.due_at_ms,
            "updated_at_ms": _milliseconds(action.updated_at),
            "actor_label": actor_label,
        },
    }


async def _operation(
    db: AsyncSession,
    owner_user_id: int,
    idempotency_key: str,
) -> MeetingActionCollaborationOperation | None:
    return (await db.execute(
        select(MeetingActionCollaborationOperation).where(
            MeetingActionCollaborationOperation.owner_user_id == owner_user_id,
            MeetingActionCollaborationOperation.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()


async def _replay(
    db: AsyncSession,
    operation: MeetingActionCollaborationOperation,
    request_hash: str,
) -> CollaborationResult:
    if operation.request_hash != request_hash:
        raise CollaborationConflict(409, "idempotency_key_reused", None)
    payload = json.loads(operation.response_json)
    if operation.operation_kind == "create_share":
        row = (await db.execute(
            select(MeetingActionShare, MeetingActionItem)
            .join(MeetingActionItem, MeetingActionItem.id == MeetingActionShare.action_id)
            .where(MeetingActionShare.id == operation.share_id)
        )).one_or_none()
        if row is None:
            raise CollaborationConflict(409, "share_missing", None)
        share, action = row
        token = _share_token(share.owner_user_id, share.client_share_id, share.id)
        payload = share_payload(
            share,
            action,
            invite_url=f"laoji://collaboration/action?token={token}",
        )
    return CollaborationResult(
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
    share: MeetingActionShare,
    action: MeetingActionItem,
    actor_id: str,
    operation_kind: str,
    status_code: int,
    payload: dict,
) -> None:
    stored_payload = dict(payload)
    if operation_kind == "create_share":
        stored_payload["invite_url"] = None
    db.add(MeetingActionCollaborationOperation(
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share_id=share.id,
        action_id=action.id,
        actor_id=actor_id,
        operation_kind=operation_kind,
        response_status=status_code,
        response_revision=action.revision,
        response_json=json.dumps(stored_payload, ensure_ascii=False, separators=(",", ":")),
    ))


async def create_action_share(
    db: AsyncSession,
    *,
    owner_user_id: int,
    meeting_id: str,
    action: MeetingActionItem,
    client_share_id: str,
    permission: str,
    expected_action_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> CollaborationResult:
    existing_operation = await _operation(db, owner_user_id, idempotency_key)
    if existing_operation is not None:
        return await _replay(db, existing_operation, request_hash)
    if action.revision != expected_action_revision:
        raise CollaborationConflict(
            412,
            "action_revision_conflict",
            shared_action_payload_for_conflict(action),
        )
    existing = (await db.execute(
        select(MeetingActionShare).where(
            MeetingActionShare.owner_user_id == owner_user_id,
            MeetingActionShare.client_share_id == client_share_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise CollaborationConflict(412, "share_already_exists", {
            "id": existing.id,
            "client_share_id": existing.client_share_id,
            "revision": existing.revision,
            "status": existing.status,
            "permission": existing.permission,
        })
    now = next_action_updated_at()
    share_id = str(uuid.uuid4())
    token = _share_token(owner_user_id, client_share_id, share_id)
    share = MeetingActionShare(
        id=share_id,
        owner_user_id=owner_user_id,
        meeting_id=meeting_id,
        action_id=action.id,
        client_share_id=client_share_id,
        token_hash=_token_hash(token),
        permission=permission,
        status="active",
        revision=1,
        created_at=now,
        updated_at=now,
    )
    db.add(share)
    await db.flush()
    invite_url = f"laoji://collaboration/action?token={token}"
    payload = share_payload(share, action, invite_url=invite_url)
    _record_operation(
        db,
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share=share,
        action=action,
        actor_id=f"owner:{owner_user_id}",
        operation_kind="create_share",
        status_code=201,
        payload=payload,
    )
    await db.flush()
    return CollaborationResult(payload=payload, status_code=201, replayed=False)


async def revoke_action_share(
    db: AsyncSession,
    *,
    owner_user_id: int,
    action: MeetingActionItem,
    share: MeetingActionShare,
    expected_share_revision: int,
    idempotency_key: str,
    request_hash: str,
) -> CollaborationResult:
    existing_operation = await _operation(db, owner_user_id, idempotency_key)
    if existing_operation is not None:
        return await _replay(db, existing_operation, request_hash)
    if share.revision != expected_share_revision:
        raise CollaborationConflict(412, "share_revision_conflict", {
            "id": share.id,
            "client_share_id": share.client_share_id,
            "revision": share.revision,
            "status": share.status,
            "permission": share.permission,
        })
    if share.status != "active":
        raise CollaborationConflict(409, "share_not_active", {
            "id": share.id,
            "client_share_id": share.client_share_id,
            "revision": share.revision,
            "status": share.status,
            "permission": share.permission,
        })
    share.status = "revoked"
    share.revision += 1
    share.revoked_at = next_action_updated_at()
    share.updated_at = share.revoked_at
    payload = share_payload(share, action, invite_url=None)
    _record_operation(
        db,
        owner_user_id=owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share=share,
        action=action,
        actor_id=f"owner:{owner_user_id}",
        operation_kind="revoke_share",
        status_code=200,
        payload=payload,
    )
    await db.flush()
    return CollaborationResult(payload=payload, status_code=200, replayed=False)


async def find_share_by_token(
    db: AsyncSession,
    token: str,
) -> tuple[MeetingActionShare, MeetingActionItem] | None:
    row = (await db.execute(
        select(MeetingActionShare, MeetingActionItem)
        .join(MeetingActionItem, MeetingActionItem.id == MeetingActionShare.action_id)
        .where(MeetingActionShare.token_hash == _token_hash(token))
    )).one_or_none()
    return (row[0], row[1]) if row else None


def shared_action_payload_for_conflict(action: MeetingActionItem) -> dict:
    return {
        "id": action.id,
        "revision": action.revision,
        "content": action.content,
        "status": action.status,
        "assignee": action.assignee,
        "due_at_ms": action.due_at_ms,
        "updated_at_ms": _milliseconds(action.updated_at),
    }


async def update_shared_action(
    db: AsyncSession,
    *,
    share: MeetingActionShare,
    action: MeetingActionItem,
    actor_id: str,
    expected_action_revision: int,
    idempotency_key: str,
    request_hash: str,
    status: str,
    assignee: str | None,
    due_at_ms: int | None,
) -> CollaborationResult:
    existing_operation = await _operation(db, share.owner_user_id, idempotency_key)
    if existing_operation is not None:
        return await _replay(db, existing_operation, request_hash)
    if share.status != "active":
        raise CollaborationConflict(410, "share_revoked", None)
    if share.permission != "action_editor":
        raise CollaborationConflict(403, "share_read_only", None)
    if action.revision != expected_action_revision:
        raise CollaborationConflict(
            412,
            "action_revision_conflict",
            shared_action_payload_for_conflict(action),
        )
    changes = {
        "status": status,
        "assignee": assignee,
        "due_at_ms": due_at_ms,
    }
    changed_fields = [key for key, value in changes.items() if getattr(action, key) != value]
    if changed_fields:
        now = next_action_updated_at(action.updated_at)
        now_ms = _milliseconds(now)
        action.status = status
        action.assignee = assignee
        action.due_at_ms = due_at_ms
        action.client_updated_at_ms = max(action.client_updated_at_ms + 1, now_ms)
        action.user_edited_at_ms = action.client_updated_at_ms
        action.completed_at_ms = action.client_updated_at_ms if status == "completed" else None
        if status != "pending" or "due_at_ms" in changed_fields:
            action.reminder_at_ms = None
        action.revision += 1
        action.updated_at = now
        db.add(MeetingActionCollaborationEvent(
            share_id=share.id,
            action_id=action.id,
            actor_id=actor_id,
            actor_role="link_collaborator",
            action_revision=action.revision,
            changed_fields_json=json.dumps(changed_fields, ensure_ascii=False, separators=(",", ":")),
            created_at=now,
        ))
    payload = shared_action_payload(share, action, actor_label="链接协作者")
    _record_operation(
        db,
        owner_user_id=share.owner_user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        share=share,
        action=action,
        actor_id=actor_id,
        operation_kind="update_shared_action",
        status_code=200,
        payload=payload,
    )
    await db.flush()
    return CollaborationResult(payload=payload, status_code=200, replayed=False)
