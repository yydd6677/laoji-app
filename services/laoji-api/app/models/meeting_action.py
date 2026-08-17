import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingActionItem(Base):
    __tablename__ = "meeting_action_items"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "meeting_id",
            "client_action_id",
            name="uq_meeting_action_client_identity",
        ),
        Index("idx_meeting_action_meeting_revision", "meeting_id", "revision"),
        Index(
            "idx_meeting_action_pull_cursor",
            "user_id",
            "meeting_id",
            "updated_at",
            "id",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    client_action_id: Mapped[str] = mapped_column(String(512), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    client_created_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_edited_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    completed_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    assignee: Mapped[str | None] = mapped_column(String(500), nullable=True)
    due_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reminder_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    followup_event_source_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    source_summary_version_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_segment_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    generation_fingerprint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class MeetingActionOperation(Base):
    __tablename__ = "meeting_action_operations"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_meeting_action_operation_key"),
        Index("idx_meeting_action_operation_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    client_action_id: Mapped[str] = mapped_column(String(512), nullable=False)
    action_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_items.id", ondelete="CASCADE"), nullable=False
    )
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
