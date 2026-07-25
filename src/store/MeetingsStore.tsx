import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  ApiMeeting,
  createMeeting as apiCreateMeeting,
  deleteMeeting as apiDeleteMeeting,
  fetchAllMeetings,
  uploadMeetingAudio,
  updateMeeting as apiUpdateMeeting,
} from '../services/api';
import { useAuth } from './AuthStore';
import { Colors as C } from '../theme/colors';
import { formatDuration } from '../utils/meetingMedia';
import {
  attachPendingMeetingAudioUploadRemoteIdentity,
  deletePendingMeetingAudioUpload,
  inspectPendingMeetingAudioUploads,
  derivePendingMeetingAudioUploadInspection,
  listPendingMeetingAudioUploads,
  PendingMeetingAudioUpload,
  restoreDeletedMeetingAudio,
  type PendingMeetingAudioUploadInspection,
  retryPendingMeetingAudioUploads,
} from '../services/meetingRecording';
import { getAppStorageItem, writeAppStorageJson } from '../services/appStorage';
import { HttpResponseError } from '../services/errors';
import { meetingSummaryToText } from '../services/meetingSummary';
import { deleteNativeMeetingArtifacts } from '../native/nativeTransferCoordinator';
import { deleteMeetingPlaybackCache } from '../services/meetingPlaybackCache';
import { listPendingMeetingSummaryTasks } from '../services/meetingSummaryTasks';
import { clearPendingMeetingTranscriptCompletion } from '../services/meetingTranscriptCompletionTasks';
import {
  runLegacyMeetingShadowImport,
} from '../data/db/legacyImport';
import {
  MEETING_PRESENTATION_LABELS,
  isScopeKey,
  secureClientIdFactory,
  type MeetingEntryPoint,
  type ProcessingStageTransition,
  type ScopeKey,
} from '../domain/meeting';
import { diagnosticAudit, diagnosticInfo, diagnosticWarn } from '../services/diagnostics';
import {
  isMeetingDeletionBlocked,
  isMeetingEligibleForRecycleBin,
} from '../services/meetingDeletionPresentation';
import { requireFreshMeetingRecycleCapability } from '../services/meetingRecycleCapability';
import { getFeatureFlags } from '../config/featureFlags';
import {
  MeetingRepositoryFacade,
  sqliteMeetingNoteRepository,
  type MeetingDualReadReport,
} from '../data/repositories';
import { reconcileNativeMeetingRecordings } from '../services/meetingRecordingReconciliation';
import {
  mirrorLegacyMeetingCreated,
  mirrorLegacyMeetingDeletion,
  mirrorLegacyMeetingStageState,
} from '../services/meetingStageMirror';
import {
  mirrorLegacySummaryContent,
  mirrorLegacyTranscriptContent,
} from '../services/meetingContentMirror';
import {
  buildCanonicalMeetingReadProjection,
  resolveMeetingReadCutover,
  type MeetingReadProjection,
} from '../services/meetingReadCutover';
import {
  mirrorCanonicalMeetingScopeToLegacy,
  type LegacyMeetingProjectionWriter,
} from '../services/meetingLegacyMirrorCoordinator';
import type { CalendarMeetingContext } from '../services/occurrenceMeeting';
import {
  evaluateTranscriptLineCandidate,
  type TranscriptCandidateKind,
  type TranscriptServerCompleteness,
} from '../services/transcriptCompleteness';
import { cancelMeetingActionNotificationsForMeeting } from '../services/notifications';
import { requestMeetingActionSync } from '../application/meeting/actionSyncTrigger';
import { requestMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import { requestMeetingSpeakerCorrectionSync } from '../application/meeting/speakerCorrectionSyncTrigger';
import { CreateMeetingNoteUseCase } from '../application/meeting/createMeetingNote';
import { DeleteMeetingNoteUseCase } from '../application/meeting/deleteMeetingNote';
import { RestoreMeetingNoteUseCase } from '../application/meeting/restoreMeetingNote';
import {
  MergeAccountMeetingRemoteSnapshotUseCase,
  type AccountMeetingRemoteSnapshot,
} from '../application/meeting/mergeAccountMeetingRemoteSnapshot';
import {
  UpdateMeetingNoteUseCase,
  type UpdateMeetingNoteChanges,
} from '../application/meeting/updateMeetingNote';
import {
  UpdateMeetingCaptureUseCase,
  UpdateGuestMeetingCaptureUseCase,
  type GuestRecordingAssetPatch,
} from '../application/meeting/updateGuestMeetingCapture';
import { SaveGuestMeetingTranscriptUseCase } from '../application/meeting/saveGuestMeetingTranscript';
import {
  ReconcileMeetingAudioUploadUseCase,
  type MeetingAudioUploadEvidence,
} from '../application/meeting/reconcileMeetingAudioUpload';
import { drainMeetingRootSync } from '../services/meetingRootSync';
import { pullMeetingRootsV2 } from '../services/meetingRootPull';
import type { IngestedMeetingMedia } from 'laoji-native-platform';

const MEETINGS_CACHE_KEY = '@laoji:meetings:v2';
const TRANSCRIPT_CACHE_KEY = '@laoji:meetingTranscripts:v1';
const SUMMARY_CACHE_KEY = '@laoji:meetingSummaries:v1';

const meetingRepositoryFacade = new MeetingRepositoryFacade(sqliteMeetingNoteRepository);
const createCanonicalMeetingNote = new CreateMeetingNoteUseCase({
  repository: sqliteMeetingNoteRepository,
});
const updateCanonicalMeetingNote = new UpdateMeetingNoteUseCase({
  repository: sqliteMeetingNoteRepository,
});
const deleteCanonicalMeetingNote = new DeleteMeetingNoteUseCase({
  repository: sqliteMeetingNoteRepository,
});
const restoreCanonicalMeetingNote = new RestoreMeetingNoteUseCase({
  repository: sqliteMeetingNoteRepository,
});
const mergeCanonicalAccountMeetingSnapshot = new MergeAccountMeetingRemoteSnapshotUseCase({
  repository: sqliteMeetingNoteRepository,
});
const updateCanonicalGuestMeetingCapture = new UpdateGuestMeetingCaptureUseCase({
  repository: sqliteMeetingNoteRepository,
});
const updateCanonicalAccountMeetingCapture = new UpdateMeetingCaptureUseCase({
  repository: sqliteMeetingNoteRepository,
});
const saveCanonicalGuestMeetingTranscript = new SaveGuestMeetingTranscriptUseCase({
  repository: sqliteMeetingNoteRepository,
});
const reconcileCanonicalMeetingAudioUpload = new ReconcileMeetingAudioUploadUseCase({
  repository: sqliteMeetingNoteRepository,
});

function mirrorMeetingProjection(scope: string, meeting: Meeting | undefined): Promise<void> {
  if (!meeting || !isScopeKey(scope)) return Promise.resolve();
  return mirrorLegacyMeetingStageState(scope, meeting);
}

async function mirrorMeetingProjections(scope: string, meetings: readonly Meeting[]): Promise<void> {
  if (!isScopeKey(scope)) return;
  for (let offset = 0; offset < meetings.length; offset += 4) {
    await Promise.all(
      meetings.slice(offset, offset + 4).map(meeting => mirrorLegacyMeetingStageState(scope, meeting)),
    );
  }
}

async function auditShadowRepositoryRead(
  scopeKey: ScopeKey,
  legacyMeetings: readonly Meeting[],
  transcripts: Readonly<Record<string, readonly TranscriptLine[]>>,
  summaries: Readonly<Record<string, MeetingSummary | null>>,
): Promise<MeetingDualReadReport | null> {
  try {
    const transcriptLineCounts = Object.fromEntries(
      Object.entries(transcripts).map(([id, lines]) => [id, lines.length]),
    );
    const summaryReady = Object.fromEntries(
      Object.entries(summaries).map(([id, summary]) => [id, Boolean(meetingSummaryToText(summary))]),
    );
    const report = await meetingRepositoryFacade.compareLegacySnapshot(scopeKey, legacyMeetings, {
      transcriptLineCounts,
      summaryReady,
    });
    diagnosticAudit('meeting_db_repository_read', {
      status: report.status,
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      legacy_meetings: report.legacyMeetings,
      projected_meetings: report.repositoryMeetings,
      tombstones: report.repositoryTombstones,
      invalid_legacy_identities: report.invalidLegacyIdentities,
      missing: report.missingFromRepository,
      extra: report.extraInRepository,
      duplicate_legacy_identities: report.duplicateLegacyIdentities,
      duplicate_identities: report.duplicateRepositoryIdentities,
      order_mismatches: report.orderMismatches,
      title_mismatches: report.titleMismatches,
      lifecycle_mismatches: report.lifecycleMismatches,
      invalid_stage_sets: report.invalidStageSets,
      transcript_count_mismatches: report.transcriptCountMismatches,
      summary_availability_mismatches: report.summaryAvailabilityMismatches,
      context_mismatches: report.contextMismatches,
    });
    return report;
  } catch (error) {
    diagnosticWarn('[meeting-db] repository shadow read failed', error);
    diagnosticAudit('meeting_db_repository_read', {
      status: 'failed',
      scope: scopeKey === 'guest' ? 'guest' : 'account',
      error_code: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

export class MeetingDeletionCleanupError extends Error {
  constructor(public readonly failureCount: number) {
    super('会议记录已删除，但部分本机录音或缓存未能清理。请在隐私设置中清除本机数据。');
    this.name = 'MeetingDeletionCleanupError';
  }
}

function isFinishedStatus(status: string): boolean {
  return ['completed', 'ended', 'done', 'processed'].includes(status);
}

function formatDateTime(value: string | undefined): { date: string; time?: string } {
  if (!value) return { date: '未知日期' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: value };
  return {
    date: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

function statusTag(status: string): { label: string; color: string } {
  if (status === 'recording') return { label: '录音中', color: C.red };
  if (status === 'paused') return { label: '录音已暂停', color: C.orange };
  if (status === 'processing') return { label: '处理中', color: C.orange };
  if (status === 'failed') return { label: '失败', color: C.red };
  if (isFinishedStatus(status)) return { label: '已完成', color: C.green };
  return { label: '未开始', color: C.purple };
}

const STATUS_TAG_LABELS = new Set([
  '录音中',
  '录音已暂停',
  '处理中',
  '失败',
  '已完成',
  '未开始',
  ...MEETING_PRESENTATION_LABELS,
]);

function tagsForStatus(meeting: Meeting, status: string): Meeting['tags'] {
  const retained = meeting.tags.filter(tag => !STATUS_TAG_LABELS.has(tag.label) && tag.label !== '待同步');
  return [statusTag(status), ...retained];
}

function tagsWithPendingSync(tags: Meeting['tags']): Meeting['tags'] {
  return [...tags.filter(tag => tag.label !== '待同步'), { label: '待同步', color: C.orange }];
}

function tagsForAudioSync(tags: Meeting['tags'], pending: boolean, blocked = false): Meeting['tags'] {
  const retained = tags.filter(tag => tag.label !== '待上传' && tag.label !== '上传受阻');
  if (!pending) return retained;
  return [...retained, blocked
    ? { label: '上传受阻', color: C.red }
    : { label: '待上传', color: C.orange }];
}

function audioUploadEvidence(
  inspection: PendingMeetingAudioUploadInspection,
  status: MeetingAudioUploadEvidence['status'] = inspection.phase,
): MeetingAudioUploadEvidence {
  const pending = inspection.pending;
  return {
    status,
    nativeSessionId: pending.meetingId,
    localUri: pending.audioUri,
    mimeType: pending.mimeType,
    fileName: pending.fileName,
    attemptCount: inspection.attemptCount,
    operationId: inspection.operationId
      ?? `meeting-audio:${pending.meetingId}:${pending.createdAt}`,
    credentialGeneration: inspection.credentialGeneration,
    errorCode: inspection.errorCode,
    retryable: inspection.retryable,
    nextRetryAtMs: inspection.nextRetryAtMs,
  };
}

type CaptureTransition = Extract<ProcessingStageTransition, { stage: 'capture' }>;
type TranscriptTransition = Extract<ProcessingStageTransition, { stage: 'transcript' }>;

function captureTransitionForLegacyMeeting(
  meeting: Meeting,
  previousStatus?: string,
): CaptureTransition {
  const status = meeting.status?.trim().toLowerCase() ?? '';
  const hasAudio = Boolean(meeting.audioLocalUri || meeting.audioAvailable);
  if (status === 'recording') {
    const normalizedPrevious = previousStatus?.trim().toLowerCase() ?? '';
    return {
      stage: 'capture',
      status: 'recording',
      attemptStarted: normalizedPrevious !== 'recording' && normalizedPrevious !== 'paused',
      progress: null,
    };
  }
  if (status === 'paused') return { stage: 'capture', status: 'paused', progress: null };
  if (status === 'processing') {
    return { stage: 'capture', status: hasAudio ? 'local_ready' : 'finalizing' };
  }
  if (isFinishedStatus(status)) return { stage: 'capture', status: 'local_ready', progress: 1 };
  if (status === 'failed') {
    return hasAudio
      ? { stage: 'capture', status: 'local_ready', progress: 1 }
      : {
          stage: 'capture',
          status: 'failed_recoverable',
          errorCode: 'recording_interrupted',
          userMessageKey: 'meeting.capture.retryable',
          retryable: true,
          progress: null,
        };
  }
  if (status === 'created') return { stage: 'capture', status: 'not_started', progress: null };
  throw new Error('当前会议录音状态无法保存，请刷新后重试。');
}

function transcriptTransitionForLegacyMeeting(meeting: Meeting): TranscriptTransition | null {
  const status = meeting.status?.trim().toLowerCase() ?? '';
  if (meeting.hasTranscript) {
    return {
      stage: 'transcript',
      status: status === 'recording' || status === 'paused' ? 'realtime_draft' : 'ready',
    };
  }
  if (status === 'processing') return { stage: 'transcript', status: 'finalizing' };
  return null;
}

function recordingAssetPatchForLegacyMeeting(
  meeting: Meeting,
  patch: Partial<Meeting>,
  nowMs: number,
): GuestRecordingAssetPatch | null {
  const status = meeting.status?.trim().toLowerCase() ?? '';
  const hasExplicitAudioPatch = [
    'audioAvailable',
    'audioLocalUri',
    'audioDurationSec',
    'audioBars',
  ].some(key => Object.prototype.hasOwnProperty.call(patch, key));
  const needsCaptureIdentity = status === 'recording'
    || status === 'paused'
    || status === 'failed'
    || status === 'created';
  if (!needsCaptureIdentity && !hasExplicitAudioPatch && !meeting.audioLocalUri) return null;

  const localUri = meeting.audioLocalUri?.trim() || null;
  let localState: GuestRecordingAssetPatch['localState'];
  if (localUri) localState = 'local_ready';
  else if (status === 'recording' || status === 'paused') localState = 'capturing';
  else localState = 'missing';

  const result: GuestRecordingAssetPatch = {
    nativeSessionId: meeting.id,
    localUri,
    mimeType: 'audio/wav',
    localState,
    ...(localState === 'local_ready' ? { lastVerifiedAtMs: nowMs } : {}),
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'audioDurationSec')) {
    const durationSec = patch.audioDurationSec;
    result.durationMs = Number.isFinite(durationSec)
      ? Math.max(0, Math.round(Number(durationSec) * 1000))
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'audioBars')) {
    result.waveformJson = patch.audioBars?.length ? JSON.stringify(patch.audioBars) : null;
  }
  return result;
}

function serverToLocal(m: ApiMeeting): Meeting {
  const recordedAt = m.recorded_at ?? m.created_at;
  const { date, time } = formatDateTime(recordedAt);
  const audioDurationSec = typeof m.audio_duration_sec === 'number' && m.audio_duration_sec > 0
    ? m.audio_duration_sec
    : undefined;
  return {
    id: m.id,
    remoteId: m.id,
    title: m.title,
    date,
    time,
    duration: formatDuration(audioDurationSec),
    tags: [statusTag(m.status), ...(m.mode ? [{ label: m.mode === 'offline' ? '离线' : '实时', color: C.blue }] : [])],
    participants: m.participants ?? [],
    hasTranscript: m.transcript_available ?? (m.transcript_count ?? 0) > 0,
    hasSummary: m.summary_available ?? false,
    status: m.status,
    mode: m.mode ?? 'realtime',
    description: m.description ?? null,
    location: m.location ?? null,
    createdAt: recordedAt,
    updatedAt: m.updated_at,
    audioAvailable: Boolean(m.audio_available),
    audioSyncPending: false,
    audioSyncBlocked: false,
    audioDurationSec,
    clientRequestId: m.client_request_id ?? undefined,
    source: 'cloud',
  };
}

function serverToCanonicalSnapshot(m: ApiMeeting): AccountMeetingRemoteSnapshot {
  const createdAtMs = Date.parse(m.created_at);
  const updatedAtMs = Date.parse(m.updated_at);
  const recordedAtMs = Date.parse(m.recorded_at ?? m.created_at);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs) || !Number.isFinite(recordedAtMs)) {
    throw new Error('meeting remote snapshot time is invalid');
  }
  return {
    remoteId: m.id,
    clientNoteId: null,
    clientRequestId: m.client_request_id?.trim() || null,
    remoteRevision: null,
    origin: null,
    entryPoint: null,
    remoteLifecycle: null,
    deletedAtMs: null,
    title: m.title,
    description: m.description ?? null,
    participants: m.participants ?? [],
    location: m.location ?? null,
    mode: m.mode ?? null,
    status: m.status,
    recordedAtMs: Math.trunc(recordedAtMs),
    createdAtMs: Math.trunc(createdAtMs),
    updatedAtMs: Math.trunc(updatedAtMs),
    audioAvailable: Boolean(m.audio_available),
    transcriptAvailable: m.transcript_available ?? (m.transcript_count ?? 0) > 0,
    summaryAvailable: Boolean(m.summary_available),
  };
}

export interface CreateMeetingOptions {
  description?: string | null;
  participants?: string[];
  mode?: ApiMeeting['mode'];
  clientRequestId?: string;
  location?: string | null;
  recordedAt?: string | null;
  calendarContext?: CalendarMeetingContext;
  entryPoint?: MeetingEntryPoint;
}

export interface ImportMeetingMediaOptions {
  title: string;
  recordedAtMs: number;
  calendarContext?: CalendarMeetingContext | null;
}

function createGuestMeeting(
  title: string,
  options: CreateMeetingOptions,
  now: Date,
): Meeting {
  return {
    id: secureClientIdFactory.create(),
    remoteId: null,
    title,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    duration: '—',
    tags: [statusTag('created'), { label: '本机', color: C.teal }],
    participants: options.participants ?? [],
    hasTranscript: false,
    hasSummary: false,
    status: 'created',
    mode: options.mode ?? 'realtime',
    description: options.description ?? null,
    location: options.location ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    audioAvailable: false,
    clientRequestId: options.clientRequestId,
    source: 'guest',
  };
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getAppStorageItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function persistJson(key: string, value: unknown): Promise<void> {
  await writeAppStorageJson(key, value, { bestEffort: true });
}

function assertMeetingDeletionAllowed(meeting: Meeting): void {
  // Failed and not-yet-started records remain resumable, but they do not own an
  // active recorder and must still be deletable from the long-press menu.
  if (isMeetingDeletionBlocked(meeting)) {
    throw new Error('请先结束并保存当前会议录音，再删除。');
  }
}

interface MeetingsContextType {
  meetings: Meeting[];
  loading: boolean;
  error: string | null;
  createMeeting: (title: string, options?: CreateMeetingOptions) => Promise<Meeting>;
  importMeetingMedia: (media: IngestedMeetingMedia, options: ImportMeetingMediaOptions) => Promise<Meeting>;
  deleteMeeting: (id: string, options?: DeleteMeetingOptions) => Promise<void>;
  restoreDeletedMeeting: (canonicalMeetingId: string, expectedRetentionDays: number) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
  updateMeetingDetails: (
    id: string,
    changes: Partial<Pick<Meeting, 'title' | 'description' | 'participants' | 'mode' | 'location'>>,
  ) => Promise<void>;
  updateMeetingStatus: (
    id: string,
    status: string,
    patch?: Partial<Meeting>,
    options?: MeetingStatusUpdateOptions,
  ) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
  reconcileAudioUploads: (uploaded?: PendingMeetingAudioUpload) => Promise<void>;
  getCachedTranscript: (id: string) => TranscriptLine[];
  saveCachedTranscript: (
    id: string,
    transcript: TranscriptLine[],
    options?: SaveCachedTranscriptOptions,
  ) => Promise<void>;
  getCachedSummary: (id: string) => MeetingSummary | null;
  saveCachedSummary: (id: string, summary: MeetingSummary | null) => Promise<SaveCachedSummaryResult>;
}

interface MeetingStatusUpdateOptions {
  remoteSync?: 'wait' | 'background';
}

export interface DeleteMeetingOptions {
  recoverable?: boolean;
  expectedRetentionDays?: number | null;
}

export interface SaveCachedTranscriptOptions {
  candidateKind?: TranscriptCandidateKind;
  serverCompleteness?: TranscriptServerCompleteness;
  remoteRevisionId?: string | null;
}

export interface SaveCachedSummaryResult {
  projection: 'updated' | 'preserved';
  mirrorStatus: string;
}

interface CanonicalOwnedScopeProjection {
  projection: MeetingReadProjection;
  mirrorStatus: 'clean' | 'unchanged' | 'failed';
  canonicalRevision: number;
}

const MeetingsContext = createContext<MeetingsContextType | null>(null);

export function MeetingsProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptCacheRef = useRef<Record<string, TranscriptLine[]>>({});
  const summaryCacheRef = useRef<Record<string, MeetingSummary | null>>({});
  const meetingsRef = useRef<Meeting[]>([]);
  const canonicalReadProjectionRef = useRef<MeetingReadProjection | null>(null);
  const canonicalReadRequestRef = useRef(0);
  const generationRef = useRef(0);
  const activeScopeRef = useRef<string | null>(null);
  const guestMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const canonicalStoreMutationDepthRef = useRef(0);
  const audioResumeOperationsRef = useRef(new Map<string, Promise<void>>());
  const lastAudioResumeAtRef = useRef(new Map<string, number>());

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const meetingsKey = `${MEETINGS_CACHE_KEY}:${scope}`;
  const transcriptKey = `${TRANSCRIPT_CACHE_KEY}:${scope}`;
  const summaryKey = `${SUMMARY_CACHE_KEY}:${scope}`;

  useLayoutEffect(() => {
    generationRef.current += 1;
    activeScopeRef.current = scope;
    meetingsRef.current = [];
    transcriptCacheRef.current = {};
    summaryCacheRef.current = {};
    canonicalReadRequestRef.current += 1;
    canonicalReadProjectionRef.current = null;
    setMeetings([]);
    setError(null);
    setLoading(false);
  }, [scope]);

  const persistMeetings = useCallback((next: Meeting[]) => persistJson(meetingsKey, next), [meetingsKey]);
  const persistMeetingsStrict = useCallback(
    (next: Meeting[]) => writeAppStorageJson(meetingsKey, next, { removeIfEmpty: true }),
    [meetingsKey],
  );
  const persistTranscripts = useCallback(
    () => writeAppStorageJson(transcriptKey, transcriptCacheRef.current, { removeIfEmpty: true }),
    [transcriptKey],
  );
  const persistSummaries = useCallback(
    () => writeAppStorageJson(summaryKey, summaryCacheRef.current, { removeIfEmpty: true }),
    [summaryKey],
  );
  const canonicalLegacyWriter = useMemo<LegacyMeetingProjectionWriter>(() => ({
    writeMeetings: async (targetScope, next) => {
      if (targetScope !== scope) throw new Error('meeting legacy mirror scope changed');
      await writeAppStorageJson(meetingsKey, next, { removeIfEmpty: true });
    },
    writeTranscripts: async (targetScope, next) => {
      if (targetScope !== scope) throw new Error('meeting legacy mirror scope changed');
      await writeAppStorageJson(transcriptKey, next, { removeIfEmpty: true });
    },
    writeSummaries: async (targetScope, next) => {
      if (targetScope !== scope) throw new Error('meeting legacy mirror scope changed');
      await writeAppStorageJson(summaryKey, next, { removeIfEmpty: true });
    },
  }), [meetingsKey, scope, summaryKey, transcriptKey]);
  const enqueueGuestMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = guestMutationQueueRef.current.then(operation, operation);
    guestMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const deactivateCanonicalRead = useCallback(() => {
    canonicalReadRequestRef.current += 1;
    canonicalReadProjectionRef.current = null;
  }, []);

  const loadCanonicalOwnedScope = useCallback(async (): Promise<CanonicalOwnedScopeProjection | null> => {
    if (!isScopeKey(scope)) return null;
    try {
      const result = await mirrorCanonicalMeetingScopeToLegacy({
        repository: sqliteMeetingNoteRepository,
        writer: canonicalLegacyWriter,
        scopeKey: scope,
      });
      if (result.status === 'not_owned') return null;
      const projection = result.projection
        ?? await buildCanonicalMeetingReadProjection(sqliteMeetingNoteRepository, scope);
      diagnosticAudit('meeting_canonical_legacy_mirror', {
        status: result.status,
        scope: scope === 'guest' ? 'guest' : 'account',
        canonical_revision: result.state.canonicalRevision,
        legacy_mirror_revision: result.state.legacyMirrorRevision,
      });
      return {
        projection,
        mirrorStatus: result.status,
        canonicalRevision: result.state.canonicalRevision,
      };
    } catch (error) {
      const state = await sqliteMeetingNoteRepository.getScopeWriteState(scope);
      if (state.writeOwner !== 'canonical') throw error;
      const projection = await buildCanonicalMeetingReadProjection(sqliteMeetingNoteRepository, scope);
      diagnosticWarn('[meeting-db] canonical legacy mirror failed', error);
      diagnosticAudit('meeting_canonical_legacy_mirror', {
        status: 'failed',
        scope: scope === 'guest' ? 'guest' : 'account',
        canonical_revision: state.canonicalRevision,
        legacy_mirror_revision: state.legacyMirrorRevision,
        error_code: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        projection,
        mirrorStatus: 'failed',
        canonicalRevision: state.canonicalRevision,
      };
    }
  }, [canonicalLegacyWriter, scope]);

  const adoptCanonicalOwnedProjection = useCallback((
    owned: CanonicalOwnedScopeProjection,
    operationGeneration: number,
  ): boolean => {
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return false;
    canonicalReadRequestRef.current += 1;
    canonicalReadProjectionRef.current = owned.projection;
    meetingsRef.current = owned.projection.meetings;
    transcriptCacheRef.current = owned.projection.transcripts;
    summaryCacheRef.current = owned.projection.summaries;
    setMeetings(owned.projection.meetings);
    return true;
  }, [scope]);

  const updateCanonicalGuestMeetingRoot = useCallback(async (
    legacyMeetingId: string,
    changes: UpdateMeetingNoteChanges,
    operationGeneration: number,
  ): Promise<void> => {
    if (
      scope !== 'guest'
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const canonicalMeetingId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    if (!canonicalMeetingId) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await updateCanonicalMeetingNote.execute({
        meetingId: canonicalMeetingId,
        scopeKey: 'guest',
        changes,
        canonicalWrite: true,
      });
      if (!result.applied || result.canonicalRevision === null) {
        throw new Error('会议修改未能保存，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      const projectedCanonicalId = owned.projection.canonicalIdByLegacyId[legacyMeetingId];
      const projectedMeeting = owned.projection.meetings.find(meeting => meeting.id === legacyMeetingId);
      if (projectedCanonicalId !== canonicalMeetingId || !projectedMeeting) {
        throw new Error('会议修改后的数据不完整，请刷新后重试。');
      }
      adoptCanonicalOwnedProjection(owned, operationGeneration);
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const createCanonicalGuestMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions,
    operationGeneration: number,
  ): Promise<Meeting> => {
    if (
      scope !== 'guest'
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) throw new Error('会议数据作用域已变化，请重试。');
    const projection = canonicalReadProjectionRef.current;
    if (!projection) throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    const clientRequestId = options.clientRequestId?.trim() || undefined;
    const existing = clientRequestId
      ? projection.meetings.find(meeting => meeting.clientRequestId === clientRequestId)
      : undefined;
    if (existing) return existing;

    const requestedRecordedAt = options.recordedAt ? new Date(options.recordedAt) : new Date();
    const recordedAt = Number.isNaN(requestedRecordedAt.getTime()) ? new Date() : requestedRecordedAt;
    const calendarContext = options.calendarContext ?? null;
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const created = await createCanonicalMeetingNote.execute({
        id: secureClientIdFactory.create(),
        scopeKey: 'guest',
        origin: calendarContext ? 'calendar' : 'ad_hoc',
        entryPoint: options.entryPoint ?? (calendarContext ? 'calendar_detail' : 'meeting_tab'),
        title,
        description: options.description ?? calendarContext?.snapshot.description ?? null,
        participants: options.participants ?? calendarContext?.snapshot.participants ?? [],
        location: options.location ?? calendarContext?.snapshot.location ?? null,
        mode: options.mode ?? 'realtime',
        clientRequestId,
        recordedAtMs: recordedAt.getTime(),
        lifecycle: 'draft',
        startedAtMs: null,
        endedAtMs: null,
        occurrence: calendarContext?.occurrence ?? null,
        scheduleSnapshot: calendarContext?.snapshot ?? null,
        recurrenceSegmentId: calendarContext?.recurrenceSegmentId ?? null,
        seriesKey: calendarContext?.seriesKey ?? null,
        canonicalWrite: true,
      });
      if (created.created && created.canonicalRevision === null) {
        throw new Error('会议记录未能写入本机数据版本，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      const projected = owned.projection.meetings.find(meeting => (
        owned.projection.canonicalIdByLegacyId[meeting.id] === created.aggregate.note.id
      ));
      if (!projected) throw new Error('会议创建后的数据不完整，请刷新后重试。');
      if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议数据作用域已变化，请重试。');
      }
      return projected;
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const updateCanonicalGuestMeetingStatus = useCallback(async (
    legacyMeetingId: string,
    status: string,
    patch: Partial<Meeting>,
    operationGeneration: number,
  ): Promise<boolean> => {
    if (
      scope !== 'guest'
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return false;
    const projection = canonicalReadProjectionRef.current;
    const canonicalMeetingId = projection?.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    const current = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    if (!canonicalMeetingId || !current) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }
    const effective: Meeting = {
      ...current,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await updateCanonicalGuestMeetingCapture.execute({
        meetingId: canonicalMeetingId,
        capture: captureTransitionForLegacyMeeting(effective, current.status),
        transcript: transcriptTransitionForLegacyMeeting(effective),
        recordingAsset: recordingAssetPatchForLegacyMeeting(effective, patch, Date.now()),
        canonicalWrite: true,
      });
      if (result.canonicalRevision === null) {
        throw new Error('会议录音状态未能保存，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      const projectedCanonicalId = owned.projection.canonicalIdByLegacyId[legacyMeetingId];
      const projectedMeeting = owned.projection.meetings.find(meeting => meeting.id === legacyMeetingId);
      if (projectedCanonicalId !== canonicalMeetingId || !projectedMeeting) {
        throw new Error('会议录音状态保存后的数据不完整，请刷新后重试。');
      }
      if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) return false;
      return true;
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const deleteCanonicalGuestMeeting = useCallback(async (
    legacyMeetingId: string,
    target: Meeting,
    operationGeneration: number,
  ): Promise<void> => {
    if (
      scope !== 'guest'
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const canonicalMeetingId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    if (!canonicalMeetingId) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }

    let deletionError: unknown = null;
    let deleted = false;
    canonicalStoreMutationDepthRef.current += 1;
    try {
      try {
        const result = await deleteCanonicalMeetingNote.execute({
          meetingId: canonicalMeetingId,
          scopeKey: 'guest',
          canonicalWrite: true,
        });
        deleted = result.deleted;
        if (
          !result.deleted
          || result.canonicalRevision === null
          || result.aggregate.note.lifecycle !== 'deleted'
          || result.aggregate.note.syncState !== 'deleted'
          || result.aggregate.note.deletedAtMs === null
        ) {
          throw new Error('会议记录未能删除，请重试。');
        }
        const owned = await loadCanonicalOwnedScope();
        if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
        if (
          owned.projection.canonicalIdByLegacyId[legacyMeetingId]
          || owned.projection.meetings.some(meeting => meeting.id === legacyMeetingId)
        ) {
          throw new Error('会议删除后的数据不完整，请刷新后重试。');
        }
        adoptCanonicalOwnedProjection(owned, operationGeneration);
      } catch (error) {
        deletionError = error;
      }
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }

    if (deleted) {
      const cleanupResults = await Promise.allSettled([
        deletePendingMeetingAudioUpload(scope, legacyMeetingId),
        deleteNativeMeetingArtifacts(scope, legacyMeetingId),
        deleteMeetingPlaybackCache(legacyMeetingId),
        cancelMeetingActionNotificationsForMeeting('guest', legacyMeetingId),
        ...(target.audioLocalUri
          ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
          : []),
      ]);
      const failures = cleanupResults.filter(result => result.status === 'rejected').length;
      if (failures > 0) throw new MeetingDeletionCleanupError(failures);
    }
    if (deletionError) throw deletionError;
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const saveCanonicalMeetingTranscript = useCallback(async (
    legacyMeetingId: string,
    transcript: readonly TranscriptLine[],
    options: SaveCachedTranscriptOptions,
    operationGeneration: number,
  ): Promise<void> => {
    if (
      !isScopeKey(scope)
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const projection = canonicalReadProjectionRef.current;
    const canonicalMeetingId = projection?.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    const current = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    if (!canonicalMeetingId || !current) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }
    const requestedKind = options.candidateKind
      ?? (current.status === 'recording' || current.status === 'paused'
        ? 'realtime_draft'
        : 'final');
    const candidateKind: TranscriptCandidateKind = options.serverCompleteness === 'incomplete'
      && requestedKind === 'final'
      ? 'realtime_draft'
      : requestedKind;

    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await saveCanonicalGuestMeetingTranscript.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        transcript,
        candidateKind,
        serverCompleteness: options.serverCompleteness,
        remoteRevisionId: options.remoteRevisionId,
        canonicalWrite: true,
      });
      if (result.canonicalRevision === null) {
        throw new Error('会议文字记录未能写入本机数据版本，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      const projectedCanonicalId = owned.projection.canonicalIdByLegacyId[legacyMeetingId];
      const projectedMeeting = owned.projection.meetings.find(meeting => meeting.id === legacyMeetingId);
      if (projectedCanonicalId !== canonicalMeetingId || !projectedMeeting) {
        throw new Error('会议文字记录保存后的数据不完整，请刷新后重试。');
      }
      if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议数据作用域已变化，请重试。');
      }
      if (options.remoteRevisionId) requestMeetingSpeakerCorrectionSync(scope);
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const saveCanonicalMeetingSummary = useCallback(async (
    legacyMeetingId: string,
    summary: MeetingSummary | null,
    operationGeneration: number,
  ): Promise<SaveCachedSummaryResult> => {
    if (
      !isScopeKey(scope)
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return { projection: 'preserved', mirrorStatus: 'stale_scope' };
    const projection = canonicalReadProjectionRef.current;
    const canonicalMeetingId = projection?.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    const current = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    if (!canonicalMeetingId || !current) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }

    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await mirrorLegacySummaryContent(scope, current, summary, {
        expectedCanonicalMeetingId: canonicalMeetingId,
        canonicalWrite: true,
        throwOnFailure: true,
      });
      if (summary && result.canonicalRevision === null) {
        throw new Error('会议整理结果未能写入本机数据版本，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      const projectedCanonicalId = owned.projection.canonicalIdByLegacyId[legacyMeetingId];
      const projectedMeeting = owned.projection.meetings.find(meeting => meeting.id === legacyMeetingId);
      if (projectedCanonicalId !== canonicalMeetingId || !projectedMeeting) {
        throw new Error('会议整理结果保存后的数据不完整，请刷新后重试。');
      }
      if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        return { projection: 'preserved', mirrorStatus: 'stale_scope' };
      }
      if (scope !== 'guest') requestMeetingActionSync(scope);
      return {
        projection: result.replaceLegacyProjection ? 'updated' : 'preserved',
        mirrorStatus: result.status,
      };
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const createCanonicalAccountMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions,
    operationGeneration: number,
  ): Promise<Meeting> => {
    if (
      scope === 'guest'
      || !isScopeKey(scope)
      || !accessToken
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) throw new Error('会议账号作用域已变化，请重试。');
    const projection = canonicalReadProjectionRef.current;
    if (!projection) throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    const clientRequestId = options.clientRequestId?.trim() || secureClientIdFactory.create();
    const existing = projection.meetings.find(meeting => meeting.clientRequestId === clientRequestId);
    if (existing) return existing;
    const requestedRecordedAt = options.recordedAt ? new Date(options.recordedAt) : new Date();
    const recordedAt = Number.isNaN(requestedRecordedAt.getTime()) ? new Date() : requestedRecordedAt;
    const calendarContext = options.calendarContext ?? null;
    const localId = secureClientIdFactory.create();

    canonicalStoreMutationDepthRef.current += 1;
    try {
      const created = await createCanonicalMeetingNote.execute({
        id: localId,
        scopeKey: scope,
        origin: calendarContext ? 'calendar' : 'ad_hoc',
        entryPoint: options.entryPoint ?? (calendarContext ? 'calendar_detail' : 'meeting_tab'),
        title,
        description: options.description ?? calendarContext?.snapshot.description ?? null,
        participants: options.participants ?? calendarContext?.snapshot.participants ?? [],
        location: options.location ?? calendarContext?.snapshot.location ?? null,
        mode: options.mode ?? 'realtime',
        clientRequestId,
        recordedAtMs: recordedAt.getTime(),
        lifecycle: 'draft',
        startedAtMs: null,
        endedAtMs: null,
        occurrence: calendarContext?.occurrence ?? null,
        scheduleSnapshot: calendarContext?.snapshot ?? null,
        recurrenceSegmentId: calendarContext?.recurrenceSegmentId ?? null,
        seriesKey: calendarContext?.seriesKey ?? null,
        canonicalWrite: true,
      });
      if (created.created && created.canonicalRevision === null) {
        throw new Error('会议记录未能写入本机数据版本，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议创建后的本机数据不完整，请刷新后重试。');
      }
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }

    const controller = new AbortController();
    try {
      await drainMeetingRootSync({
        scopeKey: scope,
        accessToken,
        signal: controller.signal,
        isCurrent: () => (
          generationRef.current === operationGeneration
          && activeScopeRef.current === scope
        ),
      });
    } catch (error) {
      diagnosticWarn('[meeting-root-sync] immediate create drain failed', error);
    }

    canonicalStoreMutationDepthRef.current += 1;
    try {
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议同步后的本机数据不完整，请刷新后重试。');
      }
      const projected = owned.projection.meetings.find(meeting => (
        owned.projection.canonicalIdByLegacyId[meeting.id] === localId
      ));
      if (!projected) throw new Error('会议创建后的数据不完整，请刷新后重试。');
      if (!projected.remoteId) requestMeetingRootSync(scope);
      return projected;
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [accessToken, adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const updateCanonicalAccountMeetingRoot = useCallback(async (
    legacyMeetingId: string,
    changes: UpdateMeetingNoteChanges,
    operationGeneration: number,
  ): Promise<void> => {
    if (scope === 'guest' || !isScopeKey(scope) || activeScopeRef.current !== scope) return;
    const canonicalMeetingId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    if (!canonicalMeetingId) throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await updateCanonicalMeetingNote.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        changes,
        syncOperation: {
          operationId: `meeting.update:${secureClientIdFactory.create()}`,
          operationType: 'meeting.update',
        },
        canonicalWrite: true,
      });
      if (!result.applied || result.canonicalRevision === null) {
        throw new Error('会议修改未能保存，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议修改后的数据不完整，请刷新后重试。');
      }
      requestMeetingRootSync(scope);
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const updateCanonicalAccountMeetingStatus = useCallback(async (
    legacyMeetingId: string,
    status: string,
    patch: Partial<Meeting>,
    operationGeneration: number,
  ): Promise<boolean> => {
    if (scope === 'guest' || !isScopeKey(scope) || activeScopeRef.current !== scope) return false;
    const projection = canonicalReadProjectionRef.current;
    const canonicalMeetingId = projection?.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    const current = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    if (!canonicalMeetingId || !current) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }
    const effective: Meeting = { ...current, ...patch, status, updatedAt: new Date().toISOString() };
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await updateCanonicalAccountMeetingCapture.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        capture: captureTransitionForLegacyMeeting(effective, current.status),
        transcript: transcriptTransitionForLegacyMeeting(effective),
        recordingAsset: recordingAssetPatchForLegacyMeeting(effective, patch, Date.now()),
        remoteStatus: status,
        syncOperation: {
          operationId: `meeting.update:${secureClientIdFactory.create()}`,
          operationType: 'meeting.update',
        },
        canonicalWrite: true,
      });
      if (!result.applied || result.canonicalRevision === null) {
        throw new Error('会议录音状态未能保存，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) return false;
      requestMeetingRootSync(scope);
      return true;
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const deleteCanonicalAccountMeeting = useCallback(async (
    legacyMeetingId: string,
    target: Meeting,
    operationGeneration: number,
    options: DeleteMeetingOptions,
  ): Promise<void> => {
    if (scope === 'guest' || !isScopeKey(scope) || activeScopeRef.current !== scope) return;
    if (options.recoverable) {
      if (!accessToken || !isMeetingEligibleForRecycleBin(target)) {
        throw new Error('此会议当前不能移到回收站');
      }
      const currentRetentionDays = await requireFreshMeetingRecycleCapability(accessToken);
      if (currentRetentionDays !== options.expectedRetentionDays) {
        throw new Error('回收站保留期限已更新，请重试');
      }
    }
    const canonicalMeetingId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    if (!canonicalMeetingId) throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    if (options.recoverable) {
      const canonicalTarget = await sqliteMeetingNoteRepository.get(canonicalMeetingId, scope);
      if (!canonicalTarget?.note.remoteId || canonicalTarget.note.remoteRevision === null) {
        throw new Error('会议云端状态尚未同步完成，请刷新后重试。');
      }
    }
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await deleteCanonicalMeetingNote.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        syncOperation: {
          operationId: `meeting.delete:${secureClientIdFactory.create()}`,
          operationType: 'meeting.delete',
        },
        canonicalWrite: true,
        preserveForRestore: options.recoverable === true,
      });
      if (!result.deleted || result.canonicalRevision === null) {
        throw new Error('会议记录未能删除，请重试。');
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议删除后的数据不完整，请刷新后重试。');
      }
      requestMeetingRootSync(scope);
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
    const cleanupResults = await Promise.allSettled([
      deletePendingMeetingAudioUpload(scope, legacyMeetingId),
      clearPendingMeetingTranscriptCompletion(scope, legacyMeetingId),
      deleteMeetingPlaybackCache(legacyMeetingId),
      cancelMeetingActionNotificationsForMeeting(scope, legacyMeetingId),
      ...(!options.recoverable ? [deleteNativeMeetingArtifacts(scope, legacyMeetingId)] : []),
      ...(!options.recoverable && target.audioLocalUri
        ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
        : []),
    ]);
    const failures = cleanupResults.filter(result => result.status === 'rejected').length;
    if (failures > 0) throw new MeetingDeletionCleanupError(failures);
  }, [accessToken, adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const restoreDeletedMeeting = useCallback(async (
    canonicalMeetingId: string,
    expectedRetentionDays: number,
  ): Promise<void> => enqueueGuestMutation(async () => {
    const operationGeneration = generationRef.current;
    if (
      scope === 'guest'
      || !isScopeKey(scope)
      || !accessToken
      || activeScopeRef.current !== scope
      || !getFeatureFlags().localMeetingDbAccountRootWriteV1
    ) throw new Error('当前账号不能恢复此会议');
    const retentionDays = await requireFreshMeetingRecycleCapability(accessToken);
    if (retentionDays !== expectedRetentionDays) {
      throw new Error('回收站保留期限已更新，请重试');
    }
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await restoreCanonicalMeetingNote.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        retentionDays,
        syncOperation: {
          operationId: `meeting.restore:${secureClientIdFactory.create()}`,
          operationType: 'meeting.restore',
        },
        canonicalWrite: true,
      });
      if (!result.restored || result.canonicalRevision === null) {
        throw new Error('会议记录未能恢复，请重试');
      }
      const owned = await loadCanonicalOwnedScope();
      const restoredLegacyId = owned
        ? Object.entries(owned.projection.canonicalIdByLegacyId)
          .find(([, id]) => id === canonicalMeetingId)?.[0]
        : null;
      if (!owned || !restoredLegacyId || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('会议恢复后的数据不完整，请刷新后重试');
      }
      restoreDeletedMeetingAudio(scope, restoredLegacyId);
      requestMeetingRootSync(scope);
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }), [accessToken, adoptCanonicalOwnedProjection, enqueueGuestMutation, loadCanonicalOwnedScope, scope]);

  const applyMeetingReadCutover = useCallback(async (
    legacyMeetings: readonly Meeting[],
    preflight?: MeetingDualReadReport | null,
  ): Promise<'legacy' | 'sqlite'> => {
    const readRequest = ++canonicalReadRequestRef.current;
    const flags = getFeatureFlags();
    if (!flags.localMeetingDbCanonicalReadV1 || !isScopeKey(scope)) {
      canonicalReadProjectionRef.current = null;
      return 'legacy';
    }
    const operationGeneration = generationRef.current;
    const result = await resolveMeetingReadCutover({
      enabled: true,
      repository: sqliteMeetingNoteRepository,
      scopeKey: scope,
      legacy: {
        meetings: legacyMeetings,
        transcripts: transcriptCacheRef.current,
        summaries: summaryCacheRef.current,
      },
      preflight,
    });
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
      || canonicalReadRequestRef.current !== readRequest
    ) return 'legacy';
    diagnosticAudit('meeting_db_read_cutover', {
      status: result.source === 'sqlite' ? 'active' : 'fallback',
      scope: scope === 'guest' ? 'guest' : 'account',
      reason: result.reason,
      meetings: result.projection.meetings.length,
      ...(result.preflight ? {
        repository_meetings: result.preflight.repositoryMeetings,
        tombstones: result.preflight.repositoryTombstones,
        invalid_legacy_identities: result.preflight.invalidLegacyIdentities,
        missing: result.preflight.missingFromRepository,
        extra: result.preflight.extraInRepository,
        duplicate_legacy_identities: result.preflight.duplicateLegacyIdentities,
        duplicate_identities: result.preflight.duplicateRepositoryIdentities,
        order_mismatches: result.preflight.orderMismatches,
        title_mismatches: result.preflight.titleMismatches,
        lifecycle_mismatches: result.preflight.lifecycleMismatches,
        invalid_stage_sets: result.preflight.invalidStageSets,
        context_mismatches: result.preflight.contextMismatches,
        transcript_count_mismatches: result.preflight.transcriptCountMismatches,
        summary_availability_mismatches: result.preflight.summaryAvailabilityMismatches,
      } : {}),
      ...(result.compatibility ? {
        meeting_projection_mismatches: result.compatibility.meetingMismatches,
        transcript_content_mismatches: result.compatibility.transcriptContentMismatches,
        summary_content_mismatches: result.compatibility.summaryContentMismatches,
      } : {}),
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
    });
    if (result.source === 'sqlite') {
      canonicalReadProjectionRef.current = result.projection;
      setMeetings(result.projection.meetings);
      return 'sqlite';
    }
    canonicalReadProjectionRef.current = null;
    setMeetings(result.projection.meetings);
    return 'legacy';
  }, [scope]);

  useEffect(() => {
    if (!getFeatureFlags().localMeetingDbCanonicalReadV1 || !isScopeKey(scope)) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshAfterMutation = () => {
      if (canonicalStoreMutationDepthRef.current > 0) {
        timer = setTimeout(refreshAfterMutation, 30);
        return;
      }
      timer = null;
      if (canonicalReadProjectionRef.current) return;
      const readRequest = canonicalReadRequestRef.current;
      const operationGeneration = generationRef.current;
      void loadCanonicalOwnedScope()
        .then(owned => {
          if (
            canonicalReadRequestRef.current !== readRequest
            || generationRef.current !== operationGeneration
            || activeScopeRef.current !== scope
          ) return;
          if (owned) {
            adoptCanonicalOwnedProjection(owned, operationGeneration);
            return;
          }
          void applyMeetingReadCutover(meetingsRef.current);
        })
        .catch(() => {
          if (
            canonicalReadRequestRef.current === readRequest
            && generationRef.current === operationGeneration
            && activeScopeRef.current === scope
          ) void applyMeetingReadCutover(meetingsRef.current);
        });
    };
    const unsubscribe = sqliteMeetingNoteRepository.observeList(scope, () => {
      deactivateCanonicalRead();
      if (timer) clearTimeout(timer);
      timer = setTimeout(refreshAfterMutation, 30);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [
    adoptCanonicalOwnedProjection,
    applyMeetingReadCutover,
    deactivateCanonicalRead,
    loadCanonicalOwnedScope,
    scope,
  ]);

  const refreshMeetingsFromCloud = useCallback(async () => {
    const requestGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode === 'signed_out') {
      deactivateCanonicalRead();
      meetingsRef.current = [];
      setMeetings([]);
      return;
    }
    if (mode === 'guest') {
      return;
    }
    if (!accessToken) return;

    setLoading(true);
    try {
      const flags = getFeatureFlags();
      const canonicalAccountRefresh = flags.localMeetingDbAccountRootWriteV1
        && isScopeKey(scope)
        && (await sqliteMeetingNoteRepository.getScopeWriteState(scope)).writeOwner === 'canonical';
      if (!canonicalAccountRefresh) deactivateCanonicalRead();
      if (canonicalAccountRefresh && isScopeKey(scope)) {
        canonicalStoreMutationDepthRef.current += 1;
        try {
          const pulled = await pullMeetingRootsV2({
            scopeKey: scope,
            accessToken,
            isCurrent: () => (
              generationRef.current === requestGeneration
              && activeScopeRef.current === scope
            ),
          });
          if (pulled.outcome === 'stale') return;
          if (pulled.outcome === 'pulled' || pulled.outcome === 'page_limit') {
            const owned = await loadCanonicalOwnedScope();
            if (!owned) throw new Error('会议下行同步后的本机数据所有权异常，请刷新后重试。');
            if (!adoptCanonicalOwnedProjection(owned, requestGeneration)) return;
            if (pulled.protectedLocal > 0) requestMeetingRootSync(scope);
            diagnosticAudit('meeting_account_remote_refresh', {
              status: `v2_${pulled.outcome}`,
              pages: pulled.pages,
              remote: pulled.items,
              created: pulled.created,
              updated: pulled.updated,
              protected_local: pulled.protectedLocal,
              identities_attached: pulled.attachedRemoteIdentities,
              tombstones: pulled.remoteTombstonesApplied,
              restores: pulled.remoteRestoresApplied,
              ignored_stale: pulled.ignoredStale,
              occurrence_conflicts: pulled.occurrenceConflicts,
              occurrence_deferred: pulled.occurrenceDeferred,
              canonical_revision: owned.canonicalRevision,
            });
            setError(null);
            return;
          }
          if (pulled.hadState) {
            throw new Error(
              pulled.outcome === 'disabled'
                ? '当前会议服务已暂停新版同步，请稍后重试。'
                : '会议同步服务暂时不可用，请稍后重试。',
            );
          }
        } finally {
          canonicalStoreMutationDepthRef.current = Math.max(
            0,
            canonicalStoreMutationDepthRef.current - 1,
          );
        }
      }
      const data = await fetchAllMeetings(accessToken);
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      if (canonicalAccountRefresh && isScopeKey(scope)) {
        canonicalStoreMutationDepthRef.current += 1;
        try {
          const merged = await mergeCanonicalAccountMeetingSnapshot.execute({
            scopeKey: scope,
            snapshots: data.map(serverToCanonicalSnapshot),
            canonicalWrite: true,
          });
          if (
            (merged.created > 0 || merged.updated > 0 || merged.attachedRemoteIdentities > 0)
            && merged.canonicalRevision === null
          ) throw new Error('meeting remote snapshot did not advance canonical revision');
          const owned = await loadCanonicalOwnedScope();
          if (!owned) throw new Error('meeting canonical ownership was lost during remote refresh');
          if (!adoptCanonicalOwnedProjection(owned, requestGeneration)) return;
          if (merged.protectedLocal > 0) requestMeetingRootSync(scope);
          diagnosticAudit('meeting_account_remote_refresh', {
            status: 'canonical',
            remote: data.length,
            created: merged.created,
            updated: merged.updated,
            protected_local: merged.protectedLocal,
            tombstones_preserved: merged.tombstonesPreserved,
            identities_attached: merged.attachedRemoteIdentities,
            canonical_revision: owned.canonicalRevision,
          });
          setError(null);
          return;
        } finally {
          canonicalStoreMutationDepthRef.current = Math.max(
            0,
            canonicalStoreMutationDepthRef.current - 1,
          );
        }
      }
      const previousById = new Map(meetingsRef.current.map(item => [item.id, item]));
      const remoteItems = data.map(item => {
        const remote = serverToLocal(item);
        const cached = previousById.get(remote.id);
        const preservePendingStatus = Boolean(cached?.statusSyncPending && cached.status);
        const audioSyncPending = !remote.audioAvailable && Boolean(cached?.audioSyncPending);
        const audioSyncBlocked = audioSyncPending && Boolean(cached?.audioSyncBlocked);
        const statusTags = preservePendingStatus
          ? tagsWithPendingSync(cached?.tags ?? remote.tags)
          : remote.tags;
        return {
          ...remote,
          status: preservePendingStatus ? cached?.status : remote.status,
          tags: tagsForAudioSync(statusTags, audioSyncPending, audioSyncBlocked),
          statusSyncPending: preservePendingStatus,
          audioSyncPending,
          audioSyncBlocked,
          hasTranscript: remote.hasTranscript || (transcriptCacheRef.current[remote.id]?.length ?? 0) > 0,
          hasSummary: remote.hasSummary || Boolean(summaryCacheRef.current[remote.id]),
          audioAvailable: remote.audioAvailable || Boolean(cached?.audioLocalUri),
          audioLocalUri: cached?.audioLocalUri,
          audioDurationSec: remote.audioDurationSec ?? cached?.audioDurationSec,
          audioBars: cached?.audioBars,
          duration: remote.audioDurationSec ? remote.duration : cached?.duration ?? remote.duration,
        };
      });
      const remoteIds = new Set(remoteItems.map(item => item.id));
      const retainedPendingItems = meetingsRef.current
        .filter(item => (
          !remoteIds.has(item.id)
          && (item.statusSyncPending || item.audioSyncPending)
        ))
        .map(item => ({
          ...item,
          tags: tagsForAudioSync(
            item.statusSyncPending ? tagsWithPendingSync(item.tags) : item.tags,
            Boolean(item.audioSyncPending),
            Boolean(item.audioSyncBlocked),
          ),
        }));
      const local = await Promise.all([...remoteItems, ...retainedPendingItems].map(async item => {
        if (!item.statusSyncPending || !item.status) return item;
        try {
          const synced = serverToLocal(await apiUpdateMeeting(item.id, { status: item.status }, accessToken));
          return {
            ...item,
            status: synced.status,
            tags: tagsForAudioSync(
              synced.tags,
              Boolean(item.audioSyncPending),
              Boolean(item.audioSyncBlocked),
            ),
            updatedAt: synced.updatedAt,
            statusSyncPending: false,
          };
        } catch {
          return item;
        }
      }));
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      meetingsRef.current = local;
      setMeetings(local);
      await persistMeetings(local);
      const mirrorOperation = mirrorMeetingProjections(scope, local);
      if (getFeatureFlags().localMeetingDbCanonicalReadV1) {
        await mirrorOperation;
        if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
        await applyMeetingReadCutover(local);
      } else {
        void mirrorOperation;
      }
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(null);
    } catch (err) {
      if (generationRef.current !== requestGeneration || activeScopeRef.current !== scope) return;
      setError(err instanceof Error ? err.message : '会议服务暂时不可用');
    } finally {
      if (generationRef.current === requestGeneration && activeScopeRef.current === scope) {
        setLoading(false);
      }
    }
  }, [accessToken, adoptCanonicalOwnedProjection, applyMeetingReadCutover, deactivateCanonicalRead, loadCanonicalOwnedScope, mode, persistMeetings, scope]);

  const reconcilePendingAudioUploads = useCallback(async (
    inspections: readonly PendingMeetingAudioUploadInspection[],
    operationGeneration: number,
    uploadedInspections: readonly PendingMeetingAudioUploadInspection[] = [],
  ) => {
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const inspectionById = new Map(inspections.map(item => [item.pending.meetingId, item]));
    const evidenceById = new Map<string, MeetingAudioUploadEvidence>();
    uploadedInspections.forEach(item => {
      if (!inspectionById.has(item.pending.meetingId)) {
        evidenceById.set(item.pending.meetingId, audioUploadEvidence(item, 'uploaded'));
      }
    });
    inspections.forEach(item => {
      evidenceById.set(item.pending.meetingId, audioUploadEvidence(item));
    });

    const flags = getFeatureFlags();
    if (
      (flags.localMeetingDbAccountUploadWriteV1 || flags.localMeetingDbAccountRootWriteV1)
      && mode === 'authenticated'
      && isScopeKey(scope)
    ) {
      const projection = canonicalReadProjectionRef.current;
      if (!projection) {
        throw new Error('会议上传状态尚未完成本机升级，请刷新后重试。');
      }
      canonicalStoreMutationDepthRef.current += 1;
      try {
        let changedCount = 0;
        for (const [legacyMeetingId, evidence] of evidenceById) {
          if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
          const canonicalMeetingId = projection.canonicalIdByLegacyId[legacyMeetingId]?.trim();
          if (!canonicalMeetingId) {
            throw new Error('会议上传状态缺少本机数据映射，请刷新后重试。');
          }
          const result = await reconcileCanonicalMeetingAudioUpload.execute({
            meetingId: canonicalMeetingId,
            scopeKey: scope,
            evidence,
            canonicalWrite: true,
          });
          if (result.changed && result.canonicalRevision === null) {
            throw new Error('会议上传状态未能写入本机数据版本，请重试。');
          }
          changedCount += result.changed ? 1 : 0;
        }
        if (evidenceById.size === 0) return;
        const owned = await loadCanonicalOwnedScope();
        if (!owned) throw new Error('会议上传状态的本机数据所有权异常，请刷新后重试。');
        if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) return;
        diagnosticAudit('meeting_audio_upload_reconciled', {
          status: 'canonical',
          scope: 'account',
          observed: evidenceById.size,
          changed: changedCount,
          canonical_revision: owned.canonicalRevision,
        });
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
      return;
    }

    const pendingById = new Map(
      inspections
        .filter(item => item.phase !== 'uploaded')
        .map(item => [item.pending.meetingId, item]),
    );
    let changed = false;
    const next = meetingsRef.current.map(meeting => {
      const inspection = pendingById.get(meeting.id);
      const audioSyncPending = Boolean(inspection);
      const audioSyncBlocked = inspection?.phase === 'blocked';
      const tags = tagsForAudioSync(meeting.tags, audioSyncPending, audioSyncBlocked);
      const hasMatchingTag = meeting.tags.some(tag => tag.label === '待上传') === audioSyncPending;
      const hasMatchingBlockedTag = meeting.tags.some(tag => tag.label === '上传受阻') === audioSyncBlocked;
      const pendingTagMatches = audioSyncBlocked
        ? !meeting.tags.some(tag => tag.label === '待上传')
        : hasMatchingTag;
      if (
        meeting.audioSyncPending === audioSyncPending
        && meeting.audioSyncBlocked === audioSyncBlocked
        && pendingTagMatches
        && hasMatchingBlockedTag
      ) return meeting;
      changed = true;
      return { ...meeting, audioSyncPending, audioSyncBlocked, tags };
    });
    deactivateCanonicalRead();
    if (changed) {
      meetingsRef.current = next;
      setMeetings(next);
      await persistMeetings(next);
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;

    if (isScopeKey(scope) && (changed || evidenceById.size > 0)) {
      await mirrorMeetingProjections(scope, next);
      for (const [legacyMeetingId, evidence] of evidenceById) {
        const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(legacyMeetingId, scope);
        if (!aggregate || aggregate.note.lifecycle === 'deleted') continue;
        await reconcileCanonicalMeetingAudioUpload.execute({
          meetingId: aggregate.note.id,
          scopeKey: scope,
          evidence,
          canonicalWrite: false,
        });
      }
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    if (flags.localMeetingDbCanonicalReadV1) await applyMeetingReadCutover(next);
    diagnosticAudit('meeting_audio_upload_reconciled', {
      status: 'shadow',
      scope: scope === 'guest' ? 'guest' : 'account',
      observed: evidenceById.size,
      changed: changed ? 1 : 0,
    });
  }, [
    adoptCanonicalOwnedProjection,
    applyMeetingReadCutover,
    deactivateCanonicalRead,
    loadCanonicalOwnedScope,
    mode,
    persistMeetings,
    scope,
  ]);

  const resumePendingAudioUploads = useCallback((force = false): Promise<void> => {
    if (mode !== 'authenticated' || !accessToken || activeScopeRef.current !== scope) {
      return Promise.resolve();
    }
    const operationKey = scope;
    const existing = audioResumeOperationsRef.current.get(operationKey);
    if (existing) return existing;
    const now = Date.now();
    const lastAttemptAt = lastAudioResumeAtRef.current.get(operationKey) ?? 0;
    if (!force && now - lastAttemptAt < 30_000) return Promise.resolve();
    lastAudioResumeAtRef.current.set(operationKey, now);
    const operationGeneration = generationRef.current;

    let operation: Promise<void>;
    operation = (async () => {
      let before = await listPendingMeetingAudioUploads(scope);
      let remoteIdentityChanged = false;
      if (getFeatureFlags().localMeetingDbV1 && isScopeKey(scope)) {
        for (const pending of before) {
          if (pending.remoteMeetingId) continue;
          const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
            pending.meetingId,
            scope,
          );
          const remoteId = aggregate?.note.remoteId?.trim();
          if (!remoteId || remoteId === pending.meetingId) continue;
          remoteIdentityChanged = await attachPendingMeetingAudioUploadRemoteIdentity(
            scope,
            pending.meetingId,
            remoteId,
          ) || remoteIdentityChanged;
        }
      }
      if (remoteIdentityChanged) before = await listPendingMeetingAudioUploads(scope);
      const beforeInspections = await inspectPendingMeetingAudioUploads(before);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      await reconcilePendingAudioUploads(beforeInspections, operationGeneration);
      if (before.length === 0) return;

      const result = await retryPendingMeetingAudioUploads(
        scope,
        accessToken,
        (pending, token) => uploadMeetingAudio(
          pending.remoteMeetingId ?? pending.meetingId,
          pending.audioUri,
          token,
          { fileName: pending.fileName, mimeType: pending.mimeType },
        ),
        2,
      );
      const after = await listPendingMeetingAudioUploads(scope);
      const afterInspections = await inspectPendingMeetingAudioUploads(after);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      if (
        (result.uploadedIds.length > 0 || after.length < before.length)
        && !getFeatureFlags().localMeetingDbAccountUploadWriteV1
      ) {
        await refreshMeetingsFromCloud();
      }
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const uploadedIds = new Set(result.uploadedIds);
      const uploadedInspections = beforeInspections.filter(item => uploadedIds.has(item.pending.meetingId));
      await reconcilePendingAudioUploads(afterInspections, operationGeneration, uploadedInspections);
    })().finally(() => {
      if (audioResumeOperationsRef.current.get(operationKey) === operation) {
        audioResumeOperationsRef.current.delete(operationKey);
      }
    });
    audioResumeOperationsRef.current.set(operationKey, operation);
    return operation;
  }, [accessToken, mode, reconcilePendingAudioUploads, refreshMeetingsFromCloud, scope]);

  const reconcileAudioUploads = useCallback(async (uploaded?: PendingMeetingAudioUpload) => {
    const operationGeneration = generationRef.current;
    await resumePendingAudioUploads(true);
    if (
      !uploaded
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    await reconcilePendingAudioUploads(
      [],
      operationGeneration,
      [derivePendingMeetingAudioUploadInspection(uploaded, null)],
    );
  }, [reconcilePendingAudioUploads, resumePendingAudioUploads, scope]);

  const refreshMeetings = useCallback(async () => {
    if (mode === 'authenticated' && isScopeKey(scope)) requestMeetingActionSync(scope);
    await refreshMeetingsFromCloud();
    void resumePendingAudioUploads(true).catch(() => {});
  }, [mode, refreshMeetingsFromCloud, resumePendingAudioUploads, scope]);

  useEffect(() => {
    if (mode !== 'authenticated' || !accessToken) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void resumePendingAudioUploads().catch(() => {});
    });
    return () => subscription.remove();
  }, [accessToken, mode, resumePendingAudioUploads]);

  useEffect(() => {
    if (!isScopeKey(scope)) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void reconcileNativeMeetingRecordings(scope);
    });
    return () => subscription.remove();
  }, [scope]);

  useEffect(() => {
    let alive = true;
    const loadGeneration = generationRef.current;
    const isCurrent = () => alive
      && generationRef.current === loadGeneration
      && activeScopeRef.current === scope;
    async function loadForScope() {
      if (mode === 'signed_out') return;
      setLoading(true);
      try {
        const [
          cachedMeetings,
          cachedTranscripts,
          cachedSummaries,
          pendingAudioUploads,
          pendingSummaryTasks,
        ] = await Promise.all([
          loadJson<Meeting[]>(meetingsKey, []),
          loadJson<Record<string, TranscriptLine[]>>(transcriptKey, {}),
          loadJson<Record<string, MeetingSummary | null>>(summaryKey, {}),
          mode === 'authenticated'
            ? listPendingMeetingAudioUploads(scope).catch(() => [])
            : Promise.resolve([]),
          listPendingMeetingSummaryTasks(scope).catch(() => []),
        ]);
        if (!isCurrent()) return;
        transcriptCacheRef.current = cachedTranscripts;
        summaryCacheRef.current = cachedSummaries;
        const pendingAudioById = new Map(pendingAudioUploads.map(item => [item.meetingId, item]));
        const hydratedMeetings = cachedMeetings.map(meeting => {
          const pendingAudio = pendingAudioById.get(meeting.id);
          const audioSyncPending = Boolean(pendingAudio);
          const audioSyncBlocked = pendingAudio?.uploadState === 'blocked';
          return {
            ...meeting,
            hasTranscript: meeting.hasTranscript || (cachedTranscripts[meeting.id]?.length ?? 0) > 0,
            hasSummary: meeting.hasSummary || Boolean(cachedSummaries[meeting.id]),
            audioSyncPending,
            audioSyncBlocked,
            tags: tagsForAudioSync(meeting.tags, audioSyncPending, audioSyncBlocked),
          };
        });
        meetingsRef.current = hydratedMeetings;
        setMeetings(hydratedMeetings);
        const flags = getFeatureFlags();
        if (flags.localMeetingDbCanonicalWriteV1 && isScopeKey(scope)) {
          const canonicalScope = scope;
          const owned = await loadCanonicalOwnedScope();
          if (!isCurrent()) return;
          if (owned) {
            adoptCanonicalOwnedProjection(owned, loadGeneration);
            const preflight = owned.mirrorStatus === 'failed'
              ? null
              : await auditShadowRepositoryRead(
                  canonicalScope,
                  owned.projection.meetings,
                  owned.projection.transcripts,
                  owned.projection.summaries,
                );
            if (!isCurrent()) return;
            diagnosticAudit('meeting_db_read_cutover', {
              status: 'active',
              scope: scope === 'guest' ? 'guest' : 'account',
              reason: 'canonical_owner_recovered',
              meetings: owned.projection.meetings.length,
              canonical_revision: owned.canonicalRevision,
              mirror_status: owned.mirrorStatus,
              ...(preflight ? {
                missing: preflight.missingFromRepository,
                extra: preflight.extraInRepository,
                duplicate_identities: preflight.duplicateRepositoryIdentities,
              } : {}),
            });
            void reconcileNativeMeetingRecordings(canonicalScope, { force: true });
            return;
          }
        }
        const synchronizeMeetingDb = async (legacyMeetings: readonly Meeting[]) => {
          if (!flags.localMeetingDbV1 || !isScopeKey(scope)) return;
          try {
            const report = await runLegacyMeetingShadowImport({
              scopeKey: scope,
              meetings: legacyMeetings,
              transcripts: transcriptCacheRef.current,
              summaries: summaryCacheRef.current,
              pendingAudioUploads,
              pendingSummaryTasks,
            });
            if (!isCurrent()) return;
            const counts = report.counts;
            diagnosticInfo(
              `[meeting-db] shadow ${report.skipped ? 'unchanged' : 'completed'}: `
              + `${counts.meetingNotes} meetings, ${counts.transcriptSegments} transcript segments, `
              + `${counts.summaryVersions} summaries, ${counts.recordingAssets} recordings`,
            );
            diagnosticAudit('meeting_db_shadow_import', {
              status: report.skipped ? 'unchanged' : 'completed',
              scope: scope === 'guest' ? 'guest' : 'account',
              meetings: counts.meetingNotes,
              transcript_segments: counts.transcriptSegments,
              summaries: counts.summaryVersions,
              recordings: counts.recordingAssets,
            });
            const preflight = await auditShadowRepositoryRead(
              scope,
              legacyMeetings,
              transcriptCacheRef.current,
              summaryCacheRef.current,
            );
            if (!isCurrent()) return;
            if (flags.localMeetingDbCanonicalReadV1) {
              if (preflight) await applyMeetingReadCutover(legacyMeetings, preflight);
              else {
                deactivateCanonicalRead();
                setMeetings([...legacyMeetings]);
                diagnosticAudit('meeting_db_read_cutover', {
                  status: 'fallback',
                  scope: scope === 'guest' ? 'guest' : 'account',
                  reason: 'preflight_failed',
                });
              }
            }
            void reconcileNativeMeetingRecordings(scope, { force: true });
          } catch (error) {
            if (!isCurrent()) return;
            deactivateCanonicalRead();
            setMeetings([...legacyMeetings]);
            diagnosticWarn('[meeting-db] shadow import failed', error);
            diagnosticAudit('meeting_db_shadow_import', {
              status: 'failed',
              scope: scope === 'guest' ? 'guest' : 'account',
              error_code: error instanceof Error ? error.name : 'UnknownError',
            });
            if (flags.localMeetingDbCanonicalReadV1) {
              diagnosticAudit('meeting_db_read_cutover', {
                status: 'fallback',
                scope: scope === 'guest' ? 'guest' : 'account',
                reason: 'shadow_import_failed',
              });
            }
          }
        };
        if (flags.localMeetingDbCanonicalReadV1) {
          if (mode === 'authenticated') await refreshMeetings();
          if (isCurrent()) await synchronizeMeetingDb(meetingsRef.current);
        } else {
          void synchronizeMeetingDb(cachedMeetings);
          if (mode === 'authenticated') await refreshMeetings();
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }
    void loadForScope();
    return () => { alive = false; };
  }, [
    adoptCanonicalOwnedProjection,
    applyMeetingReadCutover,
    deactivateCanonicalRead,
    loadCanonicalOwnedScope,
    meetingsKey,
    mode,
    refreshMeetings,
    scope,
    summaryKey,
    transcriptKey,
  ]);

  const createMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions = {},
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
    const cleanTitle = title.trim();
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return createCanonicalGuestMeeting(cleanTitle, options, operationGeneration);
        }
        const clientRequestId = options.clientRequestId?.trim() || undefined;
        const existing = clientRequestId
          ? meetingsRef.current.find(meeting => meeting.clientRequestId === clientRequestId)
          : undefined;
        if (existing) {
          if (isScopeKey(scope)) {
            await mirrorLegacyMeetingCreated(
              scope,
              existing,
              options.calendarContext,
              options.entryPoint,
            );
          }
          return existing;
        }
        deactivateCanonicalRead();
        const requestedRecordedAt = options.recordedAt ? new Date(options.recordedAt) : new Date();
        const recordedAt = Number.isNaN(requestedRecordedAt.getTime()) ? new Date() : requestedRecordedAt;
        const local = createGuestMeeting(cleanTitle, { ...options, clientRequestId }, recordedAt);
        const next = [local, ...meetingsRef.current];
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return local;
        meetingsRef.current = next;
        setMeetings(next);
        if (isScopeKey(scope)) {
          await mirrorLegacyMeetingCreated(
            scope,
            local,
            options.calendarContext,
            options.entryPoint,
          );
        }
        return local;
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    if (getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      return enqueueGuestMutation(() => createCanonicalAccountMeeting(
        cleanTitle,
        options,
        operationGeneration,
      ));
    }
    const created = serverToLocal(await apiCreateMeeting({
      title: cleanTitle,
      description: options.description ?? null,
      participants: options.participants ?? [],
      mode: options.mode ?? 'realtime',
      clientRequestId: options.clientRequestId,
      location: options.location ?? null,
      recordedAt: options.recordedAt ?? null,
    }, accessToken));
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return created;
    deactivateCanonicalRead();
    const next = [created, ...meetingsRef.current.filter(item => item.id !== created.id)];
    meetingsRef.current = next;
    setMeetings(next);
    void persistMeetings(next);
    if (isScopeKey(scope)) {
      await mirrorLegacyMeetingCreated(
        scope,
        created,
        options.calendarContext,
        options.entryPoint,
      );
    }
    return created;
  }, [accessToken, createCanonicalAccountMeeting, createCanonicalGuestMeeting, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope]);

  const importMeetingMedia = useCallback(async (
    media: IngestedMeetingMedia,
    options: ImportMeetingMediaOptions,
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (!isScopeKey(scope) || activeScopeRef.current !== scope || mode === 'signed_out') {
      throw new Error('meeting import scope is unavailable');
    }
    if (media.origin !== 'file_import' && media.origin !== 'share_intent') {
      throw new Error('meeting import origin is invalid');
    }
    if (!Number.isSafeInteger(options.recordedAtMs) || options.recordedAtMs < 0) {
      throw new Error('meeting import recorded time is invalid');
    }
    const now = new Date();
    const nowMs = now.getTime();
    if (options.recordedAtMs > nowMs + 60_000) {
      throw new Error('meeting import recorded time is in the future');
    }
    const recordedAt = new Date(options.recordedAtMs);
    if (Number.isNaN(recordedAt.getTime())) throw new Error('meeting import recorded time is invalid');
    const cleanTitle = options.title.trim();
    const calendarContext = options.calendarContext ?? null;
    const flags = getFeatureFlags();
    const created = await createCanonicalMeetingNote.execute({
      id: media.meetingId,
      scopeKey: scope,
      origin: media.origin,
      entryPoint: media.origin === 'share_intent' ? 'share_intent' : 'document_picker',
      title: cleanTitle,
      description: calendarContext?.snapshot.description ?? null,
      participants: calendarContext?.snapshot.participants ?? [],
      location: calendarContext?.snapshot.location ?? null,
      mode: 'offline',
      recordedAtMs: options.recordedAtMs,
      lifecycle: 'ended',
      startedAtMs: null,
      endedAtMs: Math.max(nowMs, options.recordedAtMs),
      occurrence: calendarContext?.occurrence ?? null,
      scheduleSnapshot: calendarContext?.snapshot ?? null,
      recurrenceSegmentId: calendarContext?.recurrenceSegmentId ?? null,
      seriesKey: calendarContext?.seriesKey ?? null,
      recordingAsset: {
        id: media.assetId,
        origin: 'imported',
        nativeSessionId: null,
        localUri: media.localUri,
        remoteAssetId: null,
        mimeType: media.mimeType,
        fileName: media.fileName,
        byteSize: media.byteSize,
        durationMs: media.durationMs,
        checksumSha256: media.checksumSha256,
        waveformJson: null,
        localState: 'local_ready',
        lastVerifiedAtMs: nowMs,
      },
      canonicalWrite: flags.localMeetingDbCanonicalWriteV1,
    });
    const primary = created.aggregate.recordingAssets.find(asset => asset.role === 'primary') ?? null;
    if (
      !primary
      || primary.id !== media.assetId
      || primary.localUri !== media.localUri
      || primary.checksumSha256 !== media.checksumSha256
    ) {
      throw new Error('meeting import identity is inconsistent');
    }
    if (flags.localMeetingDbCanonicalWriteV1) {
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('meeting canonical ownership was not established');
      const projected = owned.projection.meetings.find(meeting => meeting.id === media.meetingId);
      if (!projected) throw new Error('meeting canonical projection lost imported media');
      adoptCanonicalOwnedProjection(owned, operationGeneration);
      if (scope !== 'guest' && flags.localMeetingDbAccountRootWriteV1) {
        requestMeetingRootSync(scope);
      }
      return projected;
    }
    const localTags: Meeting['tags'] = [
      statusTag('ended'),
      { label: '已导入', color: C.blue },
      { label: '本机', color: C.teal },
    ];
    const local: Meeting = {
      id: media.meetingId,
      remoteId: null,
      title: cleanTitle,
      date: `${recordedAt.getFullYear()}年${recordedAt.getMonth() + 1}月${recordedAt.getDate()}日`,
      time: `${String(recordedAt.getHours()).padStart(2, '0')}:${String(recordedAt.getMinutes()).padStart(2, '0')}`,
      duration: formatDuration(media.durationMs / 1000),
      tags: scope === 'guest' ? localTags : tagsWithPendingSync(localTags),
      participants: [...(calendarContext?.snapshot.participants ?? [])],
      hasTranscript: false,
      hasSummary: false,
      status: 'ended',
      statusSyncPending: scope !== 'guest',
      mode: 'offline',
      description: calendarContext?.snapshot.description ?? null,
      location: calendarContext?.snapshot.location ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      audioAvailable: true,
      audioSyncPending: false,
      audioSyncBlocked: false,
      audioLocalUri: media.localUri,
      audioDurationSec: media.durationMs / 1000,
      clientRequestId: media.meetingId,
      source: scope === 'guest' ? 'guest' : 'cloud',
    };
    const next = [local, ...meetingsRef.current.filter(item => item.id !== local.id)];
    await persistMeetingsStrict(next);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return local;
    deactivateCanonicalRead();
    meetingsRef.current = next;
    setMeetings(next);
    if (getFeatureFlags().localMeetingDbCanonicalReadV1) {
      await applyMeetingReadCutover(next);
    }
    return local;
  }, [
    adoptCanonicalOwnedProjection,
    applyMeetingReadCutover,
    deactivateCanonicalRead,
    loadCanonicalOwnedScope,
    mode,
    persistMeetingsStrict,
    scope,
  ]);

  const deleteMeeting = useCallback(async (id: string, options: DeleteMeetingOptions = {}) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode !== 'guest' && !accessToken) throw new Error('not authenticated');

    if (mode === 'guest') {
      if (options.recoverable) throw new Error('本机会议删除后无法恢复');
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const target = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
        if (!target) return;
        assertMeetingDeletionAllowed(target);
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return deleteCanonicalGuestMeeting(id, target, operationGeneration);
        }
        deactivateCanonicalRead();
        const nextMeetings = meetingsRef.current.filter(meeting => meeting.id !== id);
        await persistMeetingsStrict(nextMeetings);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;

        const nextTranscripts = { ...transcriptCacheRef.current };
        const nextSummaries = { ...summaryCacheRef.current };
        delete nextTranscripts[id];
        delete nextSummaries[id];
        meetingsRef.current = nextMeetings;
        transcriptCacheRef.current = nextTranscripts;
        summaryCacheRef.current = nextSummaries;
        setMeetings(nextMeetings);
        if (isScopeKey(scope)) void mirrorLegacyMeetingDeletion(scope, id);
        const cleanupResults = await Promise.allSettled([
          persistTranscripts(),
          persistSummaries(),
          deletePendingMeetingAudioUpload(scope, id),
          deleteNativeMeetingArtifacts(scope, id),
          deleteMeetingPlaybackCache(id),
          ...(isScopeKey(scope) ? [cancelMeetingActionNotificationsForMeeting(scope, id)] : []),
          ...(target.audioLocalUri
            ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
            : []),
        ]);
        const failures = cleanupResults.filter(result => result.status === 'rejected').length;
        if (failures > 0) throw new MeetingDeletionCleanupError(failures);
      });
    }

    const previousMeetings = meetingsRef.current;
    const previousTranscripts = transcriptCacheRef.current;
    const previousSummaries = summaryCacheRef.current;
    const target = previousMeetings.find(m => m.id === id) ?? null;
    if (target) assertMeetingDeletionAllowed(target);
    if (options.recoverable && !getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      throw new Error('当前会议服务暂不支持回收站');
    }
    if (target && getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      return enqueueGuestMutation(() => deleteCanonicalAccountMeeting(
        id,
        target,
        operationGeneration,
        options,
      ));
    }
    if (options.recoverable) throw new Error('此会议当前不能移到回收站');
    deactivateCanonicalRead();
    const targetIndex = previousMeetings.findIndex(m => m.id === id);
    const hadTranscript = Object.prototype.hasOwnProperty.call(previousTranscripts, id);
    const previousTranscript = previousTranscripts[id];
    const hadSummary = Object.prototype.hasOwnProperty.call(previousSummaries, id);
    const previousSummary = previousSummaries[id];
    const nextMeetings = previousMeetings.filter(m => m.id !== id);
    const nextTranscripts = { ...transcriptCacheRef.current };
    const nextSummaries = { ...summaryCacheRef.current };
    delete nextTranscripts[id];
    delete nextSummaries[id];
    meetingsRef.current = nextMeetings;
    transcriptCacheRef.current = nextTranscripts;
    summaryCacheRef.current = nextSummaries;
    setMeetings(nextMeetings);

    try {
      await apiDeleteMeeting(id, accessToken!);
    } catch (err) {
      const alreadyDeleted = err instanceof HttpResponseError && err.status === 404;
      if (!alreadyDeleted) {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
          await Promise.allSettled([
            persistJson(meetingsKey, previousMeetings),
            writeAppStorageJson(transcriptKey, previousTranscripts, { removeIfEmpty: true }),
            writeAppStorageJson(summaryKey, previousSummaries, { removeIfEmpty: true }),
          ]);
          throw err;
        }
        if (target) {
          const restoredMeetings = meetingsRef.current.some(m => m.id === id)
            ? meetingsRef.current
            : [
              ...meetingsRef.current.slice(0, Math.max(0, targetIndex)),
              target,
              ...meetingsRef.current.slice(Math.max(0, targetIndex)),
            ];
          meetingsRef.current = restoredMeetings;
          setMeetings(restoredMeetings);
        }
        const restoredTranscripts = { ...transcriptCacheRef.current };
        if (hadTranscript) restoredTranscripts[id] = previousTranscript;
        else delete restoredTranscripts[id];
        transcriptCacheRef.current = restoredTranscripts;
        const restoredSummaries = { ...summaryCacheRef.current };
        if (hadSummary) restoredSummaries[id] = previousSummary;
        else delete restoredSummaries[id];
        summaryCacheRef.current = restoredSummaries;
        await Promise.allSettled([
          persistMeetings(meetingsRef.current),
          persistTranscripts(),
          persistSummaries(),
        ]);
        throw err;
      }
    }

    if (isScopeKey(scope)) void mirrorLegacyMeetingDeletion(scope, id);

    const cleanupResults = await Promise.allSettled([
      persistMeetingsStrict(nextMeetings),
      persistTranscripts(),
      persistSummaries(),
      deletePendingMeetingAudioUpload(scope, id),
      clearPendingMeetingTranscriptCompletion(scope, id),
      deleteNativeMeetingArtifacts(scope, id),
      deleteMeetingPlaybackCache(id),
      ...(isScopeKey(scope) ? [cancelMeetingActionNotificationsForMeeting(scope, id)] : []),
      ...(target?.audioLocalUri
        ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
        : []),
    ]);
    const failures = cleanupResults.filter(result => result.status === 'rejected').length;
    if (failures > 0) throw new MeetingDeletionCleanupError(failures);
  }, [accessToken, deactivateCanonicalRead, deleteCanonicalAccountMeeting, deleteCanonicalGuestMeeting, enqueueGuestMutation, meetingsKey, mode, persistMeetings, persistMeetingsStrict, persistSummaries, persistTranscripts, scope, summaryKey, transcriptKey]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const cleanTitle = title.trim();
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return updateCanonicalGuestMeetingRoot(id, { title: cleanTitle }, operationGeneration);
        }
        deactivateCanonicalRead();
        const next = meetingsRef.current.map(meeting => (
          meeting.id === id ? { ...meeting, title: cleanTitle, updatedAt: new Date().toISOString() } : meeting
        ));
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        meetingsRef.current = next;
        setMeetings(next);
        mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    if (getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      return enqueueGuestMutation(() => updateCanonicalAccountMeetingRoot(
        id,
        { title: cleanTitle },
        operationGeneration,
      ));
    }
    const previousMeeting = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
    deactivateCanonicalRead();
    const optimisticUpdatedAt = new Date().toISOString();
    const optimistic = meetingsRef.current.map(m => (
      m.id === id ? { ...m, title: cleanTitle, updatedAt: optimisticUpdatedAt } : m
    ));
    meetingsRef.current = optimistic;
    setMeetings(optimistic);
    if (previousMeeting) {
      mirrorMeetingProjection(scope, { ...previousMeeting, title: cleanTitle, updatedAt: optimisticUpdatedAt });
    }
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, { title: cleanTitle }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const next = meetingsRef.current.map(m => m.id === id
        ? {
            ...m,
            ...updated,
            audioSyncPending: m.audioSyncPending,
            audioSyncBlocked: m.audioSyncBlocked,
            tags: tagsForAudioSync(
              updated.tags,
              Boolean(m.audioSyncPending),
              Boolean(m.audioSyncBlocked),
            ),
          }
        : m);
      meetingsRef.current = next;
      setMeetings(next);
      void persistMeetings(next);
      mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
    } catch (err) {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) throw err;
      if (previousMeeting) {
        const rolledBack = meetingsRef.current.map(meeting => (
          meeting.id === id && meeting.title === cleanTitle
            ? { ...meeting, title: previousMeeting.title, updatedAt: previousMeeting.updatedAt }
            : meeting
        ));
        meetingsRef.current = rolledBack;
        setMeetings(rolledBack);
        mirrorMeetingProjection(scope, rolledBack.find(meeting => meeting.id === id));
      }
      throw err;
    }
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistMeetingsStrict, scope, updateCanonicalAccountMeetingRoot, updateCanonicalGuestMeetingRoot]);

  const updateMeetingDetails = useCallback(async (
    id: string,
    changes: Partial<Pick<Meeting, 'title' | 'description' | 'participants' | 'mode' | 'location'>>,
  ) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const normalized = {
      ...changes,
      ...(Object.prototype.hasOwnProperty.call(changes, 'title')
        ? { title: changes.title?.trim() ?? '' }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(changes, 'location')
        ? { location: changes.location?.trim() || null }
        : {}),
    };

    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return updateCanonicalGuestMeetingRoot(id, normalized, operationGeneration);
        }
        const previous = meetingsRef.current.find(meeting => meeting.id === id);
        if (!previous) throw new Error('会议记录不存在');
        deactivateCanonicalRead();
        const optimistic = meetingsRef.current.map(meeting => meeting.id === id
          ? { ...meeting, ...normalized, updatedAt: new Date().toISOString() }
          : meeting);
        await persistMeetingsStrict(optimistic);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        meetingsRef.current = optimistic;
        setMeetings(optimistic);
        mirrorMeetingProjection(scope, optimistic.find(meeting => meeting.id === id));
      });
    }

    const previous = meetingsRef.current.find(meeting => meeting.id === id);
    if (!previous) throw new Error('会议记录不存在');

    if (getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      return enqueueGuestMutation(() => updateCanonicalAccountMeetingRoot(
        id,
        normalized,
        operationGeneration,
      ));
    }

    deactivateCanonicalRead();
    const optimistic = meetingsRef.current.map(meeting => meeting.id === id
      ? { ...meeting, ...normalized, updatedAt: new Date().toISOString() }
      : meeting);
    await persistMeetingsStrict(optimistic);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    meetingsRef.current = optimistic;
    setMeetings(optimistic);
    mirrorMeetingProjection(scope, optimistic.find(meeting => meeting.id === id));

    if (!accessToken) throw new Error('登录状态已失效，请重新登录');
    try {
      const updated = serverToLocal(await apiUpdateMeeting(id, {
        title: normalized.title,
        description: normalized.description,
        participants: normalized.participants,
        mode: normalized.mode,
        location: normalized.location,
      }, accessToken));
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const next = meetingsRef.current.map(meeting => meeting.id === id
        ? {
            ...meeting,
            ...updated,
            audioLocalUri: meeting.audioLocalUri,
            audioBars: meeting.audioBars,
            audioSyncPending: meeting.audioSyncPending,
            audioSyncBlocked: meeting.audioSyncBlocked,
            statusSyncPending: meeting.statusSyncPending,
            tags: tagsForAudioSync(
              meeting.statusSyncPending ? tagsWithPendingSync(updated.tags) : updated.tags,
              Boolean(meeting.audioSyncPending),
              Boolean(meeting.audioSyncBlocked),
            ),
          }
        : meeting);
      await persistMeetingsStrict(next);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      meetingsRef.current = next;
      setMeetings(next);
      mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
    } catch (error) {
      if (generationRef.current === operationGeneration && activeScopeRef.current === scope) {
        const rolledBack = meetingsRef.current.map(meeting => meeting.id === id ? previous : meeting);
        meetingsRef.current = rolledBack;
        setMeetings(rolledBack);
        mirrorMeetingProjection(scope, rolledBack.find(meeting => meeting.id === id));
        await persistMeetingsStrict(rolledBack).catch(() => {});
      }
      throw error;
    }
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetingsStrict, scope, updateCanonicalAccountMeetingRoot, updateCanonicalGuestMeetingRoot]);

  const updateMeetingStatus = useCallback(async (
    id: string,
    status: string,
    patch: Partial<Meeting> = {},
    options: MeetingStatusUpdateOptions = {},
  ) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return false;
    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return updateCanonicalGuestMeetingStatus(id, status, patch, operationGeneration);
        }
        deactivateCanonicalRead();
        const next = meetingsRef.current.map(meeting => meeting.id === id
          ? { ...meeting, ...patch, status, tags: [statusTag(status), { label: '本机', color: C.teal }], updatedAt: new Date().toISOString() }
          : meeting);
        await persistMeetingsStrict(next);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
        meetingsRef.current = next;
        setMeetings(next);
        await mirrorMeetingProjection(scope, next.find(meeting => meeting.id === id));
        return true;
      });
    }
    if (!accessToken) throw new Error('not authenticated');
    if (getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      return enqueueGuestMutation(() => updateCanonicalAccountMeetingStatus(
        id,
        status,
        patch,
        operationGeneration,
      ));
    }
    deactivateCanonicalRead();
    const local = meetingsRef.current.map(meeting => {
      if (meeting.id !== id) return meeting;
      const audioSyncPending = Boolean(patch.audioSyncPending ?? meeting.audioSyncPending);
      const audioSyncBlocked = audioSyncPending
        && Boolean(patch.audioSyncBlocked ?? meeting.audioSyncBlocked);
      return {
        ...meeting,
        ...patch,
        status,
        tags: tagsForAudioSync(
          tagsWithPendingSync(tagsForStatus(meeting, status)),
          audioSyncPending,
          audioSyncBlocked,
        ),
        audioSyncPending,
        audioSyncBlocked,
        statusSyncPending: true,
        updatedAt: new Date().toISOString(),
      };
    });
    await persistMeetingsStrict(local);
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
    meetingsRef.current = local;
    setMeetings(local);
    await mirrorMeetingProjection(scope, local.find(meeting => meeting.id === id));
    const syncRemoteStatus = async (): Promise<boolean> => {
      try {
        const updated = serverToLocal(await apiUpdateMeeting(id, { status }, accessToken));
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return true;
        const current = meetingsRef.current.find(meeting => meeting.id === id);
        if (!current || current.status !== status || !current.statusSyncPending) return true;
        const synced = meetingsRef.current.map(meeting => {
          if (meeting.id !== id) return meeting;
          // The status response may arrive after WorkManager/reconciliation.
          // Preserve the current local media projection instead of replaying
          // the capture-time patch and resurrecting an already uploaded asset.
          const audioSyncPending = Boolean(meeting.audioSyncPending);
          const audioSyncBlocked = audioSyncPending && Boolean(meeting.audioSyncBlocked);
          return {
            ...meeting,
            ...updated,
            tags: tagsForAudioSync(updated.tags, audioSyncPending, audioSyncBlocked),
            hasTranscript: meeting.hasTranscript || updated.hasTranscript,
            audioAvailable: meeting.audioAvailable || updated.audioAvailable,
            audioLocalUri: meeting.audioLocalUri,
            audioDurationSec: meeting.audioDurationSec,
            audioBars: meeting.audioBars,
            duration: meeting.duration,
            audioSyncPending,
            audioSyncBlocked,
            statusSyncPending: false,
          };
        });
        await persistMeetingsStrict(synced);
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return true;
        meetingsRef.current = synced;
        setMeetings(synced);
        await mirrorMeetingProjection(scope, synced.find(meeting => meeting.id === id));
        return true;
      } catch {
        return false;
      }
    };
    if (options.remoteSync === 'background') {
      void syncRemoteStatus();
      return false;
    }
    return syncRemoteStatus();
  }, [accessToken, deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetingsStrict, scope, updateCanonicalAccountMeetingStatus, updateCanonicalGuestMeetingStatus]);

  const getCachedTranscript = useCallback((id: string) => {
    const canonical = canonicalReadProjectionRef.current;
    return canonical ? canonical.transcripts[id] ?? [] : transcriptCacheRef.current[id] ?? [];
  }, []);
  const saveCachedTranscript = useCallback(async (
    id: string,
    transcript: TranscriptLine[],
    options: SaveCachedTranscriptOptions = {},
  ) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) {
      throw new Error('会议账号已切换，文字记录将在返回原账号后继续保存。');
    }
    const contentMeeting = meetingsRef.current.find(meeting => meeting.id === id);
    if (!contentMeeting) throw new Error('会议记录已不存在，无法继续保存文字记录。');
    const transcriptFlags = getFeatureFlags();
    if (
      transcriptFlags.localMeetingDbCanonicalWriteV1
      && (mode === 'guest' || transcriptFlags.localMeetingDbAccountRootWriteV1)
    ) {
      return enqueueGuestMutation(() => saveCanonicalMeetingTranscript(
        id,
        transcript,
        options,
        operationGeneration,
      ));
    }
    deactivateCanonicalRead();
    const previous = transcriptCacheRef.current;
    const baseline = previous[id] ?? [];
    const derivedKind: TranscriptCandidateKind = contentMeeting?.status === 'recording'
      || contentMeeting?.status === 'paused'
      ? 'realtime_draft'
      : 'final';
    const requestedKind = options.candidateKind ?? derivedKind;
    const candidateKind: TranscriptCandidateKind = options.serverCompleteness === 'incomplete'
      && requestedKind === 'final'
      ? 'realtime_draft'
      : requestedKind;
    const decision = evaluateTranscriptLineCandidate(baseline, transcript, {
      candidateKind,
      serverCompleteness: options.serverCompleteness,
    });
    const effectiveTranscript = decision.useCandidate ? transcript : baseline;
    let next = previous;
    if (decision.useCandidate) {
      next = { ...previous, [id]: transcript };
      transcriptCacheRef.current = next;
      try {
        await persistTranscripts();
      } catch (error) {
        if (transcriptCacheRef.current === next) transcriptCacheRef.current = previous;
        throw error;
      }
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const nextMeetings = meetingsRef.current.map(m => (
      m.id === id ? { ...m, hasTranscript: effectiveTranscript.some(line => line.text.trim()) } : m
    ));
    meetingsRef.current = nextMeetings;
    setMeetings(nextMeetings);
    void persistMeetings(nextMeetings);
    await mirrorMeetingProjection(scope, nextMeetings.find(meeting => meeting.id === id));
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const latestMeeting = meetingsRef.current.find(meeting => meeting.id === id) ?? contentMeeting;
    if (latestMeeting && isScopeKey(scope)) {
      await mirrorLegacyTranscriptContent(scope, latestMeeting, transcript, {
        candidateKind,
        serverCompleteness: options.serverCompleteness,
        remoteRevisionId: options.remoteRevisionId,
      });
      if (options.remoteRevisionId) requestMeetingSpeakerCorrectionSync(scope);
    }
  }, [deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistTranscripts, saveCanonicalMeetingTranscript, scope]);

  const getCachedSummary = useCallback((id: string) => {
    const canonical = canonicalReadProjectionRef.current;
    return canonical ? canonical.summaries[id] ?? null : summaryCacheRef.current[id] ?? null;
  }, []);
  const saveCachedSummary = useCallback(async (id: string, summary: MeetingSummary | null) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) {
      return { projection: 'preserved' as const, mirrorStatus: 'stale_scope' };
    }
    const usableSummary = summary && meetingSummaryToText(summary) ? summary : null;
    const summaryFlags = getFeatureFlags();
    if (
      summaryFlags.localMeetingDbCanonicalWriteV1
      && (mode === 'guest' || summaryFlags.localMeetingDbAccountRootWriteV1)
    ) {
      return enqueueGuestMutation(() => saveCanonicalMeetingSummary(
        id,
        usableSummary,
        operationGeneration,
      ));
    }
    deactivateCanonicalRead();
    const contentMeeting = meetingsRef.current.find(meeting => meeting.id === id);
    let mirrorStatus = 'legacy_only';
    if (contentMeeting && isScopeKey(scope)) {
      const mirrorResult = await mirrorLegacySummaryContent(scope, contentMeeting, usableSummary);
      mirrorStatus = mirrorResult.status;
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
        return { projection: 'preserved' as const, mirrorStatus: 'stale_scope' };
      }
      if (!mirrorResult.replaceLegacyProjection) {
        return { projection: 'preserved' as const, mirrorStatus };
      }
    }
    const previous = summaryCacheRef.current;
    const next = { ...previous, [id]: usableSummary };
    summaryCacheRef.current = next;
    try {
      await persistSummaries();
    } catch (error) {
      if (summaryCacheRef.current === next) summaryCacheRef.current = previous;
      throw error;
    }
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) {
      return { projection: 'preserved' as const, mirrorStatus: 'stale_scope' };
    }
    const nextMeetings = meetingsRef.current.map(m => (
      m.id === id ? { ...m, hasSummary: Boolean(usableSummary) } : m
    ));
    meetingsRef.current = nextMeetings;
    setMeetings(nextMeetings);
    void persistMeetings(nextMeetings);
    mirrorMeetingProjection(scope, nextMeetings.find(meeting => meeting.id === id));
    return { projection: 'updated' as const, mirrorStatus };
  }, [deactivateCanonicalRead, enqueueGuestMutation, mode, persistMeetings, persistSummaries, saveCanonicalMeetingSummary, scope]);

  return (
    <MeetingsContext.Provider
      value={{
        meetings,
        loading,
        error,
        createMeeting,
        importMeetingMedia,
        deleteMeeting,
        restoreDeletedMeeting,
        updateMeetingTitle,
        updateMeetingDetails,
        updateMeetingStatus,
        refreshMeetings,
        reconcileAudioUploads,
        getCachedTranscript,
        saveCachedTranscript,
        getCachedSummary,
        saveCachedSummary,
      }}
    >
      {children}
    </MeetingsContext.Provider>
  );
}

export function useMeetings() {
  const ctx = useContext(MeetingsContext);
  if (!ctx) throw new Error('useMeetings must be used inside MeetingsProvider');
  return ctx;
}
