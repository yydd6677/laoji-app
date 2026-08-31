import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingRecordingAssetV2(Base):
    __tablename__ = "meeting_recording_assets_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "client_asset_id",
            name="uq_recording_assets_v2_user_client_asset",
        ),
        Index("idx_recording_assets_v2_meeting", "meeting_id", "role", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    client_asset_id: Mapped[str] = mapped_column(String(512), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    origin: Mapped[str] = mapped_column(String(20), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    upload_state: Mapped[str] = mapped_column(String(24), nullable=False, default="registered")
    mime_type: Mapped[str] = mapped_column(String(160), nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checksum_sha256: Mapped[str | None] = mapped_column(String(71), nullable=True)
    storage_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    content_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MeetingRecordingAssetOperationV2(Base):
    __tablename__ = "meeting_recording_asset_operations_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_recording_asset_operations_v2_user_key",
        ),
        Index("idx_recording_asset_operations_v2_asset", "asset_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_recording_assets_v2.id", ondelete="CASCADE"), nullable=False
    )
    operation_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(71), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingRecordingTranscriptionJobV2(Base):
    __tablename__ = "meeting_recording_transcription_jobs_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "client_request_id",
            name="uq_recording_transcription_jobs_v2_user_request",
        ),
        Index("idx_recording_transcription_jobs_v2_asset", "asset_id", "created_at"),
        Index("idx_recording_transcription_jobs_v2_meeting", "meeting_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_recording_assets_v2.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    client_request_id: Mapped[str] = mapped_column(String(512), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    language: Mapped[str] = mapped_column(String(32), nullable=False, default="zh")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress: Mapped[float | None] = mapped_column(Float, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(160), nullable=True)
    retryable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    result_revision_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
