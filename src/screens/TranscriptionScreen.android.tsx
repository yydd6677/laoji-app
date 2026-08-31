import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  StyleSheet,
  ToastAndroid,
  View,
} from 'react-native';
import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
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
import {
  MeetingActionEditorSheet,
  type MeetingActionEditorSaveValue,
  type MeetingActionEditorValue,
} from '../components/MeetingActionEditorSheet';
import { MeetingActionsSheet } from '../components/MeetingActionsSheet';
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
  MeetingSpeakerAssignmentSheet,
  type MeetingSpeakerAssignmentValue,
} from '../components/MeetingSpeakerAssignmentSheet';
import { MeetingSummaryEvidenceSheet } from '../components/MeetingSummaryEvidenceSheet';
import { MeetingSummaryAttachmentSheet } from '../components/MeetingSummaryAttachmentSheet';
import { MeetingSummaryCarryForwardSheet } from '../components/MeetingSummaryCarryForwardSheet';
import { MeetingShareSheet } from '../components/MeetingShareSheet';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import { readableErrorMessage } from '../services/errors';
import { CurrentAddressError, getCurrentAddress } from '../services/currentAddress';
import { Colors as C } from '../theme/colors';
import { fetchDeviceSpeakerProfiles, type SpeakerProfile } from '../services/speakers';
import { resolveMeetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import {
  getPendingMeetingAudioUpload,
  subscribePendingMeetingAudioUploadChanged,
  type PendingMeetingAudioUpload,
} from '../services/meetingRecording';
import {
  getDeviceTranscriptTask,
  retryDeviceTranscriptTask,
  subscribeDeviceTranscriptTaskChanged,
  type DeviceTranscriptTaskRecord,
} from '../services/deviceTranscriptTasks';
import {
  generateSummaryForMeeting,
  briefGreetingSummaryText,
  MeetingSummaryInputChangedError,
  isMeetingSummaryTaskPendingError,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryFactsInputFingerprint,
  savePendingMeetingSummaryTask,
  type PendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import { hasCompletedMeetingSummaryTrace } from '../services/meetingSummaryTrace';
import {
  meetingSummaryProcessingFailureCode,
  recordMeetingSummaryProcessing,
} from '../services/meetingSummaryProcessing';
import {
  getActiveMeetingSummaryOperation,
  trackMeetingSummaryOperation,
} from '../services/meetingSummaryOperationCoordinator';
import {
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
  type MeetingSummaryActionCandidate,
  type MeetingSummaryCitation,
  type MeetingSummaryDocument,
  type ProcessingStage,
  type ScopeKey,
} from '../domain/meeting';
import {
  canResumeMeetingRecording,
  transcriptDurationSec,
} from '../utils/meetingMedia';
import { legacyMeetingProcessingStatuses } from '../services/meetingPresentation';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { simplifyTranscriptLines } from '../utils/simplifiedChinese';
import { useMeetingManualNote } from '../hooks/useMeetingManualNote';
import { loadActiveMeetingTranscriptState } from '../services/meetingTranscriptState';
import { deleteMeetingMarker, loadMeetingMarkers } from '../services/meetingMarkers';
import { loadMeetingAttachments } from '../services/meetingAttachments';
import { loadMeetingActions } from '../services/meetingActions';
import { shareMeetingMarkerText } from '../services/meetingMarkerShare';
import {
  evaluateTranscriptLineCandidate,
} from '../services/transcriptCompleteness';
import {
  dedupeMeetingSummaryActions,
  meetingSummaryDocumentToText,
  normalizeMeetingSummaryDocument,
} from '../services/meetingSummaryDocument';
import { loadCurrentMeetingSummaryState } from '../services/meetingSummaryState';
import {
  loadMeetingSummaryVersions,
  type MeetingSummaryVersionsState,
} from '../services/meetingSummaryVersions';
import { authorizeMeetingSummaryCarryForward } from '../services/meetingSummaryCarryForward';
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
  MeetingSummaryVersionConflictError,
  MeetingSummaryVersionUnavailableError,
  MeetingSummarySectionConflictError,
  MeetingSummarySectionContentError,
  MeetingSummarySectionUnavailableError,
  EditMeetingSummarySectionUseCase,
  loadMeetingRecordingMergeRecovery,
  mergeDetachedMeetingRecordings,
  type MeetingRecordingMergeRecoveryState,
  SelectMeetingSummaryVersionUseCase,
  UpdateMeetingActionUseCase,
  UpdateMeetingSpeakerAssignmentUseCase,
  SpeakerAssignmentDraftError,
  SpeakerAssignmentTargetUnavailableError,
} from '../application/meeting';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import { deleteSummaryViewOverride, loadMeetingFactsRecordV3ForVersion, loadSummaryViewOverrides, saveSummaryViewOverride } from "../data/repositories/meetingSummaryV3Repository";
import { SummaryV3ActivationFenceError, type MeetingAttachmentRecord, type MarkerRecord, type RecordingAssetRecord, type SummaryVersionRecord } from "../data/repositories/meetingNoteRepository";
import {
  isMeetingSummaryInputChangedErrorLike,
  isSummaryV3ActivationFenceErrorLike,
} from '../domain/meeting/summaryErrorIdentity';
import {
  applyMeetingSummaryV3Overrides,
  projectMeetingFactsV3,
} from '../services/meetingSummaryV3';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import {
  meetingActionFollowupClientRequestId,
  meetingActionFollowupDraft,
} from '../services/meetingActionFollowup';
import {
  readMeetingDetailSession,
  rememberMeetingDetailActiveTab,
  rememberMeetingDetailSession,
  type MeetingDetailFactsSession,
} from '../services/meetingDetailSessionCache';
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
import { useNativeProjection } from '../native/useNativeProjection';
import { fenceNativeProjectionAction } from '../native/projectionActionFence';

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

type ActiveMeetingFactsV3 = MeetingDetailFactsSession;

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
const EMPTY_TRANSCRIPT_PAYLOAD: TranscriptLine[] = [];

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
  storageScope: 'guest',
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
  return summary ? normalizeMeetingSummaryDocument(meetingId, summary) : null;
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
  return meetingSummaryFactsInputFingerprint(
    input.transcriptLines,
    input.attachmentAuthorization,
    input.manualNote,
  );
}

