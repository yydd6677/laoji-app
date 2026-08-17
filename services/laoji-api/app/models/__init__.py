from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


from app.models.meeting import Meeting, MeetingSegment  # noqa: E402, F401
from app.models.transcript import TranscriptLine  # noqa: E402, F401
from app.models.summary import PeriodSummary, FinalSummary  # noqa: E402, F401
from app.models.meeting_action import MeetingActionItem, MeetingActionOperation  # noqa: E402, F401
from app.models.meeting_action_share import (  # noqa: E402, F401
    MeetingActionCollaborationEvent,
    MeetingActionCollaborationOperation,
    MeetingActionShare,
)
from app.models.meeting_content_share import (  # noqa: E402, F401
    MeetingContentShare,
    MeetingContentShareOperation,
)
from app.models.meeting_manual_note import MeetingManualNote, MeetingManualNoteOperation  # noqa: E402, F401
from app.models.meeting_attachment import (  # noqa: E402, F401
    MeetingAttachmentOperationV1,
    MeetingAttachmentV1,
)
from app.models.meeting_marker import MeetingMarkerOperationV1, MeetingMarkerV1  # noqa: E402, F401
from app.models.meeting_summary_sync import (  # noqa: E402, F401
    MeetingSummaryCurrentV1,
    MeetingSummaryOperationV1,
    MeetingSummarySectionStateV1,
    MeetingSummaryVersionV1,
)
from app.models.meeting_tag_catalog import (  # noqa: E402, F401
    MeetingTagCatalogOperationV1,
    MeetingTagCatalogV1,
)
from app.models.meeting_occurrence import (  # noqa: E402, F401
    MeetingOccurrenceLink,
    MeetingOccurrenceOperation,
    MeetingScheduleSnapshotV2,
)
from app.models.meeting_note_root import (  # noqa: E402, F401
    MeetingNoteRootOperationV2,
    MeetingNoteRootV2,
)
from app.models.meeting_question import (  # noqa: E402, F401
    MeetingQuestionCitation,
    MeetingQuestionThread,
    MeetingQuestionTurn,
)
from app.models.meeting_recording_asset import (  # noqa: E402, F401
    MeetingMediaClipJobV1,
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_recording_r2_upload import MeetingRecordingR2UploadV1  # noqa: E402, F401
from app.models.meeting_recording_transcript_draft import MeetingRecordingTranscriptDraftV1  # noqa: E402, F401
