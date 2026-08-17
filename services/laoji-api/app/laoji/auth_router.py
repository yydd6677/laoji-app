"""
老记账号路由
"""

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.auth import (
    AccountDeleteRequest,
    AccountDeleteResponse,
    AccountDeletionRequestCreate,
    AccountDeletionRequestReceipt,
    AccountDeletionRequestStatus,
    AuthLoginRequest,
    AuthProfile,
    AuthProfileUpdate,
    AuthRegisterRequest,
    AuthSessionResponse,
    AuthUser,
    PasswordChangeRequest,
    PasswordResetRequest,
    PasswordResetResponse,
)
from app.services import laoji_auth_service as auth
from app.services.account_deletion_service import (
    AccountDeletionCleanupError,
    AccountDeletionConflict,
    begin_user_meeting_deletion,
    cancel_user_meeting_deletion,
    delete_user_meeting_data,
    delete_user_voiceprints,
    finalize_user_deletion_guard,
    finalize_user_meeting_deletion,
    preflight_user_meeting_deletion,
)


router = APIRouter()
security = HTTPBearer(auto_error=False)
MAX_AVATAR_BYTES = 5 * 1024 * 1024
logger = logging.getLogger(__name__)


def _client_source(request: Request) -> str:
    return request.client.host if request.client and request.client.host else "unknown"


def _enforce_rate_limit(
    scope: str,
    key: str,
    *,
    limit: int,
    window_seconds: int,
) -> None:
    allowed, retry_after = auth.consume_auth_rate_limit(
        scope,
        key,
        limit=limit,
        window_seconds=window_seconds,
    )
    if allowed:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="请求过于频繁，请稍后重试",
        headers={"Retry-After": str(retry_after)},
    )


