import { meetingMemorySchemaV1 } from './0001MeetingMemorySchema';
import { meetingMemoryPhase1 } from './0002MeetingMemoryPhase1';
import { meetingContextV3 } from './0003MeetingContext';
import { meetingWriteOwnershipV4 } from './0004MeetingWriteOwnership';
import { summaryCitationIdentityV5 } from './0005SummaryCitationIdentity';
import { actionRemindersV6 } from './0006ActionReminders';
import { actionRemoteRevisionV7 } from './0007ActionRemoteRevision';
import { actionOutboxTransportV8 } from './0008ActionOutboxTransport';
import { actionMarkerSourceV9 } from './0009ActionMarkerSource';
import { meetingSeriesIdentityV10 } from './0010MeetingSeriesIdentity';
import { speakerAssignmentsV11 } from './0011SpeakerAssignments';
import { speakerCorrectionSyncV12 } from './0012SpeakerCorrectionSync';
import { seriesCarryImportsV13 } from './0013SeriesCarryImports';
import { actionPullCursorV14 } from './0014ActionPullCursor';
import { occurrenceLinkSyncV15 } from './0015OccurrenceLinkSync';
import { occurrenceDetachedHistoryV16 } from './0016OccurrenceDetachedHistory';
import { meetingRootPullCursorV17 } from './0017MeetingRootPullCursor';
import { meetingDeletionLifecycleV18 } from './0018MeetingDeletionLifecycle';
import { recordingMergeRecoveryV19 } from './0019RecordingMergeRecovery';
import { meetingOrganizationSearchV20 } from './0020MeetingOrganizationSearch';
import { meetingAttachmentsV21 } from './0021MeetingAttachments';
import { meetingQuestionsV22 } from './0022MeetingQuestions';
import { meetingMediaClipsV23 } from './0023MeetingMediaClips';
import { meetingActionCollaborationV24 } from './0024MeetingActionCollaboration';
import { transcriptRecordingProvenanceV25 } from './0025TranscriptRecordingProvenance';
import { recordingAssetTranscriptionTasksV26 } from './0026RecordingAssetTranscriptionTasks';
import { meetingRetentionCleanupV27 } from './0027MeetingRetentionCleanup';
import { meetingTagCatalogSyncV28 } from './0028MeetingTagCatalogSync';
import { meetingContentSharesV29 } from './0029MeetingContentShares';
import { remoteMediaClipsV30 } from './0030RemoteMediaClips';
import { transcriptReprocessTasksV31 } from './0031TranscriptReprocessTasks';
import { meetingAttachmentSyncV32 } from './0032MeetingAttachmentSync';
import { meetingListOrderV33 } from './0033MeetingListOrder';
import { meetingMarkerSyncV34 } from './0034MeetingMarkerSync';
import { meetingQuestionScopesV35 } from './0035MeetingQuestionScopes';
import { summaryCitationUserOverridesV36 } from './0036SummaryCitationUserOverrides';
import { summaryVersionSyncV37 } from './0037SummaryVersionSync';
import { localScheduleEventsV38 } from './0038LocalScheduleEvents';
import { summaryFactsV3 } from './0039SummaryFactsV3';
import { vnextAuthorityAndOperations } from './0040VNextAuthorityAndOperations';
import { vnextCutoverTombstones } from './0041VNextCutoverTombstones';
import { immutableSourcesAndQuestionQ2 } from './0042ImmutableSourcesAndQuestionQ2';
import { transcriptOverlayAndSearchVNext } from './0043TranscriptOverlayAndSearchVNext';
import { mediaGenerationAndTrashVNext } from './0044MediaGenerationAndTrashVNext';
import type { MeetingDatabaseMigration } from './types';

export const meetingDatabaseMigrations: readonly MeetingDatabaseMigration[] = [
  meetingMemorySchemaV1,
  meetingMemoryPhase1,
  meetingContextV3,
  meetingWriteOwnershipV4,
  summaryCitationIdentityV5,
  actionRemindersV6,
  actionRemoteRevisionV7,
  actionOutboxTransportV8,
  actionMarkerSourceV9,
  meetingSeriesIdentityV10,
  speakerAssignmentsV11,
  speakerCorrectionSyncV12,
  seriesCarryImportsV13,
  actionPullCursorV14,
  occurrenceLinkSyncV15,
  occurrenceDetachedHistoryV16,
  meetingRootPullCursorV17,
  meetingDeletionLifecycleV18,
  recordingMergeRecoveryV19,
  meetingOrganizationSearchV20,
  meetingAttachmentsV21,
  meetingQuestionsV22,
  meetingMediaClipsV23,
  meetingActionCollaborationV24,
  transcriptRecordingProvenanceV25,
  recordingAssetTranscriptionTasksV26,
  meetingRetentionCleanupV27,
  meetingTagCatalogSyncV28,
  meetingContentSharesV29,
  remoteMediaClipsV30,
  transcriptReprocessTasksV31,
  meetingAttachmentSyncV32,
  meetingListOrderV33,
  meetingMarkerSyncV34,
  meetingQuestionScopesV35,
  summaryCitationUserOverridesV36,
  summaryVersionSyncV37,
  localScheduleEventsV38,
  summaryFactsV3,
  vnextAuthorityAndOperations,
  vnextCutoverTombstones,
  immutableSourcesAndQuestionQ2,
  transcriptOverlayAndSearchVNext,
  mediaGenerationAndTrashVNext,
];

