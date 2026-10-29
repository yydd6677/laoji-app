from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


from app.models.meeting import Meeting  # noqa: E402, F401
from app.models.transcript import TranscriptLine  # noqa: E402, F401
from app.models.meeting_recording_asset import (  # noqa: E402, F401
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_recording_r2_upload import MeetingRecordingR2UploadV1  # noqa: E402, F401
from app.models.meeting_recording_transcript_draft import MeetingRecordingTranscriptDraftV1  # noqa: E402, F401