const SUMMARY_PREPARATION_ORPHAN_GRACE_MS = 30_000;

const updateMeetingActionUseCase = new UpdateMeetingActionUseCase(sqliteMeetingNoteRepository);
const createMeetingActionUseCase = new CreateMeetingActionUseCase(sqliteMeetingNoteRepository);
const selectMeetingSummaryVersionUseCase = new SelectMeetingSummaryVersionUseCase(sqliteMeetingNoteRepository);
const editMeetingSummarySectionUseCase = new EditMeetingSummarySectionUseCase(sqliteMeetingNoteRepository);
const updateMeetingSpeakerAssignmentUseCase = new UpdateMeetingSpeakerAssignmentUseCase(
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
  return meetingTemplateById(templateId) ? '整理结果' : '未知格式';
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
  const currentProjectionRef = useRef<NativeProjectionEnvelope | null>(null);
  const {
    meetings,
    deleteMeeting,
    getCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
    confirmCachedSummaryCurrent,
    refreshMeetings,
    reconcileAudioUploads,
    updateMeetingDetails,
    updateMeetingTitle,
  } = useMeetings();
  const { events, searchableEvents } = useEvents();
  const { refresh: refreshRecycleCapability } = useMeetingRecycleCapability();
  const { showDialog } = useAppDialog();
  const meeting = meetings.find(item => item.id === route.params.meetingId);
  const focusedTab = explicitDetailTab(route.params.focus);
  const recordingStorageScope = 'guest';
  const meetingScopeKey: ScopeKey = 'guest';
  const initialDetailSessionKey = `${recordingStorageScope}\u0000${route.params.meetingId}`;
  const initialDetailSessionRef = useRef<{
    key: string;
    value: ReturnType<typeof readMeetingDetailSession>;
  } | null>(null);
  if (initialDetailSessionRef.current?.key !== initialDetailSessionKey) {
    initialDetailSessionRef.current = {
      key: initialDetailSessionKey,
      value: meeting
        ? readMeetingDetailSession(recordingStorageScope, meeting.id)
        : null,
    };
  }
  const initialDetailSession = initialDetailSessionRef.current.value;
  const initialCachedSummary = meeting ? getCachedSummary(meeting.id) : null;
  const initialSummaryDocument = meeting
    ? initialDetailSession?.summaryDocument ?? summaryDocumentFor(meeting.id, initialCachedSummary)
    : null;
  const initialActiveTab = focusedTab ?? initialDetailSession?.activeTab ?? 'notes';
  const initialTranscript = meeting
    && (initialActiveTab === 'transcript' || initialActiveTab === 'speakers')
    ? getCachedTranscript(meeting.id)
    : EMPTY_TRANSCRIPT_PAYLOAD;
  const [activeTab, setActiveTab] = useState<MinutesDetailTab>(initialActiveTab);
  const [tabGeneration, setTabGeneration] = useState(0);
  const activeTabRef = useRef<MinutesDetailTab>(initialActiveTab);
  const [transcript, setTranscript] = useState<TranscriptLine[]>(initialTranscript);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const [summary, setSummary] = useState(() => initialSummaryDocument
    ? meetingSummaryDocumentToText(initialSummaryDocument)
    : meetingSummaryToText(initialCachedSummary));
  const [summaryDocument, setSummaryDocument] = useState<MeetingSummaryDocument | null>(initialSummaryDocument);
  const [activeMeetingFactsV3, setActiveMeetingFactsV3] = useState<ActiveMeetingFactsV3 | null>(
    initialDetailSession?.activeFactsV3 ?? null,
  );
  const [confirmedCurrentSummaryIdentity, setConfirmedCurrentSummaryIdentity] = useState('');
  // One adaptive presentation owns all new summaries. `general@3` is only the
  // compatibility envelope used by released APIs and existing databases.
  const summaryTemplate = DEFAULT_MEETING_TEMPLATE;
  const [summaryEvidenceSectionId, setSummaryEvidenceSectionId] = useState<string | null>(null);
  const [deferInactiveDetailPayload, setDeferInactiveDetailPayload] = useState(true);
  const deferInitialDetailHydration = deferInactiveDetailPayload
    && activeTab !== 'transcript'
    && activeTab !== 'speakers';
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
  const [summaryProgress, setSummaryProgress] = useState('正在整理会议记录');
  const [transcriptCached, setTranscriptCached] = useState(initialTranscript.length > 0);
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
  const [moreVisible, setMoreVisible] = useState(false);
  const [deletingMeeting, setDeletingMeeting] = useState(false);
  const [meetingActionsVisible, setMeetingActionsVisible] = useState(false);
  const [meetingActionsSheetLoading, setMeetingActionsSheetLoading] = useState(false);
  const [meetingActionsSheetError, setMeetingActionsSheetError] = useState('');
  const [meetingActionsFocusId, setMeetingActionsFocusId] = useState<string | null>(null);
  const [questionVisible, setQuestionVisible] = useState(false);
  const [pendingAudioUpload, setPendingAudioUpload] = useState<PendingMeetingAudioUpload | null>(null);
  const [pendingAudioError, setPendingAudioError] = useState('');
  const [deviceTranscriptTask, setDeviceTranscriptTask] = useState<DeviceTranscriptTaskRecord | null>(null);
  const [playerSourceError, setPlayerSourceError] = useState('');
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [recordingMergeBusy, setRecordingMergeBusy] = useState(false);
  const [retryingAudioUpload, setRetryingAudioUpload] = useState(false);
  const [canonicalProcessingSnapshot, setCanonicalProcessingSnapshot] = useState<CanonicalProcessingSnapshot | null>(null);
  const [updatingActionId, setUpdatingActionId] = useState<string | null>(null);
  const [editingAction, setEditingAction] = useState<MeetingActionEditorValue | null>(null);
  const [actionEditorSaving, setActionEditorSaving] = useState(false);
  const [actionEditorError, setActionEditorError] = useState('');
  const [summaryVersionsVisible, setSummaryVersionsVisible] = useState(false);
  const [summaryVersionsState, setSummaryVersionsState] = useState<MeetingSummaryVersionsState | null>(null);
  const [summaryVersionsLoading, setSummaryVersionsLoading] = useState(false);
  const [summaryVersionsError, setSummaryVersionsError] = useState('');
  const [switchingSummaryVersionId, setSwitchingSummaryVersionId] = useState<string | null>(null);
  const [summarySectionEditorTarget, setSummarySectionEditorTarget] = useState<SummarySectionEditorTarget | null>(null);
  const [summarySectionEditorSaving, setSummarySectionEditorSaving] = useState(false);
  const [summarySectionEditorError, setSummarySectionEditorError] = useState('');
  const [meetingActions, setMeetingActions] = useState<readonly MeetingSummaryActionCandidate[]>([]);
  const [meetingActionsLoaded, setMeetingActionsLoaded] = useState(false);
  const [meetingActionsCanonicalId, setMeetingActionsCanonicalId] = useState<string | null>(null);
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
  const autoResumeTaskRef = useRef('');
  const orphanedSummaryPreparationRef = useRef('');
  const summaryCarryLookupGenerationRef = useRef(0);
  const activeMeetingIdRef = useRef(meeting?.id ?? null);
  const activeMeetingRef = useRef(meeting);
  const activeMeetingScopeRef = useRef<ScopeKey | null>(null);
  const openingFollowupRef = useRef(false);
  const actionRequestGenerationRef = useRef(0);
  const handledActionFocusRequestRef = useRef<number | null>(null);
  const markerRequestGenerationRef = useRef(0);
  const markerLoadErrorShownRef = useRef(false);
  const attachmentRequestGenerationRef = useRef(0);
  const attachmentLoadErrorShownRef = useRef(false);
  const transcriptDurationHintSec = useMemo(
    () => transcriptDurationSec(transcript),
    [transcript],
  );
  const meetingQuestionsEnabled = true;
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
  useEffect(() => {
    setDeferInactiveDetailPayload(true);
    let frame: number | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      frame = requestAnimationFrame(() => setDeferInactiveDetailPayload(false));
    });
    return () => {
      task.cancel();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [route.params.meetingId]);

  useEffect(() => {
    if (!meeting) return;
    rememberMeetingDetailSession(recordingStorageScope, meeting.id, {
      activeTab: activeTabRef.current,
      summaryDocument,
      activeFactsV3: activeMeetingFactsV3,
    });
  }, [activeMeetingFactsV3, meeting, recordingStorageScope, summaryDocument]);

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
  ].join('|');
  if (manualNoteSnapshotKeyRef.current !== manualNoteSnapshotKey) {
    manualNoteSnapshotKeyRef.current = manualNoteSnapshotKey;
    manualNoteSnapshotGenerationRef.current = Math.min(
      2_147_483_647,
      manualNoteSnapshotGenerationRef.current + 1,
    );
  }
  const playbackStorageScope: 'guest' = 'guest';
  const routeMeetingIdRef = useRef(route.params.meetingId);
  routeMeetingIdRef.current = route.params.meetingId;
  const initialTab = initialActiveTab;
  const tabOwnerRef = useRef(new NativeMinutesTabSelectionOwner({
    meetingId: route.params.meetingId,
    tab: initialTab,
    generation: 0,
  }));
  const consumedTabRouteCommandRef = useRef('');

  const selectDetailTabFromReact = useCallback((target: MinutesDetailTab) => {
    const current = tabOwnerRef.current.current();
    const next = current.generation >= 2_147_483_647
      ? 2_147_483_647
      : current.generation + 1;
    if (!tabOwnerRef.current.accept({
      meetingId: route.params.meetingId,
      tab: target,
      generation: next,
    })) return;
    activeTabRef.current = target;
    rememberMeetingDetailActiveTab(recordingStorageScope, route.params.meetingId, target);
    setTabGeneration(next);
    setActiveTab(target);
  }, [recordingStorageScope, route.params.meetingId]);

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

  const refreshMeetingActions = useCallback(async () => {
    const requestedMeetingId = meeting?.id;
    if (!requestedMeetingId || !meetingScopeKey) {
      setMeetingActions([]);
      setMeetingActionsLoaded(false);
      setMeetingActionsCanonicalId(null);
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
      return state;
    } catch (reason) {
      diagnosticWarn('load meeting actions failed', reason);
      return null;
    }
  }, [meeting?.id, meetingScopeKey]);

  const loadSummaryVersions = useCallback(async () => {
    if (!meeting || !meetingScopeKey) {
      setSummaryVersionsState(null);
      setSummaryVersionsError('当前会议无法读取整理结果版本。');
      return;
    }
    const requestedMeetingId = meeting.id;
    setSummaryVersionsLoading(true);
    setSummaryVersionsError('');
    try {
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
      if (mountedRef.current && routeMeetingIdRef.current === requestedMeetingId) {
        setSummaryVersionsLoading(false);
      }
    }
  }, [meeting, meetingScopeKey]);

  const openSummaryVersions = useCallback(() => {
    setSummaryVersionsVisible(true);
    void loadSummaryVersions();
  }, [loadSummaryVersions]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Summary generation belongs to the meeting, not to this transient
      // detail presenter. Keep source upload/polling alive after navigation;
      // SQLite and the app-process coordinator expose progress elsewhere.
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
    const retainedSession = readMeetingDetailSession(recordingStorageScope, route.params.meetingId);
    setEditingAction(null);
    setActionEditorSaving(false);
    setActionEditorError('');
    setUpdatingActionId(null);
    setSummaryVersionsVisible(false);
    setActiveMeetingFactsV3(retainedSession?.activeFactsV3 ?? null);
    setSummaryEvidenceSectionId(null);
    setSummaryVersionsState(null);
    setSummaryVersionsLoading(false);
    setSummaryVersionsError('');
    setSwitchingSummaryVersionId(null);
    setSummarySectionEditorTarget(null);
    setSummarySectionEditorSaving(false);
    setSummarySectionEditorError('');
    setMeetingActions([]);
    setMeetingActionsLoaded(false);
    setMeetingActionsCanonicalId(null);
    setShareVisible(false);
    setMarkers([]);
    setMeetingAttachments([]);
    setDeletingMarkerId(null);
    setMarkerActionsId(null);
    setSpeakerAssignmentTarget(null);
    setSpeakerAssignmentSaving(false);
    setSpeakerAssignmentError('');
    actionRequestGenerationRef.current += 1;
    markerRequestGenerationRef.current += 1;
    markerLoadErrorShownRef.current = false;
    attachmentRequestGenerationRef.current += 1;
    attachmentLoadErrorShownRef.current = false;
  }, [recordingStorageScope, route.params.meetingId, meetingScopeKey]);

  useEffect(() => {
    void refreshMarkers();
  }, [refreshMarkers, transcriptCached, transcriptCompleting]);

  useFocusEffect(useCallback(() => {
    void refreshMeetingAttachments();
  }, [refreshMeetingAttachments]));

  useEffect(() => {
    void refreshMeetingActions();
  }, [refreshMeetingActions, summaryCached]);

  useEffect(() => {
    if (!meetingActionsCanonicalId || !meetingScopeKey) return undefined;
    return sqliteMeetingNoteRepository.observeMeeting(
      meetingActionsCanonicalId,
      meetingScopeKey,
      () => {
        void refreshMeetingActions();
      },
    );
  }, [meetingActionsCanonicalId, meetingScopeKey, refreshMeetingActions]);


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
    // The first frame only needs the selected page and its retained local
    // projection. Hydrating transcript, speakers, remote recovery and every
    // inactive page during the native stack transition makes a simple open
    // action pay for the whole detail controller. Transcript-focused deep
    // links remain eager; all other entries start recovery after interactions.
    if (deferInitialDetailHydration) return;
    let alive = true;
    const retainedSession = readMeetingDetailSession(recordingStorageScope, meeting.id);
    const cachedTranscript = getCachedTranscript(meeting.id);
    const cachedSummaryValue = getCachedSummary(meeting.id);
    // Re-entry must start from the exact projection that was already visible.
    // Falling back to the legacy mirror here used to replace Facts V3 for one
    // frame, then rebuild the page again after SQLite loaded.
    const cachedSummaryDocument = retainedSession?.summaryDocument
      ?? summaryDocumentFor(meeting.id, cachedSummaryValue);
    const cachedSummary = cachedSummaryDocument
      ? meetingSummaryDocumentToText(cachedSummaryDocument)
      : meetingSummaryToText(cachedSummaryValue);
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
      let activeState = null as Awaited<ReturnType<typeof loadActiveMeetingTranscriptState>>;
      if (meetingScopeKey) {
        activeState = await loadActiveMeetingTranscriptState(meetingScopeKey, meeting.id).catch(() => null);
      }
      if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
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
      setTranscriptVisualPhase(
        activeState?.completing ? 'running' : baseline.length > 0 ? 'ready' : 'idle',
      );
      setLoadingTranscript(false);
    })();
    void transcriptLoad;

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
            status: v3 ? 'facts_ready' : 'facts_missing',
          });
          baselineDocument = v3?.document ?? current.document;
          baselineText = meetingSummaryDocumentToText(baselineDocument);
          setSummary(baselineText);
          setSummaryDocument(baselineDocument);
          setActiveMeetingFactsV3(v3?.active ?? null);
          setSummaryCached(true);
        }
      }
      if (!ownsLocalSummaryRestore()) return;
      setSummaryVisualPhase(baselineText ? 'ready' : 'idle');
      setSummaryCached(Boolean(baselineText));
      setLoadingSummary(false);
    })();
    return () => {
      alive = false;
    };
  // Processing-stage changes update the canonical snapshot but must not
  // restart this loader and reset its visual phase to idle/running.
  }, [advancePageGenerations, beginPageRequest, deferInitialDetailHydration, getCachedSummary, getCachedTranscript, isCurrentPageRequest, loadProjectedMeetingFactsV3, meeting?.id, meetingScopeKey, recordingStorageScope, reloadKey]);

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
    if (!meeting || !playbackStorageScope) {
      setPlayerSources([]);
      setSelectedPlayerSourceId('');
      setPlayerSourceError('');
      setLoadingAudio(false);
      return;
    }
    const canonicalAssets = canonicalProcessingSnapshot
      && canonicalProcessingSnapshot.meetingId === meeting.id
      && canonicalProcessingSnapshot.scopeKey === meetingScopeKey
      ? canonicalProcessingSnapshot.recordingAssets
      : [];
    const localSources: MinutesPlayerSourceSnapshot[] = [];
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
          }
          return;
        }
        seenUris.add(uri);
        localSources.push(localPlayerSource(
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
        ));
      });
    const next = localSources.map((source, index) => ({
      ...source,
      label: source.label ?? `录音 ${index + 1}`,
    }));
    setPlayerSources(next);
    setSelectedPlayerSourceId(previous => (
      next.some(source => source.sourceId === previous)
        ? previous
        : next[0]?.sourceId ?? ''
    ));
    setPlayerSourceError('');
    setLoadingAudio(false);
  }, [canonicalProcessingSnapshot, meeting?.audioAvailable, meeting?.audioDurationSec, meeting?.audioLocalUri, meeting?.id, meeting?.title, meetingScopeKey, playbackStorageScope, reloadKey, transcriptDurationHintSec]);

  const performPendingAudioUpload = useCallback((
    pending: PendingMeetingAudioUpload,
    notifyUser: boolean,
  ): Promise<void> => {
    if (uploadInFlightRef.current) return uploadInFlightRef.current;
    setRetryingAudioUpload(true);
    setPendingAudioError('');
    let operation: Promise<void> | null = null;
    operation = (async () => {
      try {
        await reconcileAudioUploads();
        const latest = await getPendingMeetingAudioUpload(
          recordingStorageScope,
          pending.meetingId,
          pending.recordingAssetId,
        );
        if (!mountedRef.current) return;
        setPendingAudioUpload(latest);
        setPendingAudioError(latest?.failureMessage
          ? readableErrorMessage(latest.failureMessage, '自动同步未完成，录音仍保存在本机')
          : '');
        if (notifyUser) {
          showDialog(latest
            ? { title: '录音将在后台上传', tone: 'info' }
            : { title: '上传完成', tone: 'success' });
        }
      } catch {
        const latest = await getPendingMeetingAudioUpload(
          recordingStorageScope,
          pending.meetingId,
        ).catch(() => null);
        if (!mountedRef.current) return;
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
      } finally {
        if (mountedRef.current) setRetryingAudioUpload(false);
        if (uploadInFlightRef.current === operation) uploadInFlightRef.current = null;
      }
    })();
    uploadInFlightRef.current = operation;
    return operation;
  }, [reconcileAudioUploads, recordingStorageScope, showDialog]);

  useEffect(() => {
    let alive = true;
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
    }).catch(() => {
      if (alive) setPendingAudioError('无法读取录音待上传状态，请重试。');
    });
    return () => {
      alive = false;
    };
  }, [meeting?.id, meeting?.updatedAt, recordingStorageScope, reloadKey]);

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
    if (!meetingId) {
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
  }, [meeting?.id]);

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
    const sharedOperation = getActiveMeetingSummaryOperation(
      recordingStorageScope,
      currentMeeting.id,
    );
    if (sharedOperation) {
      setSummaryVisualPhase('background');
      setLoadingSummary(false);
      setSummaryError('');
      setSummaryProgress('正在整理会议记录');
      summaryInFlightRef.current = sharedOperation;
      void sharedOperation.finally(() => {
        if (summaryInFlightRef.current === sharedOperation) {
          summaryInFlightRef.current = null;
          if (mountedRef.current) setReloadKey(value => value + 1);
        }
      }).catch(() => undefined);
      return sharedOperation;
    }
    let lines = options.transcriptLines ?? transcript;
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
    const expectedMode = 'guest';
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
      if (mountedRef.current) {
        setSummaryVisualPhase('running');
        setLoadingSummary(true);
        setSummaryError('');
        setSummaryProgress('正在整理会议记录');
      }
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
        if (isActiveSummaryRun()) {
          setSummaryProgress('正在整理会议记录');
        }
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
        const persistTaskPointer = async (
          taskId: string,
          status: 'queued' | 'generating',
        ): Promise<void> => {
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
              setSummaryError('整理已发起，但本机恢复状态暂未保存。');
            }
          }
          if (currentMeetingScopeKey && recordedTaskStatus !== status) {
            const outcome = await recordMeetingSummaryProcessing({
              scopeKey: currentMeetingScopeKey,
              legacyMeetingId: currentMeeting.id,
              signal: {
                type: 'task_status',
                status,
                taskId,
                inputFingerprint: fingerprint,
              },
            });
            if (outcome !== 'failed') recordedTaskStatus = status;
          }
          if (isActiveSummaryRun()) autoResumeTaskRef.current = taskId;
        };
        const generated = await generateSummaryForMeeting({
          meetingId: currentMeeting.id,
          title: currentMeeting.title,
          meetingDate,
          transcriptLines: lines,
          template: requestedTemplate,
          carryForward,
          attachmentAuthorization,
          manualNote: summaryManualNote,
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
          onTaskPrepared: taskId => persistTaskPointer(taskId, 'queued'),
          onTaskSubmitted: taskId => persistTaskPointer(taskId, 'generating'),
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
        if (cached) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
      } catch (reason) {
        const taskStillRunning = isMeetingSummaryTaskPendingError(reason);
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
          setSummaryProgress('正在整理会议记录');
        } else if ((reason as Error)?.name === 'AbortError') {
          setSummaryVisualPhase('background');
          setSummaryProgress('正在整理会议记录');
        } else {
          setSummaryVisualPhase('error');
          const message = readableErrorMessage(
            reason,
            options.automatic ? '上次会议整理结果暂时无法恢复。' : '会议整理结果暂时无法生成，请稍后重试。',
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
      }
    })();
    const trackedOperation = trackMeetingSummaryOperation(
      recordingStorageScope,
      currentMeeting.id,
      operation,
    );
    summaryInFlightRef.current = trackedOperation;
    return trackedOperation;
  }

  function isOwnedSummaryCarryLookup(
    generation: number,
    meetingId: string,
    scopeKey: ScopeKey,
  ): boolean {
    return summaryCarryLookupGenerationRef.current === generation
      && activeMeetingIdRef.current === meetingId
      && activeMeetingScopeRef.current === scopeKey;
  }

  async function continueSummaryAfterAttachmentSelection(input: {
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
  }, attachmentAuthorization: MeetingSummaryAttachmentAuthorization | null): Promise<void> {
    await runSummaryTask({
      forceRegenerate: input.forceRegenerate,
      template: input.template,
      carryForward: null,
      attachmentAuthorization,
    });
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
    setSummaryProgress('正在整理会议记录');
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
      if (!isOwnedSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      if (!mountedRef.current) {
        await runSummaryTask({
          forceRegenerate,
          template,
          carryForward: null,
          attachmentAuthorization: null,
        });
        return;
      }
      if (attachments.length > 0) {
        setSummaryProgress('正在整理会议记录');
        setSummaryAttachmentRequest({ ...input, attachments, imageSelectionEnabled });
        return;
      }
      await continueSummaryAfterAttachmentSelection(input, null);
    } catch {
      if (!isOwnedSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      if (!mountedRef.current) {
        await runSummaryTask({
          forceRegenerate,
          template,
          carryForward: null,
          attachmentAuthorization: null,
        });
        return;
      }
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

  useEffect(() => navigation.addListener('beforeRemove', () => {
    // Optional attachments and cross-meeting references require an explicit
    // foreground authorization. If the user leaves before choosing, continue
    // the already-requested summary with the current meeting transcript and
    // note instead of cancelling the operation or leaving a false queued row.
    if (summaryInFlightRef.current) return;
    if (summaryAttachmentRequest) {
      void runSummaryTask({
        forceRegenerate: summaryAttachmentRequest.forceRegenerate,
        template: summaryAttachmentRequest.template,
        carryForward: null,
        attachmentAuthorization: null,
      });
      return;
    }
    if (summaryCarryForwardRequest) {
      void runSummaryTask({
        forceRegenerate: summaryCarryForwardRequest.forceRegenerate,
        template: summaryCarryForwardRequest.template,
        carryForward: null,
        attachmentAuthorization: summaryCarryForwardRequest.attachmentAuthorization,
      });
    }
  }), [navigation, summaryAttachmentRequest, summaryCarryForwardRequest]);

  useEffect(() => {
    if (
      !meeting
      || !meetingScopeKey
      || manualNote.loading
      || summaryInFlightRef.current
      || transcript.length === 0
    ) return;
    let alive = true;
    const requestedMeetingId = meeting.id;
    const requestedMeetingScopeKey = meetingScopeKey;
    const date = meetingDateForSummary(meeting.date, meeting.createdAt);
    const expectedMode = 'guest';
    // Pending-task recovery is meeting-owned, not a summary-page read. A
    // normal facts/version refresh advances the page request generation during
    // cold start; using that generation here silently suppressed recovery and
    // left a durable intent stuck in the active state. Only a real meeting/scope
    // replacement may invalidate this recovery lookup.
    const ownsPendingSummaryRecovery = () => (
      alive
      && activeMeetingIdRef.current === requestedMeetingId
      && activeMeetingScopeRef.current === requestedMeetingScopeKey
    );
    void getPendingMeetingSummaryTask(recordingStorageScope, meeting.id).then(async pending => {
      if (!ownsPendingSummaryRecovery()) return;
      if (
        pending
        && autoResumeTaskRef.current === pending.taskId
        && (
          summaryInFlightRef.current
          || getActiveMeetingSummaryOperation(recordingStorageScope, meeting.id)
        )
      ) return;
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
      const resumableFactsV3Task = pending.taskId.startsWith('vnext-summary:');
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
      autoResumeTaskRef.current = pending.taskId;
      void runSummaryTask({
        automatic: true,
        resumeTask: pending,
        transcriptLines: transcript,
        template: pendingTemplate,
      });
    }).catch(() => {
      if (ownsPendingSummaryRecovery()) {
        setSummaryVisualPhase('error');
        setSummaryError('无法读取上次整理任务。');
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
  }, [manualNote.loading, meeting?.createdAt, meeting?.date, meeting?.id, meeting?.title, meetingScopeKey, processingStatuses.summary, recordingStorageScope, transcript]);

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
    const stageAgeMs = Math.max(0, Date.now() - stage.updatedAtMs);
    const orphanCheckDelayMs = Math.max(
      500,
      SUMMARY_PREPARATION_ORPHAN_GRACE_MS - stageAgeMs,
    );
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
    }, orphanCheckDelayMs);
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
      || manualNote.loading
      || summaryInFlightRef.current
      || transcript.length === 0
      || !meetingScopeKey
      || !summaryStageIsActive(processingStatuses.summary)
    ) return;
    const stage = canonicalProcessingSnapshot?.stages.find(item => item.stage === 'summary');
    if (!stage?.jobId) return;
    if (
      autoResumeTaskRef.current === stage.jobId
      && (
        summaryInFlightRef.current
        || getActiveMeetingSummaryOperation(recordingStorageScope, meeting.id)
      )
    ) return;
    const template = summaryDocument?.templateId
      ? meetingTemplateById(summaryDocument.templateId, summaryDocument.templateRevision)
      : DEFAULT_MEETING_TEMPLATE;
    if (!template) return;
    autoResumeTaskRef.current = stage.jobId;
    void runSummaryTask({
      automatic: true,
      resumeTask: {
        meetingId: meeting.id,
        taskId: stage.jobId,
        mode: 'guest',
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
  }, [canonicalProcessingSnapshot, manualNote.loading, meeting, meetingScopeKey, processingStatuses.summary, recordingStorageScope, summaryDocument?.templateId, summaryDocument?.templateRevision, transcript]);

  useEffect(() => {
    const target = explicitDetailTab(route.params.focus);
    if (!target) return;
    const commandKey = [
      route.params.meetingId,
      target,
      route.params.actionFocusRequestId ?? 0,
      route.params.transcriptFocusRequestId ?? 0,
    ].join('|');
    if (consumedTabRouteCommandRef.current === commandKey) return;
    consumedTabRouteCommandRef.current = commandKey;
    selectDetailTabFromReact(target);
  }, [
    route.params.actionFocusRequestId,
    route.params.focus,
    route.params.meetingId,
    route.params.transcriptFocusRequestId,
    selectDetailTabFromReact,
  ]);

  const briefSummary = useMemo(
    () => briefGreetingSummaryText(transcript),
    [transcript],
  );
  const displayedSummary = summary || briefSummary || '';
  const snapshotTranscript = !deferInactiveDetailPayload
    || activeTab === 'transcript'
    || activeTab === 'speakers'
    ? transcript
    : EMPTY_TRANSCRIPT_PAYLOAD;
  const fullDisplayedSummaryDocument = summary && summaryDocument?.meetingId === (meeting?.id ?? route.params.meetingId)
    ? summaryDocument
    : null;
  const displayedSummaryDocument = fullDisplayedSummaryDocument;
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
  const displayedActionCandidates = useMemo(
    () => dedupeMeetingSummaryActions(sourceActionCandidates).filter(action => action.status !== 'dismissed'),
    [sourceActionCandidates],
  );
  const summaryActionCandidates = useMemo(
    () => displayedActionCandidates.filter(action => (
      action.sourceKind === undefined || action.sourceKind === 'generated'
    )),
    [displayedActionCandidates],
  );

  const openSummaryEvidenceCitation = useCallback((citation: MeetingSummaryCitation) => {
    setSummaryEvidenceSectionId(null);
    if (citation.sourceType && citation.sourceType !== 'transcript') return;
    const requestId = Date.now();
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
  }, [activeMeetingFactsV3, displayedActionCandidates, displayedSummary, displayedSummaryDocument, getCachedSummary, manualNote.content, markers, meeting, meetingAttachments, playerSource, sharing, showDialog, summaryTemplate, transcript]);

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
  }, [deleteMeeting, manualNote.flush, meeting, navigation, refreshRecycleCapability, showDialog]);

  const openSpeakerAssignment = useCallback((action: EditTranscriptSpeakerAction) => {
    if (!meeting || action.meetingId !== meeting.id) return;
    if (action.revisionKind === 'realtimeDraft') {
      ToastAndroid.show('文字记录生成中，暂不能修改讲话人。', ToastAndroid.LONG);
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
      ToastAndroid.show('文字记录生成中，暂不能修改讲话人。', ToastAndroid.LONG);
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
    void fetchDeviceSpeakerProfiles().then(profiles => {
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
  }, [speakerAssignmentTarget?.lineId]);

  const manageSpeaker = useCallback((speakerId?: string) => {
    if (speakerId && speakerId !== 'unknown') {
      navigation.navigate('SpeakerEnrollment', { speakerId });
    } else {
      navigation.navigate('SpeakerManager');
    }
  }, [navigation]);

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
  }, [activeMeetingFactsV3, advancePageGenerations, manualNote.revision, meeting, meetingScopeKey, refreshCanonicalSummary, summaryDocument, summarySectionEditorSaving, summarySectionEditorTarget, transcript]);

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
        ToastAndroid.show('文字记录生成中，暂不能修改讲话人。', ToastAndroid.LONG);
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
      advancePageGenerations('summary');
      setSummaryVersionsVisible(false);
    } catch (reason) {
      setSummaryVersionsError(reason instanceof MeetingSummaryVersionConflictError
        ? '整理结果版本已发生变化，请重新加载后再选择。'
        : '整理结果版本暂时无法切换，请稍后重试。');
    } finally {
      if (mountedRef.current) setSwitchingSummaryVersionId(null);
    }
  }, [advancePageGenerations, meeting, meetingScopeKey, refreshCanonicalSummary, summaryVersionsState, switchingSummaryVersionId]);

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
  }, [displayedActionCandidates, showDialog]);

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

  const openQuestionCitation = useCallback((target: MeetingQuestionCitationTarget) => {
    // This callback can be created before the asynchronous meetings owner has
    // hydrated `meeting`.  Gate against the stable navigation identity rather
    // than capturing that transient value; otherwise a valid citation closes
    // the sheet but is silently ignored after a cold start.
    if (target.meetingId !== route.params.meetingId) return;
    const requestId = Date.now();
    if (target.kind === 'transcript') {
      navigation.setParams({
        focus: 'transcript',
        segmentId: target.segmentId,
        positionMs: target.positionMs,
        transcriptFocusRequestId: requestId,
      });
      return;
    }
    if (target.kind === 'summary') {
      navigation.setParams({
        focus: 'summary',
        actionId: undefined,
        actionFocusRequestId: requestId,
      });
      return;
    }
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
      if (!meetingScopeKey) {
        setReloadKey(value => value + 1);
        return;
      }
      const requestedMeetingId = meeting.id;
      void retryDeviceTranscriptTask(requestedMeetingId).then(() => {
        if (!mountedRef.current || routeMeetingIdRef.current !== requestedMeetingId) return;
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
      setReloadKey(value => value + 1);
      void refreshMeetings().catch(() => {});
    }
  }

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
        // Leaving a detail surface is navigation, not a save transaction. The
        // note hook already owns autosave and unmount flush; waiting here made
        // every tab pay for an unrelated persistence operation.
        void manualNote.flush();
        navigation.goBack();
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
        // Native owns a user-initiated page transition and has already rendered
        // the selected tab. Mirroring it through React rebuilt, hashed, stored,
        // and returned the entire meeting snapshot for no visible gain.
        activeTabRef.current = action.tab;
        rememberMeetingDetailActiveTab(recordingStorageScope, action.meetingId, action.tab);
        if (action.tab === 'transcript' || action.tab === 'speakers') {
          setDeferInactiveDetailPayload(false);
        }
        break;
      case 'updateManualNote':
        if (!meeting || action.meetingId !== meeting.id) break;
        manualNote.updateContent(action.content);
        break;
      case 'retryManualNote':
        if (!meeting || action.meetingId !== meeting.id) break;
        void manualNote.retry();
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
      case 'openSummaryBlocks':
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
      case 'actionToEvent':
        if (action.meetingId !== route.params.meetingId) break;
        void openMeetingActionFollowup(action.actionId);
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
  }, [activeMeetingFactsV3, fullDisplayedSummaryDocument, loadingSummary, manageSpeaker, manualNote, markers, meeting, navigation, openMeetingActionCreator, openMeetingActionEditor, openMeetingActionFollowup, openSpeakerAssignment, openSummarySectionEditor, playerSources, processingStatuses, recordingStorageScope, removeMarker, requestMeetingLocation, retryProcessingStage, route.params.meetingId, runRecordingMerge, sharing, showDialog, summary, summaryTemplate, summaryVisualPhase, toggleMeetingAction]);

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
    || summaryVisualPhase === 'running';
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
    if (transcriptStageLoading && transcriptCompleting) {
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
    transcript: snapshotTranscript,
    actionItemCandidates: summaryActionCandidates,
    markers: markers.map(marker => ({
      id: marker.id,
      positionMs: marker.positionMs,
      nearestSegmentId: marker.nearestSegmentId,
      label: marker.label,
      deleting: marker.id === deletingMarkerId,
    })),
    summaryDocument: displayedSummaryDocument,
    transcriptLoading: Boolean(meeting && (transcriptStageLoading || deviceTranscriptPending)),
    transcriptStatusMessage: deviceTranscriptPending
      ? (deviceTranscriptTask?.phase === 'running' ? '正在生成文字记录' : '等待生成文字记录')
      : transcriptStageMessage || (transcriptCompleting ? '文字记录仍在补全' : ''),
    summaryLoading: Boolean(meeting && summaryOperationActive),
    transcriptError: meeting
      ? (deviceTranscriptFailed ? '文字处理未完成' : transcriptStageError || transcriptError)
      : '请返回会议列表后重新打开。',
    summaryError: summaryStageError || (briefSummary ? '' : summaryError),
    summaryProgress: summaryOperationActive ? summaryProgress || '正在整理会议记录' : summaryProgress,
    canShare: Boolean(meeting && !sharing),
    // Speaker profiles are device/epoch-owned in the accountless product.
    // The detail page must keep the native row actionable even without an
    // account; the callback selects the device service when no token exists.
    canManageSpeakers: Boolean(meeting),
    canGenerateSummary: Boolean(meeting && transcript.length > 0),
    canEditSummary: Boolean(
      meetingScopeKey
      && displayedSummaryDocument?.remoteVersionId
      && !loadingSummary
      && !summaryOperationActive
    ),
    canCreateAction: false,
    canShareActions: false,
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
    processingRetryStage: detailProcessingPresentation.retryStage ?? undefined,
    processingRetrying,
    recordingMergeStatusLabel,
    recordingMergeActionLabel,
    recordingMergeActionEnabled: !recordingMergeBusy && Boolean(recordingMergeActionLabel),
  }), [activeMeetingFactsV3, activeTab, briefSummary, deletingMarkerId, detailProcessingPresentation.label, detailProcessingPresentation.retryStage, detailProcessingPresentation.tone, deviceTranscriptFailed, deviceTranscriptPending, deviceTranscriptTask?.phase, displayedSummary, displayedSummaryDocument, focusedTab, loadingAudio, loadingSummary, loadingTranscript, locationLoading, manualNote.content, manualNote.enabled, manualNote.error, manualNote.loading, manualNote.retryable, manualNote.revision, manualNote.saving, markers, meeting, meetingScopeKey, pageGenerations, playerSource, playerSourceError, playerSources, processingRetrying, recordingMergeActionLabel, recordingMergeBusy, recordingMergeStatusLabel, route.params.actionFocusRequestId, route.params.actionId, route.params.focus, route.params.meetingId, route.params.positionMs, route.params.segmentId, route.params.transcriptFocusRequestId, sharing, snapshotTranscript, summaryActionCandidates, summaryCached, summaryError, summaryOperationActive, summaryProgress, summaryStageError, summaryStageLoading, summaryConfirmedCurrent, tabGeneration, transcript.length, transcriptCached, transcriptCompleting, transcriptError, transcriptStageError, transcriptStageLoading, transcriptStageMessage, updatingActionId]);
  const snapshot = useNativeProjection(snapshotBody, {
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
      { key: 'delete', label: '删除会议', destructive: true, onPress: confirmDelete },
    ];
  }, [confirmDelete, displayedActionCandidates.length, manualNote.flush, meeting, meetingAttachments.length, meetingQuestionsEnabled, meetingScopeKey, openMeetingActions, openMeetingAttachments, openSummaryVersions, summaryDocument?.remoteVersionId]);

  const markerForActions = useMemo(
    () => markers.find(marker => marker.id === markerActionsId) ?? null,
    [markerActionsId, markers],
  );
  const markerAttachmentCount = useMemo(() => markerForActions
    ? meetingAttachments.filter(attachment => attachment.markerId === markerForActions.id).length
    : 0, [markerForActions, meetingAttachments]);
  const markerItems = useMemo<AppActionSheetItem[]>(() => markerForActions ? [
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
  ] : [], [markerAttachmentCount, markerForActions, openMeetingActionCreator, openMeetingAttachments, shareMarker]);

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
        onClose={() => setShareVisible(false)}
        onShare={requestShare}
      />
      <MeetingQuestionSheet
        visible={questionVisible}
        meetingTitle={displayMeetingTitle(meeting?.title ?? '')}
        meetingId={meeting?.id ?? route.params.meetingId}
        scopeKey={meetingScopeKey}
        onClose={() => setQuestionVisible(false)}
        onOpenCitation={openQuestionCitation}
      />
      <MeetingActionsSheet
        visible={meetingActionsVisible}
        actions={displayedActionCandidates}
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
