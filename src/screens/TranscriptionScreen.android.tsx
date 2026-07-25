import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
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
import {
  MeetingActionConflictSheet,
  type MeetingActionConflictChoice,
} from '../components/MeetingActionConflictSheet';
import {
  MeetingManualNoteConflictSheet,
  type MeetingManualNoteConflictChoice,
} from '../components/MeetingManualNoteConflictSheet';
import {
  MeetingRootConflictSheet,
  type MeetingRootConflictChoice,
} from '../components/MeetingRootConflictSheet';
import {
  MeetingSummaryVersionSheet,
  type MeetingSummaryVersionChoice,
} from '../components/MeetingSummaryVersionSheet';
import {
  MeetingSpeakerAssignmentSheet,
  type MeetingSpeakerAssignmentValue,
} from '../components/MeetingSpeakerAssignmentSheet';
import { MeetingTemplateSheet } from '../components/MeetingTemplateSheet';
import { MeetingSummaryAttachmentSheet } from '../components/MeetingSummaryAttachmentSheet';
import { MeetingSummaryCarryForwardSheet } from '../components/MeetingSummaryCarryForwardSheet';
import { MeetingShareSheet } from '../components/MeetingShareSheet';
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
import { resolveMeetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  getPendingMeetingAudioUpload,
  retryPendingMeetingAudioUpload,
  type PendingMeetingAudioUpload,
} from '../services/meetingRecording';
import {
  generateSummaryForMeeting,
  briefGreetingSummaryText,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  normalizeMeetingSummaryResult,
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryInputFingerprint,
  savePendingMeetingSummaryTask,
  type PendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import {
  meetingSummaryProcessingFailureCode,
  recordMeetingSummaryProcessing,
} from '../services/meetingSummaryProcessing';
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
  type MeetingProcessingStatuses,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingTemplate,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingSummaryActionCandidate,
  type MeetingSummaryDocument,
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
import { materializeMeetingPlaybackAudio } from '../services/meetingPlaybackCache';
import { useMeetingManualNote } from '../hooks/useMeetingManualNote';
import { loadActiveMeetingTranscriptState } from '../services/meetingTranscriptState';
import { deleteMeetingMarker, loadMeetingMarkers } from '../services/meetingMarkers';
import { loadMeetingAttachments } from '../services/meetingAttachments';
import { loadMeetingActions } from '../services/meetingActions';
import { pullMeetingActionsForDetail } from '../services/meetingActionPull';
import type { MeetingActionSyncConflictView } from '../services/meetingActionConflicts';
import { pullMeetingManualNote } from '../services/meetingManualNotePull';
import {
  loadMeetingManualNoteSyncConflict,
  type MeetingManualNoteSyncConflictView,
} from '../services/meetingManualNoteConflicts';
import {
  loadMeetingRootSyncConflict,
  type MeetingRootSyncConflictView,
} from '../services/meetingRootConflicts';
import { shareMeetingMarkerText } from '../services/meetingMarkerShare';
import {
  evaluateTranscriptLineCandidate,
  shouldRecheckTranscriptRemoteCandidate,
} from '../services/transcriptCompleteness';
import {
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
  MeetingRootSyncConflictChangedError,
  MeetingSummaryVersionConflictError,
  MeetingSummaryVersionUnavailableError,
  loadMeetingRecordingMergeRecovery,
  mergeDetachedMeetingRecordings,
  type MeetingRecordingMergeRecoveryState,
  SelectMeetingSummaryVersionUseCase,
  RetryMeetingSpeakerCorrectionSyncUseCase,
  ResolveMeetingActionSyncConflictUseCase,
  ResolveMeetingManualNoteSyncConflictUseCase,
  ResolveMeetingRootSyncConflictUseCase,
  UpdateMeetingActionUseCase,
  UpdateMeetingSpeakerAssignmentUseCase,
  SpeakerAssignmentDraftError,
  SpeakerAssignmentTargetUnavailableError,
} from '../application/meeting';
import {
  sqliteMeetingNoteRepository,
  type MeetingAttachmentRecord,
  type MarkerRecord,
  type RecordingAssetRecord,
  type SummaryVersionRecord,
} from '../data/repositories';
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

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

type EditTranscriptSpeakerAction = Extract<MinutesSemanticAction, { type: 'editTranscriptSpeaker' }>;

type SpeakerAssignmentTarget = EditTranscriptSpeakerAction & {
  clusterCount: number;
};

type CanonicalProcessingSnapshot = {
  meetingId: string;
  canonicalMeetingId: string;
  scopeKey: ScopeKey;
  stages: readonly ProcessingStage[];
  recordingAssets: readonly RecordingAssetRecord[];
  recordingMergeRecovery: MeetingRecordingMergeRecoveryState;
};

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
  } = {},
): MinutesPlayerSourceSnapshot {
  return {
    sourceId: options.sourceId ?? `local:${meetingId}`,
    uri,
    label: options.label,
    localOnly: options.localOnly,
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

const TRANSCRIPT_COMPLETION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const TRANSCRIPT_COMPLETION_RECHECK_MS = 15_000;

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
const resolveMeetingRootSyncConflictUseCase = new ResolveMeetingRootSyncConflictUseCase(
  sqliteMeetingNoteRepository,
);
const selectMeetingSummaryVersionUseCase = new SelectMeetingSummaryVersionUseCase(sqliteMeetingNoteRepository);
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
  return template.id === 'general' ? '通用整理' : template.title;
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
  const {
    meetings,
    deleteMeeting,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
    refreshMeetings,
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
  const [summary, setSummary] = useState(() => meeting ? meetingSummaryToText(getCachedSummary(meeting.id)) : '');
  const [summaryDocument, setSummaryDocument] = useState<MeetingSummaryDocument | null>(() => (
    meeting ? summaryDocumentFor(meeting.id, getCachedSummary(meeting.id)) : null
  ));
  const [summaryTemplate, setSummaryTemplate] = useState<MeetingTemplate>(() => {
    const cached = meeting ? summaryDocumentFor(meeting.id, getCachedSummary(meeting.id)) : null;
    return meetingTemplateById(cached?.templateId, cached?.templateRevision) ?? DEFAULT_MEETING_TEMPLATE;
  });
  const [templateSheetVisible, setTemplateSheetVisible] = useState(false);
  const [summaryAttachmentRequest, setSummaryAttachmentRequest] = useState<{
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
    attachments: readonly MeetingAttachmentRecord[];
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
  const [moreVisible, setMoreVisible] = useState(false);
  const [questionVisible, setQuestionVisible] = useState(false);
  const [pendingAudioUpload, setPendingAudioUpload] = useState<PendingMeetingAudioUpload | null>(null);
  const [pendingAudioError, setPendingAudioError] = useState('');
  const [playerSourceError, setPlayerSourceError] = useState('');
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [recordingMergeBusy, setRecordingMergeBusy] = useState(false);
  const [retryingAudioUpload, setRetryingAudioUpload] = useState(false);
  const [retryingSpeakerCorrection, setRetryingSpeakerCorrection] = useState(false);
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
  const [rootConflict, setRootConflict] = useState<MeetingRootSyncConflictView | null>(null);
  const [rootConflictTarget, setRootConflictTarget] = useState<MeetingRootSyncConflictView | null>(null);
  const [rootConflictSaving, setRootConflictSaving] = useState(false);
  const [rootConflictError, setRootConflictError] = useState('');
  const [markers, setMarkers] = useState<readonly MarkerRecord[]>([]);
  const [meetingAttachments, setMeetingAttachments] = useState<readonly MeetingAttachmentRecord[]>([]);
  const [deletingMarkerId, setDeletingMarkerId] = useState<string | null>(null);
  const [markerActionsId, setMarkerActionsId] = useState<string | null>(null);
  const [speakerAssignmentTarget, setSpeakerAssignmentTarget] = useState<SpeakerAssignmentTarget | null>(null);
  const [speakerAssignmentSaving, setSpeakerAssignmentSaving] = useState(false);
  const [speakerAssignmentError, setSpeakerAssignmentError] = useState('');
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
  const summaryCarryLookupGenerationRef = useRef(0);
  const activeMeetingIdRef = useRef(meeting?.id ?? null);
  const activeMeetingScopeRef = useRef<ScopeKey | null>(null);
  const openingFollowupRef = useRef(false);
  const actionRequestGenerationRef = useRef(0);
  const manualNoteConflictRequestGenerationRef = useRef(0);
  const rootConflictRequestGenerationRef = useRef(0);
  const markerRequestGenerationRef = useRef(0);
  const markerLoadErrorShownRef = useRef(false);
  const attachmentRequestGenerationRef = useRef(0);
  const attachmentLoadErrorShownRef = useRef(false);
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const meetingScopeKey: ScopeKey | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  const meetingQuestionsEnabled = getFeatureFlags().meetingQuestionsV1;
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
  const processingStatusLabel = processingPresentation.label === '已完成'
    || processingPresentation.label === '未开始'
    ? ''
    : processingPresentation.label;
  activeMeetingIdRef.current = meeting?.id ?? null;
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

  const refreshRootConflict = useCallback(async () => {
    const requestedMeetingId = meeting?.id ?? route.params.meetingId;
    if (!requestedMeetingId || !meetingScopeKey || meetingScopeKey === 'guest') {
      setRootConflict(null);
      setRootConflictTarget(null);
      return null;
    }
    const generation = rootConflictRequestGenerationRef.current + 1;
    rootConflictRequestGenerationRef.current = generation;
    try {
      const conflict = await loadMeetingRootSyncConflict(meetingScopeKey, requestedMeetingId);
      if (
        !mountedRef.current
        || rootConflictRequestGenerationRef.current !== generation
        || routeMeetingIdRef.current !== requestedMeetingId
      ) return null;
      setRootConflict(conflict);
      setRootConflictTarget(current => current && conflict?.id === current.id ? conflict : null);
      return conflict;
    } catch (reason) {
      diagnosticWarn('load meeting root conflict failed', reason);
      return null;
    }
  }, [meeting?.id, meetingScopeKey, route.params.meetingId]);

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
              void refreshRootConflict();
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
  }, [meeting?.id, meetingScopeKey, refreshRootConflict]);

  useEffect(() => {
    setEditingAction(null);
    setActionEditorSaving(false);
    setActionEditorError('');
    setUpdatingActionId(null);
    setSummaryVersionsVisible(false);
    setTemplateSheetVisible(false);
    setSummaryVersionsState(null);
    setSummaryVersionsLoading(false);
    setSummaryVersionsError('');
    setSwitchingSummaryVersionId(null);
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
    setRootConflict(null);
    setRootConflictTarget(null);
    setRootConflictSaving(false);
    setRootConflictError('');
    setShareVisible(false);
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
    rootConflictRequestGenerationRef.current += 1;
    markerRequestGenerationRef.current += 1;
    markerLoadErrorShownRef.current = false;
    attachmentRequestGenerationRef.current += 1;
    attachmentLoadErrorShownRef.current = false;
  }, [route.params.meetingId, meetingScopeKey]);

  useEffect(() => {
    setSummaryTemplate(
      meetingTemplateById(summaryDocument?.templateId, summaryDocument?.templateRevision)
        ?? DEFAULT_MEETING_TEMPLATE,
    );
  }, [route.params.meetingId, summaryDocument?.templateId, summaryDocument?.templateRevision]);

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
    void refreshManualNoteConflict();
  }, [refreshManualNoteConflict]);

  useEffect(() => {
    void refreshRootConflict();
  }, [refreshRootConflict]);

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
              const [, notePull] = await Promise.all([
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
              ]);
              if (notePull.outcome === 'updated' || notePull.outcome === 'attached') {
                await manualNote.reload();
              }
              await refreshManualNoteConflict();
            } finally {
              controller = null;
            }
          }
        } catch (reason) {
          if (active) diagnosticWarn('pull meeting actions for detail failed', reason);
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
  }, [accessToken, isGuest, manualNote.flush, manualNote.reload, meetingActionsCanonicalId, meetingScopeKey, refreshManualNoteConflict, remoteMeetingId]);

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
    setLoadingSummary(false);

    setLoadingTranscript(true);
    void (async () => {
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
        const activeDecision = evaluateTranscriptLineCandidate(baseline, activeState.lines, {
          candidateKind: activeState.kind,
          serverCompleteness: activeState.kind === 'realtime_draft' ? 'incomplete' : 'complete',
        });
        if (activeDecision.useCandidate) {
          baseline = activeState.lines;
          baselineCached = true;
        }
      }
      setTranscript(baseline);
      setTranscriptCached(baselineCached);
      setTranscriptCompleting(activeState?.completing ?? false);
      if (isGuest || !accessToken) {
        setLoadingTranscript(false);
        return;
      }
      if (!remoteMeetingId) {
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
          const decision = evaluateTranscriptLineCandidate(baseline, remote.items, {
            candidateKind,
            serverCompleteness: remote.completeness,
          });
          const preserveStableFinal = hasStableFinal && remote.completeness === 'incomplete';
          let cacheWriteFailure: unknown = null;
          if (!preserveStableFinal) {
            try {
              await saveCachedTranscript(meeting.id, remote.items, {
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
            selected = refreshedActive.lines;
            selectedCached = true;
          } else if (!preserveStableFinal && decision.useCandidate) {
            selected = remote.items;
            selectedCached = cacheWriteFailure === null && remote.items.length > 0;
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

          if (cacheWriteFailure !== null) {
            if (meetingScopeKey) {
              await mirrorLegacyTranscriptSaveFailure(meetingScopeKey, meeting.id, cacheWriteFailure);
            }
            if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
            setTranscriptCompleting(false);
            setTranscriptError(hasStableFinal ? '' : '文字记录已同步，但本机缓存写入失败。');
            break;
          }
          if (remote.remoteState === 'failed') {
            if (meetingScopeKey) {
              await mirrorLegacyTranscriptProcessingFailure(
                meetingScopeKey,
                meeting.id,
                'remote_processing',
                new Error('remote transcript processing failed'),
              );
            }
            if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
            setTranscriptCompleting(false);
            setTranscriptError(hasStableFinal ? '' : '文字处理失败，可重试。');
            break;
          }

          setTranscriptError('');
          if (!shouldRecheckTranscriptRemoteCandidate(
            remote.remoteState,
            decision,
            hasStableFinal,
          )) break;
          setTranscriptCompleting(!hasStableFinal);
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
          setTranscriptError(hasStableFinal ? '' : '文字记录同步失败，当前显示本机缓存。');
        }
      } finally {
        if (alive && isCurrentPageRequest(transcriptRequest)) setLoadingTranscript(false);
      }
    })();

    const summaryRequest = beginPageRequest(meeting.id, 'summary');
    void (async () => {
      let baselineText = cachedSummary;
      let baselineDocument = cachedSummaryDocument;
      if (meetingScopeKey) {
        const current = await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(() => null);
        if (!alive || !isCurrentPageRequest(summaryRequest)) return;
        if (current) {
          baselineDocument = current.document;
          baselineText = meetingSummaryDocumentToText(current.document);
          setSummary(baselineText);
          setSummaryDocument(current.document);
          setSummaryCached(true);
        }
      }
      if (!meeting.hasSummary || isGuest || !accessToken) return;
      setLoadingSummary(true);
      setSummaryProgress('正在同步整理结果');
      try {
        if (!remoteMeetingId) throw new Error('meeting remote identity is pending');
        const value = await fetchMeetingSummaryDetail(remoteMeetingId, accessToken);
        if (!alive || !isCurrentPageRequest(summaryRequest)) return;
        const normalized = normalizeMeetingSummaryResult(meeting.id, value);
        const text = meetingSummaryToText(normalized);
        if (normalized && text) {
          const generatedDocument = summaryDocumentFor(meeting.id, normalized);
          try {
            const cacheResult = await saveCachedSummary(meeting.id, normalized);
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            const shouldReadCanonical = Boolean(
              meetingScopeKey
              && (cacheResult.projection === 'preserved' || cacheResult.mirrorStatus === 'activated'),
            );
            const current = shouldReadCanonical && meetingScopeKey
              ? await loadCurrentMeetingSummaryState(meetingScopeKey, meeting.id).catch(() => null)
              : null;
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            setSummary(current ? meetingSummaryDocumentToText(current.document) : text);
            setSummaryDocument(current?.document ?? generatedDocument);
            setSummaryCached(true);
          } catch {
            if (!alive || !isCurrentPageRequest(summaryRequest)) return;
            setSummary(text);
            setSummaryDocument(generatedDocument);
            setSummaryCached(false);
            setSummaryError('整理结果已同步，但本机缓存写入失败。');
          }
        } else {
          setSummary(baselineText);
          setSummaryDocument(baselineDocument);
          setSummaryCached(Boolean(baselineText));
        }
      } catch {
        if (alive && isCurrentPageRequest(summaryRequest)) {
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
  }, [accessToken, advancePageGenerations, beginPageRequest, getCachedSummary, getCachedTranscript, isCurrentPageRequest, isGuest, meeting?.hasSummary, meeting?.id, meetingScopeKey, reloadKey, remoteMeetingId, saveCachedSummary, saveCachedTranscript]);

  useEffect(() => {
    if (!meeting) {
      setPlayerSources([]);
      setSelectedPlayerSourceId('');
      setPlayerSourceError('');
      setLoadingAudio(false);
      return;
    }
    let alive = true;
    setPlayerSourceError('');
    if (!playbackStorageScope) {
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
    const seenUris = new Set<string>();
    if (meeting.audioLocalUri) {
      seenUris.add(meeting.audioLocalUri);
      localSources.push(localPlayerSource(
        meeting.id,
        displayMeetingTitle(meeting.title),
        meeting.audioLocalUri,
        playbackStorageScope,
        meeting.audioDurationSec ?? transcriptDurationSec(transcript),
        { localOnly: !meeting.audioAvailable },
      ));
    }
    canonicalAssets
      .filter(asset => asset.localState === 'local_ready' && Boolean(asset.localUri))
      .forEach(asset => {
        const uri = asset.localUri!;
        if (seenUris.has(uri)) return;
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
          },
        ));
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
    const hasPrimaryLocal = Boolean(meeting.audioLocalUri) || canonicalAssets.some(asset => (
      asset.role === 'primary' && asset.localState === 'local_ready' && Boolean(asset.localUri)
    ));
    if (hasPrimaryLocal || isGuest || !accessToken) {
      setLoadingAudio(false);
      return () => { alive = false; };
    }
    setLoadingAudio(true);
    if (!remoteMeetingId) {
      setLoadingAudio(false);
      if (localSources.length === 0) setPlayerSourceError('会议正在同步，请稍后重试。');
      return () => { alive = false; };
    }
    void fetchMeetingAudioInfo(remoteMeetingId, accessToken)
      .then(async info => {
        if (!alive || !info) return;
        if (!playbackStorageScope) return;
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
        commitSources([
          cloudSource,
          ...localSources.filter(source => source.uri !== cloudSource.uri),
        ]);
        setPlayerSourceError('');
      })
      .catch(() => {
        if (alive) {
          commitSources(localSources);
          setPlayerSourceError(localSources.length > 0
            ? '云端录音加载失败，本机录音仍可播放。'
            : '录音文件加载失败，请稍后重试。');
        }
      })
      .finally(() => { if (alive) setLoadingAudio(false); });
    return () => { alive = false; };
  }, [accessToken, canonicalProcessingSnapshot, isGuest, meeting?.audioAvailable, meeting?.audioDurationSec, meeting?.audioLocalUri, meeting?.id, meeting?.title, meeting?.updatedAt, meetingScopeKey, playbackStorageScope, reloadKey, remoteMeetingId, transcript]);

  const performPendingAudioUpload = useCallback((
    pending: PendingMeetingAudioUpload,
    notifyUser: boolean,
  ): Promise<void> => {
    if (!accessToken) return Promise.resolve();
    if (uploadInFlightRef.current) return uploadInFlightRef.current;
    setRetryingAudioUpload(true);
    setPendingAudioError('');
    let operation: Promise<void> | null = null;
    operation = (async () => {
      try {
        const uploaded = await retryPendingMeetingAudioUpload(
          recordingStorageScope,
          pending.meetingId,
          accessToken,
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
        if (uploaded) await refreshMeetings();
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
  }, [accessToken, recordingStorageScope, refreshMeetings, showDialog]);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!meeting || isGuest) {
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
      if (!pending || !accessToken) return;
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
  }, [accessToken, isGuest, meeting?.id, performPendingAudioUpload, recordingStorageScope, reloadKey]);

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
    const lines = options.transcriptLines ?? transcript;
    if (lines.length === 0) {
      if (!options.automatic) {
        showDialog({ title: '暂无转写', message: '需要先有会议转写内容，才能生成整理结果。', tone: 'info' });
      }
      return Promise.resolve();
    }

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
    let activeFingerprint = meetingSummaryInputFingerprint(
      lines,
      currentMeeting.title,
      meetingDate,
      requestedTemplate,
      requestedCarryForward,
      requestedAttachmentAuthorization,
    );
    let operation: Promise<void> | null = null;
    operation = (async () => {
      const summaryRequest = beginPageRequest(currentMeeting.id, 'summary');
      setLoadingSummary(true);
      setSummaryError('');
      setSummaryProgress('正在检查上次整理任务');
      const controller = new AbortController();
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = controller;
      try {
        let pending = options.resumeTask ?? null;
        if (options.forceRegenerate) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          pending = null;
        } else if (options.resumeTask === undefined) {
          try {
            pending = await getPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id);
            if (!isCurrentPageRequest(summaryRequest)) return;
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
            }
            throw new MeetingSummaryAttachmentSelectionStaleError();
          }
        }
        let fingerprint = meetingSummaryInputFingerprint(
          lines,
          currentMeeting.title,
          meetingDate,
          requestedTemplate,
          carryForward,
          attachmentAuthorization,
        );
        if (pending && (
          pending.mode !== expectedMode
          || pending.templateId !== requestedTemplate.id
          || pending.templateRevision !== requestedTemplate.revision
          || pending.inputFingerprint !== fingerprint
        )) {
          const pendingUsedAttachments = pending.attachmentAuthorization !== null;
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          if (!isCurrentPageRequest(summaryRequest)) return;
          pending = null;
          if (pendingUsedAttachments) throw new MeetingSummaryAttachmentSelectionStaleError();
          carryForward = requestedCarryForward;
          attachmentAuthorization = requestedAttachmentAuthorization;
          fingerprint = meetingSummaryInputFingerprint(
            lines,
            currentMeeting.title,
            meetingDate,
            requestedTemplate,
            carryForward,
            attachmentAuthorization,
          );
        }
        knownTaskId = pending?.taskId ?? null;
        activeFingerprint = fingerprint;
        if (!isCurrentPageRequest(summaryRequest)) return;
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
          title: currentMeeting.title,
          meetingDate,
          transcriptLines: lines,
          template: requestedTemplate,
          carryForward,
          attachmentAuthorization,
          isGuest,
          accessToken,
          resumeTaskId: pending?.taskId,
          forceRegenerate: Boolean(options.forceRegenerate),
          signal: controller.signal,
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
              if (isCurrentPageRequest(summaryRequest)) {
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
            if (isCurrentPageRequest(summaryRequest)) autoResumeTaskRef.current = taskId;
          },
          onProgress: async progress => {
            if (isCurrentPageRequest(summaryRequest)) {
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
        const text = meetingSummaryToText(generated);
        const generatedDocument = text ? summaryDocumentFor(currentMeeting.id, generated) : null;
        if (isCurrentPageRequest(summaryRequest)) setSummaryError('');
        let cached = false;
        try {
          const cacheResult = await saveCachedSummary(currentMeeting.id, generated);
          cached = cacheResult.mirrorStatus !== 'stale_scope';
          if (isCurrentPageRequest(summaryRequest)) {
            const shouldReadCanonical = Boolean(
              meetingScopeKey
              && (cacheResult.projection === 'preserved' || cacheResult.mirrorStatus === 'activated'),
            );
            const current = shouldReadCanonical && meetingScopeKey
              ? await loadCurrentMeetingSummaryState(meetingScopeKey, currentMeeting.id).catch(() => null)
              : null;
            if (isCurrentPageRequest(summaryRequest)) {
              setSummary(current ? meetingSummaryDocumentToText(current.document) : (text || '暂无整理结果'));
              setSummaryDocument(current?.document ?? generatedDocument);
              setSummaryCached(cached);
              if (cacheResult.projection === 'preserved' && !options.automatic) {
                showDialog({
                  title: '新整理结果已保存',
                  message: '当前版本包含你的修改或已处理的行动项，因此没有自动替换。',
                  tone: 'info',
                  actions: [
                    { text: '查看新版本', role: 'primary', onPress: openSummaryVersions },
                    { text: '保留当前', role: 'cancel' },
                  ],
                });
              }
            }
          }
        } catch {
          if (isCurrentPageRequest(summaryRequest)) {
            setSummary(text || '暂无整理结果');
            setSummaryDocument(generatedDocument);
            setSummaryCached(false);
            setSummaryError('整理结果已生成，但本机缓存写入失败。');
            showDialog({
              title: '整理结果已生成，保存失败',
              message: '当前页面仍可查看整理结果，但退出后可能无法离线恢复。',
              tone: 'warning',
            });
          }
        }
        if (cached || !isGuest) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
      } catch (reason) {
        if (shouldDiscardPendingMeetingSummaryTask(reason)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
        if (currentMeetingScopeKey) {
          await recordMeetingSummaryProcessing({
            scopeKey: currentMeetingScopeKey,
            legacyMeetingId: currentMeeting.id,
            signal: (reason as Error)?.name === 'AbortError'
              ? {
                type: 'aborted',
                taskId: knownTaskId,
                inputFingerprint: activeFingerprint,
              }
              : {
                type: 'failed',
                taskId: knownTaskId,
                inputFingerprint: activeFingerprint,
                errorCode: meetingSummaryProcessingFailureCode(reason),
              },
          });
        }
        if (!isCurrentPageRequest(summaryRequest)) return;
        if ((reason as Error)?.name === 'AbortError') {
          if (!options.automatic && !silentSummaryAbortRef.current.has(controller)) {
            showDialog({
              title: '已停止等待',
              message: '任务会继续在后台生成，再次打开会议即可恢复。',
              tone: 'info',
            });
          }
        } else {
          const message = readableErrorMessage(
            reason,
            options.automatic ? '上次会议整理结果暂时无法恢复，点击重试可继续获取。' : '会议整理结果暂时无法生成，请稍后重试。',
          );
          setSummaryError(message);
          if (!options.automatic) showDialog({ title: '生成失败', message, tone: 'error' });
        }
      } finally {
        if (summaryAbortRef.current === controller) {
          summaryAbortRef.current = null;
          if (isCurrentPageRequest(summaryRequest)) setLoadingSummary(false);
        }
        if (summaryInFlightRef.current === operation) summaryInFlightRef.current = null;
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

  async function prepareSummaryGeneration(template: MeetingTemplate): Promise<void> {
    if (!meeting) return;
    const currentMeetingId = meeting.id;
    const currentScopeKey = meetingScopeKey;
    const forceRegenerate = Boolean(summary);
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
    try {
      const attachments = await loadMeetingAttachments(currentScopeKey, currentMeetingId);
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      if (attachments.length > 0) {
        setSummaryAttachmentRequest({ ...input, attachments });
        return;
      }
      await continueSummaryAfterAttachmentSelection(input, null);
    } catch {
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
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
        if (
          meetingScopeKey
          && (processingStatuses.summary === 'queued' || processingStatuses.summary === 'generating')
        ) {
          await recordMeetingSummaryProcessing({
            scopeKey: meetingScopeKey,
            legacyMeetingId: meeting.id,
            signal: { type: 'discarded' },
          });
        }
        return;
      }
      const pendingTemplate = meetingTemplateById(pending.templateId, pending.templateRevision);
      const fingerprint = pendingTemplate
        ? meetingSummaryInputFingerprint(
          transcript,
          meeting.title,
          date,
          pendingTemplate,
          pending.carryForward,
          pending.attachmentAuthorization,
        )
        : '';
      if (
        !pendingTemplate
        || pending.mode !== expectedMode
        || pending.inputFingerprint !== fingerprint
      ) {
        await clearPendingMeetingSummaryTask(recordingStorageScope, meeting.id).catch(() => {});
        if (meetingScopeKey) {
          await recordMeetingSummaryProcessing({
            scopeKey: meetingScopeKey,
            legacyMeetingId: meeting.id,
            signal: { type: 'discarded' },
          });
        }
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

  useEffect(() => {
    const target = explicitDetailTab(route.params.focus);
    if (!target) return;
    setTabGeneration(value => {
      const next = value + 1;
      tabOwnerRef.current.accept({ meetingId: route.params.meetingId, tab: target, generation: next });
      return next;
    });
    setActiveTab(target);
  }, [route.params.actionFocusRequestId, route.params.focus, route.params.meetingId]);

  const briefSummary = useMemo(
    () => briefGreetingSummaryText(transcript),
    [transcript],
  );
  const displayedSummary = summary || briefSummary || '';
  const displayedSummaryDocument = summary && summaryDocument?.meetingId === (meeting?.id ?? route.params.meetingId)
    ? summaryDocument
    : null;
  const displayedActionCandidates = meetingActionsLoaded
    ? meetingActions
    : displayedSummaryDocument?.actionItemCandidates ?? [];
  const conflictedActionIds = useMemo(
    () => new Set(meetingActionConflicts.map(conflict => conflict.actionId)),
    [meetingActionConflicts],
  );

  const shareAvailability = useMemo<MeetingShareAvailability>(() => ({
    info: Boolean(meeting),
    summary: displayedSummaryDocument
      ? displayedSummaryDocument.sections.some(section => (
        section.kind !== 'action_items'
        && section.stableKey !== 'action_items'
        && Boolean(section.title?.trim() || section.content.trim())
      ))
      : Boolean(displayedSummary.trim()),
    actions: displayedActionCandidates.some(action => Boolean(action.content.trim())),
    transcript: transcript.some(line => Boolean(line.text.trim())),
    attachments: meetingAttachments.length > 0,
    audio: Boolean(meeting?.audioAvailable || meeting?.audioLocalUri || playerSource),
    manualNote: Boolean(manualNote.content.trim()),
  }), [displayedActionCandidates, displayedSummary, displayedSummaryDocument, manualNote.content, meeting, meetingAttachments.length, playerSource, transcript]);

  const runShare = useCallback(async (selection: MeetingShareSelection) => {
    if (!meeting || sharing) return;
    setSharing(true);
    try {
      await shareMeetingContent(selection, {
        meeting,
        transcriptLines: transcript,
        summaryText: displayedSummary || meetingSummaryToText(getCachedSummary(meeting.id)),
        summaryDocument: displayedSummaryDocument,
        actionItems: displayedActionCandidates,
        manualNoteText: manualNote.content,
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
  }, [accessToken, displayedActionCandidates, displayedSummary, displayedSummaryDocument, getCachedSummary, isGuest, manualNote.content, meeting, meetingAttachments, playerSource, sharing, showDialog, transcript]);

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
    showDialog({
      title: presentation.title,
      message: presentation.message,
      tone: 'danger',
      actions: [
        {
          text: presentation.confirmText,
          role: 'destructive',
          onPress: async () => {
            try {
              await manualNote.flush();
              await deleteMeeting(meeting.id, {
                recoverable: presentation.recoverable,
                expectedRetentionDays: presentation.retentionDays,
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
                showDialog({
                  title: '删除失败',
                  message: readableErrorMessage(reason, '请检查网络后重试。'),
                  tone: 'error',
                });
              }
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [deleteMeeting, manualNote.flush, meeting, navigation, refreshRecycleCapability, showDialog]);

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

  const manageSpeaker = useCallback((speakerId?: string) => {
    if (isGuest || !accessToken) {
      showDialog({ title: '登录后管理讲话人', message: '游客会议保留转写中的讲话人标签，但不上传声纹资料。', tone: 'info' });
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
    setSummaryDocument(current.document);
    setMeetingActions(current.document.actionItemCandidates);
    setMeetingActionsLoaded(true);
    setSummary(meetingSummaryDocumentToText(current.document));
    setSummaryCached(true);
    setSummaryError('');
    return current.document;
  }, [meetingScopeKey]);

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
        scope: value.applyToCluster ? 'cluster' : 'segment',
        displayName: value.displayName,
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
        setTranscript(refreshed.lines);
        setTranscriptCached(refreshed.lines.length > 0);
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
          ? value.applyToCluster
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
    void refreshCanonicalSummary(meeting.id).then(current => {
      if (current) advancePageGenerations('summary');
    }).catch(() => null);
  }, [advancePageGenerations, meeting?.id, refreshCanonicalSummary, route.params.actionFocusRequestId]);

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

  const openRootConflict = useCallback(async () => {
    const conflict = rootConflict ?? await refreshRootConflict();
    if (!conflict) {
      ToastAndroid.show('会议冲突已处理', ToastAndroid.SHORT);
      return;
    }
    setRootConflictError('');
    setRootConflictTarget(conflict);
  }, [refreshRootConflict, rootConflict]);

  const resolveRootConflict = useCallback(async (choice: MeetingRootConflictChoice) => {
    if (!meetingScopeKey || !rootConflictTarget || rootConflictSaving) return;
    setRootConflictSaving(true);
    setRootConflictError('');
    try {
      const result = await resolveMeetingRootSyncConflictUseCase.execute({
        conflictId: rootConflictTarget.id,
        meetingId: rootConflictTarget.meetingId,
        scopeKey: meetingScopeKey,
        expectedLocalUpdatedAtMs: rootConflictTarget.local.updatedAtMs,
        resolution: choice,
      });
      setRootConflictTarget(null);
      await refreshRootConflict();
      await refreshMeetings().catch(() => {});
      ToastAndroid.show(
        choice === 'keep_local' ? '本机版本将重新同步' : '已使用云端版本',
        ToastAndroid.SHORT,
      );
      if (result.aggregate.note.lifecycle === 'deleted') navigation.goBack();
    } catch (reason) {
      diagnosticAudit('meeting_root_conflict_resolution_failed', {
        operation: choice,
        error_code: reason instanceof MeetingRootSyncConflictChangedError
          ? 'conflict_changed'
          : 'resolution_failed',
      });
      setRootConflictError(reason instanceof MeetingRootSyncConflictChangedError
        ? '这次冲突已发生变化，请关闭后重新打开。'
        : choice === 'keep_local'
          ? '本机版本暂时无法重新同步，请稍后重试。'
          : '云端版本暂时无法应用，请稍后重试。');
      if (reason instanceof MeetingRootSyncConflictChangedError) {
        await refreshRootConflict().catch(() => null);
      }
    } finally {
      if (mountedRef.current) setRootConflictSaving(false);
    }
  }, [meetingScopeKey, navigation, refreshMeetings, refreshRootConflict, rootConflictSaving, rootConflictTarget]);

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

  const changeMeetingActionStatus = useCallback(async (status: 'pending' | 'dismissed') => {
    if (
      !meeting
      || !meetingScopeKey
      || !editingAction
      || editingAction.mode !== 'edit'
      || actionEditorSaving
    ) return;
    setActionEditorSaving(true);
    setActionEditorError('');
    try {
      const canonical = await loadMeetingActions(meetingScopeKey, meeting.id);
      await updateMeetingActionUseCase.execute({
        meetingId: canonical.canonicalMeetingId,
        actionId: editingAction.id,
        scopeKey: meetingScopeKey,
        expectedUpdatedAtMs: editingAction.expectedUpdatedAtMs,
        status,
      });
      if (status === 'dismissed' && editingAction.reminderNotificationId) {
        await cancelMeetingActionNotification(editingAction.reminderNotificationId).catch(reason => {
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
          title: status === 'dismissed' ? '已忽略' : '已恢复',
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
          ? '暂时无法忽略，请稍后重试。'
          : '暂时无法恢复，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setActionEditorSaving(false);
    }
  }, [actionEditorSaving, editingAction, meeting, meetingScopeKey, refreshCanonicalSummary, refreshMeetingActions, showDialog]);

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
        actionFocusRequestId: requestId,
      });
      return;
    }
    navigation.setParams({
      focus: 'notes',
      actionFocusRequestId: requestId,
    });
  }, [navigation]);

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
      if (!accessToken) {
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
      setReloadKey(value => value + 1);
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

  const handleAction = useCallback((action: MinutesSemanticAction) => {
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
      case 'openMeetingRootConflict':
        if (action.meetingId !== route.params.meetingId) break;
        void openRootConflict();
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
      case 'generateSummary':
        if (action.meetingId !== route.params.meetingId) break;
        setTemplateSheetVisible(true);
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
  }, [manageSpeaker, manualNote, markers, meeting, navigation, openManualNoteConflict, openMeetingActionCreator, openMeetingActionEditor, openMeetingActionFollowup, openRootConflict, openSpeakerAssignment, playerSources, processingStatuses, removeMarker, retryProcessingStage, route.params.meetingId, runRecordingMerge, sharing, showDialog, summary, toggleMeetingAction]);

  const transcriptStageLoading = processingStatuses.transcript === 'realtime_draft'
    || processingStatuses.transcript === 'finalizing';
  const transcriptStageMessage = processingStatuses.transcript === 'realtime_draft'
    ? '文字记录仍在补全'
    : processingStatuses.transcript === 'finalizing'
      ? '正在生成文字记录'
      : '';
  const transcriptStageError = processingStatuses.transcript === 'failed_retryable'
    ? '文字处理失败，可重试'
    : '';
  const summaryStageLoading = processingStatuses.summary === 'queued'
    || processingStatuses.summary === 'generating';
  const summaryStageError = processingStatuses.summary === 'failed_retryable'
    ? '整理失败，可重试'
    : '';
  const processingRetrying = processingPresentation.retryStage === 'upload'
    ? retryingAudioUpload
    : processingPresentation.retryStage === 'transcript'
      ? loadingTranscript
      : processingPresentation.retryStage === 'summary'
        ? loadingSummary
        : processingPresentation.retryStage === 'speaker'
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

  const snapshot = useMemo(() => buildNativeMinutesDetailSnapshot({
    meetingId: meeting?.id ?? route.params.meetingId,
    available: Boolean(meeting),
    title: meeting ? meeting.title : '会议记录不存在',
    dateTimeLabel: meeting ? compactMeetingDateTime(meeting.date, meeting.time) : '',
    location: meeting?.location ?? '',
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
    actionItemCandidates: displayedActionCandidates,
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
    transcriptLoading: Boolean(meeting && (loadingTranscript || transcriptStageLoading)),
    transcriptStatusMessage: transcriptStageMessage || (transcriptCompleting ? '文字记录仍在补全' : ''),
    summaryLoading: Boolean(meeting && (loadingSummary || summaryStageLoading)),
    transcriptError: meeting
      ? transcriptStageError || transcriptError
      : '请返回会议列表后重新打开。',
    summaryError: summaryStageError || (briefSummary ? '' : summaryError),
    summaryProgress: summaryStageLoading ? '正在整理会议记录' : summaryProgress,
    canShare: Boolean(meeting && !sharing),
    canManageSpeakers: Boolean(meeting && !isGuest && accessToken),
    canGenerateSummary: Boolean(meeting && transcript.length > 0),
    canCreateAction: Boolean(
      meeting
      && meetingScopeKey
      && (displayedSummaryDocument || displayedActionCandidates.length > 0),
    ),
    summaryGenerating: loadingSummary || summaryStageLoading,
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
    audioStatusMessage: loadingAudio ? '正在加载录音' : (!playerSource ? '仅有转写，无录音文件' : ''),
    audioErrorMessage: pendingAudioError || playerSourceError,
    processingStatusLabel,
    processingStatusTone: processingPresentation.tone,
    rootSyncConflict: rootConflict !== null,
    processingRetryStage: processingPresentation.retryStage ?? undefined,
    processingRetrying,
    recordingMergeStatusLabel,
    recordingMergeActionLabel,
    recordingMergeActionEnabled: !recordingMergeBusy && Boolean(recordingMergeActionLabel),
  }), [accessToken, activeTab, briefSummary, conflictedActionIds, deletingMarkerId, displayedActionCandidates, displayedSummary, displayedSummaryDocument, focusedTab, isGuest, loadingAudio, loadingSummary, loadingTranscript, manualNote.content, manualNote.enabled, manualNote.error, manualNote.loading, manualNote.retryable, manualNote.revision, manualNote.saving, manualNoteConflict, markers, meeting, meetingScopeKey, pageGenerations, pendingAudioError, playerSource, playerSourceError, playerSources, processingPresentation.retryStage, processingPresentation.tone, processingRetrying, processingStatusLabel, recordingMergeActionLabel, recordingMergeBusy, recordingMergeStatusLabel, retryingSpeakerCorrection, rootConflict, route.params.actionFocusRequestId, route.params.actionId, route.params.focus, route.params.meetingId, route.params.positionMs, route.params.segmentId, route.params.transcriptFocusRequestId, sharing, summaryCached, summaryError, summaryProgress, summaryStageError, summaryStageLoading, tabGeneration, transcript, transcriptCached, transcriptCompleting, transcriptError, transcriptStageError, transcriptStageLoading, transcriptStageMessage, updatingActionId]);

  const moreItems = useMemo<AppActionSheetItem[]>(() => {
    if (!meeting) return [];
    return [
      ...(meetingQuestionsEnabled
        ? [{
            key: 'questions',
            label: '会议问答',
            disabled: !meetingScopeKey,
            onPress: () => setQuestionVisible(true),
          }]
        : []),
      ...(!isGuest && accessToken
        ? [{ key: 'speakers', label: '管理讲话人', onPress: () => manageSpeaker() }]
        : []),
      ...(pendingAudioUpload
        ? [{
            key: 'retry-upload',
            label: retryingAudioUpload ? '录音正在后台同步' : '重试录音同步',
            disabled: retryingAudioUpload,
            onPress: () => { void performPendingAudioUpload(pendingAudioUpload, true); },
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
  }, [accessToken, confirmDelete, isGuest, manageSpeaker, meeting, meetingAttachments.length, meetingQuestionsEnabled, meetingScopeKey, openMeetingAttachments, openSummaryVersions, pendingAudioUpload, performPendingAudioUpload, retryingAudioUpload, summaryDocument?.remoteVersionId]);

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
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="meeting-detail-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiMinutesView
          style={styles.surface}
          surface="detail"
          snapshot={snapshot}
          onMinutesAction={event => handleAction(event.nativeEvent)}
          testID="meeting-detail-native-surface"
        />
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
        accessToken={accessToken}
        onClose={() => setQuestionVisible(false)}
        onOpenCitation={openQuestionCitation}
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
      <MeetingTemplateSheet
        visible={templateSheetVisible}
        selectedTemplate={summaryTemplate}
        busy={loadingSummary}
        onClose={() => setTemplateSheetVisible(false)}
        onSelect={template => {
          void prepareSummaryGeneration(template);
        }}
      />
      <MeetingSummaryAttachmentSheet
        visible={summaryAttachmentRequest !== null}
        attachments={summaryAttachmentRequest?.attachments ?? []}
        onClose={() => setSummaryAttachmentRequest(null)}
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
        onClose={() => setSummaryCarryForwardRequest(null)}
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
        onStatusChange={status => { void changeMeetingActionStatus(status); }}
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
      <MeetingRootConflictSheet
        visible={rootConflictTarget !== null}
        conflict={rootConflictTarget}
        saving={rootConflictSaving}
        error={rootConflictError}
        onClose={() => {
          if (rootConflictSaving) return;
          setRootConflictTarget(null);
          setRootConflictError('');
        }}
        onResolve={choice => { void resolveRootConflict(choice); }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
