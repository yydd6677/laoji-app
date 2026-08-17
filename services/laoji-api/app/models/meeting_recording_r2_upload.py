"""Durable state for direct Cloudflare R2 recording uploads."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingRecordingR2UploadV1(Base):
    __tablename__ = "meeting_recording_r2_uploads_v1"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "asset_id",
            name="uq_recording_r2_uploads_v1_user_asset",
        ),
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_recording_r2_uploads_v1_user_key",
        ),
        Index(
            "idx_recording_r2_uploads_v1_expiry",
            "status",
            "expires_at",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_recording_assets_v2.id", ondelete="CASCADE"), nullable=False
    )
    data_epoch_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    bucket: Mapped[str] = mapped_column(String(255), nullable=False)
    object_key: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)
    multipart_upload_id: Mapped[str] = mapped_column(String(512), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    part_size: Mapped[int] = mapped_column(Integer, nullable=False)
    total_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    total_parts: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum_sha256: Mapped[str | None] = mapped_column(String(71), nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

