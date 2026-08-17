import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingNoteRootV2(Base):
    __tablename__ = "meeting_note_roots_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "client_note_id",
            name="uq_meeting_note_root_client_identity",
        ),
        Index(
            "idx_meeting_note_root_pull_cursor",
            "user_id",
            "updated_at",
            "meeting_id",
        ),
    )

    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    client_note_id: Mapped[str] = mapped_column(String(160), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    __mapper_args__ = {
        "version_id_col": revision,
        "version_id_generator": False,
    }
    origin: Mapped[str] = mapped_column(String(32), nullable=False)
    entry_point: Mapped[str | None] = mapped_column(String(40), nullable=True)
    lifecycle: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingNoteRootOperationV2(Base):
    __tablename__ = "meeting_note_root_operations_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_meeting_note_root_operation_key",
        ),
        Index("idx_meeting_note_root_operation_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
