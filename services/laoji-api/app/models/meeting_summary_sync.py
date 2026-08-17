import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingSummaryVersionV1(Base):
    __tablename__ = "meeting_summary_versions_v1"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "meeting_id",
            "id",
            name="uq_meeting_summary_version_v1_owner",
        ),
        Index(
            "idx_meeting_summary_version_v1_meeting",
            "user_id",
            "meeting_id",
            "created_at",
            "id",
        ),
    )

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ready")
    template_id: Mapped[str] = mapped_column(String(80), nullable=False)
    template_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    generated_document_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingSummarySectionStateV1(Base):
    __tablename__ = "meeting_summary_section_states_v1"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "version_id",
            "section_id",
            name="uq_meeting_summary_section_state_v1_identity",
        ),
        Index(
            "idx_meeting_summary_section_state_v1_version",
            "user_id",
            "version_id",
            "ordinal",
            "section_id",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_summary_versions_v1.id", ondelete="CASCADE"), nullable=False
    )
    section_id: Mapped[str] = mapped_column(String(512), nullable=False)
    stable_key: Mapped[str] = mapped_column(String(160), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    user_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    visible_citation_ids_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingSummaryCurrentV1(Base):
    __tablename__ = "meeting_summary_current_v1"
    __table_args__ = (
        UniqueConstraint("user_id", "meeting_id", name="uq_meeting_summary_current_v1_owner"),
        Index("idx_meeting_summary_current_v1_version", "user_id", "version_id"),
    )

    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    version_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_summary_versions_v1.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    client_updated_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class MeetingSummaryOperationV1(Base):
    __tablename__ = "meeting_summary_operations_v1"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_meeting_summary_operation_v1_user_key",
        ),
        Index("idx_meeting_summary_operation_v1_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    aggregate_id: Mapped[str] = mapped_column(String(512), nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(71), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
