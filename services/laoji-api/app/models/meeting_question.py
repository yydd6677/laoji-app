import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
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


class MeetingQuestionThread(Base):
    __tablename__ = "meeting_question_threads"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "meeting_id",
            "client_thread_id",
            name="uq_meeting_question_thread_client",
        ),
        Index("idx_meeting_question_thread_meeting", "user_id", "meeting_id", "updated_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    client_thread_id: Mapped[str] = mapped_column(String(512), nullable=False)
    input_fingerprint: Mapped[str] = mapped_column(String(71), nullable=False)
    transcript_revision_id: Mapped[str] = mapped_column(String(512), nullable=False)
    summary_version_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    manual_note_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    include_manual_note: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class MeetingQuestionTurn(Base):
    __tablename__ = "meeting_question_turns"
    __table_args__ = (
        UniqueConstraint("thread_id", "client_request_id", name="uq_meeting_question_request"),
        UniqueConstraint("thread_id", "ordinal", name="uq_meeting_question_ordinal"),
        Index("idx_meeting_question_turn_thread", "thread_id", "ordinal"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    thread_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_question_threads.id", ondelete="CASCADE"), nullable=False
    )
    client_request_id: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer_scope: Mapped[str] = mapped_column(String(20), nullable=False, default="meeting")
    answer_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingQuestionCitation(Base):
    __tablename__ = "meeting_question_citations"
    __table_args__ = (
        UniqueConstraint("turn_id", "ordinal", name="uq_meeting_question_citation_ordinal"),
        Index("idx_meeting_question_citation_turn", "turn_id", "ordinal"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    turn_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_question_turns.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    source_id: Mapped[str] = mapped_column(String(512), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
