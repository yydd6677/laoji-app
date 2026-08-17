"""
老记账号 API Schema
"""

from typing import List, Optional
from pydantic import BaseModel, Field


class AuthUser(BaseModel):
    """当前登录用户资料"""
    id: int
    account: str
    nickname: str
    email: Optional[str] = None
    phone: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: str


class AuthRegisterRequest(BaseModel):
    """注册请求"""
    account: str = Field(..., min_length=3, max_length=120)
    password: str = Field(..., min_length=8, max_length=128)
    nickname: Optional[str] = Field(None, max_length=50)


class AuthLoginRequest(BaseModel):
    """登录请求"""
    account: str = Field(..., min_length=3, max_length=120)
    password: str = Field(..., min_length=6, max_length=128)


class AuthSessionResponse(BaseModel):
    """登录态响应"""
    access_token: str
    token_type: str = "bearer"
    expires_at: str
    user: AuthUser


class PasswordChangeRequest(BaseModel):
    """登录用户修改密码。当前密码兼容早期 6 位账号，新密码至少 8 位。"""
    current_password: str = Field(..., min_length=6, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


class PasswordResetRequest(BaseModel):
    """创建由管理员处理的人工密码重置请求。"""
    account: str = Field(..., min_length=3, max_length=120)


class PasswordResetResponse(BaseModel):
    request_id: str
    message: str


class AccountDeleteRequest(BaseModel):
    """Authenticated, irreversible account deletion confirmation."""
    current_password: str = Field(..., min_length=6, max_length=128)
    confirmation: str = Field(..., pattern=r"^删除账号$")


class AccountDeleteResponse(BaseModel):
    deleted: bool
    events_deleted: int = 0
    meetings_deleted: int = 0
    sessions_deleted: int = 0
    cleanup_pending: int = 0


class AccountDeletionRequestCreate(BaseModel):
    """Public web request for users who no longer have App access."""
    account: str = Field(..., min_length=3, max_length=120)
    contact: str = Field(..., min_length=3, max_length=200)
    reason: Optional[str] = Field(None, max_length=500)


class AccountDeletionRequestReceipt(BaseModel):
    request_id: str
    message: str


class AccountDeletionRequestStatus(BaseModel):
    request_id: str
    status: str
    created_at: str
    handled_at: Optional[str] = None


class AuthProfile(BaseModel):
    nickname: str
    email: Optional[str] = None
    phone: Optional[str] = None
    avatar_initial: str = ""
    avatar_colors: List[str] = Field(default_factory=lambda: ["#9268E0", "#6A38B2"])
    avatar_url: Optional[str] = None


class AuthProfileUpdate(BaseModel):
    nickname: Optional[str] = Field(None, min_length=1, max_length=50)
    email: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=25)
    avatar_initial: Optional[str] = Field(None, max_length=0)
    avatar_colors: Optional[List[str]] = Field(None, min_length=2, max_length=2)
