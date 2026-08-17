import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingSpeakerCorrectionV2(Base):
    __tablename__ = "meeting_speaker_corrections_v2"
    __table_args__ = (
        UniqueConstraint("user_id", "client_request_id", name="uq_speaker_correction_client"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_speaker_correction_operation"),
        UniqueConstraint("meeting_id", "assignment_revision", name="uq_speaker_assignment_revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_request_id: Mapped[str] = mapped_column(String(512), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    transcript_revision_id: Mapped[str] = mapped_column(String(512), nullable=False)
    scope: Mapped[str] = mapped_column(String(24), nullable=False)
    segment_ids_json: Mapped[str] = mapped_column(Text, nullable=False)
    cluster_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    speaker_profile_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    consent_to_profile_update: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    base_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    assignment_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    profile_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sample_state: Mapped[str] = mapped_column(String(32), nullable=False, default="not_requested")
    sample_error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class MeetingSpeakerAssignmentV2(Base):
    __tablename__ = "meeting_speaker_assignments_v2"
    __table_args__ = (
        UniqueConstraint("correction_id", "transcript_line_id", name="uq_speaker_correction_line"),
        UniqueConstraint("reprocess_job_id", "transcript_line_id", name="uq_speaker_reprocess_line"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    correction_id: Mapped[str | None] = mapped_column(
        ForeignKey("meeting_speaker_corrections_v2.id", ondelete="CASCADE"), nullable=True
    )
    reprocess_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("meeting_speaker_reprocess_jobs_v2.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    transcript_line_id: Mapped[str] = mapped_column(
        ForeignKey("transcript_lines.id", ondelete="CASCADE"), nullable=False, index=True
    )
    speaker_profile_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    assignment_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(24), nullable=False)
    user_locked: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    model_version: Mapped[str | None] = mapped_column(String(120), nullable=True)
    profile_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class MeetingSpeakerReprocessJobV2(Base):
    __tablename__ = "meeting_speaker_reprocess_jobs_v2"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_speaker_reprocess_operation"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    speaker_profile_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_meetings: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed_meetings: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    matched_segments: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_locked_segments: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    retryable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    profile_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    model_version: Mapped[str] = mapped_column(String(120), nullable=False)
    result_speaker_revision_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
