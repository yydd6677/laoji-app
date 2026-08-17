import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingOccurrenceLink(Base):
    __tablename__ = "meeting_occurrence_links_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "source_event_id",
            "occurrence_date",
            name="uq_meeting_occurrence_owner_identity",
        ),
        UniqueConstraint(
            "user_id",
            "meeting_id",
            name="uq_meeting_occurrence_owner_meeting",
        ),
        Index(
            "idx_meeting_occurrence_owner_series",
            "user_id",
            "series_key",
            "occurrence_date",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source_event_id: Mapped[str] = mapped_column(String(512), nullable=False)
    occurrence_date: Mapped[str] = mapped_column(String(10), nullable=False)
    calendar_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    recurrence_segment_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    series_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    link_state: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class MeetingScheduleSnapshotV2(Base):
    __tablename__ = "meeting_schedule_snapshots_v2"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "meeting_id",
            name="uq_meeting_schedule_snapshot_owner_meeting",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    event_title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    planned_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    planned_end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    all_day: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    timezone_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    location: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    participants_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_event_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    captured_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingOccurrenceOperation(Base):
    __tablename__ = "meeting_occurrence_operations"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_meeting_occurrence_operation_key",
        ),
        Index("idx_meeting_occurrence_operation_created", "created_at"),
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
    link_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_occurrence_links_v2.id", ondelete="CASCADE"), nullable=False
    )
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
