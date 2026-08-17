"""Operator workflow for externally verified account-deletion requests."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import laoji_auth_service as auth
from app.services.account_deletion_service import (
    begin_user_meeting_deletion,
    cancel_user_meeting_deletion,
    delete_user_meeting_data,
    finalize_user_deletion_guard,
    finalize_user_meeting_deletion,
    preflight_user_meeting_deletion,
)


@dataclass(frozen=True)
class OperatorDeletionReport:
    request_id: str
    user_id: int
    events_deleted: int
    meetings_deleted: int
    sessions_deleted: int
    cleanup_pending: int


async def _release_deletion_guards(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    try:
        await db.rollback()
    except Exception:
        pass
    try:
        await cancel_user_meeting_deletion(user_id, db, operation_id)
    except Exception:
        pass
    try:
        auth.cancel_account_deletion(user_id, operation_id=operation_id)
    except Exception:
        pass


async def complete_account_deletion_request(
    request_id: str,
    db: AsyncSession,
    *,
    identity_verified: bool,
    resume: bool = False,
) -> OperatorDeletionReport:
    """Delete all account data after an operator has verified identity out of band."""
    if not identity_verified:
        raise ValueError("必须先完成线下身份核验")

    request = auth.claim_account_deletion_request(request_id, resume=resume)
    user_id_value = request.get("user_id")
    if user_id_value is None:
        auth.release_account_deletion_request(request_id, "请求未关联到有效账号")
        raise ValueError("删除请求未关联到有效账号；请核验后拒绝该请求")
    user_id = int(user_id_value)
    operation_id = f"request:{request_id}"

    try:
        await begin_user_meeting_deletion(user_id, db, operation_id)
        await preflight_user_meeting_deletion(user_id, db, operation_id)
        auth.begin_account_deletion(
            user_id,
            operation_id=operation_id,
            revoke_sessions=False,
        )
        meeting_report = await delete_user_meeting_data(user_id, db, operation_id)
        await finalize_user_meeting_deletion(user_id, db, operation_id)
        account_report = auth.delete_account_data_after_verification(
            user_id,
            operation_id=operation_id,
        )
    except Exception as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        auth.release_account_deletion_request(request_id, str(exc))
        raise

    cleanup_pending = int(account_report.get("cleanup_pending", 0))
    try:
        await finalize_user_deletion_guard(user_id, db, operation_id)
    except Exception:
        cleanup_pending += 1

    return OperatorDeletionReport(
        request_id=request_id,
        user_id=user_id,
        events_deleted=int(account_report.get("events_deleted", 0)),
        meetings_deleted=meeting_report.meetings_deleted,
        sessions_deleted=int(account_report.get("sessions_deleted", 0)),
        cleanup_pending=cleanup_pending,
    )
