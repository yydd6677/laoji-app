import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingMarkerV1(Base):
    __tablename__ = "meeting_markers_v1"
    __table_args__ = (
        UniqueConstraint("user_id", "client_marker_id", name="uq_meeting_marker_v1_user_client"),
        Index(
            "idx_meeting_marker_v1_meeting",
            "user_id",
            "meeting_id",
            "created_at",
            "id",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    client_marker_id: Mapped[str] = mapped_column(String(512), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    lifecycle: Mapped[str] = mapped_column(String(20), nullable=False)
    position_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    label: Mapped[str | None] = mapped_column(String(500), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="important")
    client_created_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MeetingMarkerOperationV1(Base):
    __tablename__ = "meeting_marker_operations_v1"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_meeting_marker_operation_v1_user_key"),
        Index(
            "idx_meeting_marker_operation_v1_marker",
            "marker_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    marker_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_markers_v1.id", ondelete="CASCADE"), nullable=False
    )
    operation_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(71), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