async def _release_deletion_guards(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    try:
        await db.rollback()
    except Exception:
        logger.exception("Could not roll back meeting deletion session user_id=%s", user_id)
    try:
        await cancel_user_meeting_deletion(user_id, db, operation_id)
    except Exception:
        logger.exception("Could not release meeting deletion guard user_id=%s", user_id)
    try:
        auth.cancel_account_deletion(user_id, operation_id=operation_id)
    except Exception:
        logger.exception("Could not release auth deletion lease user_id=%s", user_id)


def _avatar_extension(content: bytes) -> str | None:
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return None


def _credentials_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="请先登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return credentials.credentials


def get_current_user(token: str = Depends(_credentials_token)) -> dict:
    user = auth.get_user_by_token(token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录已过期，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@router.post("/register", response_model=AuthSessionResponse, status_code=201)
def register(request: AuthRegisterRequest, http_request: Request):
    _enforce_rate_limit(
        "register-source",
        _client_source(http_request),
        limit=10,
        window_seconds=3600,
    )
    try:
        user = auth.register_user(request.account, request.password, request.nickname)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        session = auth.create_session(int(user["id"]))
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AuthSessionResponse(**session)


@router.post("/login", response_model=AuthSessionResponse)
def login(request: AuthLoginRequest, http_request: Request):
    source = _client_source(http_request)
    normalized_account = auth.auth_rate_limit_account_key(request.account)
    account_key = f"{source}\0{normalized_account}"
    _enforce_rate_limit("login-source", source, limit=30, window_seconds=900)
    _enforce_rate_limit("login-source-account", account_key, limit=8, window_seconds=900)
    user = auth.authenticate_user(request.account, request.password)
    if user is None:
        raise HTTPException(status_code=401, detail="账号或密码错误")
    auth.reset_auth_rate_limit("login-source-account", account_key)
    try:
        session = auth.create_session(int(user["id"]))
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AuthSessionResponse(**session)


@router.post("/refresh", response_model=AuthSessionResponse)
def refresh(token: str = Depends(_credentials_token)):
    try:
        session = auth.refresh_session(token)
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录") from exc
    if session is None:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return AuthSessionResponse(**session)


@router.get("/me", response_model=AuthUser)
def me(current_user: dict = Depends(get_current_user)):
    return AuthUser(**current_user)


@router.post("/logout", status_code=204)
def logout(token: str = Depends(_credentials_token)):
    auth.revoke_session(token)
    return None


@router.post("/change-password", status_code=204)
def change_password(
    request: PasswordChangeRequest,
    http_request: Request,
    token: str = Depends(_credentials_token),
    current_user: dict = Depends(get_current_user),
):
    _enforce_rate_limit(
        "change-password-user-source",
        f"{current_user['id']}\0{_client_source(http_request)}",
        limit=8,
        window_seconds=900,
    )
    try:
        auth.change_password(
            int(current_user["id"]),
            request.current_password,
            request.new_password,
            keep_token=token,
        )
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return None


@router.post(
    "/password-reset-requests",
    response_model=PasswordResetResponse,
    status_code=202,
)
def password_reset_request(request: PasswordResetRequest, http_request: Request):
    _enforce_rate_limit(
        "password-reset-source",
        _client_source(http_request),
        limit=6,
        window_seconds=3600,
    )
    try:
        request_id = auth.create_password_reset_request(request.account)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PasswordResetResponse(
        request_id=request_id,
        message="重置请求已提交，管理员处理后会通过账号绑定的联系方式与你确认。",
    )


@router.post(
    "/account-deletion-requests",
    response_model=AccountDeletionRequestReceipt,
    status_code=202,
)
def account_deletion_request(request: AccountDeletionRequestCreate, http_request: Request):
    _enforce_rate_limit(
        "account-deletion-request-source",
        _client_source(http_request),
        limit=10,
        window_seconds=3600,
    )
    try:
        request_id = auth.create_account_deletion_request(
            request.account,
            request.contact,
            request.reason,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return AccountDeletionRequestReceipt(
        request_id=request_id,
        message="删除请求已提交。为保护账号安全，处理前会通过你填写的联系方式核验身份。",
    )


@router.get(
    "/account-deletion-requests/{request_id}",
    response_model=AccountDeletionRequestStatus,
)
def account_deletion_request_status(request_id: str):
    result = auth.get_account_deletion_request_status(request_id)
    if result is None:
        raise HTTPException(status_code=404, detail="删除请求不存在或已过期")
    return AccountDeletionRequestStatus(**result)


@router.delete("/me", response_model=AccountDeleteResponse)
async def delete_current_account(
    request: AccountDeleteRequest,
    http_request: Request,
    _token: str = Depends(_credentials_token),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    _enforce_rate_limit(
        "delete-account-user-source",
        f"{user_id}\0{_client_source(http_request)}",
        limit=8,
        window_seconds=900,
    )
    operation_id = secrets.token_urlsafe(18)
    if not auth.verify_user_password(user_id, request.current_password):
        raise HTTPException(status_code=400, detail="当前密码错误")

    try:
        await begin_user_meeting_deletion(user_id, db, operation_id)
        await preflight_user_meeting_deletion(user_id, db, operation_id)
        auth.begin_account_deletion(
            user_id,
            request.current_password,
            operation_id=operation_id,
            revoke_sessions=False,
        )
        meeting_report = await delete_user_meeting_data(user_id, db, operation_id)
        delete_user_voiceprints(user_id)
        await finalize_user_meeting_deletion(user_id, db, operation_id)
    except auth.AccountDeletionInProgress as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except AccountDeletionConflict as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AccountDeletionCleanupError as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        raise HTTPException(status_code=503, detail=f"账号尚未删除：{exc}，请稍后重试") from exc
    except Exception as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        logger.exception("Meeting cleanup failed before deleting account user_id=%s", user_id)
        raise HTTPException(status_code=503, detail="账号尚未删除：会议数据清理失败，请稍后重试") from exc

    try:
        account_report = auth.delete_account_data_after_verification(
            user_id,
            operation_id=operation_id,
        )
    except Exception as exc:
        await _release_deletion_guards(user_id, db, operation_id)
        logger.exception("Auth cleanup failed after meeting cleanup user_id=%s", user_id)
        raise HTTPException(status_code=503, detail="账号尚未删除完整，请重试删除操作") from exc

    cleanup_pending = int(account_report.get("cleanup_pending", 0))
    try:
        await finalize_user_deletion_guard(user_id, db, operation_id)
    except Exception:
        cleanup_pending += 1
        logger.exception("Could not finalize user deletion guard user_id=%s", user_id)
    return AccountDeleteResponse(
        deleted=True,
        events_deleted=int(account_report.get("events_deleted", 0)),
        meetings_deleted=meeting_report.meetings_deleted,
        sessions_deleted=int(account_report.get("sessions_deleted", 0)),
        cleanup_pending=cleanup_pending,
    )


@router.get("/me/profile", response_model=AuthProfile)
def get_profile(current_user: dict = Depends(get_current_user)):
    profile = auth.get_profile(int(current_user["id"]))
    if profile is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return AuthProfile(**profile)


@router.patch("/me/profile", response_model=AuthProfile)
def update_profile(
    request: AuthProfileUpdate,
    current_user: dict = Depends(get_current_user),
):
    values = request.model_dump(exclude_unset=True, exclude={"avatar_initial"})
    try:
        return AuthProfile(**auth.update_profile(int(current_user["id"]), values))
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/me/avatar", response_model=AuthProfile)
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    content = await file.read(MAX_AVATAR_BYTES + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=400, detail="头像文件为空")
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="头像文件不能超过 5 MB")
    extension = _avatar_extension(content)
    if extension is None:
        raise HTTPException(status_code=415, detail="头像仅支持 JPEG、PNG 或 WebP")
    try:
        return AuthProfile(**auth.save_avatar(int(current_user["id"]), content, extension))
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/me/avatar", response_model=AuthProfile)
def delete_avatar(current_user: dict = Depends(get_current_user)):
    try:
        return AuthProfile(**auth.delete_avatar(int(current_user["id"])))
    except auth.AccountWriteBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/avatars/{filename}", include_in_schema=False)
def read_avatar(filename: str):
    path = auth.avatar_path(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="头像不存在")
    media_type = {
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"},
    )