export { MEETING_MEMORY_SCHEMA_V1_SQL } from './0001MeetingMemorySchema';
export { MEETING_MEMORY_PHASE_1_SQL } from './0002MeetingMemoryPhase1';
export { MEETING_CONTEXT_V3_SQL } from './0003MeetingContext';
export { MEETING_WRITE_OWNERSHIP_V4_SQL } from './0004MeetingWriteOwnership';
export { SUMMARY_CITATION_IDENTITY_V5_SQL } from './0005SummaryCitationIdentity';
export { ACTION_REMINDERS_V6_SQL } from './0006ActionReminders';
export { ACTION_REMOTE_REVISION_V7_SQL } from './0007ActionRemoteRevision';
export { ACTION_OUTBOX_TRANSPORT_V8_SQL } from './0008ActionOutboxTransport';
export { ACTION_MARKER_SOURCE_V9_SQL } from './0009ActionMarkerSource';
export { MEETING_SERIES_IDENTITY_V10_SQL } from './0010MeetingSeriesIdentity';
export { SPEAKER_ASSIGNMENTS_V11_SQL } from './0011SpeakerAssignments';
export { SPEAKER_CORRECTION_SYNC_V12_SQL } from './0012SpeakerCorrectionSync';
export { SERIES_CARRY_IMPORTS_V13_SQL } from './0013SeriesCarryImports';
export { ACTION_PULL_CURSOR_V14_SQL } from './0014ActionPullCursor';
export { OCCURRENCE_LINK_SYNC_V15_SQL } from './0015OccurrenceLinkSync';
export { OCCURRENCE_DETACHED_HISTORY_V16_SQL } from './0016OccurrenceDetachedHistory';
export { MEETING_ROOT_PULL_CURSOR_V17_SQL } from './0017MeetingRootPullCursor';
export { MEETING_DELETION_LIFECYCLE_V18_SQL } from './0018MeetingDeletionLifecycle';
export { RECORDING_MERGE_RECOVERY_V19_SQL } from './0019RecordingMergeRecovery';
export { MEETING_ORGANIZATION_SEARCH_V20_SQL } from './0020MeetingOrganizationSearch';
export { MEETING_ATTACHMENTS_V21_SQL } from './0021MeetingAttachments';
export { MEETING_QUESTIONS_V22_SQL } from './0022MeetingQuestions';
export { MEETING_MEDIA_CLIPS_V23_SQL } from './0023MeetingMediaClips';
export { MEETING_ACTION_COLLABORATION_V24_SQL } from './0024MeetingActionCollaboration';
export { TRANSCRIPT_RECORDING_PROVENANCE_V25_SQL } from './0025TranscriptRecordingProvenance';
export { RECORDING_ASSET_TRANSCRIPTION_TASKS_V26_SQL } from './0026RecordingAssetTranscriptionTasks';
export { MEETING_RETENTION_CLEANUP_V27_SQL } from './0027MeetingRetentionCleanup';
export { MEETING_TAG_CATALOG_SYNC_V28_SQL } from './0028MeetingTagCatalogSync';
export { MEETING_CONTENT_SHARES_V29_SQL } from './0029MeetingContentShares';
export { REMOTE_MEDIA_CLIPS_V30_SQL } from './0030RemoteMediaClips';
export { TRANSCRIPT_REPROCESS_TASKS_V31_SQL } from './0031TranscriptReprocessTasks';
export { MEETING_ATTACHMENT_SYNC_V32_SQL } from './0032MeetingAttachmentSync';
export { MEETING_LIST_ORDER_V33_SQL } from './0033MeetingListOrder';
export { MEETING_MARKER_SYNC_V34_SQL } from './0034MeetingMarkerSync';
export { MEETING_QUESTION_SCOPES_V35_SQL } from './0035MeetingQuestionScopes';
export { SUMMARY_CITATION_USER_OVERRIDES_V36_SQL } from './0036SummaryCitationUserOverrides';
export { SUMMARY_VERSION_SYNC_V37_SQL } from './0037SummaryVersionSync';
export { LOCAL_SCHEDULE_EVENTS_V38_SQL } from './0038LocalScheduleEvents';
export { SUMMARY_FACTS_V3_SQL } from './0039SummaryFactsV3';
export { VNEXT_AUTHORITY_AND_OPERATIONS_V40_SQL } from './0040VNextAuthorityAndOperations';
export { VNEXT_CUTOVER_TOMBSTONES_V41_SQL } from './0041VNextCutoverTombstones';
export { IMMUTABLE_SOURCES_AND_Q2_V42_SQL } from './0042ImmutableSourcesAndQuestionQ2';
export { TRANSCRIPT_OVERLAY_AND_SEARCH_VNEXT_V43_SQL } from './0043TranscriptOverlayAndSearchVNext';
export { MEDIA_GENERATION_AND_TRASH_VNEXT_V44_SQL } from './0044MediaGenerationAndTrashVNext';
export type { MeetingDatabaseMigration } from './types';
