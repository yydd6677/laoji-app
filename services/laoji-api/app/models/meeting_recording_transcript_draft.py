"""Durable, replaceable transcript segments published during offline ASR."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class MeetingRecordingTranscriptDraftV1(Base):
    """One provisional ASR segment for a running recording job.

    Drafts are deliberately separate from ``transcript_lines``.  Summary and
    question endpoints must never consume an incomplete transcript, while the
    device transcript endpoint can expose these rows as soon as a batch is
    recognized.  A final job atomically replaces the canonical transcript and
    removes its drafts.
    """

    __tablename__ = "meeting_recording_transcript_drafts_v1"
    __table_args__ = (
        UniqueConstraint(
            "job_id",
            "segment_id",
            name="uq_recording_transcript_drafts_v1_job_segment",
        ),
        Index(
            "idx_recording_transcript_drafts_v1_meeting_job",
            "meeting_id",
            "job_id",
            "start_ms",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_recording_assets_v2.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[str] = mapped_column(
        ForeignKey("meeting_recording_transcription_jobs_v2.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    data_epoch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    segment_id: Mapped[str] = mapped_column(String(128), nullable=False)
    speaker_id: Mapped[str] = mapped_column(String(50), nullable=False, default="unknown")
    speaker_label: Mapped[str] = mapped_column(String(100), nullable=False, default="未识别讲话人")
    text: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model_revision: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
