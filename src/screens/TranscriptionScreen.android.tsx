import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Share,
  StyleSheet,
  ToastAndroid,
  View,
} from 'react-native';
import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  hasNativeMediaClip,
  type MinutesDetailTab,
  type MinutesPlayerSourceSnapshot,
  type MinutesProcessingStage,
  type MinutesSemanticAction,
  type MinutesStatusTone,
  type NativeProjectionEnvelope,
} from 'laoji-native-platform';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import {
  MeetingQuestionSheet,
  type MeetingQuestionCitationTarget,
} from '../components/MeetingQuestionSheet';
import { MeetingMediaClipEditorSheet } from '../components/MeetingMediaClipEditorSheet';
import { MeetingMediaClipsSheet } from '../components/MeetingMediaClipsSheet';
import { MeetingActionCollaborationSheet } from '../components/MeetingActionCollaborationSheet';
import {
  MeetingActionEditorSheet,
  type MeetingActionEditorSaveValue,
  type MeetingActionEditorValue,
} from '../components/MeetingActionEditorSheet';
import { MeetingActionsSheet } from '../components/MeetingActionsSheet';
import {
  MeetingActionConflictSheet,
  type MeetingActionConflictChoice,
} from '../components/MeetingActionConflictSheet';
import {
  MeetingManualNoteConflictSheet,
  type MeetingManualNoteConflictChoice,
} from '../components/MeetingManualNoteConflictSheet';
import {
  MeetingSummaryVersionSheet,
  type MeetingSummaryVersionChoice,
} from '../components/MeetingSummaryVersionSheet';
import {
  MeetingSummarySectionEditorSheet,
  type MeetingSummarySectionEditorSaveValue,
  type MeetingSummarySectionEditorValue,
} from '../components/MeetingSummarySectionEditorSheet';
import {
  MeetingSummaryConflictSheet,
  type MeetingSummaryConflictChoice,
} from '../components/MeetingSummaryConflictSheet';
import {
  MeetingSpeakerAssignmentSheet,
  type MeetingSpeakerAssignmentValue,
} from '../components/MeetingSpeakerAssignmentSheet';
import {
  MeetingSummaryBlocksSheet,
  type MeetingSummaryBlockOption,
} from '../components/MeetingSummaryBlocksSheet';
import { MeetingSummaryEvidenceSheet } from '../components/MeetingSummaryEvidenceSheet';
import { MeetingSummaryAttachmentSheet } from '../components/MeetingSummaryAttachmentSheet';
import { MeetingSummaryCarryForwardSheet } from '../components/MeetingSummaryCarryForwardSheet';
import { MeetingShareSheet } from '../components/MeetingShareSheet';
import { MeetingContentShareManagerSheet } from '../components/MeetingContentShareManagerSheet';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { useEvents } from '../store/EventsStore';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import {
  fetchMeetingAudioInfo,
  fetchMeetingSummaryDetail,
  fetchMeetingTranscriptSnapshot,
  uploadMeetingAudio,
} from '../services/api';
import { readableErrorMessage } from '../services/errors';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';
import { Colors as C } from '../theme/colors';
import { fetchDeviceSpeakerProfiles, fetchSpeakers, type SpeakerProfile } from '../services/speakers';
import { resolveMeetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  getPendingMeetingAudioUpload,
  retryPendingMeetingAudioUpload,
  subscribePendingMeetingAudioUploadChanged,
  type PendingMeetingAudioUpload,
} from '../services/meetingRecording';
import {
  getDeviceTranscriptTask,
  rememberDeviceTranscriptTask,
  subscribeDeviceTranscriptTaskChanged,
  type DeviceTranscriptTaskRecord,
} from '../services/deviceTranscriptTasks';
import {
  generateSummaryForMeeting,
  briefGreetingSummaryText,
  MeetingSummaryInputChangedError,
  MeetingSummaryTaskPendingError,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  normalizeRemoteMeetingSummaryResult,
  normalizeMeetingSummaryResult,
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryFactsInputFingerprint,
  meetingSummaryInputFingerprint,
  savePendingMeetingSummaryTask,
  type PendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import { hasCompletedMeetingSummaryTrace } from '../services/meetingSummaryTrace';
import {
  meetingSummaryProcessingFailureCode,
  recordMeetingSummaryProcessing,
} from '../services/meetingSummaryProcessing';
import {
  buildMeetingContentShareSnapshot,
  meetingShareErrorMessage,
  shareMeetingContent,
  type MeetingShareAvailability,
  type MeetingShareSelection,
} from '../services/meetingShare';
import { openMeetingsTab } from '../navigation/tabTargets';
import {
  buildNativeMinutesDetailSnapshot,
  formatNativeMinutesTimestamp,
  nativeMinutesDetailRetryPlan,
  type NativeMinutesPageGenerations,
} from '../native/nativeMinutesSnapshots';
import {
  NativeMinutesRequestCoordinator,
  NativeMinutesTabSelectionOwner,
  type NativeMinutesRequestToken,
} from '../native/nativeMinutesRequestCoordinator';
import type { MeetingSummary, RootStackParamList, TranscriptLine } from '../types';
import {
  DEFAULT_MEETING_TEMPLATE,
  deriveMeetingPresentationState,
  meetingTemplateById,
  processingStatusesFromStages,
  secureClientIdFactory,
  transitionProcessingStage,
  type MeetingProcessingStatuses,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingTemplate,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingMediaClip,
  type MeetingMediaClipDraft,
  type MeetingActionShare,
  type MeetingActionSharePermission,
  type MeetingContentShare,
  type MeetingSummaryActionCandidate,
  type MeetingSummaryCitation,
  type MeetingSummaryDocument,
  type MeetingFactsResultV3,
  type ProcessingStage,
  type ScopeKey,
} from '../domain/meeting';
import {
  canResumeMeetingRecording,
  meetingRemoteIdentity,
  requireMeetingRemoteIdentity,
  transcriptDurationSec,
} from '../utils/meetingMedia';
import { legacyMeetingProcessingStatuses } from '../services/meetingPresentation';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { simplifyTranscriptLines } from '../utils/simplifiedChinese';
import { materializeMeetingPlaybackAudio } from '../services/meetingPlaybackCache';
import {
  listRecordingAssetsV2,
  loadMeetingCapabilities,
} from '../data/api/v2';
import { useMeetingManualNote } from '../hooks/useMeetingManualNote';
import { loadActiveMeetingTranscriptState } from '../services/meetingTranscriptState';
import { requestMeetingTranscriptReprocess } from '../services/meetingTranscriptReprocess';
import { deleteMeetingMarker, loadMeetingMarkers } from '../services/meetingMarkers';
import { subscribeMeetingMarkersChanged } from '../application/meeting/markerSyncTrigger';
import { loadMeetingAttachments } from '../services/meetingAttachments';
import { loadMeetingActions } from '../services/meetingActions';
import { pullMeetingActionsForDetail } from '../services/meetingActionPull';
import type { MeetingActionSyncConflictView } from '../services/meetingActionConflicts';
import { pullMeetingManualNote } from '../services/meetingManualNotePull';
import { pullMeetingSummaryVersions } from '../services/meetingSummaryPull';
import {
  loadMeetingSummarySyncConflicts,
  type MeetingSummarySyncConflictView,
} from '../services/meetingSummaryConflicts';
import { subscribeMeetingSummaryChanged } from '../application/meeting/summarySyncTrigger';
import {
  loadMeetingManualNoteSyncConflict,
  type MeetingManualNoteSyncConflictView,
} from '../services/meetingManualNoteConflicts';
import { shareMeetingMarkerText } from '../services/meetingMarkerShare';
import {
  evaluateTranscriptLineCandidate,
  shouldRecheckTranscriptRemoteCandidate,
} from '../services/transcriptCompleteness';
import {
  dedupeMeetingSummaryActions,
  meetingSummaryDocumentForLegacy,
  meetingSummaryDocumentToText,
} from '../services/meetingSummaryDocument';
import { loadCurrentMeetingSummaryState } from '../services/meetingSummaryState';
import {
  loadMeetingSummaryVersions,
  type MeetingSummaryVersionsState,
} from '../services/meetingSummaryVersions';
import {
  authorizeMeetingSummaryCarryForward,
  resolveMeetingSummaryCarryForwardMemory,
} from '../services/meetingSummaryCarryForward';
import type { MeetingSeriesMemoryProjection } from '../services/meetingSeriesMemory';
import {
  authorizeMeetingSummaryAttachments,
  meetingSummaryAttachmentAuthorizationIsCurrent,
  MeetingSummaryAttachmentSelectionStaleError,
} from '../services/meetingSummaryAttachments';
import {
  CreateMeetingActionUseCase,
  MeetingActionIdentityConflictError,
  MeetingActionRevisionConflictError,
  MeetingActionSyncConflictChangedError,
  MeetingManualNoteSyncConflictChangedError,
  MeetingSummaryVersionConflictError,
  MeetingSummaryVersionUnavailableError,
  MeetingSummarySectionConflictError,
  MeetingSummarySectionContentError,
  MeetingSummarySectionUnavailableError,
  MeetingSummarySyncConflictChangedError,
  EditMeetingSummarySectionUseCase,
  loadMeetingRecordingMergeRecovery,
  mergeDetachedMeetingRecordings,
  type MeetingRecordingMergeRecoveryState,
  SelectMeetingSummaryVersionUseCase,
  RetryMeetingSpeakerCorrectionSyncUseCase,
  ResolveMeetingActionSyncConflictUseCase,
  ResolveMeetingManualNoteSyncConflictUseCase,
  ResolveMeetingSummarySyncConflictUseCase,
  UpdateMeetingActionUseCase,
  UpdateMeetingSpeakerAssignmentUseCase,
  SpeakerAssignmentDraftError,
  SpeakerAssignmentTargetUnavailableError,
} from '../application/meeting';
import { requestMeetingTranscriptCompletion } from '../application/meeting/transcriptCompletionTrigger';
import {
  sqliteMeetingNoteRepository,
  deleteSummaryViewOverride,
  loadMeetingFactsRecordV3ForVersion,
  loadSummaryViewOverrides,
  saveSummaryViewOverride,
  SummaryV3ActivationFenceError,
  summaryV3UpgradeIsRunning,
  type MeetingAttachmentRecord,
  type MarkerRecord,
  type RecordingAssetRecord,
  type SummaryVersionRecord,
} from '../data/repositories';
import {
  isMeetingSummaryInputChangedErrorLike,
  isSummaryV3ActivationFenceErrorLike,
} from '../domain/meeting/summaryErrorIdentity';
import {
  applyMeetingSummaryV3Overrides,
  projectMeetingFactsV3,
} from '../services/meetingSummaryV3';
import {
  isFixedMeetingSummarySection,
  loadMeetingSummaryHiddenBlocks,
  resetMeetingSummaryHiddenBlocks,
  saveMeetingSummaryHiddenBlocks,
  visibleMeetingSummaryDocument,
} from '../services/meetingSummaryLayout';
import {
  beginSummaryV3InteractiveWork,
  subscribeSummaryV3UpgradeChanged,
} from '../services/meetingSummaryV3Upgrade';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import {
  mirrorLegacyTranscriptProcessingFailure,
  mirrorLegacyTranscriptSaveFailure,
} from '../services/meetingStageMirror';
import {
  meetingActionFollowupClientRequestId,
  meetingActionFollowupDraft,
} from '../services/meetingActionFollowup';
import { eventRefForEvent, sourceEventId as calendarSourceEventId } from '../utils/eventIdentity';
import {
  cancelMeetingActionNotification,
  meetingActionReminderAtForDue,
  MeetingActionNotificationPermissionError,
  MeetingActionReminderTimeError,
  reconcileMeetingActionNotifications,
  scheduleMeetingActionNotification,
} from '../services/notifications';
import { useMeetingRecycleCapability } from '../hooks/useMeetingRecycleCapability';
import { getFeatureFlags } from '../config/featureFlags';
import { useNativeProjection } from '../native/useNativeProjection';
import { fenceNativeProjectionAction } from '../native/projectionActionFence';
import {
  createMeetingActionShare,
  loadMeetingActionShares,
  meetingActionShareErrorMessage,
  retryMeetingActionShare,
  revokeMeetingActionShare,
} from '../services/meetingActionCollaboration';
import {
  createMeetingContentShare,
  loadMeetingContentShares,
  meetingContentShareErrorMessage,
  retryMeetingContentShare,
  revokeMeetingContentShare,
} from '../services/meetingContentShare';
import {
  createMeetingMediaClip,
  deleteMeetingMediaClip,
  loadMeetingMediaClipState,
  mediaClipPreferredAssetId,
  meetingMediaClipErrorMessage,
  prepareMeetingMediaClipDraft,
  retryMeetingMediaClip,
  shareMeetingMediaClip,
  type MeetingMediaClipDraftSource,
} from '../services/meetingMediaClips';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

type EditTranscriptSpeakerAction = Extract<MinutesSemanticAction, { type: 'editTranscriptSpeaker' }>;

type SpeakerAssignmentTarget = EditTranscriptSpeakerAction & {
  clusterCount: number;
};

type SummarySectionEditorTarget = MeetingSummarySectionEditorValue & {
  versionId: string;
  stableKey: string;
  v3TemplateId?: MeetingTemplate['id'];
};

type ActiveMeetingFactsV3 = {
  canonicalMeetingId: string;
  summaryVersionId: string;
  result: MeetingFactsResultV3;
};

type DetailVisualPhase = 'idle' | 'running' | 'ready' | 'error' | 'background';
type DetailProcessingPresentation = {
  label: string;
  tone: MinutesStatusTone;
  retryStage: MinutesProcessingStage | null;
};

/**
 * The visual phase belongs to this mounted detail page, while the processing
 * stage is durable meeting state.  A page can finish loading an older result
 * (or stop waiting when it is left) while the durable summary task is still
 * queued/generating.  Never let that page-local phase hide the durable task.
 */
function summaryStageIsActive(status: MeetingProcessingStatuses['summary']): boolean {
  return status === 'queued' || status === 'generating';
}

// Transcript loading still uses its page-local completion/error wording for
// the legacy projection. Summary loading intentionally does not use this
// suppression rule; its durable task stage must remain visible across pages.
function suppressCanonicalProcessing(phase: DetailVisualPhase): boolean {
  return phase === 'ready' || phase === 'error' || phase === 'background';
}

type CanonicalProcessingSnapshot = {
  meetingId: string;
  canonicalMeetingId: string;
  scopeKey: ScopeKey;
  stages: readonly ProcessingStage[];
  recordingAssets: readonly RecordingAssetRecord[];
  recordingMergeRecovery: MeetingRecordingMergeRecoveryState;
};

function reconcileRecoveredSummaryStage(
  snapshot: CanonicalProcessingSnapshot | null,
  document: MeetingSummaryDocument | null,
): CanonicalProcessingSnapshot | null {
  if (!snapshot || !document) return snapshot;
  const current = snapshot.stages.find(stage => stage.stage === 'summary');
  if (
    !current
    || current.status === 'ready'
    || current.status === 'stale'
    || document.completedAtMs < current.updatedAtMs
  ) return snapshot;
  const recovered = transitionProcessingStage(current, {
    stage: 'summary',
    status: document.status,
    progress: 1,
    jobId: null,
  }, Math.max(current.updatedAtMs, document.completedAtMs));
  return {
    ...snapshot,
    stages: snapshot.stages.map(stage => stage.stage === 'summary' ? recovered : stage),
  };
}

const EMPTY_PROCESSING_STATUSES: MeetingProcessingStatuses = {
  capture: 'not_started',
  upload: 'not_required',
  transcript: 'none',
  summary: 'none',
  speaker: 'none',
};

function compactMeetingDateTime(date: string, time?: string): string {
  const currentYearPrefix = `${new Date().getFullYear()}年`;
  const compactDate = date.startsWith(currentYearPrefix) ? date.slice(currentYearPrefix.length) : date;
  return [compactDate, time].filter(Boolean).join(' ');
}

function explicitDetailTab(focus: RootStackParamList['Transcription']['focus']): MinutesDetailTab | null {
  return focus === 'notes' || focus === 'transcript' || focus === 'summary' ? focus : null;
}

function processingStageCanRetry(
  statuses: MeetingProcessingStatuses,
  stage: MinutesProcessingStage,
): boolean {
  if (stage === 'capture') return statuses.capture === 'failed_recoverable';
  if (stage === 'upload') return statuses.upload === 'failed_retryable' || statuses.upload === 'blocked';
  if (stage === 'transcript') return statuses.transcript === 'failed_retryable';
  if (stage === 'summary') return statuses.summary === 'failed_retryable';
  if (stage === 'speaker') return statuses.speaker === 'failed_retryable';
  return false;
}

function transcriptSpeakerClusterId(line: TranscriptLine): string {
  return line.speakerClusterId?.trim() || line.speaker_id?.trim() || '';
}

function localPlayerSource(
  meetingId: string,
  title: string,
  uri: string,
  storageScope: 'guest' | `user:${string}`,
  durationSec?: number,
  options: {
    sourceId?: string;
    label?: string;
    localOnly?: boolean;
    recordingAssetId?: string;
    recordingAssetRemoteId?: string;
  } = {},
): MinutesPlayerSourceSnapshot {
  return {
    sourceId: options.sourceId ?? `local:${meetingId}`,
    uri,
    label: options.label,
    localOnly: options.localOnly,
    recordingAssetId: options.recordingAssetId,
    recordingAssetRemoteId: options.recordingAssetRemoteId,
    title,
    durationMsHint: durationSec ? Math.round(durationSec * 1000) : undefined,
    retainForBackground: true,
    storageScope,
  };
}

function summaryDocumentFor(
  meetingId: string,
  summary: MeetingSummary | null,
): MeetingSummaryDocument | null {
  return summary ? meetingSummaryDocumentForLegacy(meetingId, summary) : null;
}

function summaryTaskInputFingerprint(input: {
  transcriptLines: TranscriptLine[];
  title?: string;
  meetingDate?: string;
  template: Pick<MeetingTemplate, 'id' | 'revision'>;
  carryForward: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  manualNote: { content: string; revision: number };
}): string {
  if (getFeatureFlags().meetingSummarySourceStreamCandidate) {
    return meetingSummaryFactsInputFingerprint(
      input.transcriptLines,
      input.attachmentAuthorization,
      input.manualNote,
    );
  }
  return meetingSummaryInputFingerprint(
    input.transcriptLines,
    input.title,
    input.meetingDate,
    input.template,
    input.carryForward,
    input.attachmentAuthorization,
    input.manualNote,
  );
}

function summaryCacheFailureCode(reason: unknown): string {
  const message = reason instanceof Error ? reason.message.toLowerCase() : '';
  if (message.includes('模板身份')) return 'template_identity_mismatch';
  if (message.includes('响应格式')) return 'response_contract_invalid';
  if (message.includes('远端会议身份')) return 'remote_meeting_identity_invalid';
  if (message.includes('版本映射')) return 'summary_version_mapping_invalid';
  if (message.includes('生成内容被云端改写')) return 'remote_document_changed';
  if (message.includes('本机版本不存在')) return 'local_summary_version_missing';
  if (message.includes('section')) return 'summary_section_mapping_invalid';
  if (message.includes('引用')) return 'summary_citation_mapping_invalid';
  if (message.includes('当前整理结果')) return 'summary_current_mapping_invalid';
  if (message.includes('immutable summary')) return 'immutable_summary_changed';
  if (message.includes('stable canonical transcript')) return 'transcript_not_stable';
  if (message.includes('transcript revision is not the active')) return 'transcript_revision_changed';
  if (message.includes('canonical meeting identity changed')) return 'meeting_identity_changed';
  if (message.includes('canonical meeting became unavailable')) return 'meeting_became_unavailable';
  if (message.includes('本机升级')) return 'canonical_projection_missing';
  if (message.includes('本机数据状态异常')) return 'canonical_reload_failed';
  if (message.includes('保存后的数据不完整')) return 'canonical_projection_incomplete';
  if (message.includes('数据作用域已变化')) return 'scope_changed';
  if (message.includes('未能写入本机数据版本')) return 'canonical_revision_missing';
  if (message.includes('constraint')) return 'sqlite_constraint';
  if (message.includes('database is locked')) return 'sqlite_locked';
  return reason instanceof Error && reason.name
    ? reason.name.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80)
    : 'unknown';
}

const TRANSCRIPT_COMPLETION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const TRANSCRIPT_COMPLETION_RECHECK_MS = 15_000;
const AUDIO_SOURCE_RESOLUTION_TIMEOUT_MS = 20_000;

function waitForTranscriptCompletionRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('transcript completion retry cancelled');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('transcript completion retry cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const updateMeetingActionUseCase = new UpdateMeetingActionUseCase(sqliteMeetingNoteRepository);
const createMeetingActionUseCase = new CreateMeetingActionUseCase(sqliteMeetingNoteRepository);
const resolveMeetingActionSyncConflictUseCase = new ResolveMeetingActionSyncConflictUseCase(
  sqliteMeetingNoteRepository,
);
const resolveMeetingManualNoteSyncConflictUseCase = new ResolveMeetingManualNoteSyncConflictUseCase(
  sqliteMeetingNoteRepository,
);
const selectMeetingSummaryVersionUseCase = new SelectMeetingSummaryVersionUseCase(sqliteMeetingNoteRepository);
const editMeetingSummarySectionUseCase = new EditMeetingSummarySectionUseCase(sqliteMeetingNoteRepository);
const resolveMeetingSummarySyncConflictUseCase = new ResolveMeetingSummarySyncConflictUseCase();
const updateMeetingSpeakerAssignmentUseCase = new UpdateMeetingSpeakerAssignmentUseCase(
  sqliteMeetingNoteRepository,
);
const retryMeetingSpeakerCorrectionSyncUseCase = new RetryMeetingSpeakerCorrectionSyncUseCase(
  sqliteMeetingNoteRepository,
);

function summaryVersionTimestamp(version: SummaryVersionRecord): number {
  return version.completedAtMs ?? version.createdAtMs;
}

function summaryVersionDateLabel(version: SummaryVersionRecord): string {
  const date = new Date(summaryVersionTimestamp(version));
  if (Number.isNaN(date.getTime())) return '生成时间未知';
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function summaryTemplateLabel(templateId: string): string {
  if (templateId === 'legacy') return '旧版整理';
  const template = meetingTemplateById(templateId);
  if (!template) return '整理结果';
  return template.id === 'general' ? '统一整理' : `旧版${template.title}`;
}

function summaryVersionChoices(state: MeetingSummaryVersionsState | null): MeetingSummaryVersionChoice[] {
  if (!state) return [];
  const current = state.versions.find(version => version.id === state.currentVersionId);
  const currentTimestamp = current ? summaryVersionTimestamp(current) : Number.POSITIVE_INFINITY;
  return state.versions.map(version => {
    const metadata = [
      summaryVersionDateLabel(version),
      summaryTemplateLabel(version.templateId),
      version.userEdited ? '含人工修改' : '',
      version.status === 'stale' ? '内容可能已过期' : '',
    ].filter(Boolean).join(' · ');
    const isCurrent = version.id === state.currentVersionId;
    return {
      id: version.id,
      title: isCurrent
        ? '当前版本'
        : summaryVersionTimestamp(version) > currentTimestamp ? '新版本' : '历史版本',
      metadata,
      current: isCurrent,
    };
  });
}

function meetingAction(
  actions: readonly MeetingSummaryActionCandidate[],
  actionId: string,
) {
  return actions.find(action => (action.canonicalId ?? action.id) === actionId) ?? null;
}

function meetingActionFailureCode(reason: unknown): string {
  const message = reason instanceof Error ? reason.message.toLowerCase() : '';
  if (message.includes('expected revision')) return 'expected_revision_invalid';
  if (message.includes('revision changed')) return 'revision_conflict';
  if (message.includes('does not exist')) return 'action_missing';
  if (message.includes('database is locked')) return 'database_locked';
  if (message.includes('transaction')) return 'transaction_failed';
  if (message.includes('update time') || message.includes('clock')) return 'clock_invalid';
  if (message.includes('no such')) return 'schema_missing';
  return reason instanceof Error ? reason.name.replace(/[^a-z0-9_.-]/gi, '_').toLowerCase() : 'unknown_error';
}

/** MIN-DETAIL-001 / MIN-SUMMARY-001 / MIN-GUEST-001 / MIN-PLAYER-001. */
export function TranscriptionScreen({ navigation, route }: Props) {
  const projectionCandidateEnabled = getFeatureFlags().nativeProjectionEnvelopeCandidate;
  const currentProjectionRef = useRef<NativeProjectionEnvelope | null>(null);
  const {
    meetings,
    deleteMeeting,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
    confirmCachedSummaryCurrent,
    refreshMeetings,
    reconcileAudioUploads,
    updateMeetingDetails,
    updateMeetingTitle,
  } = useMeetings();
  const { events, searchableEvents } = useEvents();
  const { accessToken, isGuest, session } = useAuth();
  const { refresh: refreshRecycleCapability } = useMeetingRecycleCapability();
  const { showDialog } = useAppDialog();
  const meeting = meetings.find(item => item.id === route.params.meetingId);
  const remoteMeetingId = meeting ? meetingRemoteIdentity(meeting) : null;
  const focusedTab = explicitDetailTab(route.params.focus);
  const [activeTab, setActiveTab] = useState<MinutesDetailTab>(
    focusedTab ?? 'notes',
  );
  const [tabGeneration, setTabGeneration] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>(
    () => meeting ? getCachedTranscript(meeting.id) : [],
  );
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const [summary, setSummary] = useState(() => meeting ? meetingSummaryToText(getCachedSummary(meeting.id)) : '');
  const [summaryDocument, setSummaryDocument] = useState<MeetingSummaryDocument | null>(() => (
    meeting ? summaryDocumentFor(meeting.id, getCachedSummary(meeting.id)) : null
  ));
  const [activeMeetingFactsV3, setActiveMeetingFactsV3] = useState<ActiveMeetingFactsV3 | null>(null);
  const [summaryV3UpgradeRunning, setSummaryV3UpgradeRunning] = useState(false);
  const summaryV3UpgradeWasRunningRef = useRef(false);
  const [confirmedCurrentSummaryIdentity, setConfirmedCurrentSummaryIdentity] = useState('');
  // Generation retains the general@3 wire envelope for server/history
  // compatibility, while the active product has one adaptive summary.
  const [summaryTemplate, setSummaryTemplate] = useState<MeetingTemplate>(DEFAULT_MEETING_TEMPLATE);
  const [summaryBlocksSheetVisible, setSummaryBlocksSheetVisible] = useState(false);
  const [summaryEvidenceSectionId, setSummaryEvidenceSectionId] = useState<string | null>(null);
  const [hiddenSummaryBlockKeys, setHiddenSummaryBlockKeys] = useState<readonly string[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [summaryAttachmentRequest, setSummaryAttachmentRequest] = useState<{
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
    attachments: readonly MeetingAttachmentRecord[];
    imageSelectionEnabled: boolean;
  } | null>(null);
  const [summaryCarryForwardRequest, setSummaryCarryForwardRequest] = useState<{
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
    memory: MeetingSeriesMemoryProjection;
    attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null;
  } | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [transcriptVisualPhase, setTranscriptVisualPhase] = useState<DetailVisualPhase>('idle');
  const [summaryVisualPhase, setSummaryVisualPhase] = useState<DetailVisualPhase>('idle');
  const [transcriptError, setTranscriptError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [summaryProgress, setSummaryProgress] = useState('正在提交整理任务');
  const [transcriptCached, setTranscriptCached] = useState(() => Boolean(meeting && getCachedTranscript(meeting.id).length));
  const [transcriptCompleting, setTranscriptCompleting] = useState(false);
  const [summaryCached, setSummaryCached] = useState(() => Boolean(meeting && getCachedSummary(meeting.id)));
  const requestCoordinatorRef = useRef(new NativeMinutesRequestCoordinator());
  const [pageGenerations, setPageGenerations] = useState<NativeMinutesPageGenerations>(
    () => requestCoordinatorRef.current.snapshot(),
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [playerSources, setPlayerSources] = useState<readonly MinutesPlayerSourceSnapshot[]>([]);
  const [selectedPlayerSourceId, setSelectedPlayerSourceId] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [contentShareManagerVisible, setContentShareManagerVisible] = useState(false);
  const [contentShares, setContentShares] = useState<readonly MeetingContentShare[]>([]);
  const [contentSharesLoading, setContentSharesLoading] = useState(false);
  const [contentShareBusyId, setContentShareBusyId] = useState<string | null>(null);
  const [contentShareError, setContentShareError] = useState('');
  const [moreVisible, setMoreVisible] = useState(false);
  const [deletingMeeting, setDeletingMeeting] = useState(false);
  const [meetingActionsVisible, setMeetingActionsVisible] = useState(false);
  const [meetingActionsSheetLoading, setMeetingActionsSheetLoading] = useState(false);
  const [meetingActionsSheetError, setMeetingActionsSheetError] = useState('');
  const [meetingActionsFocusId, setMeetingActionsFocusId] = useState<string | null>(null);
  const [questionVisible, setQuestionVisible] = useState(false);
  const [mediaClipsVisible, setMediaClipsVisible] = useState(false);
  const [mediaClipEditorVisible, setMediaClipEditorVisible] = useState(false);
  const [mediaClips, setMediaClips] = useState<readonly MeetingMediaClip[]>([]);
  const [mediaClipsLoading, setMediaClipsLoading] = useState(false);
  const [mediaClipDraft, setMediaClipDraft] = useState<MeetingMediaClipDraft | null>(null);
  const [mediaClipPreparing, setMediaClipPreparing] = useState(false);
  const [mediaClipBusyId, setMediaClipBusyId] = useState<string | null>(null);
  const [mediaClipError, setMediaClipError] = useState('');
  const [pendingAudioUpload, setPendingAudioUpload] = useState<PendingMeetingAudioUpload | null>(null);
  const [pendingAudioError, setPendingAudioError] = useState('');
  const [deviceTranscriptTask, setDeviceTranscriptTask] = useState<DeviceTranscriptTaskRecord | null>(null);
  const [playerSourceError, setPlayerSourceError] = useState('');
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [recordingMergeBusy, setRecordingMergeBusy] = useState(false);
  const [retryingAudioUpload, setRetryingAudioUpload] = useState(false);
  const [retryingSpeakerCorrection, setRetryingSpeakerCorrection] = useState(false);
  const [requestingTranscriptReprocess, setRequestingTranscriptReprocess] = useState(false);
  const [transcriptReprocessAvailable, setTranscriptReprocessAvailable] = useState(false);
  const [canonicalProcessingSnapshot, setCanonicalProcessingSnapshot] = useState<CanonicalProcessingSnapshot | null>(null);
  const [updatingActionId, setUpdatingActionId] = useState<string | null>(null);
  const [editingAction, setEditingAction] = useState<MeetingActionEditorValue | null>(null);
  const [actionEditorSaving, setActionEditorSaving] = useState(false);
  const [actionEditorError, setActionEditorError] = useState('');
  const [actionShareTarget, setActionShareTarget] = useState<MeetingSummaryActionCandidate | null>(null);
  const [actionShares, setActionShares] = useState<readonly MeetingActionShare[]>([]);
  const [actionSharesLoading, setActionSharesLoading] = useState(false);
  const [actionShareBusyId, setActionShareBusyId] = useState<string | null>(null);
  const [actionShareError, setActionShareError] = useState('');
  const [summaryVersionsVisible, setSummaryVersionsVisible] = useState(false);
  const [summaryVersionsState, setSummaryVersionsState] = useState<MeetingSummaryVersionsState | null>(null);
  const [summaryVersionsLoading, setSummaryVersionsLoading] = useState(false);
  const [summaryVersionsError, setSummaryVersionsError] = useState('');
  const [switchingSummaryVersionId, setSwitchingSummaryVersionId] = useState<string | null>(null);
  const [summarySectionEditorTarget, setSummarySectionEditorTarget] = useState<SummarySectionEditorTarget | null>(null);
  const [summarySectionEditorSaving, setSummarySectionEditorSaving] = useState(false);
  const [summarySectionEditorError, setSummarySectionEditorError] = useState('');
  const [summarySyncConflicts, setSummarySyncConflicts] = useState<readonly MeetingSummarySyncConflictView[]>([]);
  const [summarySyncConflictTarget, setSummarySyncConflictTarget] = useState<MeetingSummarySyncConflictView | null>(null);
  const [summarySyncConflictSaving, setSummarySyncConflictSaving] = useState(false);
  const [summarySyncConflictError, setSummarySyncConflictError] = useState('');
  const [meetingActions, setMeetingActions] = useState<readonly MeetingSummaryActionCandidate[]>([]);
  const [meetingActionsLoaded, setMeetingActionsLoaded] = useState(false);
  const [meetingActionsCanonicalId, setMeetingActionsCanonicalId] = useState<string | null>(null);
  const [meetingActionConflicts, setMeetingActionConflicts] = useState<readonly MeetingActionSyncConflictView[]>([]);
  const [actionConflictTarget, setActionConflictTarget] = useState<MeetingActionSyncConflictView | null>(null);
  const [actionConflictSaving, setActionConflictSaving] = useState(false);
  const [actionConflictError, setActionConflictError] = useState('');
  const [manualNoteConflict, setManualNoteConflict] = useState<MeetingManualNoteSyncConflictView | null>(null);
  const [manualNoteConflictTarget, setManualNoteConflictTarget] = useState<MeetingManualNoteSyncConflictView | null>(null);
  const [manualNoteConflictSaving, setManualNoteConflictSaving] = useState(false);
  const [manualNoteConflictError, setManualNoteConflictError] = useState('');
  const [markers, setMarkers] = useState<readonly MarkerRecord[]>([]);
  const [meetingAttachments, setMeetingAttachments] = useState<readonly MeetingAttachmentRecord[]>([]);
  const [deletingMarkerId, setDeletingMarkerId] = useState<string | null>(null);
  const [markerActionsId, setMarkerActionsId] = useState<string | null>(null);
  const [speakerAssignmentTarget, setSpeakerAssignmentTarget] = useState<SpeakerAssignmentTarget | null>(null);
  const [speakerAssignmentSaving, setSpeakerAssignmentSaving] = useState(false);
  const [speakerAssignmentError, setSpeakerAssignmentError] = useState('');
  const [speakerProfiles, setSpeakerProfiles] = useState<readonly SpeakerProfile[]>([]);
  const [speakerProfilesLoading, setSpeakerProfilesLoading] = useState(false);
  const [speakerProfilesError, setSpeakerProfilesError] = useState('');
  const speakerProfileRequestGenerationRef = useRef(0);
  const playerSource = useMemo(() => (
    playerSources.find(source => source.sourceId === selectedPlayerSourceId)
    ?? playerSources[0]
    ?? null
  ), [playerSources, selectedPlayerSourceId]);
  const mountedRef = useRef(true);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const silentSummaryAbortRef = useRef(new WeakSet<AbortController>());
  const summaryScopeRef = useRef<string | null>(null);
  const summaryInFlightRef = useRef<Promise<void> | null>(null);
  const uploadInFlightRef = useRef<Promise<void> | null>(null);
  const automaticAudioUploadKeyRef = useRef('');
  const autoResumeTaskRef = useRef('');
  const orphanedSummaryPreparationRef = useRef('');
  const summaryCarryLookupGenerationRef = useRef(0);
  const activeMeetingIdRef = useRef(meeting?.id ?? null);
  const activeMeetingRef = useRef(meeting);
  const activeMeetingScopeRef = useRef<ScopeKey | null>(null);
  const openingFollowupRef = useRef(false);
  const actionRequestGenerationRef = useRef(0);
  const handledActionFocusRequestRef = useRef<number | null>(null);
  const manualNoteConflictRequestGenerationRef = useRef(0);
  const summaryConflictRequestGenerationRef = useRef(0);
  const markerRequestGenerationRef = useRef(0);
  const markerLoadErrorShownRef = useRef(false);
  const attachmentRequestGenerationRef = useRef(0);
  const attachmentLoadErrorShownRef = useRef(false);
  const mediaClipRequestGenerationRef = useRef(0);
  const actionShareRequestGenerationRef = useRef(0);
  const contentShareRequestGenerationRef = useRef(0);
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const meetingScopeKey: ScopeKey | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  const transcriptDurationHintSec = useMemo(
    () => transcriptDurationSec(transcript),
    [transcript],
  );
  const meetingQuestionsEnabled = getFeatureFlags().meetingQuestionsV1
    || getFeatureFlags().meetingQuestionsQ2Candidate;
  const meetingMediaClipsEnabled = getFeatureFlags().meetingMediaClipsV1 && hasNativeMediaClip();
  const meetingTranscriptReprocessEnabled = getFeatureFlags().meetingTranscriptReprocessV1;
  // Device-primary meetings do not expose cross-device collaboration.  Keep
  // the account implementation available for compatibility builds, but do
  // not render an action-share entry that can only fail with "登录后..." in
  // the production guest/device path.
  const meetingActionCollaborationEnabled = !isGuest
    && Boolean(accessToken)
    && getFeatureFlags().meetingActionCollaborationV1;
  const meetingContentShareLinksEnabled = getFeatureFlags().meetingContentShareLinksV1;
  const canCreateMediaClip = Boolean(
    meetingMediaClipsEnabled
    && meeting
    && meetingScopeKey
    && canonicalProcessingSnapshot
    && canonicalProcessingSnapshot.meetingId === meeting.id
    && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
    && canonicalProcessingSnapshot.recordingAssets.some(asset => {
      const mime = asset.mimeType?.trim().toLowerCase() ?? '';
      const name = asset.fileName?.trim().toLowerCase() ?? '';
      const uri = asset.localUri?.trim().toLowerCase() ?? '';
      return asset.localState === 'local_ready'
        && Boolean(asset.localUri)
        && Boolean(mime || name || uri);
    })
  );
  const processingStatuses = useMemo<MeetingProcessingStatuses>(() => {
    if (
      canonicalProcessingSnapshot
      && meeting
      && meetingScopeKey
      && canonicalProcessingSnapshot.meetingId === meeting.id
      && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
    ) {
      try {
        return processingStatusesFromStages(canonicalProcessingSnapshot.stages);
      } catch {
        // A partial or malformed canonical aggregate must not make the detail
        // page disappear. The old DTO remains the conservative projection.
      }
    }
    return meeting ? legacyMeetingProcessingStatuses(meeting) : EMPTY_PROCESSING_STATUSES;
  }, [canonicalProcessingSnapshot, meeting, meetingScopeKey]);
  const processingPresentation = useMemo(
    () => deriveMeetingPresentationState(processingStatuses),
    [processingStatuses],
  );
  activeMeetingIdRef.current = meeting?.id ?? null;
  activeMeetingRef.current = meeting;
  activeMeetingScopeRef.current = meetingScopeKey;
  const speakerNameCandidates = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    transcript.forEach(line => {
      const name = line.speaker_label?.normalize('NFKC').trim() ?? '';
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    return names.slice(0, 100);
  }, [transcript]);
  const manualNote = useMeetingManualNote(meetingScopeKey, meeting?.id);
  const loadProjectedMeetingFactsV3 = useCallback(async (
    current: { canonicalMeetingId: string; document: MeetingSummaryDocument },
    _requestedTemplate?: MeetingTemplate,
  ): Promise<{
    active: ActiveMeetingFactsV3;
    document: MeetingSummaryDocument;
    template: MeetingTemplate;
  } | null> => {
    if (!meetingScopeKey) return null;
    const currentVersion = await sqliteMeetingNoteRepository.getCurrentSummaryVersion(
      current.canonicalMeetingId,
      meetingScopeKey,
    );
    if (!currentVersion) {
      diagnosticAudit('meeting_summary_v3_projection', { status: 'missing_current_version' });
      return null;
    }
    const stored = await loadMeetingFactsRecordV3ForVersion(currentVersion.id);
    if (!stored?.summaryVersionId) {
      diagnosticAudit('meeting_summary_v3_projection', { status: 'missing_facts_link' });
      return null;
    }
    const template = DEFAULT_MEETING_TEMPLATE;
    const overrides = await loadSummaryViewOverrides(currentVersion.id, template.id);
    const projected = applyMeetingSummaryV3Overrides(
      projectMeetingFactsV3(
        stored.result,
        template,
        current.document.manualNoteRevision,
        transcriptRef.current,
      ),
      overrides,
    );
    return {
      active: {
        canonicalMeetingId: current.canonicalMeetingId,
        summaryVersionId: currentVersion.id,
        result: stored.result,
      },
      template,
      document: {
        ...projected,
        meetingId: current.document.meetingId,
        remoteVersionId: current.document.remoteVersionId ?? stored.result.documentId,
        transcriptRevisionId: current.document.transcriptRevisionId,
        remoteTranscriptRevisionId: projected.remoteTranscriptRevisionId ?? stored.result.transcriptRevision,
        manualNoteRevision: current.document.manualNoteRevision,
        status: current.document.status,
        supersedesVersionId: current.document.supersedesVersionId,
      },
    };
  }, [meetingScopeKey]);
  const currentSummaryIdentity = meeting && summaryDocument
    ? [
      meeting.id,
      summaryDocument.templateId,
      summaryDocument.templateRevision,
      summaryDocument.manualNoteRevision,
      summaryDocument.completedAtMs,
    ].join(':')
    : '';
  const summaryConfirmedCurrent = Boolean(
    currentSummaryIdentity
    && confirmedCurrentSummaryIdentity === currentSummaryIdentity
  );

  useEffect(() => {
    setConfirmedCurrentSummaryIdentity('');
  }, [currentSummaryIdentity]);

  useEffect(() => {
    if (
      !meeting
      || !summaryDocument
      || summaryDocument.status !== 'stale'
      || transcript.length === 0
      || manualNote.loading
      || manualNote.saving
      || summaryDocument.manualNoteRevision !== manualNote.revision
    ) return undefined;
    const template = meetingTemplateById(
      summaryDocument.templateId,
      summaryDocument.templateRevision,
    );
    if (!template) return undefined;
    let active = true;
    const fingerprint = summaryTaskInputFingerprint({
      transcriptLines: transcript,
      title: meeting.title,
      meetingDate: meetingDateForSummary(meeting.date, meeting.createdAt),
      template,
      carryForward: null,
      attachmentAuthorization: null,
      manualNote: manualNote.snapshot(),
    });
    const identity = currentSummaryIdentity;
    void hasCompletedMeetingSummaryTrace({
      meetingId: meeting.id,
      inputFingerprint: fingerprint,
      templateId: template.id,
      templateRevision: template.revision,
      summaryCompletedAtMs: summaryDocument.completedAtMs,
    }).then(async confirmed => {
      if (!active || !confirmed || activeMeetingIdRef.current !== meeting.id) return;
      setConfirmedCurrentSummaryIdentity(identity);
      setSummaryDocument(current => (
        current
        && [
          meeting.id,
          current.templateId,
          current.templateRevision,
          current.manualNoteRevision,
          current.completedAtMs,
        ].join(':') === identity
          ? { ...current, status: 'ready' }
          : current
      ));
      try {
        await confirmCachedSummaryCurrent(meeting.id, {
          templateId: summaryDocument.templateId,
          templateRevision: summaryDocument.templateRevision,
          manualNoteRevision: summaryDocument.manualNoteRevision,
          completedAtMs: summaryDocument.completedAtMs,
        });
      } catch (reason) {
        diagnosticWarn('[meeting-summary] completed-input status repair deferred', reason);
      }
    }).catch(reason => {
      diagnosticWarn('[meeting-summary] completed-input trace check failed', reason);
    });
    return () => { active = false; };
  }, [
    confirmCachedSummaryCurrent,
    currentSummaryIdentity,
    manualNote.loading,
    manualNote.revision,
    manualNote.saving,
    meeting?.createdAt,
    meeting?.date,
    meeting?.id,
    meeting?.title,
    summaryDocument?.completedAtMs,
    summaryDocument?.manualNoteRevision,
    summaryDocument?.status,
    summaryDocument?.templateId,
    summaryDocument?.templateRevision,
    transcript,
  ]);
  const manualNoteSnapshotKeyRef = useRef('');
  const manualNoteSnapshotGenerationRef = useRef(0);
  const manualNoteSnapshotKey = [
    manualNote.revision,
    manualNote.loading ? 1 : 0,
    manualNote.saving ? 1 : 0,
    manualNote.enabled ? 1 : 0,
    manualNote.error,
    manualNote.retryable ? 1 : 0,
    manualNoteConflict?.id ?? '',
  ].join('|');
  if (manualNoteSnapshotKeyRef.current !== manualNoteSnapshotKey) {
    manualNoteSnapshotKeyRef.current = manualNoteSnapshotKey;
    manualNoteSnapshotGenerationRef.current = Math.min(
      2_147_483_647,
      manualNoteSnapshotGenerationRef.current + 1,
    );
  }
  const playbackStorageScope: 'guest' | `user:${string}` | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  const routeMeetingIdRef = useRef(route.params.meetingId);
  routeMeetingIdRef.current = route.params.meetingId;
  const initialTab = focusedTab ?? 'notes';
  const tabOwnerRef = useRef(new NativeMinutesTabSelectionOwner({
    meetingId: route.params.meetingId,
    tab: initialTab,
    generation: 0,
  }));

  const advancePageGenerations = useCallback((...tabs: readonly MinutesDetailTab[]) => {
    const next = requestCoordinatorRef.current.advance(...tabs);
    setPageGenerations(next);
    return next;
  }, []);

  const beginPageRequest = useCallback((meetingId: string, ...tabs: readonly MinutesDetailTab[]) => {
    const request = requestCoordinatorRef.current.begin(meetingId, ...tabs);
    setPageGenerations(request.generations);
    return request.token;
  }, []);

  const isCurrentPageRequest = useCallback((token: NativeMinutesRequestToken) => (
    mountedRef.current && requestCoordinatorRef.current.isCurrent(token, routeMeetingIdRef.current)
  ), []);

  const refreshMarkers = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      setMarkers([]);
      return;
    }
    const generation = markerRequestGenerationRef.current + 1;
    markerRequestGenerationRef.current = generation;
    try {
      const state = await loadMeetingMarkers(meetingScopeKey, requestedMeetingId);
      if (
        !mountedRef.current
        || markerRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return;
      markerLoadErrorShownRef.current = false;
      setMarkers(state.markers);
    } catch {
      if (
        mountedRef.current
        && markerRequestGenerationRef.current === generation
        && routeMeetingIdRef.current === requestedMeetingId
        && !markerLoadErrorShownRef.current
      ) {
        markerLoadErrorShownRef.current = true;
        ToastAndroid.show('标记暂时无法加载，请稍后重试。', ToastAndroid.LONG);
      }
    }
  }, [meeting?.id, meetingScopeKey]);

  const refreshMeetingAttachments = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      setMeetingAttachments([]);
      return;
    }
    const generation = attachmentRequestGenerationRef.current + 1;
    attachmentRequestGenerationRef.current = generation;
    try {
      const attachments = await loadMeetingAttachments(meetingScopeKey, requestedMeetingId);
      if (
        !mountedRef.current
        || attachmentRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return;
      attachmentLoadErrorShownRef.current = false;
      setMeetingAttachments(attachments);
    } catch {
      if (
        mountedRef.current
        && attachmentRequestGenerationRef.current === generation
        && routeMeetingIdRef.current === requestedMeetingId
        && !attachmentLoadErrorShownRef.current
      ) {
        attachmentLoadErrorShownRef.current = true;
        ToastAndroid.show('附件暂时无法加载，请稍后重试。', ToastAndroid.LONG);
      }
    }
  }, [meeting?.id, meetingScopeKey]);

  const refreshMeetingMediaClips = useCallback(async (showLoading = false) => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey || !meetingMediaClipsEnabled) {
      setMediaClips([]);
      setMediaClipsLoading(false);
      return;
    }
    const generation = mediaClipRequestGenerationRef.current + 1;
    mediaClipRequestGenerationRef.current = generation;
    if (showLoading) setMediaClipsLoading(true);
    try {
      const state = await loadMeetingMediaClipState(meetingScopeKey, requestedMeetingId, accessToken);
      if (
        !mountedRef.current
        || mediaClipRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return;
      setMediaClips(state.clips);
      setMediaClipError('');
    } catch (reason) {
      if (
        mountedRef.current
        && mediaClipRequestGenerationRef.current === generation
        && routeMeetingIdRef.current === requestedMeetingId
      ) setMediaClipError(meetingMediaClipErrorMessage(reason, '音频片段暂时无法加载，请稍后重试。'));
    } finally {
      if (
        mountedRef.current
        && mediaClipRequestGenerationRef.current === generation
        && routeMeetingIdRef.current === requestedMeetingId
      ) setMediaClipsLoading(false);
    }
  }, [accessToken, meeting?.id, meetingMediaClipsEnabled, meetingScopeKey]);

  const refreshMeetingActions = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      setMeetingActions([]);
      setMeetingActionsLoaded(false);
      setMeetingActionsCanonicalId(null);
      setMeetingActionConflicts([]);
      return null;
    }
    const generation = actionRequestGenerationRef.current + 1;
    actionRequestGenerationRef.current = generation;
    try {
      const state = await loadMeetingActions(meetingScopeKey, requestedMeetingId);
      if (
        !mountedRef.current
        || actionRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return null;
      setMeetingActions(state.actions);
      setMeetingActionsLoaded(true);
      setMeetingActionsCanonicalId(state.canonicalMeetingId);
      setMeetingActionConflicts(state.conflicts);
      setActionConflictTarget(current => current
        ? state.conflicts.find(conflict => conflict.id === current.id) ?? null
        : null);
      return state;
    } catch (reason) {
      diagnosticWarn('load meeting actions failed', reason);
      return null;
    }
  }, [meeting?.id, meetingScopeKey]);

  const refreshManualNoteConflict = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey || meetingScopeKey === 'guest') {
      setManualNoteConflict(null);
      setManualNoteConflictTarget(null);
      return null;
    }
    const generation = manualNoteConflictRequestGenerationRef.current + 1;
    manualNoteConflictRequestGenerationRef.current = generation;
    try {
      const conflict = await loadMeetingManualNoteSyncConflict(
        meetingScopeKey,
        requestedMeetingId,
      );
      if (
        !mountedRef.current
        || manualNoteConflictRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return null;
      setManualNoteConflict(conflict);
      setManualNoteConflictTarget(current => current && conflict?.id === current.id ? conflict : null);
      return conflict;
    } catch (reason) {
      diagnosticWarn('load meeting manual note conflict failed', reason);
      return null;
    }
  }, [meeting?.id, meetingScopeKey]);

  const refreshSummarySyncConflicts = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (
      !requestedMeetingId
      || !meetingScopeKey
      || meetingScopeKey === 'guest'
      || !meetingActionsCanonicalId
    ) {
      setSummarySyncConflicts([]);
      setSummarySyncConflictTarget(null);
      return [];
    }
    const generation = summaryConflictRequestGenerationRef.current + 1;
    summaryConflictRequestGenerationRef.current = generation;
    try {
      const conflicts = await loadMeetingSummarySyncConflicts(
        meetingScopeKey,
        meetingActionsCanonicalId,
      );
      if (
        !mountedRef.current
        || summaryConflictRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return [];
      setSummarySyncConflicts(conflicts);
      setSummarySyncConflictTarget(current => current
        ? conflicts.find(conflict => conflict.id === current.id) ?? null
        : null);
      return conflicts;
    } catch (reason) {
      diagnosticWarn('load meeting summary sync conflicts failed', reason);
      return [];
    }
  }, [meeting?.id, meetingActionsCanonicalId, meetingScopeKey]);

  const loadSummaryVersions = useCallback(async () => {
    if (!meeting || !meetingScopeKey) {
      setSummaryVersionsState(null);
      setSummaryVersionsError('当前会议无法读取整理结果版本。');
      return;
    }
    const requestedMeetingId = meeting.id;
    setSummaryVersionsLoading(true);
    setSummaryVersionsError('');
    const refreshController = new AbortController();
    try {
      // The local version list can contain legacy projections from before the
      // structured-summary migration. Refresh the remote catalog when the
      // user explicitly opens this panel so template labels and the current
      // pointer reflect the just-generated server version immediately.
      if (meetingScopeKey !== 'guest' && accessToken && remoteMeetingId) {
        const canonicalMeetingId = meetingActionsCanonicalId
          ?? await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
            requestedMeetingId,
            meetingScopeKey,
          );
        if (canonicalMeetingId) {
          await pullMeetingSummaryVersions({
            scopeKey: meetingScopeKey,
            canonicalMeetingId,
            meeting,
            meetingRemoteId: remoteMeetingId,
            accessToken,
            signal: refreshController.signal,
          }).catch(reason => {
            // A remote outage must not hide versions already available on the
            // device; the local catalog remains the explicit fallback.
            diagnosticWarn('refresh meeting summary versions failed', reason);
            diagnosticAudit('summary_versions_pull', {
              status: 'failed',
              reason: summaryCacheFailureCode(reason),
            });
          });
        }
      }
      const state = await loadMeetingSummaryVersions(meetingScopeKey, requestedMeetingId);
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      if (!state) {
        setSummaryVersionsState(null);
        setSummaryVersionsError('当前会议没有可用的整理结果版本。');
        return;
      }
      setSummaryVersionsState(state);
    } catch {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setSummaryVersionsError('整理结果版本暂时无法加载，请稍后重试。');
      }
    } finally {
      refreshController.abort();
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setSummaryVersionsLoading(false);
      }
    }
  }, [accessToken, meeting, meetingActionsCanonicalId, meetingScopeKey, remoteMeetingId]);

  const openSummaryVersions = useCallback(() => {
    setSummaryVersionsVisible(true);
    void loadSummaryVersions();
  }, [loadSummaryVersions]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      summaryAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const requestedMeetingId = meeting?.id;
    const requestedScopeKey = meetingScopeKey;
    let active = true;
    let observedCanonicalId = '';
    let loadGeneration = 0;
    let unsubscribe: (() => void) | null = null;
    setCanonicalProcessingSnapshot(null);
    if (!requestedMeetingId || !requestedScopeKey) return () => { active = false; };

    const load = async () => {
      const generation = loadGeneration + 1;
      loadGeneration = generation;
      try {
        const direct = await sqliteMeetingNoteRepository.get(requestedMeetingId, requestedScopeKey);
        const aggregate = direct ?? await sqliteMeetingNoteRepository.findByNativeSessionId(
          requestedMeetingId,
          requestedScopeKey,
        );
        if (
          !active
          || generation !== loadGeneration
          || routeMeetingIdRef.current !== requestedMeetingId
          || activeMeetingScopeRef.current !== requestedScopeKey
        ) return;
        if (!aggregate) {
          setCanonicalProcessingSnapshot(null);
          return;
        }
        const recordingMergeRecovery = await loadMeetingRecordingMergeRecovery(
          requestedScopeKey,
          aggregate.note.id,
        );
        if (
          !active
          || generation !== loadGeneration
          || routeMeetingIdRef.current !== requestedMeetingId
          || activeMeetingScopeRef.current !== requestedScopeKey
        ) return;
        setCanonicalProcessingSnapshot({
          meetingId: requestedMeetingId,
          canonicalMeetingId: aggregate.note.id,
          scopeKey: requestedScopeKey,
          stages: aggregate.processingStages,
          recordingAssets: aggregate.recordingAssets,
          recordingMergeRecovery,
        });
        if (observedCanonicalId !== aggregate.note.id) {
          unsubscribe?.();
          observedCanonicalId = aggregate.note.id;
          unsubscribe = sqliteMeetingNoteRepository.observeMeeting(
            aggregate.note.id,
            requestedScopeKey,
            () => {
              void load();
            },
          );
        }
      } catch (reason) {
        if (!active || generation !== loadGeneration) return;
        setCanonicalProcessingSnapshot(null);
        diagnosticWarn('load detail meeting processing stages failed', reason);
      }
    };
    void load();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [meeting?.id, meetingScopeKey]);

  useEffect(() => {
    setEditingAction(null);
    setActionEditorSaving(false);
    setActionEditorError('');
    setActionShareTarget(null);
    setActionShares([]);
    setActionSharesLoading(false);
    setActionShareBusyId(null);
    setActionShareError('');
    setUpdatingActionId(null);
    setSummaryVersionsVisible(false);
    setActiveMeetingFactsV3(null);
    setSummaryV3UpgradeRunning(false);
    setSummaryBlocksSheetVisible(false);
    setSummaryEvidenceSectionId(null);
    setHiddenSummaryBlockKeys([]);
    setSummaryVersionsState(null);
    setSummaryVersionsLoading(false);
    setSummaryVersionsError('');
    setSwitchingSummaryVersionId(null);
    setSummarySectionEditorTarget(null);
    setSummarySectionEditorSaving(false);
    setSummarySectionEditorError('');
    setSummarySyncConflicts([]);
    setSummarySyncConflictTarget(null);
    setSummarySyncConflictSaving(false);
    setSummarySyncConflictError('');
    setMeetingActions([]);
    setMeetingActionsLoaded(false);
    setMeetingActionsCanonicalId(null);
    setMeetingActionConflicts([]);
    setActionConflictTarget(null);
    setActionConflictSaving(false);
    setActionConflictError('');
    setManualNoteConflict(null);
    setManualNoteConflictTarget(null);
    setManualNoteConflictSaving(false);
    setManualNoteConflictError('');
    setShareVisible(false);
    setMediaClipsVisible(false);
    setMediaClipEditorVisible(false);
    setMediaClips([]);
    setMediaClipsLoading(false);
    setMediaClipDraft(null);
    setMediaClipPreparing(false);
    setMediaClipBusyId(null);
    setMediaClipError('');
    setMarkers([]);
    setMeetingAttachments([]);
    setDeletingMarkerId(null);
    setMarkerActionsId(null);
    setSpeakerAssignmentTarget(null);
    setSpeakerAssignmentSaving(false);
    setSpeakerAssignmentError('');
    setRetryingSpeakerCorrection(false);
    actionRequestGenerationRef.current += 1;
    manualNoteConflictRequestGenerationRef.current += 1;
    summaryConflictRequestGenerationRef.current += 1;
    markerRequestGenerationRef.current += 1;
    markerLoadErrorShownRef.current = false;
    attachmentRequestGenerationRef.current += 1;
    attachmentLoadErrorShownRef.current = false;
    mediaClipRequestGenerationRef.current += 1;
  }, [route.params.meetingId, meetingScopeKey]);

  useEffect(() => {
    if (!meeting || !meetingScopeKey || activeMeetingFactsV3) {
      setSummaryV3UpgradeRunning(false);
      return undefined;
    }
    let active = true;
    let canonicalMeetingId = '';
    const refresh = async () => {
      canonicalMeetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
        meeting.id,
        meetingScopeKey,
      ) ?? '';
      const running = canonicalMeetingId
        ? await summaryV3UpgradeIsRunning(canonicalMeetingId).catch(() => false)
        : false;
      if (active) setSummaryV3UpgradeRunning(running);
    };
    void refresh();
    const unsubscribe = subscribeSummaryV3UpgradeChanged(changedMeetingId => {
      if (changedMeetingId === canonicalMeetingId) void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeMeetingFactsV3, meeting?.id, meetingScopeKey]);

  useEffect(() => {
    const wasRunning = summaryV3UpgradeWasRunningRef.current;
    summaryV3UpgradeWasRunningRef.current = summaryV3UpgradeRunning;
    if (wasRunning && !summaryV3UpgradeRunning && meeting) {
      setReloadKey(value => value + 1);
    }
  }, [meeting, summaryV3UpgradeRunning]);

  useEffect(() => {
    setSummaryTemplate(DEFAULT_MEETING_TEMPLATE);
    let active = true;
    void loadMeetingSummaryHiddenBlocks(route.params.meetingId).then(keys => {
      if (active && routeMeetingIdRef.current === route.params.meetingId) {
        setHiddenSummaryBlockKeys(keys);
      }
    }).catch(reason => diagnosticWarn('[meeting-summary-layout] preference load failed', reason));
    return () => { active = false; };
  }, [route.params.meetingId]);

  useEffect(() => {
    void refreshMarkers();
  }, [refreshMarkers, transcriptCached, transcriptCompleting]);

  useEffect(() => {
    if (!meetingScopeKey) return undefined;
    return subscribeMeetingMarkersChanged(changedScope => {
      if (changedScope === meetingScopeKey) void refreshMarkers();
    });
  }, [meetingScopeKey, refreshMarkers]);

  useFocusEffect(useCallback(() => {
    void refreshMeetingAttachments();
  }, [refreshMeetingAttachments]));

  useFocusEffect(useCallback(() => {
    void refreshMeetingMediaClips();
  }, [refreshMeetingMediaClips]));

  useEffect(() => {
    if (
      !mediaClipsVisible
      || mediaClipBusyId
      || !accessToken
      || !mediaClips.some(clip => clip.exportMode === 'remote_async' && clip.status === 'pending')
    ) return undefined;
    const timer = setTimeout(() => { void refreshMeetingMediaClips(); }, 2_000);
    return () => clearTimeout(timer);
  }, [accessToken, mediaClipBusyId, mediaClips, mediaClipsVisible, refreshMeetingMediaClips]);

  useEffect(() => {
    void refreshMeetingActions();
  }, [refreshMeetingActions, summaryCached]);

  useEffect(() => {
    void refreshManualNoteConflict();
  }, [refreshManualNoteConflict]);

  useEffect(() => {
    void refreshSummarySyncConflicts();
  }, [refreshSummarySyncConflicts]);

  useEffect(() => {
    if (!meetingScopeKey) return undefined;
    return subscribeMeetingSummaryChanged(changedScope => {
      if (changedScope !== meetingScopeKey) return;
      void refreshSummarySyncConflicts();
      if (meeting?.id) {
        void loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).then(current => {
          if (!current || !mountedRef.current) return;
          setSummaryDocument(current.document);
          setSummary(meetingSummaryDocumentToText(current.document));
          setSummaryCached(true);
          advancePageGenerations('summary');
        }).catch(() => null);
      }
    });
  }, [advancePageGenerations, meeting?.id, meetingScopeKey, refreshSummarySyncConflicts]);

  useEffect(() => {
    if (!meetingActionsCanonicalId || !meetingScopeKey) return undefined;
    return sqliteMeetingNoteRepository.observeMeeting(
      meetingActionsCanonicalId,
      meetingScopeKey,
      () => {
        void refreshMeetingActions();
        void refreshManualNoteConflict();
      },
    );
  }, [meetingActionsCanonicalId, meetingScopeKey, refreshManualNoteConflict, refreshMeetingActions]);

  useEffect(() => {
    if (
      isGuest
      || !accessToken
      || !meetingScopeKey
      || !meetingActionsCanonicalId
      || !remoteMeetingId
    ) return undefined;
    let active = true;
    let running = false;
    let requested = true;
    let controller: AbortController | null = null;
    const requestPull = () => {
      if (!active) return;
      requested = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            controller = new AbortController();
            try {
              await manualNote.flush();
              const [, notePull, summaryPull] = await Promise.all([
                pullMeetingActionsForDetail({
                  scopeKey: meetingScopeKey,
                  canonicalMeetingId: meetingActionsCanonicalId,
                  meetingRemoteId: remoteMeetingId,
                  accessToken,
                  signal: controller.signal,
                }),
                pullMeetingManualNote({
                  scopeKey: meetingScopeKey,
                  meetingId: meetingActionsCanonicalId,
                  meetingRemoteId: remoteMeetingId,
                  accessToken,
                  signal: controller.signal,
                }),
                meeting ? pullMeetingSummaryVersions({
                  scopeKey: meetingScopeKey,
                  canonicalMeetingId: meetingActionsCanonicalId,
                  meeting,
                  meetingRemoteId: remoteMeetingId,
                  accessToken,
                  signal: controller.signal,
                }) : Promise.resolve({
                  outcome: 'stale' as const,
                  versionCount: 0,
                  conflictCount: 0,
                }),
              ]);
              if (notePull.outcome === 'updated' || notePull.outcome === 'attached') {
                await manualNote.reload();
              }
              if (meeting && (summaryPull.outcome === 'updated' || summaryPull.outcome === 'conflicted')) {
                const current = await loadCurrentMeetingSummaryState(
                  meetingScopeKey,
                  meeting.id,
                ).catch(() => null);
                if (current && active) {
                  setSummaryDocument(current.document);
                  setSummary(meetingSummaryDocumentToText(current.document));
                  setSummaryCached(true);
                  setSummaryVisualPhase('ready');
                  setSummaryError('');
                  advancePageGenerations('summary');
                }
              }
              await refreshManualNoteConflict();
              await refreshSummarySyncConflicts();
            } finally {
              controller = null;
            }
          }
        } catch (reason) {
          if (active) diagnosticWarn('pull meeting detail account content failed', reason);
        } finally {
          running = false;
          if (active && requested) requestPull();
        }
      })();
    };
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestPull();
    });
    requestPull();
    return () => {
      active = false;
      requested = false;
      controller?.abort();
      appStateSubscription.remove();
    };
  }, [accessToken, advancePageGenerations, isGuest, manualNote.flush, manualNote.reload, meeting, meetingActionsCanonicalId, meetingScopeKey, refreshManualNoteConflict, refreshSummarySyncConflicts, remoteMeetingId]);

  useEffect(() => {
    const previousScope = summaryScopeRef.current;
    summaryScopeRef.current = recordingStorageScope;
    if (previousScope == null || previousScope === recordingStorageScope) return;
    const controller = summaryAbortRef.current;
    if (!controller) return;
    silentSummaryAbortRef.current.add(controller);
    controller.abort();
  }, [recordingStorageScope]);

  useEffect(() => {
    if (!meeting) {
      setTranscriptReprocessAvailable(false);
      advancePageGenerations('transcript', 'summary', 'speakers');
      setTranscript([]);
      setSummary('');
      setSummaryDocument(null);
      setTranscriptCached(false);
      setTranscriptCompleting(false);
      setSummaryCached(false);
      setLoadingTranscript(false);
      setLoadingSummary(false);
      setTranscriptVisualPhase('idle');
      setSummaryVisualPhase('idle');
      setTranscriptError('');
      setSummaryError('');
      return;
    }
    let alive = true;
    const transcriptController = new AbortController();
    const cachedTranscript = getCachedTranscript(meeting.id);
    const cachedSummaryValue = getCachedSummary(meeting.id);
    const cachedSummary = meetingSummaryToText(cachedSummaryValue);
    const cachedSummaryDocument = summaryDocumentFor(meeting.id, cachedSummaryValue);
    const transcriptRequest = beginPageRequest(meeting.id, 'transcript', 'speakers');
    setTranscript(cachedTranscript);
    setTranscriptCached(cachedTranscript.length > 0);
    setTranscriptCompleting(false);
    setSummary(cachedSummary);
    setSummaryDocument(cachedSummaryDocument);
    setSummaryCached(Boolean(cachedSummary));
    setTranscriptError('');
    setSummaryError('');
    setTranscriptVisualPhase('running');
    setSummaryVisualPhase('idle');
    setLoadingSummary(false);

    setLoadingTranscript(true);
    const transcriptLoad = (async () => {
      let baseline = cachedTranscript;
      let baselineCached = cachedTranscript.length > 0;
      let hasStableFinal = false;
      let activeState = null as Awaited<ReturnType<typeof loadActiveMeetingTranscriptState>>;
      if (meetingScopeKey) {
        activeState = await loadActiveMeetingTranscriptState(meetingScopeKey, meeting.id).catch(() => null);
      }
      if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
      hasStableFinal = Boolean(
        activeState
        && activeState.kind !== 'realtime_draft'
        && !activeState.completing,
      );
      if (activeState?.lines.length) {
        const activeLines = simplifyTranscriptLines(activeState.lines);
        const activeDecision = evaluateTranscriptLineCandidate(baseline, activeLines, {
          candidateKind: activeState.kind,
          serverCompleteness: activeState.kind === 'realtime_draft' ? 'incomplete' : 'complete',
        });
        if (activeDecision.useCandidate) {
          baseline = activeLines;
          baselineCached = true;
        }
      }
      setTranscript(baseline);
      setTranscriptCached(baselineCached);
      setTranscriptCompleting(activeState?.completing ?? false);
      if (isGuest || !accessToken) {
        setTranscriptVisualPhase(activeState?.completing ? 'running' : 'ready');
        setLoadingTranscript(false);
        return;
      }
      if (!remoteMeetingId) {
        setTranscriptVisualPhase(baseline.length > 0 ? 'ready' : 'idle');
        setLoadingTranscript(false);
        return;
      }

      try {
        let retryIndex = 0;
        while (alive && isCurrentPageRequest(transcriptRequest)) {
          const remote = await fetchMeetingTranscriptSnapshot(remoteMeetingId, accessToken, {
            signal: transcriptController.signal,
          });
          if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
          const candidateKind = remote.completeness === 'incomplete' ? 'realtime_draft' : 'final';
          const remoteItems = remote.script === 'zh-Hans'
            ? remote.items
            : simplifyTranscriptLines(remote.items);
          const decision = evaluateTranscriptLineCandidate(baseline, remoteItems, {
            candidateKind,
            serverCompleteness: remote.completeness,
          });
          const preserveStableFinal = hasStableFinal && remote.completeness === 'incomplete';
          let cacheWriteFailure: unknown = null;
          if (!preserveStableFinal) {
            try {
              await saveCachedTranscript(meeting.id, remoteItems, {
                candidateKind,
                serverCompleteness: remote.completeness,
                remoteRevisionId: remote.remoteRevisionId,
              });
            } catch (reason) {
              cacheWriteFailure = reason;
            }
          }
          if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
          const refreshedActive = meetingScopeKey
            ? await loadActiveMeetingTranscriptState(meetingScopeKey, meeting.id).catch(() => null)
            : null;
          if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
          let selected = baseline;
          let selectedCached = baselineCached;
          if (refreshedActive?.lines.length) {
            selected = simplifyTranscriptLines(refreshedActive.lines);
            selectedCached = true;
          } else if (!preserveStableFinal && decision.useCandidate) {
            selected = remoteItems;
            selectedCached = cacheWriteFailure === null && remoteItems.length > 0;
          }
          hasStableFinal = refreshedActive
            ? refreshedActive.kind !== 'realtime_draft' && !refreshedActive.completing
            : hasStableFinal || Boolean(
              !preserveStableFinal
              && cacheWriteFailure === null
              && decision.useCandidate
              && candidateKind !== 'realtime_draft',
            );
          baseline = selected;
          baselineCached = selectedCached;
          setTranscript(selected);
          setTranscriptCached(selectedCached);
          setTranscriptCompleting(refreshedActive?.completing ?? decision.completing);
          setTranscriptVisualPhase(
            (refreshedActive?.completing ?? decision.completing) ? 'running' : 'ready',
          );

          if (cacheWriteFailure !== null) {
            if (meetingScopeKey) {
              await mirrorLegacyTranscriptSaveFailure(meetingScopeKey, meeting.id, cacheWriteFailure);
            }
            if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
            setTranscriptCompleting(false);
            setTranscriptVisualPhase(hasStableFinal ? 'ready' : 'error');
            setTranscriptError(hasStableFinal ? '' : '文字记录已同步，但本机缓存写入失败。');
            break;
          }
          if (remote.remoteState === 'failed') {
            const noSpeech = remote.errorCode === 'no_speech';
            if (meetingScopeKey) {
              await mirrorLegacyTranscriptProcessingFailure(
                meetingScopeKey,
                meeting.id,
                noSpeech ? 'no_speech' : 'remote_processing',
                new Error(
                  noSpeech
                    ? 'remote transcript contains no speech'
                    : 'remote transcript processing failed',
                ),
              );
            }
            if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
            setTranscriptCompleting(false);
            setTranscriptVisualPhase(hasStableFinal || noSpeech ? 'ready' : 'error');
            setTranscriptError(hasStableFinal || noSpeech ? '' : '文字处理失败，可重试。');
            break;
          }

          setTranscriptError('');
          if (!shouldRecheckTranscriptRemoteCandidate(
            remote.remoteState,
            decision,
            hasStableFinal,
          )) break;
          setTranscriptCompleting(!hasStableFinal);
          setTranscriptVisualPhase(hasStableFinal ? 'ready' : 'running');
          const retryDelayMs = retryIndex < TRANSCRIPT_COMPLETION_RETRY_DELAYS_MS.length
            ? TRANSCRIPT_COMPLETION_RETRY_DELAYS_MS[retryIndex]
            : TRANSCRIPT_COMPLETION_RECHECK_MS;
          if (retryIndex < TRANSCRIPT_COMPLETION_RETRY_DELAYS_MS.length) retryIndex += 1;
          await waitForTranscriptCompletionRetry(retryDelayMs, transcriptController.signal);
        }
      } catch (reason) {
        const cancelled = transcriptController.signal.aborted
          || (reason as Error)?.name === 'AbortError';
        if (!cancelled && alive && isCurrentPageRequest(transcriptRequest)) {
          if (meetingScopeKey) {
            await mirrorLegacyTranscriptProcessingFailure(
              meetingScopeKey,
              meeting.id,
              'sync',
              reason,
            );
          }
        }
        if (!cancelled && alive && isCurrentPageRequest(transcriptRequest)) {
          setTranscript(baseline);
          setTranscriptCached(baselineCached);
          setTranscriptCompleting(false);
          setTranscriptVisualPhase(hasStableFinal ? 'ready' : 'error');
          setTranscriptError(hasStableFinal ? '' : '文字记录同步失败，当前显示本机缓存。');
        }
      } finally {
        if (alive && isCurrentPageRequest(transcriptRequest)) setLoadingTranscript(false);
      }
    })();
    void transcriptLoad;

    const summaryRequest = beginPageRequest(meeting.id, 'summary');
    // A canonical SQLite read is the local owner state, not a remote page
    // response. Native page generations can advance while the database is
    // opening (status/player/layout updates do this legitimately); rejecting
    // the local result on that counter leaves a valid Facts V3 link hidden
    // until the next generation. Scope and meeting identity are the only
    // stale-response boundary for this local restore. Remote reads below keep
    // using the stricter request token.
    const ownsLocalSummaryRestore = () => (
      alive
      && routeMeetingIdRef.current === meeting.id
      && activeMeetingScopeRef.current === meetingScopeKey
    );
    void (async () => {
      let baselineText = cachedSummary;
      let baselineDocument = cachedSummaryDocument;
      if (meetingScopeKey) {
        const current = await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(reason => {
          diagnosticAudit('meeting_summary_v3_restore', {
            status: 'current_read_failed',
            error_name: reason instanceof Error ? reason.name : 'unknown',
          });
          return null;
        });
        if (!ownsLocalSummaryRestore()) return;
        if (!current) {
          diagnosticAudit('meeting_summary_v3_restore', { status: 'current_missing' });
        }
        if (current) {
          const v3 = await loadProjectedMeetingFactsV3(current).catch(reason => {
            diagnosticWarn('[meeting-summary-v3] restore projection failed', reason);
            return null;
          });
          if (!ownsLocalSummaryRestore()) return;
          diagnosticAudit('meeting_summary_v3_restore', {
            status: v3 ? 'facts_ready' : 'legacy_only',
          });
          baselineDocument = v3?.document ?? current.document;
          baselineText = meetingSummaryDocumentToText(baselineDocument);
          setSummary(baselineText);
          setSummaryDocument(baselineDocument);
          setActiveMeetingFactsV3(v3?.active ?? null);
          if (v3) setSummaryTemplate(v3.template);
          setSummaryCached(true);
        }
      }
      // The list snapshot can still say hasSummary=false when a durable task
      // finishes while this account is signed out or the App is not polling.
      // The authenticated final endpoint is a cheap nullable read (404 ->
      // null), so it must remain the recovery authority on every detail open.
      if (isGuest || !accessToken) return;
      setSummaryVisualPhase('running');
      setLoadingSummary(true);
      setSummaryProgress('正在同步整理结果');
      try {
        if (!remoteMeetingId) throw new Error('meeting remote identity is pending');
        const value = await fetchMeetingSummaryDetail(remoteMeetingId, accessToken);
        if (!alive || !isCurrentPageRequest(summaryRequest)) return;
        const normalized = normalizeRemoteMeetingSummaryResult(
          meeting.id,
          remoteMeetingId,
          value,
        );
        const text = meetingSummaryToText(normalized);
        if (normalized && text) {
          const generatedDocument = summaryDocumentFor(meeting.id, normalized);
          setSummaryError('');
          try {
            const saveRecoveredSummary = async () => {
              try {
                return await saveCachedSummary(meeting.id, normalized);
              } catch (reason) {
                diagnosticAudit('meeting_summary_cache_write_retry', {
                  phase: 'initial',
                  error_code: summaryCacheFailureCode(reason),
                });
                // Transcript and summary recovery start together when detail opens.
                // Any canonical version transition can make the first summary write
                // stale, not only a realtime draft, so always wait for transcript
                // recovery before deciding that the summary is unwritable.
                await transcriptLoad;
                if (!alive || !isCurrentPageRequest(summaryRequest)) throw reason;
                const alreadyPersisted = meetingScopeKey
                  ? await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(() => null)
                  : null;
                if (
                  alreadyPersisted
                  && meetingSummaryDocumentToText(alreadyPersisted.document) === text
                ) {
                  return { projection: 'preserved' as const, mirrorStatus: 'already_current' };
                }
                try {
                  return await saveCachedSummary(meeting.id, normalized);
                } catch (retryReason) {
                  const persistedAfterRetry = meetingScopeKey
                    ? await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(() => null)
                    : null;
                  if (
                    persistedAfterRetry
                    && meetingSummaryDocumentToText(persistedAfterRetry.document) === text
                  ) {
                    return { projection: 'preserved' as const, mirrorStatus: 'already_current' };
                  }
                  diagnosticAudit('meeting_summary_cache_write_retry', {
                    phase: 'final',
                    error_code: summaryCacheFailureCode(retryReason),
                  });
                  diagnosticWarn('persist recovered meeting summary failed', retryReason);
                  throw retryReason;
                }
              }
            };
            const cacheResult = await saveRecoveredSummary();
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            setCanonicalProcessingSnapshot(current => (
              reconcileRecoveredSummaryStage(current, generatedDocument)
            ));
            // A successful mirror can report `updated + unchanged` when the
            // immutable version already exists. Re-read canonical content in
            // every success branch so a remote-ID compatibility document never
            // replaces the local structured identity used by native actions.
            const current = meetingScopeKey
              ? await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(() => null)
              : null;
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            setSummary(current ? meetingSummaryDocumentToText(current.document) : text);
            setSummaryDocument(current?.document ?? generatedDocument);
            setSummaryCached(true);
            setSummaryVisualPhase('ready');
          } catch (reason) {
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            diagnosticAudit('meeting_summary_cache_write_failed', {
              error_code: summaryCacheFailureCode(reason),
            });
            diagnosticWarn('cache synchronized meeting summary failed', reason);
            setSummary(text);
            setSummaryDocument(generatedDocument);
            setSummaryCached(false);
            setSummaryVisualPhase('ready');
            setSummaryError('整理结果已同步，但本机缓存写入失败。');
          }
        } else {
          setSummaryVisualPhase('idle');
          setSummary(baselineText);
          setSummaryDocument(baselineDocument);
          setSummaryCached(Boolean(baselineText));
        }
      } catch {
        if (alive && isCurrentPageRequest(summaryRequest)) {
          setSummaryVisualPhase('error');
          setSummaryCached(Boolean(baselineText));
          setSummaryError('整理结果同步失败，可重试或重新生成。');
        }
      } finally {
        if (alive && isCurrentPageRequest(summaryRequest)) setLoadingSummary(false);
      }
    })();
    return () => {
      alive = false;
      transcriptController.abort();
    };
  // Processing-stage changes update the canonical snapshot but must not
  // restart this loader and reset its visual phase to idle/running.
  }, [accessToken, advancePageGenerations, beginPageRequest, getCachedSummary, getCachedTranscript, isCurrentPageRequest, isGuest, loadProjectedMeetingFactsV3, meeting?.id, meetingScopeKey, reloadKey, remoteMeetingId, saveCachedSummary, saveCachedTranscript]);

  // Recording transcription is also completed by the app-level coordinator.
  // `hasTranscript` becomes true as soon as the first stable segment is saved,
  // so it does not flip again when the final revision arrives. Observe the
  // canonical transcript stage as well and only clear the page-local
  // "completing" state after the active revision is actually final. This keeps
  // an open detail page aligned with the list without requiring re-entry.
  useEffect(() => {
    if (!meeting?.hasTranscript) return;
    const requestedMeetingId = meeting.id;
    let active = true;
    void (async () => {
      const activeState = meetingScopeKey
        ? await loadActiveMeetingTranscriptState(meetingScopeKey, requestedMeetingId).catch(() => null)
        : null;
      if (
        !active
        || !mountedRef.current
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return;
      const completed = simplifyTranscriptLines(
        activeState?.lines.length
          ? activeState.lines
          : getCachedTranscript(requestedMeetingId),
      );
      const hasFinalRevision = activeState
        ? activeState.kind !== 'realtime_draft' && !activeState.completing
        : completed.length > 0 && completed.every(line => (
          line.isFinal !== false && line.revisionKind !== 'realtimeDraft'
        ));
      if (!hasFinalRevision || completed.length === 0) return;
      setTranscript(current => {
        const decision = evaluateTranscriptLineCandidate(current, completed, {
          candidateKind: 'final',
          serverCompleteness: 'complete',
        });
        return decision.useCandidate ? completed : current;
      });
      setTranscriptCached(true);
      setTranscriptCompleting(false);
      setTranscriptVisualPhase('ready');
      setTranscriptError('');
      advancePageGenerations('transcript', 'speakers');
    })();
    return () => { active = false; };
  }, [
    advancePageGenerations,
    getCachedTranscript,
    meeting?.hasTranscript,
    meeting?.id,
    meetingScopeKey,
    processingStatuses.transcript,
  ]);

  useEffect(() => {
    if (!meeting) {
      setPlayerSources([]);
      setSelectedPlayerSourceId('');
      setPlayerSourceError('');
      setLoadingAudio(false);
      return;
    }
    let alive = true;
    let loadingTimer: ReturnType<typeof setTimeout> | null = null;
    setTranscriptReprocessAvailable(false);
    setPlayerSourceError('');
    if (!playbackStorageScope) {
      setTranscriptReprocessAvailable(false);
      setPlayerSources([]);
      setSelectedPlayerSourceId('');
      setLoadingAudio(false);
      return () => { alive = false; };
    }
    const canonicalAssets = canonicalProcessingSnapshot
      && canonicalProcessingSnapshot.meetingId === meeting.id
      && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
      ? canonicalProcessingSnapshot.recordingAssets
      : [];
    const localSources: MinutesPlayerSourceSnapshot[] = [];
    const localSourceIdByAsset = new Map<string, string>();
    const localSourceIdByRemoteAsset = new Map<string, string>();
    const seenUris = new Set<string>();
    if (meeting.audioLocalUri) {
      seenUris.add(meeting.audioLocalUri);
      localSources.push(localPlayerSource(
        meeting.id,
        displayMeetingTitle(meeting.title),
        meeting.audioLocalUri,
        playbackStorageScope,
        meeting.audioDurationSec ?? transcriptDurationHintSec,
        { localOnly: !meeting.audioAvailable },
      ));
    }
    canonicalAssets
      .filter(asset => asset.localState === 'local_ready' && Boolean(asset.localUri))
      .forEach(asset => {
        const uri = asset.localUri!;
        if (seenUris.has(uri)) {
          const existing = localSources.find(source => source.uri === uri);
          if (existing) {
            existing.recordingAssetId = asset.id;
            existing.recordingAssetRemoteId = asset.remoteAssetId ?? undefined;
            localSourceIdByAsset.set(asset.id, existing.sourceId);
            if (asset.remoteAssetId) {
              localSourceIdByRemoteAsset.set(asset.remoteAssetId, existing.sourceId);
            }
          }
          return;
        }
        seenUris.add(uri);
        const source = localPlayerSource(
          meeting.id,
          displayMeetingTitle(meeting.title),
          uri,
          playbackStorageScope,
          asset.durationMs === null ? undefined : asset.durationMs / 1000,
          {
            sourceId: asset.role === 'primary' ? `local:${meeting.id}` : `asset:${asset.id}`,
            localOnly: asset.remoteAssetId === null,
            recordingAssetId: asset.id,
            recordingAssetRemoteId: asset.remoteAssetId ?? undefined,
          },
        );
        localSources.push(source);
        localSourceIdByAsset.set(asset.id, source.sourceId);
        if (asset.remoteAssetId) {
          localSourceIdByRemoteAsset.set(asset.remoteAssetId, source.sourceId);
        }
      });
    const labelSources = (sources: readonly MinutesPlayerSourceSnapshot[]) => sources.map((source, index) => ({
      ...source,
      label: source.label ?? `录音 ${index + 1}`,
    }));
    const commitSources = (sources: readonly MinutesPlayerSourceSnapshot[]) => {
      if (!alive) return;
      const next = labelSources(sources);
      setPlayerSources(next);
      setSelectedPlayerSourceId(previous => (
        next.some(source => source.sourceId === previous)
          ? previous
          : next[0]?.sourceId ?? ''
      ));
    };
    commitSources(localSources);
    if (isGuest || !accessToken) {
      setTranscriptReprocessAvailable(false);
      setLoadingAudio(false);
      return () => { alive = false; };
    }
    setLoadingAudio(true);
    loadingTimer = setTimeout(() => {
      if (!alive) return;
      setLoadingAudio(false);
      if (localSources.length === 0) {
        setPlayerSourceError('录音加载超时，请稍后重试。');
      }
    }, AUDIO_SOURCE_RESOLUTION_TIMEOUT_MS);
    if (!remoteMeetingId) {
      if (loadingTimer) clearTimeout(loadingTimer);
      setLoadingAudio(false);
      if (localSources.length === 0) setPlayerSourceError('会议正在同步，请稍后重试。');
      return () => {
        alive = false;
        if (loadingTimer) clearTimeout(loadingTimer);
      };
    }
    void (async () => {
      const capability = await loadMeetingCapabilities({
        accessToken,
        forceRefresh: true,
        allowStaleOnError: false,
      }).catch(() => null);
      if (alive) {
        setTranscriptReprocessAvailable(Boolean(
          meetingTranscriptReprocessEnabled
          && capability?.source === 'remote'
          && capability.capabilities.recordingAssetsV2
          && capability.capabilities.transcriptReprocessV1,
        ));
      }
      if (capability?.source === 'remote' && capability.capabilities.recordingAssetsV2) {
        const remoteAssets = await listRecordingAssetsV2({
          accessToken,
          meetingRemoteId: remoteMeetingId,
        });
        const matchedLocalSourceIds = new Set<string>();
        const remoteSources: MinutesPlayerSourceSnapshot[] = [];
        let remoteDownloadFailed = false;
        for (const asset of remoteAssets) {
          if (asset.uploadState !== 'uploaded' || !asset.contentUrl) continue;
          // A repaired guest migration can legitimately retain the server's
          // historical client ID while the canonical local asset is linked by
          // its immutable remote ID. Both identities describe one recording.
          const localSourceId = localSourceIdByAsset.get(asset.clientAssetId)
            ?? localSourceIdByRemoteAsset.get(asset.remoteId);
          if (localSourceId) {
            matchedLocalSourceIds.add(localSourceId);
            const local = localSources.find(source => source.sourceId === localSourceId);
            if (local && !remoteSources.some(source => source.sourceId === local.sourceId)) {
              remoteSources.push({
                ...local,
                localOnly: false,
                recordingAssetRemoteId: asset.remoteId,
              });
            }
            continue;
          }
          try {
            const localUri = await materializeMeetingPlaybackAudio({
              meetingId: `${meeting.id}-${asset.remoteId}`,
              meetingUpdatedAt: new Date(asset.serverUpdatedAtMs).toISOString(),
              audio: {
                url: asset.contentUrl,
                mime_type: asset.mimeType,
                duration_sec: asset.durationMs === null ? null : asset.durationMs / 1_000,
                file_name: asset.fileName,
                expires_at: null,
                requires_auth: true,
              },
              accessToken,
            });
            if (!alive) return;
            remoteSources.push({
              sourceId: `remote-asset:${asset.remoteId}`,
              uri: localUri,
              recordingAssetRemoteId: asset.remoteId,
              localOnly: false,
              title: displayMeetingTitle(meeting.title),
              durationMsHint: asset.durationMs ?? undefined,
              retainForBackground: true,
              storageScope: playbackStorageScope,
            });
          } catch {
            remoteDownloadFailed = true;
          }
        }
        if (!alive) return;
        const unmatchedLocal = localSources
          .filter(source => !matchedLocalSourceIds.has(source.sourceId))
          .map(source => ({ ...source, localOnly: true }));
        const merged = [...remoteSources, ...unmatchedLocal];
        commitSources(merged);
        setPlayerSourceError(remoteDownloadFailed
          ? merged.length > 0
            ? '部分云端录音加载失败，本机录音仍可播放。'
            : '录音文件加载失败，请稍后重试。'
          : '');
        return;
      }

      const hasPrimaryLocal = Boolean(meeting.audioLocalUri) || canonicalAssets.some(asset => (
        asset.role === 'primary' && asset.localState === 'local_ready' && Boolean(asset.localUri)
      ));
      if (hasPrimaryLocal) return;
      const info = await fetchMeetingAudioInfo(remoteMeetingId, accessToken);
      if (!alive || !info) return;
      const localUri = await materializeMeetingPlaybackAudio({
        meetingId: meeting.id,
        meetingUpdatedAt: meeting.updatedAt,
        audio: info,
        accessToken,
      });
      if (!alive) return;
      const cloudSource: MinutesPlayerSourceSnapshot = {
        sourceId: `cloud:${meeting.id}`,
        uri: localUri,
        label: '录音 1',
        localOnly: false,
        title: displayMeetingTitle(meeting.title),
        durationMsHint: info.duration_sec ? Math.round(info.duration_sec * 1000) : undefined,
        retainForBackground: true,
        storageScope: playbackStorageScope,
      };
      commitSources([cloudSource, ...localSources.filter(source => source.uri !== cloudSource.uri)]);
      setPlayerSourceError('');
    })()
      .catch(() => {
        if (alive) {
          setTranscriptReprocessAvailable(false);
          commitSources(localSources);
          setPlayerSourceError(localSources.length > 0
            ? '云端录音加载失败，本机录音仍可播放。'
            : '录音文件加载失败，请稍后重试。');
        }
      })
      .finally(() => {
        if (loadingTimer) clearTimeout(loadingTimer);
        if (alive) setLoadingAudio(false);
      });
    return () => {
      alive = false;
      if (loadingTimer) clearTimeout(loadingTimer);
    };
  }, [accessToken, canonicalProcessingSnapshot, isGuest, meeting?.audioAvailable, meeting?.audioDurationSec, meeting?.audioLocalUri, meeting?.id, meeting?.title, meeting?.updatedAt, meetingScopeKey, meetingTranscriptReprocessEnabled, playbackStorageScope, reloadKey, remoteMeetingId, transcriptDurationHintSec]);

  const performPendingAudioUpload = useCallback((
    pending: PendingMeetingAudioUpload,
    notifyUser: boolean,
  ): Promise<void> => {
    // Guest mode has no account token by design. Its retry still goes through
    // the device/epoch uploader; only the old account compatibility path needs
    // an access token.
    if (!isGuest && !accessToken) return Promise.resolve();
    if (uploadInFlightRef.current) return uploadInFlightRef.current;
    setRetryingAudioUpload(true);
    setPendingAudioError('');
    let operation: Promise<void> | null = null;
    operation = (async () => {
      try {
        // This branch waits for the account/canonical upload reconciler.  The
        // accountless device path has its own upload + transcription contract
        // below; sending it through the account branch kept the visible state
        // on "正在上传录音" until transcription had already completed.
        if (!isGuest && getFeatureFlags().localMeetingDbAccountUploadWriteV1) {
          await reconcileAudioUploads();
          const latest = await getPendingMeetingAudioUpload(
            recordingStorageScope,
            pending.meetingId,
            pending.recordingAssetId,
          );
          if (mountedRef.current) {
            setPendingAudioUpload(latest);
            setPendingAudioError(latest?.failureMessage
              ? readableErrorMessage(latest.failureMessage, '自动同步未完成，录音仍保存在本机')
              : '');
          }
          if (notifyUser && mountedRef.current) {
            showDialog(latest
              ? { title: '正在后台同步', message: '录音将在后台继续上传。', tone: 'info' }
              : { title: '上传完成', message: '本机录音已同步到会议服务。', tone: 'success' });
          }
          return;
        }
        // Guest/device uploads must go through the same capability-selected
        // queue as the meeting list.  Calling the legacy uploader directly
        // here raced the v2 barrier and produced a visible 426 before the
        // durable v2 worker could take ownership of the asset.
        if (isGuest) {
          await reconcileAudioUploads();
          const latest = await getPendingMeetingAudioUpload(
            recordingStorageScope,
            pending.meetingId,
            pending.recordingAssetId,
          );
          if (mountedRef.current) {
            setPendingAudioUpload(latest);
            setPendingAudioError(latest?.failureMessage
              ? readableErrorMessage(latest.failureMessage, '自动同步未完成，录音仍保存在本机')
              : '');
          }
          if (notifyUser && mountedRef.current) {
            showDialog(latest
              ? { title: '正在后台同步', message: '录音将在后台继续上传。', tone: 'info' }
              : { title: '上传完成', message: '本机录音已同步到会议服务。', tone: 'success' });
          }
          return;
        }

        const uploadCredential = accessToken ?? 'device';
        const uploaded = await retryPendingMeetingAudioUpload(
          recordingStorageScope,
          pending.recordingAssetId,
          uploadCredential,
          (item, token) => uploadMeetingAudio(
              item.remoteMeetingId ?? item.meetingId,
              item.audioUri,
              token,
              { fileName: item.fileName, mimeType: item.mimeType },
          ),
          { automatic: !notifyUser },
        );
        const stillPending = uploaded
          ? null
          : await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId);
        if (mountedRef.current) {
          setPendingAudioUpload(stillPending);
          setPendingAudioError(stillPending?.failureMessage
            ? readableErrorMessage(stillPending.failureMessage, '自动同步未完成，录音仍保存在本机')
            : '');
        }
        if (uploaded) {
          // Upload completion is the visible boundary between transfer and
          // transcription.  Canonical reconciliation may legitimately keep
          // working for tens of seconds, but it must not extend the upload
          // label or hide the server task that already owns the next stage.
          if (isGuest && uploaded.transcriptionTaskId) {
            const queuedTask: DeviceTranscriptTaskRecord = {
              meetingId: uploaded.meetingId,
              taskId: uploaded.transcriptionTaskId,
              state: 'pending',
              phase: 'queued',
              eventCursor: 0,
              eventTotal: null,
              updatedAt: new Date().toISOString(),
            };
            if (mountedRef.current && routeMeetingIdRef.current === uploaded.meetingId) {
              setDeviceTranscriptTask(queuedTask);
              setRetryingAudioUpload(false);
            }
            await rememberDeviceTranscriptTask(
              uploaded.meetingId,
              uploaded.transcriptionTaskId,
            ).catch(reason => {
              // The in-memory task still gives this open detail an honest
              // state; the completion provider can discover the result by
              // meeting id even if the durable hint cannot be written.
              diagnosticWarn('[device-transcript] task hint write deferred in detail', reason);
            });
          } else if (mountedRef.current) {
            setRetryingAudioUpload(false);
          }
          await reconcileAudioUploads(uploaded).catch(reason => {
            // Upload already succeeded. Reconciliation is a local projection
            // concern and must never be presented as an upload failure.
            diagnosticWarn('[meeting-detail] uploaded audio reconciliation deferred', reason);
          });
        }
        if (notifyUser && mountedRef.current) {
          showDialog(uploaded
            ? { title: '上传完成', message: '本机录音已同步到会议服务。', tone: 'success' }
            : { title: '正在后台同步', message: '录音将在后台继续上传。', tone: 'info' });
        }
      } catch {
        const latest = await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId).catch(() => null);
        if (mountedRef.current) {
          setPendingAudioUpload(latest);
          setPendingAudioError(readableErrorMessage(
            latest?.failureMessage,
            '自动同步未完成，录音仍保存在本机',
          ));
          if (notifyUser) {
            showDialog({
              title: latest?.uploadState === 'blocked' ? '录音上传受阻' : '上传失败',
              message: readableErrorMessage(
                latest?.failureMessage,
                '录音仍保存在本机，可稍后再次重试。',
              ),
              tone: 'error',
            });
          }
        }
      } finally {
        if (mountedRef.current) setRetryingAudioUpload(false);
        if (uploadInFlightRef.current === operation) uploadInFlightRef.current = null;
      }
    })();
    uploadInFlightRef.current = operation;
    return operation;
  }, [accessToken, isGuest, reconcileAudioUploads, recordingStorageScope, showDialog]);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!meeting) {
      setPendingAudioUpload(null);
      setPendingAudioError('');
      return () => { alive = false; };
    }
    void getPendingMeetingAudioUpload(recordingStorageScope, meeting.id).then(pending => {
      if (!alive) return;
      setPendingAudioUpload(pending);
      setPendingAudioError(pending?.failureMessage
        ? readableErrorMessage(pending.failureMessage, '自动同步未完成，录音仍保存在本机')
        : '');
      if (!pending || (!accessToken && !isGuest)) return;
      // The provider and WorkManager are the only automatic executors for the
      // accountless v2 queue. This detail screen observes their durable state;
      // it only wakes the executor from the explicit retry action below.
      if (isGuest) return;
      const key = `${recordingStorageScope}:${pending.meetingId}:${pending.attemptCount}:${pending.nextAttemptAt ?? ''}`;
      if (automaticAudioUploadKeyRef.current === key) return;
      automaticAudioUploadKeyRef.current = key;
      if (canAutomaticallyRetryPendingMeetingAudioUpload(pending)) {
        void performPendingAudioUpload(pending, false);
      } else if (pending.uploadState !== 'blocked' && pending.nextAttemptAt) {
        const retryAt = Date.parse(pending.nextAttemptAt);
        if (!Number.isNaN(retryAt)) {
          retryTimer = setTimeout(() => setReloadKey(value => value + 1), Math.max(0, retryAt - Date.now()));
        }
      }
    }).catch(() => {
      if (alive) setPendingAudioError('无法读取录音待上传状态，请重试。');
    });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accessToken, isGuest, meeting?.id, meeting?.updatedAt, performPendingAudioUpload, recordingStorageScope, reloadKey]);

  useEffect(() => {
    const meetingId = meeting?.id;
    if (!meetingId) return undefined;
    const refresh = () => setReloadKey(value => value + 1);
    const unsubscribe = subscribePendingMeetingAudioUploadChanged(changedMeetingId => {
      if (changedMeetingId === meetingId) refresh();
    });
    refresh();
    return unsubscribe;
  }, [meeting?.id]);

  useEffect(() => {
    const meetingId = meeting?.id;
    let active = true;
    if (!isGuest || !meetingId) {
      setDeviceTranscriptTask(null);
      return () => { active = false; };
    }
    const refresh = () => {
      void getDeviceTranscriptTask(meetingId)
        .then(task => {
          if (active && routeMeetingIdRef.current === meetingId) setDeviceTranscriptTask(task);
        })
        .catch(() => {
          if (active && routeMeetingIdRef.current === meetingId) setDeviceTranscriptTask(null);
        });
    };
    setDeviceTranscriptTask(null);
    refresh();
    const unsubscribe = subscribeDeviceTranscriptTaskChanged(changedMeetingId => {
      if (changedMeetingId === meetingId) refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isGuest, meeting?.id]);

  useEffect(() => { autoResumeTaskRef.current = ''; }, [meeting?.id, recordingStorageScope]);

  useEffect(() => {
    summaryCarryLookupGenerationRef.current += 1;
    setSummaryAttachmentRequest(null);
    setSummaryCarryForwardRequest(null);
  }, [meeting?.id, meetingScopeKey]);

  function runSummaryTask(options: {
    automatic?: boolean;
    forceRegenerate?: boolean;
    resumeTask?: PendingMeetingSummaryTask | null;
    transcriptLines?: TranscriptLine[];
    template?: MeetingTemplate;
    carryForward?: MeetingSummaryCarryForwardAuthorization | null;
    attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
  } = {}): Promise<void> {
    if (!meeting) return Promise.resolve();
    if (summaryInFlightRef.current) return summaryInFlightRef.current;
    const currentMeeting = meeting;
    let lines = options.transcriptLines ?? transcript;
    const releaseInteractiveWork = beginSummaryV3InteractiveWork();

    const meetingDate = meetingDateForSummary(currentMeeting.date, currentMeeting.createdAt);
    const resumedTemplate = options.resumeTask
      ? meetingTemplateById(options.resumeTask.templateId, options.resumeTask.templateRevision)
      : null;
    const requestedTemplate = options.template ?? resumedTemplate ?? summaryTemplate;
    const hasExplicitCarryForward = Object.prototype.hasOwnProperty.call(options, 'carryForward');
    const requestedCarryForward = options.resumeTask
      ? options.resumeTask.carryForward
      : hasExplicitCarryForward
        ? options.carryForward ?? null
        : null;
    const hasExplicitAttachmentAuthorization = Object.prototype.hasOwnProperty.call(
      options,
      'attachmentAuthorization',
    );
    const requestedAttachmentAuthorization = options.resumeTask
      ? options.resumeTask.attachmentAuthorization
      : hasExplicitAttachmentAuthorization
        ? options.attachmentAuthorization ?? null
        : null;
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    const currentMeetingScopeKey = meetingScopeKey;
    let knownTaskId = options.resumeTask?.taskId ?? null;
    let recordedTaskStatus: 'queued' | 'generating' | null = options.resumeTask
      ? 'generating'
      : null;
    let sourceTranscriptWasCanonical = false;
    let activeFingerprint = summaryTaskInputFingerprint({
      transcriptLines: lines,
      title: currentMeeting.title,
      meetingDate,
      template: requestedTemplate,
      carryForward: requestedCarryForward,
      attachmentAuthorization: requestedAttachmentAuthorization,
      manualNote: manualNote.snapshot(),
    });
    let operation: Promise<void> | null = null;
    operation = (async () => {
      // A summary run belongs to the meeting, not to one transient native page
      // generation. Background summary-version pulls legitimately advance the
      // summary page generation while this request is polling; using that
      // generation as the operation lifetime left the final result visible but
      // the loading state permanently active.
      beginPageRequest(currentMeeting.id, 'summary');
      setSummaryVisualPhase('running');
      setLoadingSummary(true);
      setSummaryError('');
      setSummaryProgress('正在检查上次整理任务');
      const controller = new AbortController();
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = controller;
      const isActiveSummaryRun = () => (
        mountedRef.current
        && summaryAbortRef.current === controller
        && activeMeetingIdRef.current === currentMeeting.id
        && activeMeetingScopeRef.current === currentMeetingScopeKey
      );
      try {
        if (manualNote.loading) throw new Error('我的笔记仍在读取，请稍后重试。');
        await manualNote.flush();
        const summaryManualNote = manualNote.snapshot();
        // The visible transcript can briefly be the legacy cache while the
        // canonical revision is loading. Creating a durable source-stream
        // task from that transient projection makes the same task impossible
        // to resume once the canonical lines arrive because their stable
        // source identities differ. Resolve the local owner revision inside
        // every initial and resumed run so both paths hash the same source.
        if (currentMeetingScopeKey) {
          const activeTranscript = await loadActiveMeetingTranscriptState(
            currentMeetingScopeKey,
            currentMeeting.id,
          );
          if (activeTranscript) {
            lines = simplifyTranscriptLines(activeTranscript.lines);
            sourceTranscriptWasCanonical = true;
          }
        }
        if (lines.length === 0) {
          if (isActiveSummaryRun()) {
            setSummaryVisualPhase(summaryDocument ? 'ready' : 'idle');
            setSummaryProgress('');
          }
          if (!options.automatic) {
            showDialog({
              title: '暂无转写',
              message: '需要先有会议转写内容，才能生成整理结果。',
              tone: 'info',
            });
          }
          return;
        }
        activeFingerprint = summaryTaskInputFingerprint({
          transcriptLines: lines,
          title: currentMeeting.title,
          meetingDate,
          template: requestedTemplate,
          carryForward: requestedCarryForward,
          attachmentAuthorization: requestedAttachmentAuthorization,
          manualNote: summaryManualNote,
        });
        let pending = options.resumeTask ?? null;
        if (options.forceRegenerate) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          pending = null;
        } else if (options.resumeTask === undefined) {
          try {
            pending = await getPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id);
            if (!isActiveSummaryRun()) return;
          } catch {
            throw new Error('无法读取上次整理任务，未提交新任务。请检查本机存储后重试。');
          }
        }
        let carryForward = options.resumeTask
          ? options.resumeTask.carryForward
          : hasExplicitCarryForward
            ? options.carryForward ?? null
            : pending?.carryForward ?? null;
        let attachmentAuthorization = options.resumeTask
          ? options.resumeTask.attachmentAuthorization
          : hasExplicitAttachmentAuthorization
            ? options.attachmentAuthorization ?? null
            : pending?.attachmentAuthorization ?? null;
        if (attachmentAuthorization) {
          const authorizationIsCurrent = Boolean(
            currentMeetingScopeKey
            && await meetingSummaryAttachmentAuthorizationIsCurrent({
              scopeKey: currentMeetingScopeKey,
              meetingId: currentMeeting.id,
              authorization: attachmentAuthorization,
              accessToken,
            }),
          );
          if (!authorizationIsCurrent) {
            if (pending) {
              await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
              // The user-approved source changed after a durable task was
              // submitted. This is an activation-fence outcome, not a service
              // failure or a bad selection. Preserve the previous summary and
              // converge the canonical stage through the shared input-changed
              // terminal path.
              throw new MeetingSummaryInputChangedError();
            }
            throw new MeetingSummaryAttachmentSelectionStaleError();
          }
        }
        let fingerprint = summaryTaskInputFingerprint({
          transcriptLines: lines,
          title: currentMeeting.title,
          meetingDate,
          template: requestedTemplate,
          carryForward,
          attachmentAuthorization,
          manualNote: summaryManualNote,
        });
        const resumableFactsV3Task = Boolean(
          pending
          && getFeatureFlags().meetingSummarySourceStreamCandidate
          && pending.taskId.startsWith('vnext-summary:'),
        );
        if (pending && (
          pending.mode !== expectedMode
          || (!resumableFactsV3Task && (
            pending.templateId !== requestedTemplate.id
            || pending.templateRevision !== requestedTemplate.revision
            || pending.inputFingerprint !== fingerprint
          ))
        )) {
          const pendingUsedAttachments = pending.attachmentAuthorization !== null;
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          if (!isActiveSummaryRun()) return;
          pending = null;
          if (pendingUsedAttachments) throw new MeetingSummaryAttachmentSelectionStaleError();
          carryForward = requestedCarryForward;
          attachmentAuthorization = requestedAttachmentAuthorization;
          fingerprint = summaryTaskInputFingerprint({
            transcriptLines: lines,
            title: currentMeeting.title,
            meetingDate,
            template: requestedTemplate,
            carryForward,
            attachmentAuthorization,
            manualNote: summaryManualNote,
          });
        }
        knownTaskId = pending?.taskId ?? null;
        activeFingerprint = fingerprint;
        if (!isActiveSummaryRun()) return;
        setSummaryProgress(pending ? '正在恢复上次整理任务' : '正在提交整理任务');
        if (currentMeetingScopeKey) {
          await recordMeetingSummaryProcessing({
            scopeKey: currentMeetingScopeKey,
            legacyMeetingId: currentMeeting.id,
            signal: pending
              ? {
                type: 'task_status',
                status: 'generating',
                taskId: pending.taskId,
                inputFingerprint: fingerprint,
              }
              : {
                type: 'prepare',
                inputFingerprint: fingerprint,
              },
          });
        }
        const generated = await generateSummaryForMeeting({
          meetingId: isGuest
            ? currentMeeting.id
            : requireMeetingRemoteIdentity(currentMeeting),
          localMeetingId: currentMeeting.id,
          title: currentMeeting.title,
          meetingDate,
          transcriptLines: lines,
          template: requestedTemplate,
          carryForward,
          attachmentAuthorization,
          manualNote: summaryManualNote,
          isGuest,
          accessToken,
          resumeTaskId: pending?.taskId,
          forceRegenerate: Boolean(options.forceRegenerate),
          signal: controller.signal,
          traceSource: options.automatic
            ? 'automatic_resume'
            : options.forceRegenerate
              ? 'regenerate'
              : options.resumeTask
                ? 'resume'
                : 'manual',
          inputFingerprint: fingerprint,
          onTaskSubmitted: async taskId => {
            knownTaskId = taskId;
            try {
              await savePendingMeetingSummaryTask(recordingStorageScope, {
                meetingId: currentMeeting.id,
                taskId,
                mode: expectedMode,
                templateId: requestedTemplate.id,
                templateRevision: requestedTemplate.revision,
                inputFingerprint: fingerprint,
                carryForward,
                attachmentAuthorization,
              });
            } catch {
              if (isActiveSummaryRun()) {
                setSummaryError('任务已提交，但本机无法保存恢复状态，请保持当前页面打开。');
              }
            }
            if (currentMeetingScopeKey) {
              const outcome = await recordMeetingSummaryProcessing({
                scopeKey: currentMeetingScopeKey,
                legacyMeetingId: currentMeeting.id,
                signal: {
                  type: 'task_status',
                  status: 'generating',
                  taskId,
                  inputFingerprint: fingerprint,
                },
              });
              if (outcome !== 'failed') recordedTaskStatus = 'generating';
            }
            if (isActiveSummaryRun()) autoResumeTaskRef.current = taskId;
          },
          onProgress: async progress => {
            if (isActiveSummaryRun()) {
              setSummaryProgress(meetingSummaryProgressLabel(progress));
            }
            if (!currentMeetingScopeKey) return;
            if (progress.stage === 'resubmitting') {
              knownTaskId = null;
              recordedTaskStatus = null;
              await recordMeetingSummaryProcessing({
                scopeKey: currentMeetingScopeKey,
                legacyMeetingId: currentMeeting.id,
                signal: { type: 'prepare', inputFingerprint: fingerprint },
              });
              return;
            }
            if (!knownTaskId || progress.stage === 'reconnecting') return;
            const nextStatus = progress.stage === 'queued' ? 'queued' : 'generating';
            if (recordedTaskStatus === nextStatus) return;
            const outcome = await recordMeetingSummaryProcessing({
              scopeKey: currentMeetingScopeKey,
              legacyMeetingId: currentMeeting.id,
              signal: {
                type: 'task_status',
                status: nextStatus,
                taskId: knownTaskId,
                inputFingerprint: fingerprint,
              },
            });
            if (outcome !== 'failed') recordedTaskStatus = nextStatus;
          },
        });
        await manualNote.flush();
        const latestMeeting = activeMeetingRef.current;
        const latestNote = manualNote.snapshot();
        if (
          !latestMeeting
          || latestMeeting.id !== currentMeeting.id
          || activeMeetingScopeRef.current !== currentMeetingScopeKey
        ) throw new MeetingSummaryInputChangedError();
        if (
          attachmentAuthorization
          && (
            !currentMeetingScopeKey
            || !await meetingSummaryAttachmentAuthorizationIsCurrent({
              scopeKey: currentMeetingScopeKey,
              meetingId: currentMeeting.id,
              authorization: attachmentAuthorization,
              accessToken,
            })
          )
        ) throw new MeetingSummaryInputChangedError();
        let activationTranscriptLines = transcriptRef.current;
        if (sourceTranscriptWasCanonical && currentMeetingScopeKey) {
          const latestTranscript = await loadActiveMeetingTranscriptState(
            currentMeetingScopeKey,
            currentMeeting.id,
          );
          if (!latestTranscript) throw new MeetingSummaryInputChangedError();
          activationTranscriptLines = simplifyTranscriptLines(latestTranscript.lines);
        }
        const activationFingerprint = summaryTaskInputFingerprint({
          transcriptLines: activationTranscriptLines,
          title: latestMeeting.title,
          meetingDate: meetingDateForSummary(latestMeeting.date, latestMeeting.createdAt),
          template: requestedTemplate,
          carryForward,
          attachmentAuthorization,
          manualNote: latestNote,
        });
        if (activationFingerprint !== fingerprint) throw new MeetingSummaryInputChangedError();
        const text = meetingSummaryToText(generated);
        const generatedDocument = text ? summaryDocumentFor(currentMeeting.id, generated) : null;
        if (isActiveSummaryRun()) setSummaryError('');
        let cached = false;
        let localPersistPhase = 'canonical_identity';
        try {
          let v3CanonicalMeetingId: string | null = null;
          if (generated.facts_document_v3 && currentMeetingScopeKey) {
            v3CanonicalMeetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
              currentMeeting.id,
              currentMeetingScopeKey,
            );
            if (!v3CanonicalMeetingId) throw new Error('新版整理结果无法关联本机会议');
          }
          localPersistPhase = 'summary_projection';
          const cacheResult = await saveCachedSummary(currentMeeting.id, generated);
          cached = cacheResult.mirrorStatus !== 'stale_scope';
          if (generated.facts_document_v3 && v3CanonicalMeetingId && currentMeetingScopeKey) {
            if (!cacheResult.localVersionId) throw new Error('新版整理结果缺少本机版本身份');
            localPersistPhase = 'facts_version_verify';
            const storedFacts = await loadMeetingFactsRecordV3ForVersion(cacheResult.localVersionId);
            if (
              !storedFacts
              || storedFacts.canonicalMeetingId !== v3CanonicalMeetingId
              || storedFacts.result.documentId !== generated.facts_document_v3.documentId
            ) throw new Error('新版整理事实与本机版本未原子关联');
            localPersistPhase = 'adaptive_projection_ready';
          }
          localPersistPhase = 'projection_refresh';
          if (
            currentMeetingScopeKey
            && currentMeetingScopeKey !== 'guest'
            && accessToken
            && !controller.signal.aborted
          ) {
            try {
              const canonicalMeetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
                currentMeeting.id,
                currentMeetingScopeKey,
              );
              if (canonicalMeetingId) {
                await pullMeetingSummaryVersions({
                  scopeKey: currentMeetingScopeKey,
                  canonicalMeetingId,
                  meeting: currentMeeting,
                  meetingRemoteId: requireMeetingRemoteIdentity(currentMeeting),
                  accessToken,
                  signal: controller.signal,
                });
              }
            } catch (reason) {
              // The generated result is already durable. Catalog refresh is a
              // best-effort pointer reconciliation and must not turn a
              // successful generation into a save failure.
              diagnosticWarn('refresh generated meeting summary version failed', reason);
            }
          }
          if (isActiveSummaryRun()) {
            setCanonicalProcessingSnapshot(current => (
              reconcileRecoveredSummaryStage(current, generatedDocument)
            ));
            const current = meetingScopeKey
              ? await loadCurrentMeetingSummaryState(meetingScopeKey, currentMeeting.id).catch(() => null)
              : null;
            if (isActiveSummaryRun()) {
              const v3 = current
                ? await loadProjectedMeetingFactsV3(current, requestedTemplate).catch(reason => {
                  diagnosticWarn('[meeting-summary-v3] generated projection failed', reason);
                  return null;
                })
                : null;
              if (!isActiveSummaryRun()) return;
              const visibleDocument = v3?.document ?? current?.document ?? generatedDocument;
              setSummary(visibleDocument ? meetingSummaryDocumentToText(visibleDocument) : (text || '暂无整理结果'));
              setSummaryDocument(visibleDocument);
              setActiveMeetingFactsV3(v3?.active ?? (generated.facts_document_v3 && cacheResult.localVersionId && v3CanonicalMeetingId
                ? {
                  canonicalMeetingId: v3CanonicalMeetingId,
                  summaryVersionId: cacheResult.localVersionId,
                  result: generated.facts_document_v3,
                }
                : null));
              setSummaryCached(cached);
              const currentMatchesGenerated = Boolean(
                current
                && generatedDocument
                && current.document.templateId === generatedDocument.templateId
                && current.document.templateRevision === generatedDocument.templateRevision
                && meetingSummaryDocumentToText(current.document) === text,
              );
              if (
                cacheResult.projection === 'preserved'
                && !currentMatchesGenerated
                && !options.automatic
              ) {
                const protectedProjection = cacheResult.mirrorStatus === 'preserved_user_projection';
                showDialog({
                  title: '新整理结果已保存',
                  message: protectedProjection
                    ? '当前版本包含你的修改或已处理的待办事项，因此没有自动替换。'
                    : '新结果已保存到版本列表，当前页面暂未完成切换。',
                  tone: 'info',
                  actions: [
                    { text: '查看新版本', role: 'primary', onPress: openSummaryVersions },
                    { text: '保留当前', role: 'cancel' },
                  ],
                });
              }
            }
          }
        } catch (reason) {
          if (
            reason instanceof SummaryV3ActivationFenceError
            || isSummaryV3ActivationFenceErrorLike(reason)
          ) {
            throw new MeetingSummaryInputChangedError();
          }
          diagnosticAudit('meeting_summary_v3_local_persist', {
            status: 'failed',
            phase: localPersistPhase,
            error_name: reason instanceof Error ? reason.name : 'unknown',
          });
          if (isActiveSummaryRun()) {
            setSummary(text || '暂无整理结果');
            setSummaryDocument(generatedDocument);
            setSummaryCached(false);
            setSummaryVisualPhase('ready');
            setSummaryError('整理结果已生成，但本机缓存写入失败。');
            showDialog({
              title: '整理结果已生成，保存失败',
              message: '当前页面仍可查看整理结果，但退出后可能无法离线恢复。',
              tone: 'warning',
            });
          }
        }
        // Commit the visual terminal state only after the durable mirror has
        // settled, so the loading slot does not briefly coexist with the
        // final action label.
        if (isActiveSummaryRun()) setSummaryVisualPhase('ready');
        if (cached || !isGuest) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
      } catch (reason) {
        const taskStillRunning = reason instanceof MeetingSummaryTaskPendingError;
        const inputChanged = reason instanceof MeetingSummaryInputChangedError
          || isMeetingSummaryInputChangedErrorLike(reason)
          || isSummaryV3ActivationFenceErrorLike(reason);
        const failureCode = meetingSummaryProcessingFailureCode(reason);
        diagnosticAudit('meeting_summary_run_terminal', {
          outcome: inputChanged
            ? 'input_changed'
            : taskStillRunning
              ? 'background'
              : (reason as { name?: unknown })?.name === 'AbortError'
                ? 'aborted'
                : 'failed',
          error_name: reason && typeof reason === 'object'
            && typeof (reason as { name?: unknown }).name === 'string'
            ? (reason as { name: string }).name
            : typeof reason,
          failure_code: failureCode,
        });
        if (inputChanged || shouldDiscardPendingMeetingSummaryTask(reason)) {
          try {
            await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id);
            diagnosticAudit('meeting_summary_pending_task_discard', { status: 'cleared' });
          } catch (discardReason) {
            diagnosticAudit('meeting_summary_pending_task_discard', {
              status: 'failed',
              error_name: discardReason && typeof discardReason === 'object'
                && typeof (discardReason as { name?: unknown }).name === 'string'
                ? (discardReason as { name: string }).name
                : typeof discardReason,
            });
          }
        }
        if (currentMeetingScopeKey) {
          await recordMeetingSummaryProcessing({
            scopeKey: currentMeetingScopeKey,
            legacyMeetingId: currentMeeting.id,
            signal: inputChanged
              ? { type: 'discarded' }
              : (reason as Error)?.name === 'AbortError' || taskStillRunning
              ? {
                type: 'aborted',
                taskId: knownTaskId,
                inputFingerprint: activeFingerprint,
              }
              : {
                type: 'failed',
                taskId: knownTaskId,
                inputFingerprint: activeFingerprint,
                errorCode: failureCode,
              },
          });
        }
        if (!isActiveSummaryRun()) return;
        if (inputChanged) {
          setSummaryVisualPhase(summaryDocument ? 'ready' : 'idle');
          setSummaryError('');
          setSummaryProgress('');
          if (!options.automatic) {
            showDialog({
              title: '会议内容已更新',
              message: summaryDocument
                ? '整理期间会议内容发生了变化，已保留上一份可用结果。请按当前内容重新整理。'
                : '整理期间会议内容发生了变化，本次结果未保存。请按当前内容重新整理。',
              tone: 'info',
            });
          }
        } else if (taskStillRunning) {
          setSummaryVisualPhase('background');
          setSummaryError('');
          setSummaryProgress('整理任务仍在后台进行');
          if (!options.automatic) {
            showDialog({
              title: '整理仍在进行',
              message: '任务会继续在后台生成，再次打开会议可继续获取。',
              tone: 'info',
            });
          }
        } else if ((reason as Error)?.name === 'AbortError') {
          setSummaryVisualPhase('background');
          if (!options.automatic && !silentSummaryAbortRef.current.has(controller)) {
            showDialog({
              title: '已停止等待',
              message: '任务会继续在后台生成，再次打开会议即可恢复。',
              tone: 'info',
            });
          }
        } else {
          setSummaryVisualPhase('error');
          const message = readableErrorMessage(
            reason,
            options.automatic ? '上次会议整理结果暂时无法恢复，点击重试可继续获取。' : '会议整理结果暂时无法生成，请稍后重试。',
          );
          setSummaryError(message);
          if (!options.automatic) showDialog({ title: '生成失败', message, tone: 'error' });
        }
      } finally {
        if (summaryAbortRef.current === controller) {
          const ownsActiveMeeting = isActiveSummaryRun();
          summaryAbortRef.current = null;
          if (ownsActiveMeeting) setLoadingSummary(false);
        }
        if (summaryInFlightRef.current === operation) summaryInFlightRef.current = null;
        releaseInteractiveWork();
      }
    })();
    summaryInFlightRef.current = operation;
    return operation;
  }

  function isActiveSummaryCarryLookup(
    generation: number,
    meetingId: string,
    scopeKey: ScopeKey,
  ): boolean {
    return mountedRef.current
      && summaryCarryLookupGenerationRef.current === generation
      && activeMeetingIdRef.current === meetingId
      && activeMeetingScopeRef.current === scopeKey;
  }

  async function continueSummaryAfterAttachmentSelection(input: {
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
  }, attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null): Promise<void> {
    if (isGuest) {
      await runSummaryTask({
        forceRegenerate: input.forceRegenerate,
        template: input.template,
        carryForward: null,
        attachmentAuthorization,
      });
      return;
    }
    const generation = summaryCarryLookupGenerationRef.current + 1;
    summaryCarryLookupGenerationRef.current = generation;
    try {
      const memory = await resolveMeetingSummaryCarryForwardMemory(input.scopeKey, input.meetingId);
      if (!isActiveSummaryCarryLookup(generation, input.meetingId, input.scopeKey)) return;
      if (!memory || (memory.decisions.length === 0 && memory.pendingActions.length === 0)) {
        await runSummaryTask({
          forceRegenerate: input.forceRegenerate,
          template: input.template,
          carryForward: null,
          attachmentAuthorization,
        });
        return;
      }
      setSummaryCarryForwardRequest({
        ...input,
        memory,
        attachmentAuthorization,
      });
    } catch {
      if (!isActiveSummaryCarryLookup(generation, input.meetingId, input.scopeKey)) return;
      // Attachment/history lookup is only preparation. Release its local
      // busy state before presenting the recovery choice; otherwise closing
      // the dialog leaves the detail page locked on “正在准备整理”.
      setSummaryVisualPhase('error');
      setLoadingSummary(false);
      setSummaryError('暂时无法读取上次会议内容。');
      showDialog({
        title: '无法读取上次会议内容',
        message: '暂时无法检查可引用的决定和未完成事项。',
        tone: 'warning',
        actions: [
          {
            text: '不引用，继续',
            role: 'primary',
            onPress: () => {
              if (
                activeMeetingIdRef.current === input.meetingId
                && activeMeetingScopeRef.current === input.scopeKey
              ) {
                void runSummaryTask({
                  forceRegenerate: input.forceRegenerate,
                  template: input.template,
                  carryForward: null,
                  attachmentAuthorization,
                });
              }
            },
          },
          { text: '取消', role: 'cancel' },
        ],
      });
    }
  }

  function cancelSummaryPreparation(meetingId: string, scopeKey: ScopeKey): void {
    if (summaryInFlightRef.current) return;
    void recordMeetingSummaryProcessing({
      scopeKey,
      legacyMeetingId: meetingId,
      signal: { type: 'discarded' },
    }).catch(reason => diagnosticWarn('[meeting-summary] preparation cancellation deferred', reason));
  }

  async function prepareSummaryGeneration(template: MeetingTemplate): Promise<void> {
    if (!meeting || summaryInFlightRef.current || summaryVisualPhase === 'running') return;
    const currentMeetingId = meeting.id;
    const currentScopeKey = meetingScopeKey;
    const forceRegenerate = Boolean(summary);
    // Template/attachment/carry-forward checks are part of the same user
    // action.  Previously the page stayed visually idle until all of those
    // checks finished, so tapping “重新生成” appeared to do nothing even
    // though the task would be submitted afterwards.  The detail status slot
    // is the single owner for this preparation state as well as generation.
    setSummaryVisualPhase('running');
    setLoadingSummary(true);
    setSummaryError('');
    setSummaryProgress('正在准备整理');
    setSummaryTemplate(template);
    setSummaryAttachmentRequest(null);
    setSummaryCarryForwardRequest(null);

    if (!currentScopeKey) {
      await runSummaryTask({
        forceRegenerate,
        template,
        carryForward: null,
        attachmentAuthorization: null,
      });
      return;
    }

    const input = {
      meetingId: currentMeetingId,
      scopeKey: currentScopeKey,
      template,
      forceRegenerate,
    };
    const generation = summaryCarryLookupGenerationRef.current + 1;
    summaryCarryLookupGenerationRef.current = generation;
    // Record the preparation phase before optional attachment/history reads so
    // the list, a reopened detail page, and the native status slot all share
    // one meeting-level state from the first user tap.
    void recordMeetingSummaryProcessing({
      scopeKey: currentScopeKey,
      legacyMeetingId: currentMeetingId,
      signal: {
        type: 'prepare',
        inputFingerprint: summaryTaskInputFingerprint({
          transcriptLines: transcript,
          title: meeting.title,
          meetingDate: meetingDateForSummary(meeting.date, meeting.createdAt),
          template,
          carryForward: null,
          attachmentAuthorization: null,
          manualNote: manualNote.snapshot(),
        }),
      },
    }).catch(reason => diagnosticWarn('[meeting-summary] preparation state write deferred', reason));
    try {
      const [attachments, imageSelectionEnabled] = await Promise.all([
        loadMeetingAttachments(currentScopeKey, currentMeetingId),
        Promise.resolve(false),
      ]);
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      if (attachments.length > 0) {
        setSummaryProgress('正在准备整理');
        setSummaryAttachmentRequest({ ...input, attachments, imageSelectionEnabled });
        return;
      }
      await continueSummaryAfterAttachmentSelection(input, null);
    } catch {
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      setSummaryVisualPhase('error');
      setLoadingSummary(false);
      setSummaryError('暂时无法读取会议附件。');
      showDialog({
        title: '无法读取附件',
        message: '暂时无法确认本次会议的附件。',
        tone: 'warning',
        actions: [
          {
            text: '不使用，继续',
            role: 'primary',
            onPress: () => {
              if (
                activeMeetingIdRef.current === currentMeetingId
                && activeMeetingScopeRef.current === currentScopeKey
              ) void continueSummaryAfterAttachmentSelection(input, null);
            },
          },
          { text: '取消', role: 'cancel' },
        ],
      });
    }
  }

  useEffect(() => {
    if (!meeting || loadingTranscript || loadingSummary || summaryInFlightRef.current || transcript.length === 0) return;
    let alive = true;
    const date = meetingDateForSummary(meeting.date, meeting.createdAt);
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    const pendingRequest = requestCoordinatorRef.current.capture(meeting.id, 'summary');
    void getPendingMeetingSummaryTask(recordingStorageScope, meeting.id).then(async pending => {
      if (!alive || !isCurrentPageRequest(pendingRequest)) return;
      if (pending && autoResumeTaskRef.current === pending.taskId) return;
      if (!pending) {
        // The SQLite stage is durable meeting state.  The AsyncStorage task
        // registry is only a recovery hint and can be momentarily absent while
        // the submit callback is flushing, after a scope switch, or after a
        // process restart.  Missing that hint is not evidence that the server
        // task was discarded; clearing the canonical stage here split the
        // detail page from the meeting list and made a running regeneration
        // disappear on re-entry.
        return;
      }
      const pendingTemplate = meetingTemplateById(pending.templateId, pending.templateRevision);
      const fingerprint = pendingTemplate
        ? summaryTaskInputFingerprint({
          transcriptLines: transcript,
          title: meeting.title,
          meetingDate: date,
          template: pendingTemplate,
          carryForward: pending.carryForward,
          attachmentAuthorization: pending.attachmentAuthorization,
          manualNote: manualNote.snapshot(),
        })
        : '';
      const resumableFactsV3Task = getFeatureFlags().meetingSummarySourceStreamCandidate
        && pending.taskId.startsWith('vnext-summary:');
      if (
        !pendingTemplate
        || pending.mode !== expectedMode
        || (!resumableFactsV3Task && pending.inputFingerprint !== fingerprint)
      ) {
        await clearPendingMeetingSummaryTask(recordingStorageScope, meeting.id).catch(() => {});
        // A mismatched registry entry is stale, but do not overwrite a
        // canonical queued/generating stage unless the task was explicitly
        // confirmed terminal.  The next foreground pass can rediscover the
        // durable result or submit a correctly fingerprinted recovery task.
        return;
      }
      setSummaryTemplate(pendingTemplate);
      autoResumeTaskRef.current = pending.taskId;
      void runSummaryTask({
        automatic: true,
        resumeTask: pending,
        transcriptLines: transcript,
        template: pendingTemplate,
      });
    }).catch(() => {
      if (alive && isCurrentPageRequest(pendingRequest)) {
        setSummaryVisualPhase('error');
        setSummaryError('无法读取上次整理任务，点击重试可重新生成。');
        if (
          meetingScopeKey
          && (processingStatuses.summary === 'queued' || processingStatuses.summary === 'generating')
        ) {
          void recordMeetingSummaryProcessing({
            scopeKey: meetingScopeKey,
            legacyMeetingId: meeting.id,
            signal: { type: 'recovery_failed' },
          });
        }
      }
    });
    return () => { alive = false; };
  }, [isCurrentPageRequest, isGuest, loadingSummary, loadingTranscript, meeting?.createdAt, meeting?.date, meeting?.id, meeting?.title, meetingScopeKey, processingStatuses.summary, recordingStorageScope, transcript]);

  // Preparation is persisted before the optional attachment sheet opens so
  // list/detail status stays consistent from the first tap. If the process is
  // killed while that sheet is open, however, there is no accepted task ID or
  // local UI operation to resume. Leaving that bare queued stage in SQLite
  // permanently disables template and regenerate actions after the next
  // launch. Recover only the provably orphaned case: no mounted preparation,
  // no in-flight request, no durable task ID, and no pending-task registry
  // entry. A task that reached onTaskSubmitted keeps either jobId or the
  // registry entry and is never discarded here.
  useEffect(() => {
    if (
      !meeting
      || !meetingScopeKey
      || loadingSummary
      || summaryInFlightRef.current
      || summaryAttachmentRequest
      || summaryCarryForwardRequest
    ) return undefined;
    const stage = canonicalProcessingSnapshot?.stages.find(item => item.stage === 'summary');
    if (
      !stage
      || !summaryStageIsActive(processingStatuses.summary)
      || stage.jobId
    ) return undefined;
    const recoveryKey = `${meetingScopeKey}:${meeting.id}:${stage.updatedAtMs}`;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (orphanedSummaryPreparationRef.current === recoveryKey) return;
      orphanedSummaryPreparationRef.current = recoveryKey;
      void getPendingMeetingSummaryTask(recordingStorageScope, meeting.id)
        .then(async pending => {
          if (cancelled) return;
          if (pending) {
            orphanedSummaryPreparationRef.current = '';
            return;
          }
          const outcome = await recordMeetingSummaryProcessing({
            scopeKey: meetingScopeKey,
            legacyMeetingId: meeting.id,
            signal: { type: 'discarded' },
          });
          diagnosticAudit('meeting_summary_orphaned_preparation_recovery', {
            outcome,
            had_current_summary: Boolean(summaryDocument),
          });
          if (outcome === 'failed') orphanedSummaryPreparationRef.current = '';
        })
        .catch(reason => {
          orphanedSummaryPreparationRef.current = '';
          diagnosticWarn('[meeting-summary] orphaned preparation recovery deferred', reason);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    canonicalProcessingSnapshot,
    loadingSummary,
    meeting,
    meetingScopeKey,
    processingStatuses.summary,
    recordingStorageScope,
    summaryAttachmentRequest,
    summaryCarryForwardRequest,
    summaryDocument,
  ]);

  // If the recovery registry was lost but the canonical stage still carries a
  // task ID, resume that exact task from SQLite.  This is deliberately
  // separate from the registry-based path above: it never creates a second
  // generation request just because AsyncStorage was unavailable.
  useEffect(() => {
    if (
      !meeting
      || loadingTranscript
      || loadingSummary
      || summaryInFlightRef.current
      || transcript.length === 0
      || !meetingScopeKey
      || !summaryStageIsActive(processingStatuses.summary)
    ) return;
    const stage = canonicalProcessingSnapshot?.stages.find(item => item.stage === 'summary');
    if (!stage?.jobId || autoResumeTaskRef.current === stage.jobId) return;
    const template = summaryDocument?.templateId
      ? meetingTemplateById(summaryDocument.templateId, summaryDocument.templateRevision)
      : summaryTemplate;
    if (!template) return;
    autoResumeTaskRef.current = stage.jobId;
    void runSummaryTask({
      automatic: true,
      resumeTask: {
        meetingId: meeting.id,
        taskId: stage.jobId,
        mode: isGuest ? 'guest' : 'authenticated',
        templateId: template.id,
        templateRevision: template.revision,
        inputFingerprint: stage.inputFingerprint ?? summaryTaskInputFingerprint({
          transcriptLines: transcript,
          title: meeting.title,
          meetingDate: meetingDateForSummary(meeting.date, meeting.createdAt),
          template,
          carryForward: null,
          attachmentAuthorization: null,
          manualNote: manualNote.snapshot(),
        }),
        carryForward: null,
        attachmentAuthorization: null,
        createdAt: new Date(stage.updatedAtMs).toISOString(),
        updatedAt: new Date(stage.updatedAtMs).toISOString(),
      },
      transcriptLines: transcript,
      template,
    }).catch(() => {
      // The canonical stage remains authoritative; a later foreground pass
      // can retry without making the detail page lose its processing state.
    });
  }, [canonicalProcessingSnapshot, isGuest, loadingSummary, loadingTranscript, meeting, meetingScopeKey, processingStatuses.summary, summaryDocument?.templateId, summaryDocument?.templateRevision, summaryTemplate, transcript]);

  useEffect(() => {
    const target = explicitDetailTab(route.params.focus);
    if (!target) return;
    setTabGeneration(value => {
      const next = value + 1;
      tabOwnerRef.current.accept({ meetingId: route.params.meetingId, tab: target, generation: next });
      return next;
    });
    setActiveTab(target);
  }, [
    route.params.actionFocusRequestId,
    route.params.focus,
    route.params.meetingId,
    route.params.transcriptFocusRequestId,
  ]);

  const briefSummary = useMemo(
    () => briefGreetingSummaryText(transcript),
    [transcript],
  );
  const displayedSummary = summary || briefSummary || '';
  const fullDisplayedSummaryDocument = summary && summaryDocument?.meetingId === (meeting?.id ?? route.params.meetingId)
    ? summaryDocument
    : null;
  const displayedSummaryDocument = useMemo(() => (
    fullDisplayedSummaryDocument
      ? visibleMeetingSummaryDocument(fullDisplayedSummaryDocument, hiddenSummaryBlockKeys)
      : null
  ), [fullDisplayedSummaryDocument, hiddenSummaryBlockKeys]);
  const summaryBlockOptions = useMemo<readonly MeetingSummaryBlockOption[]>(() => (
    fullDisplayedSummaryDocument?.sections.map(section => ({
      stableKey: section.stableKey,
      title: section.title?.trim() || '整理内容',
      visible: isFixedMeetingSummarySection(section) || !hiddenSummaryBlockKeys.includes(section.stableKey),
      fixed: isFixedMeetingSummarySection(section),
    })) ?? []
  ), [fullDisplayedSummaryDocument, hiddenSummaryBlockKeys]);
  const summaryEvidenceSection = useMemo(() => (
    summaryEvidenceSectionId
      ? fullDisplayedSummaryDocument?.sections.find(section => section.id === summaryEvidenceSectionId) ?? null
      : null
  ), [fullDisplayedSummaryDocument, summaryEvidenceSectionId]);
  const sourceActionCandidates = useMemo(
    () => {
      const projected = displayedSummaryDocument?.actionItemCandidates ?? [];
      if (!meetingActionsLoaded) return projected;
      return meetingActions.map(action => {
        const metadata = projected.find(candidate => (
          candidate.id === action.id
          || candidate.id === action.canonicalId
          || candidate.canonicalId === action.id
          || candidate.content.trim() === action.content.trim()
        ));
        return metadata ? {
          ...action,
          dueText: action.dueText ?? metadata.dueText ?? null,
          scheduleFit: action.scheduleFit ?? metadata.scheduleFit,
          evidenceScore: action.evidenceScore ?? metadata.evidenceScore,
        } : action;
      });
    },
    [displayedSummaryDocument, meetingActions, meetingActionsLoaded],
  );
  const conflictedActionIds = useMemo(
    () => new Set(meetingActionConflicts.map(conflict => conflict.actionId)),
    [meetingActionConflicts],
  );
  const displayedActionCandidates = useMemo(
    () => dedupeMeetingSummaryActions(sourceActionCandidates).filter(action => {
      const actionId = action.canonicalId ?? action.id;
      return action.status !== 'dismissed' || conflictedActionIds.has(actionId);
    }),
    [conflictedActionIds, sourceActionCandidates],
  );
  const summaryActionCandidates = useMemo(
    () => displayedActionCandidates.filter(action => (
      action.sourceKind === undefined || action.sourceKind === 'generated'
    )),
    [displayedActionCandidates],
  );

  const toggleSummaryBlock = useCallback((stableKey: string) => {
    const requestedMeetingId = meeting?.id;
    const option = summaryBlockOptions.find(item => item.stableKey === stableKey);
    if (!requestedMeetingId || !option || option.fixed) return;
    setHiddenSummaryBlockKeys(current => {
      const next = current.includes(stableKey)
        ? current.filter(key => key !== stableKey)
        : [...current, stableKey];
      void saveMeetingSummaryHiddenBlocks(requestedMeetingId, next).catch(reason => {
        diagnosticWarn('[meeting-summary-layout] preference save failed', reason);
        ToastAndroid.show('板块显示偏好暂时无法保存。', ToastAndroid.SHORT);
      });
      return next;
    });
  }, [meeting?.id, summaryBlockOptions]);

  const resetSummaryBlocks = useCallback(() => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId) return;
    setHiddenSummaryBlockKeys([]);
    void resetMeetingSummaryHiddenBlocks(requestedMeetingId).catch(reason => {
      diagnosticWarn('[meeting-summary-layout] preference reset failed', reason);
      ToastAndroid.show('暂时无法恢复自动板块。', ToastAndroid.SHORT);
    });
  }, [meeting?.id]);

  const openSummaryEvidenceCitation = useCallback((citation: MeetingSummaryCitation) => {
    setSummaryEvidenceSectionId(null);
    if (citation.sourceType && citation.sourceType !== 'transcript') return;
    const requestId = Date.now();
    setTabGeneration(value => {
      const next = value + 1;
      tabOwnerRef.current.accept({ meetingId: route.params.meetingId, tab: 'transcript', generation: next });
      return next;
    });
    setActiveTab('transcript');
    navigation.setParams({
      focus: 'transcript',
      segmentId: citation.segmentId,
      positionMs: citation.startMs,
      transcriptFocusRequestId: requestId,
    });
  }, [navigation, route.params.meetingId]);

  const refreshMeetingActionsSheet = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      setMeetingActionsSheetError('当前会议尚未完成本机保存。');
      return null;
    }
    setMeetingActionsSheetLoading(true);
    setMeetingActionsSheetError('');
    try {
      const state = await refreshMeetingActions();
      if (
        !state
        && mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
      ) setMeetingActionsSheetError('本场待办暂时无法加载，请稍后重试。');
      return state;
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setMeetingActionsSheetLoading(false);
      }
    }
  }, [meeting?.id, meetingScopeKey, refreshMeetingActions]);

  const openMeetingActions = useCallback((focusActionId: string | null = null) => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      showDialog({
        title: '暂时无法打开',
        message: '当前会议尚未完成本机保存，请稍后重试。',
        tone: 'warning',
      });
      return;
    }
    const delay = moreVisible ? 320 : 0;
    setMoreVisible(false);
    setMeetingActionsFocusId(focusActionId);
    setTimeout(() => {
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      setMeetingActionsVisible(true);
      void refreshMeetingActionsSheet();
    }, delay);
  }, [meeting?.id, meetingScopeKey, moreVisible, refreshMeetingActionsSheet, showDialog]);

  const openMeetingActionSource = useCallback((actionId: string) => {
    const candidate = meetingAction(displayedActionCandidates, actionId);
    const citation = candidate?.citations.find(item => (
      item.sourceType === undefined || item.sourceType === 'transcript'
    ));
    const positionMs = citation?.startMs ?? candidate?.sourceStartMs;
    const segmentId = citation?.segmentId ?? candidate?.sourceSegmentId;
    if (
      !candidate
      || positionMs === null
      || positionMs === undefined
      || !Number.isFinite(positionMs)
    ) {
      ToastAndroid.show('这条待办没有可定位的文字来源。', ToastAndroid.SHORT);
      return;
    }
    const requestedMeetingId = meeting?.id;
    setMeetingActionsVisible(false);
    setTimeout(() => {
      if (!mountedRef.current || !requestedMeetingId || routeMeetingIdRef.current !== requestedMeetingId) return;
      navigation.setParams({
        focus: 'transcript',
        actionId: undefined,
        actionFocusRequestId: undefined,
        segmentId: segmentId ?? undefined,
        positionMs,
        transcriptFocusRequestId: Date.now(),
      });
    }, 320);
  }, [displayedActionCandidates, meeting?.id, navigation]);

  const shareAvailability = useMemo<MeetingShareAvailability>(() => ({
    info: Boolean(meeting),
    summary: displayedSummaryDocument
      ? displayedSummaryDocument.sections.some(section => (
        section.kind !== 'action_items'
        && section.stableKey !== 'action_items'
        && section.kind !== 'decisions'
        && !['decisions', 'commitments'].includes(section.stableKey)
        && Boolean(section.title?.trim() || section.content.trim())
      ))
      : Boolean(displayedSummary.trim()),
    actions: displayedActionCandidates.some(action => Boolean(action.content.trim())),
    transcript: transcript.some(line => Boolean(line.text.trim())),
    markers: markers.length > 0,
    attachments: meetingAttachments.length > 0,
    audio: Boolean(meeting?.audioAvailable || meeting?.audioLocalUri || playerSource),
    manualNote: Boolean(manualNote.content.trim()),
  }), [displayedActionCandidates, displayedSummary, displayedSummaryDocument, manualNote.content, markers.length, meeting, meetingAttachments.length, playerSource, transcript]);

  const runShare = useCallback(async (selection: MeetingShareSelection) => {
    if (!meeting || sharing) return;
    setSharing(true);
    try {
      await shareMeetingContent(selection, {
        meeting,
        transcriptLines: transcript,
        summaryText: displayedSummary || meetingSummaryToText(getCachedSummary(meeting.id)),
        summaryDocument: displayedSummaryDocument,
        summaryFactsV3: activeMeetingFactsV3?.result ?? null,
        summaryTemplate,
        actionItems: displayedActionCandidates,
        manualNoteText: manualNote.content,
        markers,
        attachments: meetingAttachments,
        summaryVersionId: displayedSummaryDocument?.remoteVersionId,
        isGuest,
        accessToken,
        audioInfo: playerSource ? {
          url: playerSource.uri,
          duration_sec: playerSource.durationMsHint
            ? playerSource.durationMsHint / 1000
            : null,
          file_name: playerSource.uri.split('/').pop() ?? 'meeting.wav',
          requires_auth: false,
        } : null,
      });
    } catch (reason) {
      showDialog({ title: '分享失败', message: meetingShareErrorMessage(reason), tone: 'error' });
    } finally {
      if (mountedRef.current) setSharing(false);
    }
  }, [accessToken, activeMeetingFactsV3, displayedActionCandidates, displayedSummary, displayedSummaryDocument, getCachedSummary, isGuest, manualNote.content, markers, meeting, meetingAttachments, playerSource, sharing, showDialog, summaryTemplate, transcript]);

  const requestShare = useCallback((selection: MeetingShareSelection) => {
    if (!selection.manualNote) {
      void runShare(selection);
      return;
    }
    showDialog({
      title: '包含我的笔记？',
      message: '我的笔记会原样写入分享文件。',
      tone: 'warning',
      actions: [
        { text: '继续分享', role: 'primary', onPress: () => { void runShare(selection); } },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [runShare, showDialog]);

  const refreshContentShares = useCallback(async (showLoading = true) => {
    if (!meeting || !meetingScopeKey) return;
    const requestedMeetingId = meeting.id;
    const requestGeneration = ++contentShareRequestGenerationRef.current;
    if (showLoading) setContentSharesLoading(true);
    setContentShareError('');
    try {
      const result = await loadMeetingContentShares({
        scopeKey: meetingScopeKey,
        meetingId: requestedMeetingId,
        accessToken,
      });
      if (
        !mountedRef.current
        || routeMeetingIdRef.current !== requestedMeetingId
        || contentShareRequestGenerationRef.current !== requestGeneration
      ) return;
      setContentShares(result.shares);
      setContentShareError(result.remoteError);
    } catch (reason) {
      if (
        mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
        && contentShareRequestGenerationRef.current === requestGeneration
      ) {
        setContentShareError(readableErrorMessage(reason, '共享链接暂时无法读取，请稍后重试。'));
      }
    } finally {
      if (
        mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
        && contentShareRequestGenerationRef.current === requestGeneration
      ) setContentSharesLoading(false);
    }
  }, [accessToken, meeting, meetingScopeKey]);

  const openContentShareManager = useCallback(() => {
    if (!meetingContentShareLinksEnabled || !meeting || !meetingScopeKey || !accessToken) return;
    setContentShareManagerVisible(true);
    setContentShareError('');
    void refreshContentShares(true);
  }, [accessToken, meeting, meetingContentShareLinksEnabled, meetingScopeKey, refreshContentShares]);

  const sendContentShare = useCallback(async (share: MeetingContentShare) => {
    if (!share.inviteUrl) return;
    try {
      await Share.share({ title: '共享会议资料', message: share.inviteUrl });
    } catch (reason) {
      if (mountedRef.current) {
        setContentShareError(readableErrorMessage(reason, '共享面板暂时无法打开，请稍后重试。'));
      }
    }
  }, []);

  const runCreateContentShare = useCallback(async (
    selection: MeetingShareSelection,
    followLatestSummary: boolean,
  ) => {
    if (!meeting || !meetingScopeKey || !accessToken || contentShareBusyId) return;
    setContentShareBusyId('creating');
    setContentShareError('');
    try {
      const snapshot = buildMeetingContentShareSnapshot(selection, {
        meeting,
        transcriptLines: transcript,
        summaryText: displayedSummary || meetingSummaryToText(getCachedSummary(meeting.id)),
        summaryDocument: displayedSummaryDocument,
        summaryFactsV3: activeMeetingFactsV3?.result ?? null,
        summaryTemplate,
        actionItems: displayedActionCandidates,
        manualNoteText: manualNote.content,
        markers,
        attachments: meetingAttachments,
        summaryVersionId: displayedSummaryDocument?.remoteVersionId,
        isGuest,
        accessToken,
      });
      const created = await createMeetingContentShare({
        scopeKey: meetingScopeKey,
        meetingId: meeting.id,
        snapshot,
        followLatestSummary,
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== meeting.id) return;
      setContentShares(current => [created, ...current.filter(item => item.id !== created.id)]);
      await sendContentShare(created);
    } catch (reason) {
      if (mountedRef.current) {
        setContentShareManagerVisible(true);
        setContentShareError(readableErrorMessage(reason, '共享链接暂时无法创建，请稍后重试。'));
        await refreshContentShares(false).catch(() => undefined);
      }
    } finally {
      if (mountedRef.current) setContentShareBusyId(null);
    }
  }, [accessToken, activeMeetingFactsV3, contentShareBusyId, displayedActionCandidates, displayedSummary, displayedSummaryDocument, getCachedSummary, isGuest, manualNote.content, markers, meeting, meetingAttachments, meetingScopeKey, refreshContentShares, sendContentShare, summaryTemplate, transcript]);

  const requestContentShare = useCallback((
    selection: MeetingShareSelection,
    followLatestSummary: boolean,
  ) => {
    if (!selection.manualNote) {
      void runCreateContentShare(selection, followLatestSummary);
      return;
    }
    showDialog({
      title: '包含我的笔记？',
      message: '我的笔记会原样显示在共享链接中。',
      tone: 'warning',
      actions: [
        {
          text: '继续创建',
          role: 'primary',
          onPress: () => { void runCreateContentShare(selection, followLatestSummary); },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [runCreateContentShare, showDialog]);

  const retryContentShare = useCallback(async (share: MeetingContentShare) => {
    if (!meeting || !meetingScopeKey || !accessToken || contentShareBusyId) return;
    setContentShareBusyId(share.id);
    setContentShareError('');
    try {
      const updated = await retryMeetingContentShare({
        scopeKey: meetingScopeKey,
        meetingId: meeting.id,
        share,
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== meeting.id) return;
      setContentShares(current => current.map(item => item.id === updated.id ? updated : item));
      if (updated.status === 'active') await sendContentShare(updated);
    } catch (reason) {
      if (mountedRef.current) {
        setContentShareError(readableErrorMessage(reason, meetingContentShareErrorMessage(share)));
        await refreshContentShares(false).catch(() => undefined);
      }
    } finally {
      if (mountedRef.current) setContentShareBusyId(null);
    }
  }, [accessToken, contentShareBusyId, meeting, meetingScopeKey, refreshContentShares, sendContentShare]);

  const confirmRevokeContentShare = useCallback((share: MeetingContentShare) => {
    if (!meeting || !meetingScopeKey || !accessToken || contentShareBusyId) return;
    setContentShareManagerVisible(false);
    setTimeout(() => {
      if (!mountedRef.current) return;
      showDialog({
        title: '撤销共享链接',
        message: '撤销后，收到链接的人将无法再打开这些会议资料。',
        tone: 'warning',
        actions: [
          {
            text: '取消',
            role: 'cancel',
            onPress: () => { if (mountedRef.current) setContentShareManagerVisible(true); },
          },
          {
            text: '撤销',
            role: 'destructive',
            onPress: () => {
              setContentShareBusyId(share.id);
              setContentShareError('');
              void revokeMeetingContentShare({
                scopeKey: meetingScopeKey,
                meetingId: meeting.id,
                share,
                accessToken,
              }).then(updated => {
                if (!mountedRef.current) return;
                setContentShares(current => current.map(item => item.id === updated.id ? updated : item));
                ToastAndroid.show('共享链接已撤销', ToastAndroid.SHORT);
              }).catch(reason => {
                if (mountedRef.current) {
                  setContentShareError(readableErrorMessage(reason, '共享链接暂时无法撤销，请稍后重试。'));
                  void refreshContentShares(false);
                }
              }).finally(() => {
                if (mountedRef.current) {
                  setContentShareBusyId(null);
                  setContentShareManagerVisible(true);
                }
              });
            },
          },
        ],
      });
    }, 320);
  }, [accessToken, contentShareBusyId, meeting, meetingScopeKey, refreshContentShares, showDialog]);

  const confirmDelete = useCallback(async () => {
    if (!meeting) return;
    let presentation;
    try {
      presentation = await resolveMeetingDeletionPresentation(meeting, refreshRecycleCapability);
    } catch (reason) {
      showDialog({
        title: '无法确认删除方式',
        message: readableErrorMessage(reason, '暂时无法确认此会议是否可以恢复，请稍后重试。'),
        tone: 'error',
      });
      return;
    }
    if (presentation.blocked) {
      showDialog({
        title: presentation.title,
        message: presentation.message,
        tone: 'warning',
      });
      return;
    }
    const performDelete = async (recoverable: boolean, retentionDays: number | null) => {
      try {
        await manualNote.flush();
        setDeletingMeeting(true);
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        await deleteMeeting(meeting.id, {
          recoverable,
          expectedRetentionDays: retentionDays,
        });
        openMeetingsTab(navigation);
      } catch (reason) {
        if (reason instanceof MeetingDeletionCleanupError) {
          openMeetingsTab(navigation);
          showDialog({
            title: '会议已删除，清理未完成',
            message: readableErrorMessage(reason, '会议已删除，但本机清理尚未完成。'),
            tone: 'warning',
          });
        } else {
          if (mountedRef.current) setDeletingMeeting(false);
          showDialog({
            title: '删除失败',
            message: readableErrorMessage(reason, '请检查网络后重试。'),
            tone: 'error',
          });
        }
      }
    };
    const canRecycle = presentation.recoverable && presentation.retentionDays !== null;
    showDialog({
      title: canRecycle ? '删除会议记录？' : presentation.title,
      message: canRecycle
        ? `删除后会移到回收站，可在${presentation.retentionDays}天内恢复。`
        : !presentation.recoverable && mediaClips.length > 0
          ? `${presentation.message}\n\n其中包含 ${mediaClips.length} 个音频片段，片段也会一并删除。`
          : presentation.message,
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: () => performDelete(canRecycle, canRecycle ? presentation.retentionDays : null),
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [deleteMeeting, manualNote.flush, mediaClips.length, meeting, navigation, refreshRecycleCapability, showDialog]);

  const openSpeakerAssignment = useCallback((action: EditTranscriptSpeakerAction) => {
    if (!meeting || action.meetingId !== meeting.id) return;
    if (action.revisionKind === 'realtimeDraft') {
      ToastAndroid.show('文字记录还在生成，完成后才能修改讲话人。', ToastAndroid.LONG);
      return;
    }
    const exact = transcript.filter(line => line.id === action.lineId);
    const positioned = exact.length === 0
      ? transcript.filter(line => (
        Math.round((line.start_time ?? 0) * 1_000) === action.positionMs
        && (!action.speakerId || line.speaker_id === action.speakerId)
      ))
      : [];
    const line = exact.length === 1 ? exact[0] : positioned.length === 1 ? positioned[0] : null;
    if (line?.revisionKind === 'realtimeDraft' || line?.isFinal === false) {
      ToastAndroid.show('文字记录还在生成，完成后才能修改讲话人。', ToastAndroid.LONG);
      return;
    }
    const clusterId = action.speakerClusterId?.trim()
      || (line ? transcriptSpeakerClusterId(line) : '')
      || action.speakerId.trim();
    const clusterCount = clusterId
      ? transcript.filter(candidate => transcriptSpeakerClusterId(candidate) === clusterId).length
      : 1;
    setSpeakerAssignmentError('');
    setSpeakerAssignmentTarget({
      ...action,
      speakerClusterId: clusterId || undefined,
      speakerLabel: line?.speaker_label?.trim() || action.speakerLabel || '讲话人',
      clusterCount: Math.max(1, clusterCount),
    });
  }, [meeting, transcript]);

  useEffect(() => {
    const generation = ++speakerProfileRequestGenerationRef.current;
    if (!speakerAssignmentTarget) {
      setSpeakerProfiles([]);
      setSpeakerProfilesLoading(false);
      setSpeakerProfilesError('');
      return;
    }
    setSpeakerProfiles([]);
    setSpeakerProfilesLoading(true);
    setSpeakerProfilesError('');
    const loadProfiles = isGuest || !accessToken
      ? fetchDeviceSpeakerProfiles()
      : fetchSpeakers(accessToken);
    void loadProfiles.then(profiles => {
      if (speakerProfileRequestGenerationRef.current !== generation) return;
      setSpeakerProfiles(profiles.filter(profile => profile.available_in_realtime !== false));
    }).catch(reason => {
      if (speakerProfileRequestGenerationRef.current !== generation) return;
      diagnosticWarn('load speaker profiles for assignment failed', reason);
      setSpeakerProfiles([]);
      setSpeakerProfilesError('讲话人资料暂时无法加载');
    }).finally(() => {
      if (speakerProfileRequestGenerationRef.current === generation) {
        setSpeakerProfilesLoading(false);
      }
    });
    return () => { speakerProfileRequestGenerationRef.current += 1; };
  }, [accessToken, isGuest, speakerAssignmentTarget?.lineId]);

  const manageSpeaker = useCallback((speakerId?: string) => {
    // The device-primary product has no account gate.  SpeakerManager and
    // SpeakerEnrollment already select the device/epoch service when there is
    // no token; keeping the old login dialog here made the feature appear
    // unavailable even though its accountless implementation was complete.
    if (isGuest || !accessToken) {
      if (speakerId && speakerId !== 'unknown') {
        navigation.navigate('SpeakerEnrollment', { speakerId });
      } else {
        navigation.navigate('SpeakerManager');
      }
      return;
    }
    if (speakerId && speakerId !== 'unknown') {
      navigation.navigate('SpeakerEnrollment', { speakerId });
    } else {
      navigation.navigate('SpeakerManager');
    }
  }, [accessToken, isGuest, navigation, showDialog]);

  const refreshCanonicalSummary = useCallback(async (meetingId: string) => {
    if (!meetingScopeKey) return null;
    const current = await loadCurrentMeetingSummaryState(meetingScopeKey, meetingId);
    if (!current) return null;
    const v3 = await loadProjectedMeetingFactsV3(current).catch(reason => {
      diagnosticWarn('[meeting-summary-v3] refresh projection failed', reason);
      return null;
    });
    const document = v3?.document ?? current.document;
    setSummaryDocument(document);
    setActiveMeetingFactsV3(v3?.active ?? null);
    if (v3) setSummaryTemplate(v3.template);
    setMeetingActions(document.actionItemCandidates);
    setMeetingActionsLoaded(true);
    setSummary(meetingSummaryDocumentToText(document));
    setSummaryCached(true);
    setSummaryError('');
    return document;
  }, [loadProjectedMeetingFactsV3, meetingScopeKey]);

  const openSummarySectionEditor = useCallback((sectionId: string) => {
    const document = displayedSummaryDocument;
    const v3 = activeMeetingFactsV3;
    const versionId = v3?.summaryVersionId ?? document?.remoteVersionId?.trim();
    const section = document?.sections.find(item => item.id === sectionId);
    if (!document || !versionId || !section || loadingSummary) {
      showDialog({
        title: '暂时无法编辑',
        message: '整理内容尚未准备好，请稍后重试。',
        tone: 'warning',
      });
      return;
    }
    setSummarySectionEditorError('');
    setSummarySectionEditorTarget({
      id: section.id,
      versionId,
      stableKey: section.stableKey,
      v3TemplateId: v3 ? summaryTemplate.id : undefined,
      title: section.title,
      content: section.content,
      userEdited: section.userEdited === true,
      citationsLocked: Boolean(v3),
      citations: section.citations.map(citation => ({
        id: citation.id,
        startMs: citation.startMs,
      })),
    });
  }, [activeMeetingFactsV3, displayedSummaryDocument, loadingSummary, showDialog, summaryTemplate.id]);

  const saveSummarySectionEdit = useCallback(async (value: MeetingSummarySectionEditorSaveValue | null) => {
    const target = summarySectionEditorTarget;
    if (!meeting || !meetingScopeKey || !target || summarySectionEditorSaving) return;
    const requestedMeetingId = meeting.id;
    setSummarySectionEditorSaving(true);
    setSummarySectionEditorError('');
    try {
      if (target.v3TemplateId && activeMeetingFactsV3) {
        if (value) {
          await saveSummaryViewOverride({
            versionId: target.versionId,
            templateId: target.v3TemplateId,
            stableBlockKey: target.stableKey,
            replacementKind: value.content.includes('\n') ? 'bullet_group' : 'paragraph',
            replacementText: value.content,
            userEditedAtMs: Date.now(),
          });
        } else {
          await deleteSummaryViewOverride(
            target.versionId,
            target.v3TemplateId,
            target.stableKey,
          );
        }
        const template = meetingTemplateById(target.v3TemplateId, 3) ?? DEFAULT_MEETING_TEMPLATE;
        const overrides = await loadSummaryViewOverrides(target.versionId, template.id);
        const projected = applyMeetingSummaryV3Overrides(
          projectMeetingFactsV3(
            activeMeetingFactsV3.result,
            template,
            summaryDocument?.manualNoteRevision ?? manualNote.revision,
            transcript,
          ),
          overrides,
        );
        const visibleDocument: MeetingSummaryDocument = {
          ...projected,
          meetingId: meeting.id,
          remoteVersionId: summaryDocument?.remoteVersionId ?? activeMeetingFactsV3.result.documentId,
          transcriptRevisionId: summaryDocument?.transcriptRevisionId ?? null,
          remoteTranscriptRevisionId: projected.remoteTranscriptRevisionId ?? activeMeetingFactsV3.result.transcriptRevision,
          manualNoteRevision: summaryDocument?.manualNoteRevision ?? manualNote.revision,
          status: summaryDocument?.status ?? 'ready',
          supersedesVersionId: summaryDocument?.supersedesVersionId ?? null,
        };
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        setSummaryDocument(visibleDocument);
        setSummary(meetingSummaryDocumentToText(visibleDocument));
        advancePageGenerations('summary');
        setSummarySectionEditorTarget(null);
        ToastAndroid.show(value ? '整理内容已保存' : '已恢复生成内容', ToastAndroid.SHORT);
        return;
      }
      const current = await loadCurrentMeetingSummaryState(meetingScopeKey, requestedMeetingId);
      if (!current) throw new MeetingSummarySectionUnavailableError();
      const result = await editMeetingSummarySectionUseCase.execute({
        meetingId: current.canonicalMeetingId,
        versionId: target.versionId,
        sectionId: target.id,
        content: value?.content ?? null,
        visibleCitationIds: value?.visibleCitationIds ?? null,
        expectedContent: target.content,
        expectedVisibleCitationIds: target.citations.map(citation => citation.id),
        expectedUserEdited: target.userEdited,
        scopeKey: meetingScopeKey,
        canonicalWrite: true,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      const refreshed = await refreshCanonicalSummary(requestedMeetingId);
      if (!refreshed) throw new MeetingSummarySectionUnavailableError();
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      await refreshSummarySyncConflicts();
      advancePageGenerations('summary');
      setSummarySectionEditorTarget(null);
      ToastAndroid.show(
        result.restored ? '已恢复生成内容' : '整理内容已保存',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      diagnosticAudit('meeting_summary_section_edit', {
        status: 'failed',
        reason: reason instanceof Error
          ? reason.message.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || reason.name
          : 'unknown',
      });
      if (
        reason instanceof MeetingSummarySectionConflictError
        || reason instanceof MeetingSummarySectionUnavailableError
      ) {
        setSummarySectionEditorError('整理内容已发生变化，请关闭后重新打开。');
      } else if (reason instanceof MeetingSummarySectionContentError) {
        setSummarySectionEditorError('整理内容不能为空，且不能超过 20000 个字符。');
      } else {
        diagnosticWarn('save meeting summary section edit failed', reason);
        setSummarySectionEditorError('整理内容暂时无法保存，请稍后重试。');
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setSummarySectionEditorSaving(false);
      }
    }
  }, [activeMeetingFactsV3, advancePageGenerations, manualNote.revision, meeting, meetingScopeKey, refreshCanonicalSummary, refreshSummarySyncConflicts, summaryDocument, summarySectionEditorSaving, summarySectionEditorTarget, transcript]);

  const saveSpeakerAssignment = useCallback(async (value: MeetingSpeakerAssignmentValue) => {
    const target = speakerAssignmentTarget;
    if (!meeting || !meetingScopeKey || !target || speakerAssignmentSaving) return;
    if (target.meetingId !== meeting.id) return;
    const requestedMeetingId = meeting.id;
    setSpeakerAssignmentSaving(true);
    setSpeakerAssignmentError('');
    try {
      const result = await updateMeetingSpeakerAssignmentUseCase.execute({
        nativeMeetingId: requestedMeetingId,
        scopeKey: meetingScopeKey,
        lineId: target.lineId,
        positionMs: target.positionMs,
        speakerId: target.speakerClusterId ?? target.speakerId,
        scope: value.speakerProfileId
          ? 'future_profile'
          : value.applyToCluster ? 'cluster' : 'segment',
        displayName: value.displayName,
        speakerProfileId: value.speakerProfileId,
        consentToProfileUpdate: value.consentToProfileUpdate,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      const refreshed = await loadActiveMeetingTranscriptState(
        meetingScopeKey,
        requestedMeetingId,
      ).catch(reason => {
        diagnosticWarn('reload transcript after speaker assignment failed', reason);
        return null;
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      if (refreshed) {
        const refreshedLines = simplifyTranscriptLines(refreshed.lines);
        setTranscript(refreshedLines);
        setTranscriptCached(refreshedLines.length > 0);
        setTranscriptCompleting(refreshed.completing);
      } else {
        setReloadKey(current => current + 1);
      }
      advancePageGenerations('transcript', 'speakers', 'summary');
      await refreshCanonicalSummary(requestedMeetingId).catch(reason => {
        diagnosticWarn('reload summary after speaker assignment failed', reason);
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      setSpeakerAssignmentTarget(null);
      ToastAndroid.show(
        result.applied
          ? value.speakerProfileId
            ? '已关联讲话人资料'
            : value.applyToCluster
            ? `已更新本场 ${result.affectedSegmentIds.length} 处讲话人`
            : '讲话人已更新'
          : '讲话人名称未变化',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      if (reason instanceof SpeakerAssignmentDraftError) {
        setSpeakerAssignmentTarget(null);
        ToastAndroid.show('文字记录还在生成，完成后才能修改讲话人。', ToastAndroid.LONG);
      } else if (reason instanceof SpeakerAssignmentTargetUnavailableError) {
        setSpeakerAssignmentError('这段文字记录已发生变化，请刷新后重试。');
      } else if (reason instanceof Error && reason.message === 'speaker display name is invalid') {
        setSpeakerAssignmentError('请输入 1 至 120 个字符的人名。');
      } else {
        diagnosticWarn('update meeting speaker assignment failed', reason);
        setSpeakerAssignmentError('讲话人暂时无法更新，请稍后重试。');
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setSpeakerAssignmentSaving(false);
      }
    }
  }, [advancePageGenerations, meeting, meetingScopeKey, refreshCanonicalSummary, speakerAssignmentSaving, speakerAssignmentTarget]);

  useEffect(() => {
    if (!route.params.actionFocusRequestId || !meeting) return;
    if (handledActionFocusRequestRef.current === route.params.actionFocusRequestId) return;
    handledActionFocusRequestRef.current = route.params.actionFocusRequestId;
    if (route.params.actionId) {
      openMeetingActions(route.params.actionId);
      return;
    }
    void refreshCanonicalSummary(meeting.id).then(current => {
      if (current) advancePageGenerations('summary');
    }).catch(() => null);
  }, [advancePageGenerations, meeting?.id, openMeetingActions, refreshCanonicalSummary, route.params.actionFocusRequestId, route.params.actionId]);

  const openMeetingActionFollowup = useCallback(async (actionId: string) => {
    if (!meeting || !meetingScopeKey || openingFollowupRef.current) return;
    const candidate = meetingAction(displayedActionCandidates, actionId);
    if (!candidate) {
      showDialog({ title: '无法打开', message: '这条待办事项已发生变化，请刷新后重试。', tone: 'error' });
      return;
    }
    if (candidate.followupEventSourceId) {
      const target = [...searchableEvents, ...events].find(event => (
        calendarSourceEventId(event) === candidate.followupEventSourceId
        && !event.isExpandedOccurrence
      )) ?? [...searchableEvents, ...events].find(event => (
        calendarSourceEventId(event) === candidate.followupEventSourceId
      ));
      if (!target) {
        showDialog({
          title: '后续日程暂不可用',
          message: '该日程可能已删除或尚未同步，请稍后重试。',
          tone: 'warning',
        });
        return;
      }
      navigation.navigate('EventDetail', { eventRef: eventRefForEvent(target) });
      return;
    }

    openingFollowupRef.current = true;
    try {
      const canonical = await loadMeetingActions(meetingScopeKey, meeting.id);
      const canonicalAction = meetingAction(canonical.actions, actionId);
      if (!canonicalAction?.canonicalId) {
        throw new Error('meeting action canonical projection is unavailable');
      }
      navigation.navigate('AddEvent', {
        draft: meetingActionFollowupDraft(canonicalAction),
        followup: {
          meetingId: meeting.id,
          canonicalMeetingId: canonical.canonicalMeetingId,
          actionId: canonicalAction.canonicalId,
          clientRequestId: meetingActionFollowupClientRequestId(canonicalAction.canonicalId),
        },
      });
    } catch {
      showDialog({
        title: '暂时无法创建后续日程',
        message: '这条待办事项尚未完成本机保存，请稍后重试。',
        tone: 'error',
      });
    } finally {
      openingFollowupRef.current = false;
    }
  }, [displayedActionCandidates, events, meeting, meetingScopeKey, navigation, searchableEvents, showDialog]);

  const openMeetingActionFollowupFromList = useCallback((actionId: string) => {
    const requestedMeetingId = meeting?.id;
    setMeetingActionsVisible(false);
    navigation.setParams({ actionId: undefined, actionFocusRequestId: undefined });
    setTimeout(() => {
      if (!mountedRef.current || !requestedMeetingId || routeMeetingIdRef.current !== requestedMeetingId) return;
      void openMeetingActionFollowup(actionId);
    }, 320);
  }, [meeting?.id, navigation, openMeetingActionFollowup]);

  const selectSummaryVersion = useCallback(async (versionId: string) => {
    if (!meeting || !meetingScopeKey || !summaryVersionsState || switchingSummaryVersionId) return;
    if (versionId === summaryVersionsState.currentVersionId) return;
    setSwitchingSummaryVersionId(versionId);
    setSummaryVersionsError('');
    try {
      await selectMeetingSummaryVersionUseCase.execute({
        meetingId: summaryVersionsState.canonicalMeetingId,
        versionId,
        expectedCurrentVersionId: summaryVersionsState.currentVersionId,
        scopeKey: meetingScopeKey,
      });
      const current = await refreshCanonicalSummary(meeting.id);
      if (!current) throw new MeetingSummaryVersionUnavailableError();
      setSummaryVersionsState(previous => previous ? { ...previous, currentVersionId: versionId } : previous);
      await refreshSummarySyncConflicts();
      advancePageGenerations('summary');
      setSummaryVersionsVisible(false);
    } catch (reason) {
      setSummaryVersionsError(reason instanceof MeetingSummaryVersionConflictError
        ? '整理结果版本已发生变化，请重新加载后再选择。'
        : '整理结果版本暂时无法切换，请稍后重试。');
    } finally {
      if (mountedRef.current) setSwitchingSummaryVersionId(null);
    }
  }, [advancePageGenerations, meeting, meetingScopeKey, refreshCanonicalSummary, refreshSummarySyncConflicts, summaryVersionsState, switchingSummaryVersionId]);

  const toggleMeetingAction = useCallback(async (
    actionId: string,
    completed: boolean,
  ) => {
    if (!meeting || !meetingScopeKey || updatingActionId) return;
    const candidate = meetingAction(displayedActionCandidates, actionId);
    if (!candidate?.updatedAtMs) {
      showDialog({ title: '更新失败', message: '这条待办事项尚未完成本机保存，请稍后重试。', tone: 'error' });
      return;
    }
    setUpdatingActionId(actionId);
    try {
      const canonical = await loadMeetingActions(meetingScopeKey, meeting.id);
      await updateMeetingActionUseCase.execute({
        meetingId: canonical.canonicalMeetingId,
        actionId,
        scopeKey: meetingScopeKey,
        expectedUpdatedAtMs: candidate.updatedAtMs,
        status: completed ? 'completed' : 'pending',
      });
      if (completed && candidate.reminderNotificationId) {
        await cancelMeetingActionNotification(candidate.reminderNotificationId).catch(reason => {
          diagnosticWarn('cancel completed meeting action notification failed', reason);
        });
      }
      if (completed) {
        await reconcileMeetingActionNotifications(meetingScopeKey).catch(reason => {
          diagnosticWarn('reconcile meeting action notifications after completion failed', reason);
        });
      }
      const current = await refreshMeetingActions();
      await refreshCanonicalSummary(meeting.id).catch(() => null);
      if (!current) {
        showDialog({
          title: '已更新',
          message: '待办状态已保存，但页面内容暂未刷新，请重新打开会议查看。',
          tone: 'warning',
        });
      }
    } catch (reason) {
      diagnosticAudit('meeting_action_update_failed', {
        operation: 'toggle',
        error_code: meetingActionFailureCode(reason),
      });
      showDialog({
        title: '更新失败',
        message: reason instanceof MeetingActionRevisionConflictError
          ? '这条待办事项已在其他操作中更新，请重试。'
          : '待办事项暂时无法更新，请稍后重试。',
        tone: 'error',
      });
      await refreshMeetingActions().catch(() => null);
      await refreshCanonicalSummary(meeting.id).catch(() => null);
    } finally {
      if (mountedRef.current) setUpdatingActionId(null);
    }
  }, [displayedActionCandidates, meeting, meetingScopeKey, refreshCanonicalSummary, refreshMeetingActions, showDialog, updatingActionId]);

  const openMeetingActionEditor = useCallback((actionId: string) => {
    const syncConflict = meetingActionConflicts.find(conflict => conflict.actionId === actionId);
    if (syncConflict) {
      setActionConflictError('');
      setActionConflictTarget(syncConflict);
      return;
    }
    const candidate = meetingAction(displayedActionCandidates, actionId);
    if (!candidate) {
      showDialog({ title: '无法编辑', message: '这条待办事项已发生变化，请刷新后重试。', tone: 'error' });
      return;
    }
    setActionEditorError('');
    setEditingAction({
      mode: 'edit',
      id: actionId,
      content: candidate.content,
      assignee: candidate.assignee,
      dueAtMs: candidate.dueAtMs,
      reminderAtMs: candidate.reminderAtMs,
      reminderNotificationId: candidate.reminderNotificationId,
      sourceMarkerId: null,
      status: candidate.status,
      expectedUpdatedAtMs: candidate.updatedAtMs ?? 0,
    });
  }, [displayedActionCandidates, meetingActionConflicts, showDialog]);

  const resolveMeetingActionConflict = useCallback(async (choice: MeetingActionConflictChoice) => {
    if (!meeting || !meetingScopeKey || !actionConflictTarget || actionConflictSaving) return;
    setActionConflictSaving(true);
    setActionConflictError('');
    try {
      const result = await resolveMeetingActionSyncConflictUseCase.execute({
        conflictId: actionConflictTarget.id,
        meetingId: actionConflictTarget.meetingId,
        actionId: actionConflictTarget.actionId,
        scopeKey: meetingScopeKey,
        expectedUpdatedAtMs: actionConflictTarget.local.updatedAtMs,
        resolution: choice,
      });
      if (choice === 'use_remote' && result.previousNotificationId) {
        await cancelMeetingActionNotification(result.previousNotificationId).catch(reason => {
          diagnosticWarn('cancel replaced conflict action notification failed', reason);
        });
      }
      await reconcileMeetingActionNotifications(meetingScopeKey).catch(reason => {
        diagnosticWarn('reconcile meeting action notifications after conflict resolution failed', reason);
      });
      const current = await refreshMeetingActions();
      await refreshCanonicalSummary(meeting.id).catch(() => null);
      setActionConflictTarget(null);
      ToastAndroid.show(
        choice === 'keep_local' ? '本机版本将重新同步' : '已使用云端版本',
        ToastAndroid.SHORT,
      );
      if (!current) {
        showDialog({
          title: '版本已选择',
          message: '待办事项已保存，但页面内容暂未刷新，请重新打开会议查看。',
          tone: 'warning',
        });
      }
    } catch (reason) {
      diagnosticAudit('meeting_action_conflict_resolution_failed', {
        operation: choice,
        error_code: meetingActionFailureCode(reason),
      });
      setActionConflictError(reason instanceof MeetingActionSyncConflictChangedError
        ? '这条冲突已发生变化，请关闭后重新打开。'
        : choice === 'keep_local'
          ? '本机版本暂时无法重新同步，请稍后重试。'
          : '云端版本暂时无法应用，请稍后重试。');
      if (reason instanceof MeetingActionSyncConflictChangedError) {
        await refreshMeetingActions().catch(() => null);
      }
    } finally {
      if (mountedRef.current) setActionConflictSaving(false);
    }
  }, [actionConflictSaving, actionConflictTarget, meeting, meetingScopeKey, refreshCanonicalSummary, refreshMeetingActions, showDialog]);

  const openManualNoteConflict = useCallback(async () => {
    await manualNote.flush();
    const conflict = manualNoteConflict ?? await refreshManualNoteConflict();
    if (!conflict) {
      ToastAndroid.show('笔记冲突已处理', ToastAndroid.SHORT);
      return;
    }
    setManualNoteConflictError('');
    setManualNoteConflictTarget(conflict);
  }, [manualNote.flush, manualNoteConflict, refreshManualNoteConflict]);

  const resolveManualNoteConflict = useCallback(async (
    choice: MeetingManualNoteConflictChoice,
  ) => {
    if (!meetingScopeKey || !manualNoteConflictTarget || manualNoteConflictSaving) return;
    setManualNoteConflictSaving(true);
    setManualNoteConflictError('');
    try {
      await resolveMeetingManualNoteSyncConflictUseCase.execute({
        conflictId: manualNoteConflictTarget.id,
        meetingId: manualNoteConflictTarget.meetingId,
        scopeKey: meetingScopeKey,
        expectedLocalRevision: manualNoteConflictTarget.local.revision,
        resolution: choice,
      });
      await manualNote.reload();
      await refreshManualNoteConflict();
      setManualNoteConflictTarget(null);
      advancePageGenerations('notes');
      ToastAndroid.show(
        choice === 'keep_local' ? '本机笔记将重新同步' : '已使用云端笔记',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      diagnosticAudit('manual_note_conflict_resolution_failed', {
        operation: choice,
        error_code: reason instanceof MeetingManualNoteSyncConflictChangedError
          ? 'conflict_changed'
          : 'resolution_failed',
      });
      setManualNoteConflictError(reason instanceof MeetingManualNoteSyncConflictChangedError
        ? '这次冲突已发生变化，请关闭后重新打开。'
        : choice === 'keep_local'
          ? '本机笔记暂时无法重新同步，请稍后重试。'
          : '云端笔记暂时无法应用，请稍后重试。');
      if (reason instanceof MeetingManualNoteSyncConflictChangedError) {
        await refreshManualNoteConflict().catch(() => null);
      }
    } finally {
      if (mountedRef.current) setManualNoteConflictSaving(false);
    }
  }, [advancePageGenerations, manualNote.reload, manualNoteConflictSaving, manualNoteConflictTarget, meetingScopeKey, refreshManualNoteConflict]);

  const openSummarySyncConflict = useCallback(async () => {
    const conflicts = summarySyncConflicts.length > 0
      ? summarySyncConflicts
      : await refreshSummarySyncConflicts();
    const conflict = conflicts[0];
    if (!conflict) {
      ToastAndroid.show('整理结果冲突已处理', ToastAndroid.SHORT);
      return;
    }
    setSummarySyncConflictError('');
    setSummarySyncConflictTarget(conflict);
  }, [refreshSummarySyncConflicts, summarySyncConflicts]);

  const resolveSummarySyncConflict = useCallback(async (
    choice: MeetingSummaryConflictChoice,
  ) => {
    if (!meetingScopeKey || !summarySyncConflictTarget || summarySyncConflictSaving) return;
    setSummarySyncConflictSaving(true);
    setSummarySyncConflictError('');
    try {
      await resolveMeetingSummarySyncConflictUseCase.execute({
        conflictId: summarySyncConflictTarget.id,
        meetingId: summarySyncConflictTarget.meetingId,
        scopeKey: meetingScopeKey,
        resolution: choice,
      });
      setSummarySyncConflictTarget(null);
      await refreshSummarySyncConflicts();
      if (meeting) await refreshCanonicalSummary(meeting.id).catch(() => null);
      if (summaryVersionsVisible) await loadSummaryVersions().catch(() => null);
      advancePageGenerations('summary');
      ToastAndroid.show(
        choice === 'keep_local' ? '本机整理结果将重新同步' : '已使用云端整理结果',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      setSummarySyncConflictError(reason instanceof MeetingSummarySyncConflictChangedError
        ? '这次冲突已发生变化，请关闭后重新打开。'
        : choice === 'keep_local'
          ? '本机整理结果暂时无法重新同步，请稍后重试。'
          : '云端整理结果暂时无法应用，请稍后重试。');
      if (reason instanceof MeetingSummarySyncConflictChangedError) {
        await refreshSummarySyncConflicts().catch(() => null);
      }
    } finally {
      if (mountedRef.current) setSummarySyncConflictSaving(false);
    }
  }, [advancePageGenerations, loadSummaryVersions, meeting, meetingScopeKey, refreshCanonicalSummary, refreshSummarySyncConflicts, summarySyncConflictSaving, summarySyncConflictTarget, summaryVersionsVisible]);

  const openMeetingActionCreator = useCallback((sourceMarkerId: string | null = null) => {
    if (!meeting || !meetingScopeKey) {
      showDialog({
        title: '暂时无法新建',
        message: '当前会议尚未完成本机保存，请稍后重试。',
        tone: 'warning',
      });
      return;
    }
    setActionEditorError('');
    try {
      setEditingAction({
        mode: 'create',
        id: secureClientIdFactory.create(),
        content: '',
        assignee: null,
        dueAtMs: null,
        reminderAtMs: null,
        reminderNotificationId: null,
        sourceMarkerId,
        status: 'pending',
        expectedUpdatedAtMs: 0,
      });
    } catch (reason) {
      diagnosticAudit('meeting_action_create_failed', {
        operation: 'prepare',
        error_code: meetingActionFailureCode(reason),
      });
      showDialog({ title: '暂时无法新建', message: '待办事项创建准备失败，请稍后重试。', tone: 'error' });
    }
  }, [meeting, meetingScopeKey, showDialog]);

  const saveMeetingActionEdit = useCallback(async (value: MeetingActionEditorSaveValue) => {
    if (!meeting || !meetingScopeKey || !editingAction || actionEditorSaving) return;
    setActionEditorSaving(true);
    setActionEditorError('');
    const isCreating = editingAction.mode === 'create';
    const desiredReminderAtMs = value.reminderEnabled && value.dueAtMs !== null
      ? meetingActionReminderAtForDue(value.dueAtMs)
      : null;
    const oldNotificationId = editingAction.reminderNotificationId;
    let newNotificationId: string | null = null;
    let nextNotificationId = desiredReminderAtMs === null ? null : oldNotificationId;
    let committed = false;
    let schedulingNotification = false;
    try {
      const canonical = await loadMeetingActions(meetingScopeKey, meeting.id);
      const reminderAlreadyDelivered = desiredReminderAtMs !== null
        && desiredReminderAtMs <= Date.now()
        && editingAction.reminderAtMs === desiredReminderAtMs;
      const notificationNeedsReplacement = desiredReminderAtMs !== null && !reminderAlreadyDelivered && (
        !oldNotificationId
        || editingAction.reminderAtMs !== desiredReminderAtMs
        || editingAction.content.trim() !== value.content.trim()
      );
      if (notificationNeedsReplacement) {
        schedulingNotification = true;
        newNotificationId = await scheduleMeetingActionNotification({
          actionId: editingAction.id,
          canonicalMeetingId: canonical.canonicalMeetingId,
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          content: value.content,
          reminderAtMs: desiredReminderAtMs,
        }, meetingScopeKey);
        if (!newNotificationId) throw new Error('meeting action notification scope changed');
        schedulingNotification = false;
        nextNotificationId = newNotificationId;
      }
      if (isCreating) {
        await createMeetingActionUseCase.execute({
          meetingId: canonical.canonicalMeetingId,
          actionId: editingAction.id,
          scopeKey: meetingScopeKey,
          content: value.content,
          assigneeText: value.assignee,
          dueAtMs: value.dueAtMs,
          reminderAtMs: desiredReminderAtMs,
          reminderNotificationId: nextNotificationId,
          sourceMarkerId: editingAction.sourceMarkerId,
        });
      } else {
        await updateMeetingActionUseCase.execute({
          meetingId: canonical.canonicalMeetingId,
          actionId: editingAction.id,
          scopeKey: meetingScopeKey,
          expectedUpdatedAtMs: editingAction.expectedUpdatedAtMs,
          content: value.content,
          assigneeText: value.assignee,
          dueAtMs: value.dueAtMs,
          reminderAtMs: desiredReminderAtMs,
          reminderNotificationId: nextNotificationId,
        });
      }
      committed = true;
      if (oldNotificationId && oldNotificationId !== nextNotificationId) {
        await cancelMeetingActionNotification(oldNotificationId).catch(reason => {
          diagnosticWarn('cancel replaced meeting action notification failed', reason);
        });
      }
      await reconcileMeetingActionNotifications(meetingScopeKey).catch(reason => {
        diagnosticWarn('reconcile meeting action notifications after edit failed', reason);
      });
      const current = await refreshMeetingActions();
      await refreshCanonicalSummary(meeting.id).catch(() => null);
      setEditingAction(null);
      if (!current) {
        showDialog({
          title: isCreating ? '已创建' : '已保存',
          message: `待办事项已${isCreating ? '创建' : '保存'}，但页面内容暂未刷新，请重新打开会议查看。`,
          tone: 'warning',
        });
      }
    } catch (reason) {
      if (!committed && newNotificationId) {
        await cancelMeetingActionNotification(newNotificationId).catch(cancelReason => {
          diagnosticWarn('rollback meeting action notification failed', cancelReason);
        });
      }
      diagnosticAudit('meeting_action_update_failed', {
        operation: isCreating ? 'create' : 'edit',
        error_code: meetingActionFailureCode(reason),
      });
      if (reason instanceof MeetingActionNotificationPermissionError) {
        setActionEditorError('未获得通知权限，请在“通知与提醒”中开启后再保存。');
      } else if (reason instanceof MeetingActionReminderTimeError) {
        setActionEditorError('提醒时间已过，请选择之后的截止日期。');
      } else if (
        reason instanceof MeetingActionRevisionConflictError
        || reason instanceof MeetingActionIdentityConflictError
      ) {
        setActionEditorError(isCreating
          ? '这条待办事项已创建，请关闭后查看。'
          : '这条待办事项已更新，请关闭后重新编辑。');
        await refreshMeetingActions().catch(() => null);
        await refreshCanonicalSummary(meeting.id).catch(() => null);
      } else if (schedulingNotification) {
        setActionEditorError('保存失败，未能创建系统提醒，请稍后重试。');
      } else {
        setActionEditorError(isCreating ? '创建失败，请稍后重试。' : '保存失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setActionEditorSaving(false);
    }
  }, [actionEditorSaving, editingAction, meeting, meetingScopeKey, refreshCanonicalSummary, refreshMeetingActions, showDialog]);

  const changeMeetingActionStatus = useCallback(async (
    status: 'pending' | 'dismissed',
    target: MeetingActionEditorValue | null = editingAction,
    reopenOnFailure = false,
  ) => {
    if (
      !meeting
      || !meetingScopeKey
      || !target
      || target.mode !== 'edit'
      || actionEditorSaving
    ) return;
    setActionEditorSaving(true);
    setActionEditorError('');
    try {
      const canonical = await loadMeetingActions(meetingScopeKey, meeting.id);
      await updateMeetingActionUseCase.execute({
        meetingId: canonical.canonicalMeetingId,
        actionId: target.id,
        scopeKey: meetingScopeKey,
        expectedUpdatedAtMs: target.expectedUpdatedAtMs,
        status,
      });
      if (status === 'dismissed' && target.reminderNotificationId) {
        await cancelMeetingActionNotification(target.reminderNotificationId).catch(reason => {
          diagnosticWarn('cancel dismissed meeting action notification failed', reason);
        });
      }
      await reconcileMeetingActionNotifications(meetingScopeKey).catch(reason => {
        diagnosticWarn('reconcile meeting action notifications after status change failed', reason);
      });
      const current = await refreshMeetingActions();
      await refreshCanonicalSummary(meeting.id).catch(() => null);
      setEditingAction(null);
      if (!current) {
        showDialog({
          title: status === 'dismissed' ? '已删除' : '已恢复',
          message: '待办状态已保存，但页面内容暂未刷新，请重新打开会议查看。',
          tone: 'warning',
        });
      }
    } catch (reason) {
      diagnosticAudit('meeting_action_update_failed', {
        operation: status === 'dismissed' ? 'dismiss' : 'restore',
        error_code: meetingActionFailureCode(reason),
      });
      if (reason instanceof MeetingActionRevisionConflictError) {
        setActionEditorError('这条待办事项已更新，请关闭后重试。');
        await refreshMeetingActions().catch(() => null);
        await refreshCanonicalSummary(meeting.id).catch(() => null);
      } else {
        setActionEditorError(status === 'dismissed'
          ? '暂时无法删除，请稍后重试。'
          : '暂时无法恢复，请稍后重试。');
      }
      if (reopenOnFailure && mountedRef.current) setEditingAction(target);
    } finally {
      if (mountedRef.current) setActionEditorSaving(false);
    }
  }, [actionEditorSaving, editingAction, meeting, meetingScopeKey, refreshCanonicalSummary, refreshMeetingActions, showDialog]);

  const requestMeetingActionStatusChange = useCallback((status: 'pending' | 'dismissed') => {
    if (status !== 'dismissed') {
      void changeMeetingActionStatus(status);
      return;
    }
    if (!editingAction || editingAction.mode !== 'edit' || actionEditorSaving) return;
    const target = editingAction;
    const targetMeetingId = meeting?.id ?? '';
    setEditingAction(null);
    setActionEditorError('');
    setTimeout(() => {
      if (
        !mountedRef.current
        || !targetMeetingId
        || routeMeetingIdRef.current !== targetMeetingId
      ) return;
      showDialog({
        title: '删除待办事项',
        message: '删除后，这条待办事项将不再显示。',
        tone: 'danger',
        actions: [
          {
            text: '删除',
            role: 'destructive',
            onPress: () => { void changeMeetingActionStatus('dismissed', target, true); },
          },
          {
            text: '取消',
            role: 'cancel',
            onPress: () => {
              if (mountedRef.current && routeMeetingIdRef.current === targetMeetingId) {
                setEditingAction(target);
              }
            },
          },
        ],
      });
    }, 320);
  }, [actionEditorSaving, changeMeetingActionStatus, editingAction, meeting?.id, showDialog]);

  const removeMarker = useCallback(async (markerId: string) => {
    if (!meeting || !meetingScopeKey || deletingMarkerId) return;
    setDeletingMarkerId(markerId);
    try {
      await deleteMeetingMarker(meetingScopeKey, meeting.id, markerId);
      if (!mountedRef.current || routeMeetingIdRef.current !== meeting.id) return;
      setMarkers(current => current.filter(marker => marker.id !== markerId));
      setMarkerActionsId(current => current === markerId ? null : current);
      ToastAndroid.show('已删除标记', ToastAndroid.SHORT);
    } catch (reason) {
      if (mountedRef.current && routeMeetingIdRef.current === meeting.id) {
        ToastAndroid.show(
          readableErrorMessage(reason, '标记删除失败，请稍后重试。'),
          ToastAndroid.LONG,
        );
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === meeting.id) {
        setDeletingMarkerId(null);
      }
    }
  }, [deletingMarkerId, meeting, meetingScopeKey]);

  const shareMarker = useCallback(async (markerId: string) => {
    const marker = markers.find(candidate => candidate.id === markerId);
    if (!marker) {
      ToastAndroid.show('这条标记已发生变化，请刷新后重试。', ToastAndroid.LONG);
      return;
    }
    try {
      await shareMeetingMarkerText(marker, transcript);
    } catch (reason) {
      showDialog({
        title: '分享失败',
        message: readableErrorMessage(reason, '标记文字暂时无法分享，请稍后重试。'),
        tone: 'error',
      });
    }
  }, [markers, showDialog, transcript]);

  const openMeetingAttachments = useCallback((marker: MarkerRecord | null = null) => {
    if (!meeting) return;
    setMoreVisible(false);
    setMarkerActionsId(null);
    navigation.navigate('MeetingAttachments', {
      meetingId: meeting.id,
      meetingTitle: displayMeetingTitle(meeting.title),
      ...(marker ? { markerId: marker.id, positionMs: marker.positionMs } : {}),
    });
  }, [meeting, navigation]);

  const openMediaClipEditor = useCallback(async (source: MeetingMediaClipDraftSource) => {
    if (!meeting || !meetingScopeKey || !canCreateMediaClip || mediaClipPreparing) {
      if (!mediaClipPreparing) {
        showDialog({
          title: '无法生成音频片段',
          message: '当前会议没有可生成片段的录音。',
          tone: 'warning',
        });
      }
      return;
    }
    const requestedMeetingId = meeting.id;
    setMoreVisible(false);
    setMarkerActionsId(null);
    setMediaClipPreparing(true);
    setMediaClipError('');
    try {
      const draft = await prepareMeetingMediaClipDraft({
        scopeKey: meetingScopeKey,
        meetingId: requestedMeetingId,
        source,
        preferredRecordingAssetId: mediaClipPreferredAssetId(selectedPlayerSourceId),
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      setMediaClipDraft(draft);
      setMediaClipEditorVisible(true);
    } catch (reason) {
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      showDialog({
        title: '无法生成音频片段',
        message: meetingMediaClipErrorMessage(reason),
        tone: 'warning',
      });
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setMediaClipPreparing(false);
      }
    }
  }, [accessToken, canCreateMediaClip, mediaClipPreparing, meeting, meetingScopeKey, selectedPlayerSourceId, showDialog]);

  const saveMediaClip = useCallback(async (draft: MeetingMediaClipDraft) => {
    if (!meeting || !meetingScopeKey || mediaClipBusyId) return;
    const requestedMeetingId = meeting.id;
    setMediaClipBusyId('creating');
    setMediaClipError('');
    try {
      const clip = await createMeetingMediaClip({ scopeKey: meetingScopeKey, draft, accessToken });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      setMediaClips(current => [clip, ...current.filter(candidate => candidate.id !== clip.id)]);
      setMediaClipEditorVisible(false);
      setMediaClipDraft(null);
      ToastAndroid.show(
        clip.status === 'ready'
          ? '音频片段已生成'
          : clip.status === 'failed' ? '音频片段生成失败，可重试' : '音频片段正在生成',
        ToastAndroid.SHORT,
      );
      setTimeout(() => {
        if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
          setMediaClipsVisible(true);
        }
      }, 320);
    } catch (reason) {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        const message = meetingMediaClipErrorMessage(reason);
        await refreshMeetingMediaClips().catch(() => undefined);
        if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
          setMediaClipError(message);
        }
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setMediaClipBusyId(null);
      }
    }
  }, [accessToken, mediaClipBusyId, meeting, meetingScopeKey, refreshMeetingMediaClips]);

  const retryMediaClip = useCallback(async (clip: MeetingMediaClip) => {
    if (!meetingScopeKey || mediaClipBusyId) return;
    setMediaClipBusyId(clip.id);
    setMediaClipError('');
    try {
      const ready = await retryMeetingMediaClip(meetingScopeKey, clip, accessToken);
      if (!mountedRef.current) return;
      setMediaClips(current => current.map(candidate => candidate.id === ready.id ? ready : candidate));
    } catch (reason) {
      if (mountedRef.current) setMediaClipError(meetingMediaClipErrorMessage(reason));
    } finally {
      if (mountedRef.current) setMediaClipBusyId(null);
    }
  }, [accessToken, mediaClipBusyId, meetingScopeKey]);

  const shareMediaClip = useCallback(async (clip: MeetingMediaClip) => {
    if (mediaClipBusyId) return;
    setMediaClipBusyId(clip.id);
    setMediaClipError('');
    try {
      await shareMeetingMediaClip(clip);
    } catch (reason) {
      if (mountedRef.current) {
        setMediaClipError(meetingMediaClipErrorMessage(reason, '音频片段暂时无法分享，请稍后重试。'));
      }
    } finally {
      if (mountedRef.current) setMediaClipBusyId(null);
    }
  }, [mediaClipBusyId]);

  const confirmDeleteMediaClip = useCallback((clip: MeetingMediaClip) => {
    if (!meetingScopeKey || mediaClipBusyId) return;
    setMediaClipsVisible(false);
    setTimeout(() => {
      if (!mountedRef.current) return;
      showDialog({
        title: '删除音频片段',
        message: '只删除此片段，原会议录音不会改变。',
        tone: 'warning',
        actions: [
          {
            text: '取消',
            role: 'cancel',
            onPress: () => { if (mountedRef.current) setMediaClipsVisible(true); },
          },
          {
            text: '删除',
            role: 'destructive',
            onPress: () => {
              setMediaClipBusyId(clip.id);
              setMediaClipError('');
              void deleteMeetingMediaClip(meetingScopeKey, clip, accessToken)
                .then(() => {
                  if (mountedRef.current) {
                    setMediaClips(current => current.filter(candidate => candidate.id !== clip.id));
                    ToastAndroid.show('已删除音频片段', ToastAndroid.SHORT);
                  }
                })
                .catch(reason => {
                  if (mountedRef.current) {
                    setMediaClipError(meetingMediaClipErrorMessage(reason, '音频片段删除失败，请稍后重试。'));
                    setMediaClipsVisible(true);
                  }
                })
                .finally(() => { if (mountedRef.current) setMediaClipBusyId(null); });
            },
          },
        ],
      });
    }, 320);
  }, [accessToken, mediaClipBusyId, meetingScopeKey, showDialog]);

  const openMediaClipSource = useCallback((clip: MeetingMediaClip) => {
    const sourceMarker = clip.sourceKind === 'marker'
      ? markers.find(marker => marker.id === clip.sourceMarkerId) ?? null
      : null;
    const sourceLine = clip.sourceKind === 'transcript' && clip.transcriptText
      ? transcript.find(line => line.text.includes(clip.transcriptText!)) ?? null
      : null;
    const fallbackPositionMs = clip.sourceKind === 'marker'
      ? Math.round((clip.startMs + clip.endMs) / 2)
      : Math.min(clip.endMs, clip.startMs + 1_500);
    const targetPositionMs = sourceMarker?.positionMs
      ?? (sourceLine?.start_time == null ? fallbackPositionMs : Math.round(sourceLine.start_time * 1_000));
    const nearest = sourceLine ?? transcript.reduce<TranscriptLine | null>((current, line) => {
      const distance = Math.abs((line.start_time ?? 0) * 1_000 - targetPositionMs);
      if (!current) return line;
      const currentDistance = Math.abs((current.start_time ?? 0) * 1_000 - targetPositionMs);
      return distance < currentDistance ? line : current;
    }, null);
    setMediaClipsVisible(false);
    navigation.setParams({
      focus: 'transcript',
      segmentId: nearest?.id,
      positionMs: targetPositionMs,
      transcriptFocusRequestId: Date.now(),
    });
  }, [markers, navigation, transcript]);

  const refreshActionShares = useCallback(async (
    target = actionShareTarget,
    showLoading = false,
  ) => {
    if (!meeting || !meetingScopeKey || !target?.canonicalId) {
      setActionShares([]);
      setActionSharesLoading(false);
      return;
    }
    const requestedMeetingId = meeting.id;
    const requestedActionId = target.canonicalId;
    const requestGeneration = ++actionShareRequestGenerationRef.current;
    if (showLoading) setActionSharesLoading(true);
    try {
      const result = await loadMeetingActionShares({
        scopeKey: meetingScopeKey,
        meetingId: requestedMeetingId,
        actionId: requestedActionId,
      });
      if (
        !mountedRef.current
        || routeMeetingIdRef.current !== requestedMeetingId
        || actionShareRequestGenerationRef.current !== requestGeneration
      ) return;
      setActionShares(result.shares);
    } catch (reason) {
      if (
        mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
        && actionShareRequestGenerationRef.current === requestGeneration
      ) {
        setActionShareError(readableErrorMessage(reason, '共享记录暂时无法读取，请稍后重试。'));
      }
    } finally {
      if (
        mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
        && actionShareRequestGenerationRef.current === requestGeneration
      ) {
        setActionSharesLoading(false);
      }
    }
  }, [actionShareTarget, meeting, meetingScopeKey]);

  const openActionCollaboration = useCallback((actionId: string) => {
    if (!meetingActionCollaborationEnabled) return;
    const target = meetingAction(displayedActionCandidates, actionId);
    if (!target?.canonicalId) {
      showDialog({ title: '暂时无法共享', message: '这条待办事项尚未完成本机保存，请稍后重试。', tone: 'warning' });
      return;
    }
    setActionShareTarget(target);
    setActionShares([]);
    setActionShareError('');
    if (!isGuest && accessToken && meetingScopeKey) {
      void refreshActionShares(target, true);
    }
  }, [accessToken, displayedActionCandidates, isGuest, meetingActionCollaborationEnabled, meetingScopeKey, refreshActionShares, showDialog]);

  const sendActionShare = useCallback(async (share: MeetingActionShare) => {
    if (!share.inviteUrl || !actionShareTarget) return;
    try {
      await Share.share({
        title: '共享待办',
        message: `${actionShareTarget.content}\n${share.inviteUrl}`,
      });
    } catch (reason) {
      if (mountedRef.current) {
        setActionShareError(readableErrorMessage(reason, '共享面板暂时无法打开，请稍后重试。'));
      }
    }
  }, [actionShareTarget]);

  const createActionShare = useCallback(async (permission: MeetingActionSharePermission) => {
    if (!meeting || !meetingScopeKey || !accessToken || !actionShareTarget?.canonicalId || actionShareBusyId) return;
    setActionShareBusyId('creating');
    setActionShareError('');
    try {
      const created = await createMeetingActionShare({
        scopeKey: meetingScopeKey,
        meetingId: meeting.id,
        actionId: actionShareTarget.canonicalId,
        permission,
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== meeting.id) return;
      setActionShares(current => [created, ...current.filter(item => item.id !== created.id)]);
      await sendActionShare(created);
    } catch (reason) {
      if (mountedRef.current) {
        setActionShareError(readableErrorMessage(reason, '共享暂时不可用，请稍后重试。'));
        await refreshActionShares(actionShareTarget).catch(() => undefined);
      }
    } finally {
      if (mountedRef.current) setActionShareBusyId(null);
    }
  }, [accessToken, actionShareBusyId, actionShareTarget, meeting, meetingScopeKey, refreshActionShares, sendActionShare]);

  const retryActionShare = useCallback(async (share: MeetingActionShare) => {
    if (!meeting || !meetingScopeKey || !accessToken || actionShareBusyId) return;
    setActionShareBusyId(share.id);
    setActionShareError('');
    try {
      const updated = await retryMeetingActionShare({
        scopeKey: meetingScopeKey,
        meetingId: meeting.id,
        share,
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== meeting.id) return;
      setActionShares(current => current.map(item => item.id === updated.id ? updated : item));
      if (updated.status === 'active') await sendActionShare(updated);
    } catch (reason) {
      if (mountedRef.current) {
        setActionShareError(readableErrorMessage(reason, meetingActionShareErrorMessage(share)));
        await refreshActionShares(actionShareTarget).catch(() => undefined);
      }
    } finally {
      if (mountedRef.current) setActionShareBusyId(null);
    }
  }, [accessToken, actionShareBusyId, actionShareTarget, meeting, meetingScopeKey, refreshActionShares, sendActionShare]);

  const confirmRevokeActionShare = useCallback((share: MeetingActionShare) => {
    if (!meeting || !meetingScopeKey || !accessToken || actionShareBusyId) return;
    const target = actionShareTarget;
    setActionShareTarget(null);
    setTimeout(() => {
      if (!mountedRef.current) return;
      showDialog({
        title: '撤销共享链接',
        message: '撤销后，收到链接的人将无法再打开这条待办。',
        tone: 'warning',
        actions: [
          {
            text: '取消',
            role: 'cancel',
            onPress: () => { if (mountedRef.current) setActionShareTarget(target); },
          },
          {
            text: '撤销',
            role: 'destructive',
            onPress: () => {
              setActionShareBusyId(share.id);
              setActionShareError('');
              void revokeMeetingActionShare({
                scopeKey: meetingScopeKey,
                meetingId: meeting.id,
                share,
                accessToken,
              }).then(updated => {
                if (!mountedRef.current) return;
                setActionShares(current => current.map(item => item.id === updated.id ? updated : item));
                ToastAndroid.show('共享链接已撤销', ToastAndroid.SHORT);
              }).catch(reason => {
                if (mountedRef.current) {
                  setActionShareError(readableErrorMessage(reason, '共享链接暂时无法撤销，请稍后重试。'));
                }
              }).finally(() => {
                if (mountedRef.current) {
                  setActionShareBusyId(null);
                  setActionShareTarget(target);
                }
              });
            },
          },
        ],
      });
    }, 320);
  }, [accessToken, actionShareBusyId, actionShareTarget, meeting, meetingScopeKey, showDialog]);

  const openQuestionCitation = useCallback((target: MeetingQuestionCitationTarget) => {
    // This callback can be created before the asynchronous meetings owner has
    // hydrated `meeting`.  Gate against the stable navigation identity rather
    // than capturing that transient value; otherwise a valid citation closes
    // the sheet but is silently ignored after a cold start.
    if (target.meetingId !== route.params.meetingId) return;
    const requestId = Date.now();
    const selectCitationTab = (tab: MinutesDetailTab) => {
      setTabGeneration(value => {
        const next = value + 1;
        tabOwnerRef.current.accept({
          meetingId: target.meetingId,
          tab,
          generation: next,
        });
        return next;
      });
      setActiveTab(tab);
    };
    if (target.kind === 'transcript') {
      selectCitationTab('transcript');
      navigation.setParams({
        focus: 'transcript',
        segmentId: target.segmentId,
        positionMs: target.positionMs,
        transcriptFocusRequestId: requestId,
      });
      return;
    }
    if (target.kind === 'summary') {
      selectCitationTab('summary');
      navigation.setParams({
        focus: 'summary',
        actionId: undefined,
        actionFocusRequestId: requestId,
      });
      return;
    }
    selectCitationTab('notes');
    navigation.setParams({
      focus: 'notes',
      actionId: undefined,
      actionFocusRequestId: requestId,
    });
  }, [navigation, route.params.meetingId]);

  function retryProcessingStage(stage: MinutesProcessingStage): void {
    if (!meeting || !processingStageCanRetry(processingStatuses, stage)) {
      setReloadKey(value => value + 1);
      void refreshMeetings().catch(() => {});
      return;
    }
    if (stage === 'capture') {
      if (!canResumeMeetingRecording(meeting)) {
        showDialog({
          title: '无法重新开始录音',
          message: '当前会议已有录音文件，不能继续写入同一份记录。',
          tone: 'warning',
        });
        return;
      }
      const requestedMeetingId = meeting.id;
      void manualNote.flush().finally(() => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        navigation.replace('MeetingLive', { meetingId: requestedMeetingId, startRequested: true });
      });
      return;
    }
    if (stage === 'upload') {
      if (retryingAudioUpload) return;
      if (!isGuest && !accessToken) {
        showDialog({
          title: '暂时无法重试上传',
          message: '登录状态已失效，请重新登录后再试。',
          tone: 'warning',
        });
        return;
      }
      const requestedMeetingId = meeting.id;
      void (async () => {
        const pending = pendingAudioUpload ?? await getPendingMeetingAudioUpload(
          recordingStorageScope,
          requestedMeetingId,
        ).catch(() => null);
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        if (!pending) {
          await refreshMeetings().catch(() => {});
          if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
          setReloadKey(value => value + 1);
          showDialog({
            title: '待上传状态已变化',
            message: '未找到可重试的本机录音，已重新读取会议状态。',
            tone: 'info',
          });
          return;
        }
        await performPendingAudioUpload(pending, true);
      })();
      return;
    }
    if (stage === 'transcript') {
      if (loadingTranscript) return;
      setTranscriptError('');
      const canonicalMeetingId = canonicalProcessingSnapshot
        && canonicalProcessingSnapshot.meetingId === meeting.id
        && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
        ? canonicalProcessingSnapshot.canonicalMeetingId
        : null;
      if (!canonicalMeetingId || !meetingScopeKey || meetingScopeKey === 'guest') {
        setReloadKey(value => value + 1);
        return;
      }
      const requestedMeetingId = meeting.id;
      void sqliteMeetingNoteRepository.retryRecordingAssetTranscriptionTasks(
        canonicalMeetingId,
        meetingScopeKey,
        Date.now(),
      ).then(scheduled => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        if (scheduled > 0) {
          requestMeetingTranscriptCompletion(meetingScopeKey, { discoverRecordingAssets: true });
        }
        setReloadKey(value => value + 1);
      }).catch(reason => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        diagnosticWarn('retry recording asset transcription failed', reason);
        setTranscriptError('文字处理暂时无法重试，请稍后再试。');
      });
      return;
    }
    if (stage === 'summary') {
      if (loadingSummary) return;
      setSummaryError('');
      void runSummaryTask();
      return;
    }
    if (stage === 'speaker') {
      if (retryingSpeakerCorrection) return;
      if (!accessToken || !meetingScopeKey || meetingScopeKey === 'guest') {
        showDialog({
          title: '暂时无法重试同步',
          message: '登录状态已失效，请重新登录后再试。',
          tone: 'warning',
        });
        return;
      }
      const canonicalMeetingId = canonicalProcessingSnapshot
        && canonicalProcessingSnapshot.meetingId === meeting.id
        && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
        ? canonicalProcessingSnapshot.canonicalMeetingId
        : null;
      if (!canonicalMeetingId) {
        setReloadKey(value => value + 1);
        void refreshMeetings().catch(() => {});
        return;
      }
      const requestedMeetingId = meeting.id;
      setRetryingSpeakerCorrection(true);
      void retryMeetingSpeakerCorrectionSyncUseCase.execute({
        meetingId: canonicalMeetingId,
        scopeKey: meetingScopeKey,
      }).then(scheduled => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        if (!scheduled) {
          setReloadKey(value => value + 1);
          showDialog({
            title: '同步状态已变化',
            message: '当前没有可重试的讲话人修改，已重新读取会议状态。',
            tone: 'info',
          });
        }
      }).catch(reason => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
        showDialog({
          title: '重试失败',
          message: readableErrorMessage(reason, '讲话人修改暂时无法重新同步，请稍后重试。'),
          tone: 'error',
        });
      }).finally(() => {
        if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
          setRetryingSpeakerCorrection(false);
        }
      });
    }
  }

  const runTranscriptReprocess = useCallback(async () => {
    if (
      !meeting
      || !meetingScopeKey
      || meetingScopeKey === 'guest'
      || !accessToken
      || requestingTranscriptReprocess
    ) return;
    const requestedMeetingId = meeting.id;
    setRequestingTranscriptReprocess(true);
    try {
      const result = await requestMeetingTranscriptReprocess({
        scopeKey: meetingScopeKey,
        meetingId: requestedMeetingId,
        accessToken,
      });
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      setTranscriptCompleting(true);
      setTranscriptVisualPhase('running');
      setTranscriptError('');
      setReloadKey(value => value + 1);
      ToastAndroid.show(
        result.recordingCount > 1
          ? `正在重新处理${result.recordingCount}段录音`
          : '正在重新处理录音',
        ToastAndroid.SHORT,
      );
    } catch (reason) {
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      showDialog({
        title: '暂时无法重新生成',
        message: readableErrorMessage(reason, '文字记录暂时无法重新生成，请稍后再试。'),
        tone: 'error',
      });
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setRequestingTranscriptReprocess(false);
      }
    }
  }, [accessToken, meeting, meetingScopeKey, requestingTranscriptReprocess, showDialog]);

  const confirmTranscriptReprocess = useCallback(() => {
    if (requestingTranscriptReprocess) return;
    showDialog({
      title: '重新生成文字记录',
      message: '将基于现有录音创建新版本，当前文字记录会保留。',
      tone: 'info',
      actions: [
        { text: '重新生成', role: 'primary', onPress: () => { void runTranscriptReprocess(); } },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [requestingTranscriptReprocess, runTranscriptReprocess, showDialog]);

  const runRecordingMerge = useCallback(async () => {
    if (!meeting || !meetingScopeKey || recordingMergeBusy) return;
    const canonicalMeetingId = canonicalProcessingSnapshot
      && canonicalProcessingSnapshot.meetingId === meeting.id
      && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
      ? canonicalProcessingSnapshot.canonicalMeetingId
      : null;
    if (!canonicalMeetingId) {
      ToastAndroid.show('会议本机数据尚未准备好，请稍后重试。', ToastAndroid.LONG);
      return;
    }
    const requestedMeetingId = meeting.id;
    setRecordingMergeBusy(true);
    try {
      const result = await mergeDetachedMeetingRecordings(meetingScopeKey, canonicalMeetingId);
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      if (result.completedCount > 0) {
        ToastAndroid.show(`已加入${result.completedCount}段本机录音`, ToastAndroid.SHORT);
      } else if (result.waitingCount > 0) {
        ToastAndroid.show('录音结束后即可加入当前会议。', ToastAndroid.LONG);
      } else if (result.blockedCount > 0) {
        ToastAndroid.show('本机录音文件无法读取。', ToastAndroid.LONG);
      } else if (result.failedCount > 0) {
        ToastAndroid.show('本机录音暂时无法加入，请稍后重试。', ToastAndroid.LONG);
      }
    } catch (reason) {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        ToastAndroid.show(
          readableErrorMessage(reason, '本机录音暂时无法加入，请稍后重试。'),
          ToastAndroid.LONG,
        );
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setRecordingMergeBusy(false);
      }
    }
  }, [canonicalProcessingSnapshot, meeting, meetingScopeKey, recordingMergeBusy]);

  const requestMeetingLocation = useCallback(async () => {
    if (!meeting || locationLoading) return;
    const requestedMeetingId = meeting.id;
    setLocationLoading(true);
    try {
      const result = await getCurrentAddress();
      if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
      await updateMeetingDetails(requestedMeetingId, { location: result.address });
      if (
        result.usedCoordinateFallback
        && mountedRef.current
        && routeMeetingIdRef.current === requestedMeetingId
      ) {
        showDialog({
          title: '已记录当前位置',
          message: '系统未返回详细地址，已保存当前位置坐标。',
          tone: 'info',
        });
      }
    } catch (reason) {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        showDialog({
          title: '无法获取位置',
          message: reason instanceof CurrentAddressError
            ? reason.message
            : readableErrorMessage(reason, '暂时无法获取当前位置，请稍后重试。'),
          tone: 'warning',
        });
      }
    } finally {
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setLocationLoading(false);
      }
    }
  }, [locationLoading, meeting, showDialog, updateMeetingDetails]);

  const handleAction = useCallback((action: MinutesSemanticAction) => {
    const projectionFence = fenceNativeProjectionAction(
      projectionCandidateEnabled,
      currentProjectionRef.current,
      action.projection,
    );
    if (!projectionFence.accepted) {
      diagnosticAudit('native_projection_action_rejected', {
        surface: 'transcript',
        action_type: action.type,
        reason: projectionFence.reason,
      });
      return;
    }
    switch (action.type) {
      case 'back':
        void manualNote.flush().finally(() => navigation.goBack());
        break;
      case 'share':
        if (!sharing) setShareVisible(true);
        break;
      case 'more':
        if (meeting) setMoreVisible(true);
        break;
      case 'saveTitle':
        if (!meeting || action.meetingId !== meeting.id) break;
        void updateMeetingTitle(meeting.id, action.title).catch(() => {
          showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试。', tone: 'error' });
        });
        break;
      case 'requestMeetingLocation':
        if (!meeting || action.meetingId !== meeting.id) break;
        void requestMeetingLocation();
        break;
      case 'selectDetailTab':
        if (action.meetingId !== route.params.meetingId) break;
        if (action.selectionGeneration < tabOwnerRef.current.current().generation) break;
        if (!tabOwnerRef.current.accept({
          meetingId: action.meetingId,
          tab: action.tab,
          generation: action.selectionGeneration,
        })) break;
        setTabGeneration(action.selectionGeneration);
        setActiveTab(action.tab);
        break;
      case 'updateManualNote':
        if (!meeting || action.meetingId !== meeting.id) break;
        manualNote.updateContent(action.content);
        break;
      case 'retryManualNote':
        if (!meeting || action.meetingId !== meeting.id) break;
        void manualNote.retry();
        break;
      case 'openManualNoteConflict':
        if (!meeting || action.meetingId !== meeting.id) break;
        void openManualNoteConflict();
        break;
      case 'openSummarySyncConflict':
        if (action.meetingId !== route.params.meetingId) break;
        void openSummarySyncConflict();
        break;
      case 'retryDetailContent':
        if (action.meetingId !== route.params.meetingId) break;
        if (action.tab === 'transcript' && processingStatuses.transcript === 'failed_retryable') {
          retryProcessingStage('transcript');
          break;
        }
        if (action.tab === 'summary' && processingStatuses.summary === 'failed_retryable') {
          retryProcessingStage('summary');
          break;
        }
        const retryPlan = nativeMinutesDetailRetryPlan(action.tab, Boolean(summary));
        if (retryPlan.kind === 'generateSummary') {
          void runSummaryTask({ forceRegenerate: retryPlan.forceRegenerate });
        } else {
          setReloadKey(value => value + 1);
        }
        break;
      case 'retryProcessingStage':
        if (action.meetingId !== route.params.meetingId) break;
        retryProcessingStage(action.stage);
        break;
      case 'mergeRecordingAssets':
        if (action.meetingId !== route.params.meetingId) break;
        void runRecordingMerge();
        break;
      case 'selectPlayerSource':
        if (action.meetingId !== route.params.meetingId) break;
        if (playerSources.some(source => source.sourceId === action.sourceId)) {
          setSelectedPlayerSourceId(action.sourceId);
        }
        break;
      case 'seekTranscript':
        if (action.meetingId !== route.params.meetingId) break;
        if (
          action.playerSourceId
          && playerSources.some(source => source.sourceId === action.playerSourceId)
        ) setSelectedPlayerSourceId(action.playerSourceId);
        break;
      case 'generateSummary':
        if (action.meetingId !== route.params.meetingId) break;
        if (summaryInFlightRef.current || loadingSummary || summaryVisualPhase === 'running') break;
        void prepareSummaryGeneration(summaryTemplate);
        break;
      case 'selectSummaryTemplate': // Compatibility with pre-v20 native snapshots.
      case 'openSummaryBlocks':
        if (action.meetingId !== route.params.meetingId || !activeMeetingFactsV3) break;
        setSummaryBlocksSheetVisible(true);
        break;
      case 'openSummaryEvidence':
        if (action.meetingId !== route.params.meetingId) break;
        if (!fullDisplayedSummaryDocument?.sections.some(section => (
          section.id === action.sectionId && section.citations.length > 0
        ))) break;
        setSummaryEvidenceSectionId(action.sectionId);
        break;
      case 'editSummarySection':
        if (action.meetingId !== route.params.meetingId) break;
        openSummarySectionEditor(action.sectionId);
        break;
      case 'editTranscriptSpeaker':
        openSpeakerAssignment(action);
        break;
      case 'manageSpeaker':
        manageSpeaker(action.speakerId);
        break;
      case 'toggleAction':
        if (action.meetingId !== route.params.meetingId) break;
        void toggleMeetingAction(
          action.actionId,
          action.completed,
        );
        break;
      case 'createAction':
        if (action.meetingId !== route.params.meetingId) break;
        openMeetingActionCreator();
        break;
      case 'editAction':
        if (action.meetingId !== route.params.meetingId) break;
        openMeetingActionEditor(action.actionId);
        break;
      case 'shareAction':
        if (action.meetingId !== route.params.meetingId) break;
        openActionCollaboration(action.actionId);
        break;
      case 'actionToEvent':
        if (action.meetingId !== route.params.meetingId) break;
        void openMeetingActionFollowup(action.actionId);
        break;
      case 'createClipFromTranscript':
        if (action.meetingId !== route.params.meetingId) break;
        void openMediaClipEditor({
          kind: 'transcript',
          segmentId: action.lineId,
          selectedText: action.selectedText,
        });
        break;
      case 'deleteMarker':
        if (action.meetingId !== route.params.meetingId) break;
        void removeMarker(action.markerId);
        break;
      case 'openMarkerActions':
        if (action.meetingId !== route.params.meetingId) break;
        if (markers.some(marker => marker.id === action.markerId)) setMarkerActionsId(action.markerId);
        break;
      case 'openMarker':
        // Native owns tab selection, transcript positioning, and optional audio seek.
        break;
      default:
        break;
    }
  }, [activeMeetingFactsV3, fullDisplayedSummaryDocument, loadingSummary, manageSpeaker, manualNote, markers, meeting, navigation, openActionCollaboration, openManualNoteConflict, openMediaClipEditor, openMeetingActionCreator, openMeetingActionEditor, openMeetingActionFollowup, openSpeakerAssignment, openSummarySectionEditor, openSummarySyncConflict, playerSources, processingStatuses, projectionCandidateEnabled, removeMarker, requestMeetingLocation, retryProcessingStage, route.params.meetingId, runRecordingMerge, sharing, showDialog, summary, summaryTemplate, summaryVisualPhase, toggleMeetingAction]);

  const transcriptCanonicalSuppressed = suppressCanonicalProcessing(transcriptVisualPhase);
  const transcriptStageLoading = transcriptVisualPhase === 'running'
    || (!transcriptCanonicalSuppressed && (
      processingStatuses.transcript === 'realtime_draft'
      || processingStatuses.transcript === 'finalizing'
    ));
  const transcriptStageMessage = transcriptVisualPhase === 'running'
    ? (transcriptCompleting ? '文字记录仍在补全' : '正在生成文字记录')
    : processingStatuses.transcript === 'realtime_draft'
      ? '文字记录仍在补全'
      : processingStatuses.transcript === 'finalizing'
        ? '正在生成文字记录'
        : processingStatuses.transcript === 'no_speech'
          ? '未检测到人声'
          : '';
  const transcriptStageError = !transcriptCanonicalSuppressed
    && processingStatuses.transcript === 'failed_retryable'
    ? '文字处理失败，可重试'
    : '';
  // The canonical SQLite stage is the cross-page source of truth.  The
  // mounted page phase only adds local wording while a request is being
  // refreshed; it must never suppress a queued/generating stage written by a
  // previous page instance.
  const summaryStageLoading = summaryStageIsActive(processingStatuses.summary)
    || summaryVisualPhase === 'running'
    || summaryV3UpgradeRunning;
  const summaryStageError = processingStatuses.summary === 'failed_retryable'
    ? '整理失败，可重试'
    : !summaryStageLoading && summaryVisualPhase === 'error' && summaryError
      ? summaryError
      : '';
  const summaryOperationActive = summaryStageLoading
    || (summaryVisualPhase === 'background' && summaryStageIsActive(processingStatuses.summary));
  const hasStableFinalTranscript = transcript.length > 0
    && !transcriptCompleting
    && transcript.every(line => line.isFinal !== false && line.revisionKind !== 'realtimeDraft');
  const deviceTranscriptPending = !hasStableFinalTranscript && deviceTranscriptTask?.state === 'pending';
  const deviceTranscriptNoSpeech = !hasStableFinalTranscript
    && deviceTranscriptTask?.state === 'failed'
    && deviceTranscriptTask.errorCode === 'no_speech';
  const deviceTranscriptFailed = !hasStableFinalTranscript
    && deviceTranscriptTask?.state === 'failed'
    && !deviceTranscriptNoSpeech;
  const canonicalUploadPending = processingStatuses.upload === 'queued'
    || processingStatuses.upload === 'uploading';
  const canonicalUploadFailed = processingStatuses.upload === 'failed_retryable'
    || processingStatuses.upload === 'blocked';
  const detailProcessingPresentation: DetailProcessingPresentation = (() => {
    if (retryingAudioUpload) {
      return { label: '正在上传录音', tone: 'neutral', retryStage: null };
    }
    if (pendingAudioError && canonicalUploadFailed) {
      return {
        label: pendingAudioUpload?.uploadState === 'blocked' ? '录音上传受阻' : '录音上传失败，可重试',
        tone: 'danger',
        retryStage: pendingAudioUpload ? 'upload' : null,
      };
    }
    if (pendingAudioUpload && canonicalUploadPending) {
      return { label: '等待上传录音', tone: 'neutral', retryStage: null };
    }
    if (deviceTranscriptTask?.state === 'failed' && !hasStableFinalTranscript) {
      return deviceTranscriptNoSpeech
        ? { label: '未检测到人声', tone: 'neutral', retryStage: null }
        : { label: '文字处理未完成', tone: 'danger', retryStage: null };
    }
    if (deviceTranscriptPending) {
      return deviceTranscriptTask.phase === 'running'
        ? { label: '正在生成文字记录', tone: 'neutral', retryStage: null }
        : { label: '等待生成文字记录', tone: 'neutral', retryStage: null };
    }
    if (transcriptStageError || (transcriptVisualPhase === 'error' && transcriptError)) {
      return { label: '文字处理失败，可重试', tone: 'danger', retryStage: 'transcript' };
    }
    if (transcriptStageLoading && (!isGuest || transcriptCompleting)) {
      return {
        label: transcriptStageMessage || '正在生成文字记录',
        tone: 'neutral',
        retryStage: null,
      };
    }
    if (summaryStageError || (summaryVisualPhase === 'error' && summaryError)) {
      return { label: '整理失败，可重试', tone: 'danger', retryStage: 'summary' };
    }
    if (summaryOperationActive) {
      return {
        label: summaryProgress || '正在整理会议记录',
        tone: 'neutral',
        retryStage: null,
      };
    }
    if (
      processingPresentation.label === '已完成'
      || processingPresentation.label === '未开始'
      || (
        processingPresentation.label === '整理结果可更新'
        && summaryConfirmedCurrent
      )
    ) {
      return { label: '', tone: 'neutral', retryStage: null };
    }
    return {
      label: processingPresentation.label,
      tone: processingPresentation.tone,
      retryStage: processingPresentation.retryStage,
    };
  })();
  const processingRetrying = detailProcessingPresentation.retryStage === 'upload'
    ? retryingAudioUpload
    : detailProcessingPresentation.retryStage === 'transcript'
      ? loadingTranscript
      : detailProcessingPresentation.retryStage === 'summary'
        ? loadingSummary
        : detailProcessingPresentation.retryStage === 'speaker'
          ? retryingSpeakerCorrection
          : false;
  const recordingMergeRecovery = canonicalProcessingSnapshot
    && meeting
    && canonicalProcessingSnapshot.meetingId === meeting.id
    && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
    ? canonicalProcessingSnapshot.recordingMergeRecovery
    : null;
  const recordingMergeStatusLabel = recordingMergeBusy
    ? '正在加入本机录音'
    : (recordingMergeRecovery?.failedCount ?? 0) > 0
      ? '本机录音尚未加入'
      : (recordingMergeRecovery?.readyCount ?? 0) > 0
        ? '有本机录音可加入'
        : (recordingMergeRecovery?.waitingCount ?? 0) > 0
          ? '本机录音结束后可加入'
          : (recordingMergeRecovery?.blockedCount ?? 0) > 0
            ? '本机录音无法读取'
            : '';
  const recordingMergeActionLabel = recordingMergeBusy
    ? '加入中'
    : (recordingMergeRecovery?.failedCount ?? 0) > 0
      ? '重试'
      : (recordingMergeRecovery?.readyCount ?? 0) > 0
        ? '加入'
        : '';

  const snapshotBody = useMemo(() => buildNativeMinutesDetailSnapshot({
    meetingId: meeting?.id ?? route.params.meetingId,
    available: Boolean(meeting),
    title: meeting ? meeting.title : '会议记录不存在',
    dateTimeLabel: meeting ? compactMeetingDateTime(meeting.date, meeting.time) : '',
    location: meeting?.location ?? '',
    locationLoading,
    canEditLocation: Boolean(meeting),
    activeTab,
    tabGeneration,
    activeTabIsExplicit: focusedTab !== null,
    manualNote: manualNote.content,
    manualNoteLoading: manualNote.loading,
    manualNoteSaving: manualNote.saving,
    manualNoteEnabled: manualNote.enabled,
    manualNoteError: manualNote.error,
    manualNoteRetryable: manualNote.retryable,
    manualNoteConflict: manualNoteConflict !== null,
    transcript,
    actionItemCandidates: summaryActionCandidates,
    conflictedActionIds,
    markers: markers.map(marker => ({
      id: marker.id,
      positionMs: marker.positionMs,
      nearestSegmentId: marker.nearestSegmentId,
      label: marker.label,
      deleting: marker.id === deletingMarkerId,
    })),
    summaryDocument: displayedSummaryDocument,
    summaryText: displayedSummary,
    transcriptLoading: Boolean(meeting && (transcriptStageLoading || deviceTranscriptPending)),
    transcriptStatusMessage: deviceTranscriptPending
      ? (deviceTranscriptTask?.phase === 'running' ? '正在生成文字记录' : '等待生成文字记录')
      : transcriptStageMessage || (transcriptCompleting ? '文字记录仍在补全' : ''),
    summaryLoading: Boolean(meeting && summaryOperationActive),
    transcriptError: meeting
      ? (deviceTranscriptFailed ? '文字处理未完成' : transcriptStageError || transcriptError)
      : '请返回会议列表后重新打开。',
    summaryError: summaryStageError || (briefSummary ? '' : summaryError),
    summaryProgress: summaryV3UpgradeRunning
      ? '正在升级整理结果'
      : summaryOperationActive ? summaryProgress || '正在整理会议记录' : summaryProgress,
    canShare: Boolean(meeting && !sharing),
    // Speaker profiles are device/epoch-owned in the accountless product.
    // The detail page must keep the native row actionable even without an
    // account; the callback selects the device service when no token exists.
    canManageSpeakers: Boolean(meeting),
    canGenerateSummary: Boolean(meeting && transcript.length > 0),
    // Legacy wire field names remain additive-compatible with older native
    // shells; the active control now owns local block visibility, not a
    // generation template.
    canSelectSummaryTemplate: Boolean(
      meeting
      && activeMeetingFactsV3
      && summaryBlockOptions.some(option => !option.fixed),
    ),
    summaryTemplateLabel: '板块',
    canEditSummary: Boolean(
      meetingScopeKey
      && displayedSummaryDocument?.remoteVersionId
      && !loadingSummary
      && !summaryOperationActive
    ),
    canCreateAction: false,
    canShareActions: meetingActionCollaborationEnabled,
    canCreateClip: canCreateMediaClip,
    summaryGenerating: summaryOperationActive,
    updatingActionId,
    focusActionId: route.params.actionId,
    focusActionRequestId: route.params.actionFocusRequestId,
    focusTranscriptSegmentId: route.params.segmentId,
    focusTranscriptPositionMs: route.params.positionMs,
    focusTranscriptRequestId: route.params.transcriptFocusRequestId,
    titleEditRequestId: route.params.focus === 'title' ? 1 : 0,
    pageGenerations: {
      ...pageGenerations,
      notes: manualNoteSnapshotGenerationRef.current,
    },
    pageCached: {
      notes: true,
      transcript: transcriptCached || transcriptCompleting,
      summary: summaryCached,
      speakers: transcriptCached,
    },
    playerSource,
    playerSources,
    audioStatusMessage: loadingAudio && !playerSource
      ? '正在加载录音'
      : '',
    audioErrorMessage: playerSourceError,
    processingStatusLabel: detailProcessingPresentation.label,
    processingStatusTone: detailProcessingPresentation.tone,
    // Root revision conflicts are reconciled by the background sync worker;
    // the meeting detail page must never turn an implementation failure into
    // a user-selectable version-merge task.
    rootSyncConflict: false,
    summarySyncConflict: summarySyncConflicts.length > 0,
    processingRetryStage: detailProcessingPresentation.retryStage ?? undefined,
    processingRetrying,
    recordingMergeStatusLabel,
    recordingMergeActionLabel,
    recordingMergeActionEnabled: !recordingMergeBusy && Boolean(recordingMergeActionLabel),
  }), [accessToken, activeMeetingFactsV3, activeTab, briefSummary, canCreateMediaClip, conflictedActionIds, deletingMarkerId, detailProcessingPresentation.label, detailProcessingPresentation.retryStage, detailProcessingPresentation.tone, deviceTranscriptFailed, deviceTranscriptPending, deviceTranscriptTask?.phase, displayedSummary, displayedSummaryDocument, focusedTab, isGuest, loadingAudio, loadingSummary, loadingTranscript, locationLoading, manualNote.content, manualNote.enabled, manualNote.error, manualNote.loading, manualNote.retryable, manualNote.revision, manualNote.saving, manualNoteConflict, markers, meeting, meetingActionCollaborationEnabled, meetingScopeKey, pageGenerations, playerSource, playerSourceError, playerSources, processingRetrying, recordingMergeActionLabel, recordingMergeBusy, recordingMergeStatusLabel, retryingSpeakerCorrection, route.params.actionFocusRequestId, route.params.actionId, route.params.focus, route.params.meetingId, route.params.positionMs, route.params.segmentId, route.params.transcriptFocusRequestId, sharing, summaryActionCandidates, summaryBlockOptions, summaryCached, summaryError, summaryOperationActive, summaryProgress, summaryStageError, summaryStageLoading, summarySyncConflicts, summaryConfirmedCurrent, summaryV3UpgradeRunning, tabGeneration, transcript, transcriptCached, transcriptCompleting, transcriptError, transcriptStageError, transcriptStageLoading, transcriptStageMessage, updatingActionId]);
  const snapshot = useNativeProjection(snapshotBody, {
    enabled: projectionCandidateEnabled,
    entityId: meeting?.id ?? route.params.meetingId,
    surfaceKey: 'transcript',
  });
  currentProjectionRef.current = snapshot.projection ?? null;

  const moreItems = useMemo<AppActionSheetItem[]>(() => {
    if (!meeting) return [];
    return [
      {
        key: 'meeting-actions',
        label: displayedActionCandidates.length > 0
          ? `本场待办（${displayedActionCandidates.length}）`
          : '本场待办',
        disabled: !meetingScopeKey,
        onPress: () => openMeetingActions(),
      },
      ...(meetingQuestionsEnabled
        ? [{
            key: 'questions',
            label: '会议问答',
            disabled: !meetingScopeKey,
            onPress: () => {
              // The question evidence snapshot is loaded from the repository.
              // Flush the editor first so a question opened immediately after
              // typing cannot read the previous note revision.
              void manualNote.flush().then(() => {
                if (mountedRef.current) setQuestionVisible(true);
              });
            },
          }]
        : []),
      // Upload/transcription progress is rendered in the fixed detail status
      // slot. It must not be hidden behind the overflow menu: the user needs
      // to see the operation while browsing any detail tab.
      ...(transcriptReprocessAvailable && !isGuest && accessToken
        ? [{
            key: 'reprocess-transcript',
            label: requestingTranscriptReprocess ? '正在重新生成文字记录' : '重新生成文字记录',
            disabled: requestingTranscriptReprocess
              || loadingTranscript
              || transcriptStageLoading
              || transcript.length === 0,
            onPress: confirmTranscriptReprocess,
          }]
        : []),
      ...(summaryDocument?.remoteVersionId
        ? [{ key: 'summary-versions', label: '整理结果版本', onPress: openSummaryVersions }]
        : []),
      ...(meetingAttachments.length > 0
        ? [{
            key: 'attachments',
            label: `附件（${meetingAttachments.length}）`,
            onPress: () => openMeetingAttachments(),
          }]
        : []),
      ...(meetingMediaClipsEnabled
        ? [{
            key: 'media-clips',
            label: mediaClips.length > 0 ? `音频片段（${mediaClips.length}）` : '音频片段',
            disabled: mediaClipsLoading,
            onPress: () => {
              setMediaClipError('');
              setMediaClipsVisible(true);
              void refreshMeetingMediaClips(true);
            },
          }]
        : []),
      { key: 'delete', label: '删除会议', destructive: true, onPress: confirmDelete },
    ];
  }, [accessToken, confirmDelete, confirmTranscriptReprocess, displayedActionCandidates.length, isGuest, loadingTranscript, manageSpeaker, manualNote.flush, mediaClips.length, mediaClipsLoading, meeting, meetingAttachments.length, meetingMediaClipsEnabled, meetingQuestionsEnabled, meetingScopeKey, openMeetingActions, openMeetingAttachments, openSummaryVersions, pendingAudioUpload, performPendingAudioUpload, refreshMeetingMediaClips, requestingTranscriptReprocess, retryingAudioUpload, summaryDocument?.remoteVersionId, transcript.length, transcriptReprocessAvailable, transcriptStageLoading]);

  const markerForActions = useMemo(
    () => markers.find(marker => marker.id === markerActionsId) ?? null,
    [markerActionsId, markers],
  );
  const markerAttachmentCount = useMemo(() => markerForActions
    ? meetingAttachments.filter(attachment => attachment.markerId === markerForActions.id).length
    : 0, [markerForActions, meetingAttachments]);
  const markerItems = useMemo<AppActionSheetItem[]>(() => markerForActions ? [
    ...(meetingMediaClipsEnabled ? [{
      key: 'create-media-clip',
      label: mediaClipPreparing ? '正在读取录音' : '生成音频片段',
      disabled: !canCreateMediaClip || mediaClipPreparing,
      onPress: () => { void openMediaClipEditor({ kind: 'marker', markerId: markerForActions.id }); },
    }] : []),
    {
      key: 'attachments',
      label: `附件（${markerAttachmentCount}）`,
      onPress: () => openMeetingAttachments(markerForActions),
    },
    {
      key: 'create-action',
      label: '创建待办事项',
      onPress: () => openMeetingActionCreator(markerForActions.id),
    },
    {
      key: 'share-text',
      label: '分享标记文字',
      onPress: () => { void shareMarker(markerForActions.id); },
    },
  ] : [], [canCreateMediaClip, markerAttachmentCount, markerForActions, mediaClipPreparing, meetingMediaClipsEnabled, openMediaClipEditor, openMeetingActionCreator, openMeetingAttachments, shareMarker]);

  const versionChoices = useMemo(
    () => summaryVersionChoices(summaryVersionsState),
    [summaryVersionsState],
  );

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <View
        style={styles.root}
        testID="meeting-detail-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        {!deletingMeeting ? (
          <LaojiMinutesView
            style={styles.surface}
            surface="detail"
            snapshot={snapshot}
            onMinutesAction={event => handleAction(event.nativeEvent)}
            testID="meeting-detail-native-surface"
          />
        ) : null}
      </View>
      <MeetingShareSheet
        visible={shareVisible}
        availability={shareAvailability}
        linkEnabled={meetingContentShareLinksEnabled && !isGuest && Boolean(accessToken)}
        onClose={() => setShareVisible(false)}
        onShare={requestShare}
        onCreateLink={requestContentShare}
        onManageLinks={openContentShareManager}
      />
      <MeetingContentShareManagerSheet
        visible={contentShareManagerVisible}
        shares={contentShares}
        loading={contentSharesLoading}
        busyShareId={contentShareBusyId}
        error={contentShareError}
        onClose={() => {
          if (contentShareBusyId) return;
          contentShareRequestGenerationRef.current += 1;
          setContentShareManagerVisible(false);
          setContentSharesLoading(false);
          setContentShareError('');
        }}
        onSend={share => { void sendContentShare(share); }}
        onRetry={share => { void retryContentShare(share); }}
        onRevoke={confirmRevokeContentShare}
      />
      <MeetingQuestionSheet
        visible={questionVisible}
        meetingTitle={displayMeetingTitle(meeting?.title ?? '')}
        meetingId={meeting?.id ?? route.params.meetingId}
        scopeKey={meetingScopeKey}
        accessToken={accessToken}
        onClose={() => setQuestionVisible(false)}
        onOpenCitation={openQuestionCitation}
      />
      <MeetingMediaClipEditorSheet
        visible={mediaClipEditorVisible}
        draft={mediaClipDraft}
        saving={mediaClipBusyId === 'creating'}
        error={mediaClipEditorVisible ? mediaClipError : ''}
        onClose={() => {
          if (mediaClipBusyId === 'creating') return;
          setMediaClipEditorVisible(false);
          setMediaClipDraft(null);
          setMediaClipError('');
        }}
        onSubmit={draft => { void saveMediaClip(draft); }}
      />
      <MeetingMediaClipsSheet
        visible={mediaClipsVisible}
        clips={mediaClips}
        loading={mediaClipsLoading}
        busyClipId={mediaClipBusyId}
        error={mediaClipsVisible ? mediaClipError : ''}
        onClose={() => {
          if (mediaClipBusyId) return;
          setMediaClipsVisible(false);
          setMediaClipError('');
        }}
        onOpenSource={openMediaClipSource}
        onRetry={clip => { void retryMediaClip(clip); }}
        onShare={clip => { void shareMediaClip(clip); }}
        onDelete={confirmDeleteMediaClip}
      />
      <MeetingActionsSheet
        visible={meetingActionsVisible}
        actions={displayedActionCandidates}
        conflictedActionIds={conflictedActionIds}
        loading={meetingActionsSheetLoading}
        busyActionId={updatingActionId}
        error={meetingActionsSheetError}
        focusActionId={meetingActionsFocusId}
        onClose={() => {
          if (updatingActionId) return;
          setMeetingActionsVisible(false);
          if (meetingActionsFocusId) {
            navigation.setParams({ actionId: undefined, actionFocusRequestId: undefined });
          }
          setMeetingActionsFocusId(null);
          setMeetingActionsSheetError('');
        }}
        onRetry={() => { void refreshMeetingActionsSheet(); }}
        onCreate={() => openMeetingActionCreator()}
        onToggle={(actionId, completed) => { void toggleMeetingAction(actionId, completed); }}
        onEdit={openMeetingActionEditor}
        onOpenSource={openMeetingActionSource}
        onOpenFollowup={openMeetingActionFollowupFromList}
      />
      <MeetingActionCollaborationSheet
        visible={actionShareTarget !== null}
        actionContent={actionShareTarget?.content ?? ''}
        authenticated={!isGuest && Boolean(accessToken)}
        shares={actionShares}
        loading={actionSharesLoading}
        busyShareId={actionShareBusyId}
        error={actionShareError}
        onClose={() => {
          if (actionShareBusyId) return;
          actionShareRequestGenerationRef.current += 1;
          setActionShareTarget(null);
          setActionShares([]);
          setActionSharesLoading(false);
          setActionShareError('');
        }}
        onCreate={permission => { void createActionShare(permission); }}
        onSend={share => { void sendActionShare(share); }}
        onRetry={share => { void retryActionShare(share); }}
        onRevoke={confirmRevokeActionShare}
      />
      <AppActionSheet
        visible={moreVisible}
        title={meeting?.title ?? '会议记录'}
        items={moreItems}
        onClose={() => setMoreVisible(false)}
      />
      <AppActionSheet
        visible={markerForActions !== null}
        title={markerForActions
          ? `标记 ${formatNativeMinutesTimestamp(markerForActions.positionMs / 1_000)}`
          : '标记操作'}
        items={markerItems}
        onClose={() => setMarkerActionsId(null)}
      />
      <MeetingSummaryVersionSheet
        visible={summaryVersionsVisible}
        choices={versionChoices}
        loading={summaryVersionsLoading}
        error={summaryVersionsError}
        switchingId={switchingSummaryVersionId}
        onClose={() => {
          if (switchingSummaryVersionId) return;
          setSummaryVersionsVisible(false);
        }}
        onRetry={() => { void loadSummaryVersions(); }}
        onSelect={versionId => { void selectSummaryVersion(versionId); }}
      />
      <MeetingSummarySectionEditorSheet
        visible={summarySectionEditorTarget !== null}
        value={summarySectionEditorTarget}
        saving={summarySectionEditorSaving}
        error={summarySectionEditorError}
        onClose={() => {
          if (summarySectionEditorSaving) return;
          setSummarySectionEditorTarget(null);
          setSummarySectionEditorError('');
        }}
        onSave={value => { void saveSummarySectionEdit(value); }}
        onRestore={() => { void saveSummarySectionEdit(null); }}
      />
      <MeetingSummaryBlocksSheet
        visible={summaryBlocksSheetVisible}
        options={summaryBlockOptions}
        customized={hiddenSummaryBlockKeys.length > 0}
        onClose={() => setSummaryBlocksSheetVisible(false)}
        onToggle={toggleSummaryBlock}
        onReset={resetSummaryBlocks}
      />
      <MeetingSummaryEvidenceSheet
        visible={summaryEvidenceSection !== null}
        sectionTitle={summaryEvidenceSection?.title?.trim() || '整理内容'}
        citations={summaryEvidenceSection?.citations ?? []}
        onClose={() => setSummaryEvidenceSectionId(null)}
        onOpenCitation={openSummaryEvidenceCitation}
      />
        <MeetingSummaryAttachmentSheet
        visible={summaryAttachmentRequest !== null}
        attachments={summaryAttachmentRequest?.attachments ?? []}
        imageSelectionEnabled={summaryAttachmentRequest?.imageSelectionEnabled ?? false}
        onClose={() => {
          const request = summaryAttachmentRequest;
          setSummaryAttachmentRequest(null);
          if (!summaryInFlightRef.current) {
            setSummaryVisualPhase('idle');
            setLoadingSummary(false);
            if (request) cancelSummaryPreparation(request.meetingId, request.scopeKey);
          }
        }}
        onSkip={() => {
          const request = summaryAttachmentRequest;
          setSummaryAttachmentRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) void continueSummaryAfterAttachmentSelection(request, null);
        }}
        onAuthorize={attachmentIds => {
          const request = summaryAttachmentRequest;
          if (
            !request
            || activeMeetingIdRef.current !== request.meetingId
            || activeMeetingScopeRef.current !== request.scopeKey
          ) return Promise.reject(new MeetingSummaryAttachmentSelectionStaleError());
          return authorizeMeetingSummaryAttachments({
            scopeKey: request.scopeKey,
            meetingId: request.meetingId,
            attachmentIds,
            accessToken,
          });
        }}
        onCompleted={authorization => {
          const request = summaryAttachmentRequest;
          setSummaryAttachmentRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) void continueSummaryAfterAttachmentSelection(request, authorization);
        }}
      />
      <MeetingSummaryCarryForwardSheet
        visible={summaryCarryForwardRequest !== null}
        memory={summaryCarryForwardRequest?.memory ?? null}
        onClose={() => {
          const request = summaryCarryForwardRequest;
          setSummaryCarryForwardRequest(null);
          if (!summaryInFlightRef.current) {
            setSummaryVisualPhase('idle');
            setLoadingSummary(false);
            if (request) cancelSummaryPreparation(request.meetingId, request.scopeKey);
          }
        }}
        onSkip={() => {
          const request = summaryCarryForwardRequest;
          setSummaryCarryForwardRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) {
            void runSummaryTask({
              forceRegenerate: request.forceRegenerate,
              template: request.template,
              carryForward: null,
              attachmentAuthorization: request.attachmentAuthorization,
            });
          }
        }}
        onAuthorize={selection => {
          const request = summaryCarryForwardRequest;
          if (
            !request
            || activeMeetingIdRef.current !== request.meetingId
            || activeMeetingScopeRef.current !== request.scopeKey
          ) {
            return Promise.reject(new Error('summary carry-forward request is no longer active'));
          }
          return authorizeMeetingSummaryCarryForward({
            scopeKey: request.scopeKey,
            meetingId: request.meetingId,
            selection,
          });
        }}
        onCompleted={carryForward => {
          const request = summaryCarryForwardRequest;
          setSummaryCarryForwardRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) {
            void runSummaryTask({
              forceRegenerate: request.forceRegenerate,
              template: request.template,
              carryForward,
              attachmentAuthorization: request.attachmentAuthorization,
            });
          }
        }}
      />
      <MeetingSpeakerAssignmentSheet
        visible={speakerAssignmentTarget !== null}
        targetKey={speakerAssignmentTarget?.lineId ?? ''}
        speakerLabel={speakerAssignmentTarget?.speakerLabel ?? ''}
        clusterCount={speakerAssignmentTarget?.clusterCount ?? 1}
        candidates={speakerNameCandidates}
        profiles={speakerProfiles.map(profile => ({ id: profile.speaker_id, name: profile.name }))}
        profilesLoading={speakerProfilesLoading}
        profilesError={speakerProfilesError}
        saving={speakerAssignmentSaving}
        error={speakerAssignmentError}
        onClearError={() => setSpeakerAssignmentError('')}
        onClose={() => {
          if (speakerAssignmentSaving) return;
          setSpeakerAssignmentTarget(null);
          setSpeakerAssignmentError('');
        }}
        onSave={value => { void saveSpeakerAssignment(value); }}
      />
      <MeetingActionEditorSheet
        visible={editingAction !== null}
        action={editingAction}
        saving={actionEditorSaving}
        error={actionEditorError}
        onClose={() => {
          if (actionEditorSaving) return;
          setEditingAction(null);
          setActionEditorError('');
        }}
        onSave={value => { void saveMeetingActionEdit(value); }}
        onStatusChange={requestMeetingActionStatusChange}
      />
      <MeetingActionConflictSheet
        visible={actionConflictTarget !== null}
        conflict={actionConflictTarget}
        saving={actionConflictSaving}
        error={actionConflictError}
        onClose={() => {
          if (actionConflictSaving) return;
          setActionConflictTarget(null);
          setActionConflictError('');
        }}
        onResolve={choice => { void resolveMeetingActionConflict(choice); }}
      />
      <MeetingManualNoteConflictSheet
        visible={manualNoteConflictTarget !== null}
        conflict={manualNoteConflictTarget}
        saving={manualNoteConflictSaving}
        error={manualNoteConflictError}
        onClose={() => {
          if (manualNoteConflictSaving) return;
          setManualNoteConflictTarget(null);
          setManualNoteConflictError('');
        }}
        onResolve={choice => { void resolveManualNoteConflict(choice); }}
      />
      <MeetingSummaryConflictSheet
        visible={summarySyncConflictTarget !== null}
        conflict={summarySyncConflictTarget}
        saving={summarySyncConflictSaving}
        error={summarySyncConflictError}
        onClose={() => {
          if (summarySyncConflictSaving) return;
          setSummarySyncConflictTarget(null);
          setSummarySyncConflictError('');
        }}
        onResolve={choice => { void resolveSummarySyncConflict(choice); }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
