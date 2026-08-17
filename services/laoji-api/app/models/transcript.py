import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Float, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base


class TranscriptLine(Base):
    __tablename__ = "transcript_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    meeting_id: Mapped[str] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    recording_asset_id: Mapped[str | None] = mapped_column(
        ForeignKey("meeting_recording_assets_v2.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    transcription_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("meeting_recording_transcription_jobs_v2.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    speaker_id: Mapped[str] = mapped_column(String(50), nullable=False)
    speaker_label: Mapped[str] = mapped_column(String(100), nullable=False)
    text: Mapped[str] = mapped_column(String(2000), nullable=False)
    start_time: Mapped[float] = mapped_column(Float, nullable=False)
    end_time: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    meeting: Mapped["Meeting"] = relationship(back_populates="transcript_lines")
