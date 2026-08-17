import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingManualNote(Base):
    __tablename__ = "meeting_manual_notes"
    __table_args__ = (
        UniqueConstraint("user_id", "meeting_id", name="uq_meeting_manual_note_owner"),
        Index("idx_meeting_manual_note_owner_revision", "user_id", "meeting_id", "revision"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    client_note_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_edited_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class MeetingManualNoteOperation(Base):
    __tablename__ = "meeting_manual_note_operations"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_manual_note_operation_key"),
        Index("idx_manual_note_operation_created", "created_at"),
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
    note_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_manual_notes.id", ondelete="CASCADE"), nullable=False
    )
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
