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


class MeetingActionShare(Base):
    __tablename__ = "meeting_action_shares"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "client_share_id",
            name="uq_meeting_action_share_client_identity",
        ),
        UniqueConstraint("token_hash", name="uq_meeting_action_share_token_hash"),
        Index(
            "idx_meeting_action_share_owner_action",
            "owner_user_id",
            "meeting_id",
            "action_id",
            "updated_at",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    action_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_items.id", ondelete="CASCADE"), nullable=False
    )
    client_share_id: Mapped[str] = mapped_column(String(512), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    permission: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MeetingActionCollaborationOperation(Base):
    __tablename__ = "meeting_action_collaboration_operations"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "idempotency_key",
            name="uq_meeting_action_collaboration_operation_key",
        ),
        Index("idx_meeting_action_collaboration_operation_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    share_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_shares.id", ondelete="CASCADE"), nullable=False
    )
    action_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_items.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[str] = mapped_column(String(160), nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingActionCollaborationEvent(Base):
    __tablename__ = "meeting_action_collaboration_events"
    __table_args__ = (
        Index("idx_meeting_action_collaboration_event_share", "share_id", "created_at", "id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    share_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_shares.id", ondelete="CASCADE"), nullable=False
    )
    action_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_action_items.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[str] = mapped_column(String(160), nullable=False)
    actor_role: Mapped[str] = mapped_column(String(20), nullable=False)
    action_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    changed_fields_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
