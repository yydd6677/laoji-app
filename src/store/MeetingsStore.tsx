import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Meeting, MeetingSummary, TranscriptLine } from '../types';
import { Colors as C } from '../theme/colors';
import {
  attachNativeUploadRegistration,
  clearPendingMeetingAudioUpload,
  deletePendingMeetingAudioUpload,
  inspectPendingMeetingAudioUploads,
  derivePendingMeetingAudioUploadInspection,
  listPendingMeetingAudioUploads,
  PendingMeetingAudioUpload,
  restoreDeletedMeetingAudio,
  type PendingMeetingAudioUploadInspection,
  retryPendingMeetingAudioUpload,
  retryPendingMeetingAudioUploads,
  upsertPendingMeetingAudioUpload,
} from '../services/meetingRecording';
import { meetingSummaryToText } from '../services/meetingSummary';
import {
  cancelNativeMeetingUpload,
  deleteNativeMeetingArtifacts,
  enqueueNativeDeviceV2MeetingUpload,
} from '../native/nativeTransferCoordinator';
import { deleteMeetingPlaybackCache } from '../services/meetingPlaybackCache';
import { deleteMeetingAttachmentFiles } from '../services/meetingAttachmentStorage';
import {
  clearPendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import { clearPendingMeetingTranscriptCompletion } from '../services/meetingTranscriptCompletionTasks';
import {
  isScopeKey,
  secureClientIdFactory,
  transitionProcessingStage,
  type MeetingEntryPoint,
  type MeetingProcessingStatuses,
  type MeetingSummaryDocument,
  type ProcessingStageTransition,
  type ScopeKey,
} from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import {
  isMeetingDeletionBlocked,
} from '../services/meetingDeletionPresentation';
import { canonicalRecordingSourceSha256, type MeetingSearchResult } from "../data/repositories/meetingNoteRepository";
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import { reconcileNativeMeetingRecordings } from '../services/meetingRecordingReconciliation';
import {
  persistMeetingSummaryFacts,
} from '../services/meetingContentMirror';
import {
  buildCanonicalMeetingListProjection,
  buildCanonicalMeetingReadProjection,
  type MeetingReadProjection,
} from '../services/meetingListProjection';
import type { CalendarMeetingContext } from '../services/occurrenceMeeting';
import {
  type TranscriptCandidateKind,
  type TranscriptServerCompleteness,
} from '../services/transcriptCompleteness';
import { cancelMeetingActionNotificationsForMeeting } from '../services/notifications';
import { CreateMeetingNoteUseCase } from '../application/meeting/createMeetingNote';
import { simplifyTranscriptLines } from '../utils/simplifiedChinese';
import {
  AttachImportedMeetingMediaError,
  AttachImportedMeetingMediaUseCase,
} from '../application/meeting/attachImportedMeetingMedia';
import { DeleteMeetingNoteUseCase } from '../application/meeting/deleteMeetingNote';
import { RestoreMeetingNoteUseCase } from '../application/meeting/restoreMeetingNote';
import {
  UpdateMeetingNoteUseCase,
  type UpdateMeetingNoteChanges,
} from '../application/meeting/updateMeetingNote';
import {
  UpdateGuestMeetingCaptureUseCase,
  type GuestRecordingAssetPatch,
} from '../application/meeting/updateGuestMeetingCapture';
import { SaveGuestMeetingTranscriptUseCase } from '../application/meeting/saveGuestMeetingTranscript';
import {
  ReconcileMeetingAudioUploadUseCase,
  type MeetingAudioUploadEvidence,
} from '../application/meeting/reconcileMeetingAudioUpload';
import {
  markDeviceUploadOperationSuccess,
  syncDeviceUploadOperationState,
} from '../services/deviceUploadOperations';
import {
  drainDeviceMeetingDeletionOutbox,
  enqueueDeviceMeetingDeletion,
} from '../services/deviceMeetingDeletion';
import { rememberDeviceTranscriptTask } from '../services/deviceTranscriptTasks';
import { loadDeviceV2Capabilities } from '../services/deviceV2Api';
import { sha256NativeFile, type IngestedMeetingMedia } from 'laoji-native-platform';

async function rememberDeviceTranscriptTaskBestEffort(
  meetingId: string,
  taskId: string,
): Promise<void> {
  try {
    await rememberDeviceTranscriptTask(meetingId, taskId);
  } catch (error) {
    // The upload and server-side transcription submission already succeeded.
    // SQLite is the durable task owner, so a transient local write error
    // must not turn a completed upload into a failed/retryable upload.  The
    // completion provider can still discover the result from the canonical
    // local revision and the device transcript endpoint on its next pass.
    diagnosticWarn('[device-transcript] task hint write deferred', error);
  }
}

function simplifyTranscriptCache(
  cache: Record<string, TranscriptLine[]>,
): { cache: Record<string, TranscriptLine[]>; changed: boolean } {
  let changed = false;
  const next: Record<string, TranscriptLine[]> = {};
  Object.entries(cache).forEach(([meetingId, lines]) => {
    const simplified = simplifyTranscriptLines(lines);
    if (simplified.some((line, index) => line.text !== lines[index]?.text)) changed = true;
    next[meetingId] = simplified;
  });
  return { cache: next, changed };
}

const createCanonicalMeetingNote = new CreateMeetingNoteUseCase({
  repository: sqliteMeetingNoteRepository,
});
const attachCanonicalImportedMeetingMedia = new AttachImportedMeetingMediaUseCase({
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
const updateCanonicalGuestMeetingCapture = new UpdateGuestMeetingCaptureUseCase({
  repository: sqliteMeetingNoteRepository,
});
const saveCanonicalGuestMeetingTranscript = new SaveGuestMeetingTranscriptUseCase({
  repository: sqliteMeetingNoteRepository,
});
const reconcileCanonicalMeetingAudioUpload = new ReconcileMeetingAudioUploadUseCase({
  repository: sqliteMeetingNoteRepository,
});

async function ensureMeetingScopeRevision(scopeKey: ScopeKey): Promise<number> {
  const current = await sqliteMeetingNoteRepository.getScopeRevisionState(scopeKey);
  if (current.canonicalRevision > 0) return current.canonicalRevision;
  await sqliteMeetingNoteRepository.transaction(transaction => (
    transaction.advanceCanonicalWrite(scopeKey, Date.now())
  ));
  const initialized = await sqliteMeetingNoteRepository.getScopeRevisionState(scopeKey);
  if (initialized.canonicalRevision < 1) {
    throw new Error('会议本机数据所有者初始化失败');
  }
  return initialized.canonicalRevision;
}

async function buildStableCanonicalMeetingProjection(
  scopeKey: ScopeKey,
  kind: 'roots' | 'full',
): Promise<{ projection: MeetingReadProjection; canonicalRevision: number }> {
  await ensureMeetingScopeRevision(scopeKey);
  const retryDelaysMs = [0, 25, 75];
  let lastError: unknown = null;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    const before = await sqliteMeetingNoteRepository.getScopeRevisionState(scopeKey);
    try {
      const projection = kind === 'roots'
        ? await buildCanonicalMeetingListProjection(sqliteMeetingNoteRepository, scopeKey)
        : await buildCanonicalMeetingReadProjection(sqliteMeetingNoteRepository, scopeKey);
      const after = await sqliteMeetingNoteRepository.getScopeRevisionState(scopeKey);
      if (after.canonicalRevision === before.canonicalRevision) {
        return { projection, canonicalRevision: after.canonicalRevision };
      }
      lastError = new Error('会议本机数据在读取时发生变化');
    } catch (error) {
      const after = await sqliteMeetingNoteRepository.getScopeRevisionState(scopeKey);
      if (after.canonicalRevision === before.canonicalRevision) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('会议本机数据读取未能稳定');
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

function statusTag(status: string): { label: string; color: string } {
  if (status === 'preparing') return { label: '正在准备录音', color: C.blue };
  if (status === 'recording') return { label: '录音中', color: C.red };
  if (status === 'paused') return { label: '录音已暂停', color: C.orange };
  if (status === 'processing') return { label: '处理中', color: C.orange };
  if (status === 'failed') return { label: '失败', color: C.red };
  if (isFinishedStatus(status)) return { label: '已完成', color: C.green };
  return { label: '未开始', color: C.purple };
}

function audioUploadEvidence(
  inspection: PendingMeetingAudioUploadInspection,
  status: MeetingAudioUploadEvidence['status'] = inspection.phase,
): MeetingAudioUploadEvidence {
  const pending = inspection.pending;
  return {
    status,
    recordingAssetId: pending.recordingAssetId,
    role: pending.role,
    origin: pending.origin,
    nativeSessionId: pending.nativeSessionId ?? null,
    localUri: pending.audioUri,
    mimeType: pending.mimeType,
    fileName: pending.fileName,
    byteSize: pending.byteSize ?? null,
    durationMs: pending.durationMs ?? null,
    checksumSha256: pending.checksumSha256 ?? null,
    remoteAssetId: pending.remoteAssetId ?? null,
    remoteAssetRevision: pending.remoteAssetRevision ?? null,
    attemptCount: inspection.attemptCount,
    operationId: inspection.operationId
      ?? `meeting-audio:${pending.meetingId}:${pending.createdAt}`,
    credentialGeneration: inspection.credentialGeneration,
    errorCode: inspection.errorCode,
    retryable: inspection.retryable,
    nextRetryAtMs: inspection.nextRetryAtMs,
  };
}

async function prepareGuestDeviceV2Upload(
  pending: PendingMeetingAudioUpload,
): Promise<PendingMeetingAudioUpload | null> {
  let aggregate = await sqliteMeetingNoteRepository.get(
    pending.canonicalMeetingId?.trim() || pending.meetingId,
    'guest',
  );
  if (!aggregate) {
    aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(
      pending.nativeSessionId?.trim() || pending.meetingId,
      'guest',
    );
  }
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return null;
  const asset = aggregate.recordingAssets.find(item => item.id === pending.recordingAssetId)
    ?? aggregate.recordingAssets.find(item => item.localUri === pending.audioUri)
    ?? (pending.role === 'primary'
      ? aggregate.recordingAssets.find(item => item.role === 'primary')
      : null);
  if (!asset?.localUri || asset.localState !== 'local_ready') return null;
  if (asset.localUri !== pending.audioUri) return null;

  const knownSource = asset.sourceSha256
    ?? pending.sourceSha256
    ?? canonicalRecordingSourceSha256(asset.checksumSha256 ?? pending.checksumSha256);
  const knownSize = asset.byteSize && asset.byteSize > 0
    ? asset.byteSize
    : pending.byteSize && pending.byteSize > 0
      ? pending.byteSize
      : null;
  let sourceSha256 = knownSource;
  let byteSize = knownSize;
  if (!sourceSha256 || byteSize === null) {
    const verified = await sha256NativeFile(asset.localUri);
    if (knownSource && verified.checksumSha256 !== knownSource) {
      throw new Error('本机录音内容与已保存校验值不一致');
    }
    if (knownSize !== null && verified.byteSize !== knownSize) {
      throw new Error('本机录音大小与已保存记录不一致');
    }
    sourceSha256 = verified.checksumSha256;
    byteSize = verified.byteSize;
  }
  if (!sourceSha256 || byteSize < 1) return null;

  if (
    asset.sourceSha256 !== sourceSha256
    || asset.byteSize !== byteSize
    || canonicalRecordingSourceSha256(asset.checksumSha256) !== sourceSha256
  ) {
    const updatedAtMs = Math.max(Date.now(), asset.updatedAtMs);
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const current = await transaction.getRecordingAsset(
        aggregate!.note.id,
        asset.id,
        'guest',
      );
      if (!current || current.assetGeneration !== asset.assetGeneration) {
        throw new Error('本机录音代际已变化');
      }
      if (current.sourceSha256 && current.sourceSha256 !== sourceSha256) {
        throw new Error('本机录音校验值已变化');
      }
      await transaction.saveRecordingAsset({
        ...current,
        byteSize,
        checksumSha256: sourceSha256,
        sourceSha256,
        updatedAtMs,
        lastVerifiedAtMs: updatedAtMs,
      }, 'guest');
      await transaction.advanceCanonicalWrite('guest', updatedAtMs);
    });
  }

  return {
    ...pending,
    canonicalMeetingId: aggregate.note.id,
    recordingAssetId: asset.id,
    role: asset.role,
    origin: asset.origin,
    nativeSessionId: asset.nativeSessionId ?? pending.nativeSessionId,
    audioUri: asset.localUri,
    fileName: asset.fileName ?? pending.fileName,
    mimeType: asset.mimeType?.trim() || pending.mimeType,
    byteSize,
    durationMs: asset.durationMs ?? pending.durationMs,
    checksumSha256: sourceSha256,
    sourceSha256,
    assetGeneration: asset.assetGeneration,
  };
}

/**
 * Commits the remote identity returned by the device worker before the
 * durable device operation is allowed to become terminal.  A native success
 * result is only a transport observation; the local SQLite asset is the
 * recovery authority and must contain the identity first.
 */
async function commitGuestNativeUploadSuccess(
  inspection: PendingMeetingAudioUploadInspection,
): Promise<boolean> {
  const pending = inspection.pending;
  const remoteAssetId = pending.remoteAssetId?.trim() || '';
  const remoteRevision = pending.remoteAssetRevision;
  if (
    !remoteAssetId
    || !Number.isSafeInteger(remoteRevision)
    || Number(remoteRevision) < 1
  ) {
    diagnosticWarn('[device-v2-upload] success missing remote identity', {
      meeting_id: pending.meetingId,
      recording_asset_id: pending.recordingAssetId,
    });
    return false;
  }
  const meetingId = pending.canonicalMeetingId?.trim() || pending.meetingId;
  const aggregate = await sqliteMeetingNoteRepository.get(meetingId, 'guest');
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return false;
  const asset = aggregate.recordingAssets.find(item => item.id === pending.recordingAssetId);
  if (!asset || asset.assetGeneration !== pending.assetGeneration) return false;
  const updatedAtMs = Math.max(
    Date.now(),
    asset.updatedAtMs,
    aggregate.note.updatedAtMs,
  );
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const current = await transaction.getRecordingAsset(meetingId, asset.id, 'guest');
    if (!current || current.assetGeneration !== asset.assetGeneration) {
      throw new Error('录音资产代际在上传提交期间发生变化');
    }
    if (current.remoteAssetId && current.remoteAssetId !== remoteAssetId) {
      throw new Error('录音资产云端身份发生变化');
    }
    await transaction.saveRecordingAsset({
      ...current,
      remoteAssetId,
      remoteObjectRevision: Math.max(current.remoteObjectRevision ?? 0, Number(remoteRevision)),
      localState: current.localUri ? 'local_ready' : 'remote_only',
      updatedAtMs,
      lastVerifiedAtMs: updatedAtMs,
    }, 'guest');
    await transaction.enrichTranscriptRecordingProvenance(meetingId, asset.id, 'guest');
    await transaction.advanceCanonicalWrite('guest', updatedAtMs);
  });
  await clearPendingMeetingAudioUpload('guest', pending.recordingAssetId);
  return true;
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
  if (status === 'preparing') {
    return { stage: 'capture', status: 'preparing', progress: null };
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
  const needsCaptureIdentity = status === 'preparing'
    || status === 'recording'
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

export interface CreateMeetingOptions {
  /** Optional stable local ID, used by optimistic local-first creation. */
  id?: string;
  description?: string | null;
  participants?: string[];
  mode?: Meeting['mode'];
  clientRequestId?: string;
  location?: string | null;
  recordedAt?: string | null;
  calendarContext?: CalendarMeetingContext;
  entryPoint?: MeetingEntryPoint;
  /** Initial local processing state for a shell created before media ingest. */
  initialProcessingStatuses?: Partial<MeetingProcessingStatuses>;
  /** Return a local shell without waiting for the full compatibility mirror. */
  fastLocalResult?: boolean;
}

export interface ImportMeetingMediaOptions {
  title: string;
  recordedAtMs: number;
  calendarContext?: CalendarMeetingContext | null;
  targetMeetingId?: string | null;
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
  reorderMeetings: (orderedLegacyIds: readonly string[]) => Promise<void>;
  createMeeting: (title: string, options?: CreateMeetingOptions) => Promise<Meeting>;
  importMeetingMedia: (media: IngestedMeetingMedia, options: ImportMeetingMediaOptions) => Promise<Meeting>;
  deleteMeeting: (id: string, options?: DeleteMeetingOptions) => Promise<void>;
  restoreDeletedMeeting: (canonicalMeetingId: string, expectedRetentionDays: number) => Promise<void>;
  permanentlyDeleteDeletedMeeting: (canonicalMeetingId: string, expectedRetentionDays: number) => Promise<void>;
  updateMeetingTitle: (id: string, title: string) => Promise<void>;
  updateMeetingDetails: (
    id: string,
    changes: Partial<Pick<Meeting, 'title' | 'description' | 'participants' | 'mode' | 'location'>>,
  ) => Promise<void>;
  updateMeetingStatus: (
    id: string,
    status: string,
    patch?: Partial<Meeting>,
  ) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
  searchMeetingContent: (query: string, limit?: number) => Promise<readonly MeetingSearchResult[]>;
  reconcileAudioUploads: (uploaded?: PendingMeetingAudioUpload) => Promise<void>;
  getCachedTranscript: (id: string) => TranscriptLine[];
  saveCachedTranscript: (
    id: string,
    transcript: TranscriptLine[],
    options?: SaveCachedTranscriptOptions,
  ) => Promise<void>;
  getCachedSummary: (id: string) => MeetingSummary | null;
  saveCachedSummary: (id: string, summary: MeetingSummary | null) => Promise<SaveCachedSummaryResult>;
  confirmCachedSummaryCurrent: (
    id: string,
    expected: Pick<MeetingSummaryDocument,
      'templateId' | 'templateRevision' | 'manualNoteRevision' | 'completedAtMs'>,
  ) => Promise<boolean>;
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
  localVersionId?: string | null;
}

interface CanonicalOwnedScopeProjection {
  projection: MeetingReadProjection;
  canonicalRevision: number;
}

const MeetingsContext = createContext<MeetingsContextType | null>(null);

export function MeetingsProvider({ children }: { children: React.ReactNode }) {
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
  const audioResumeRerunScopesRef = useRef(new Set<string>());
  const lastAudioResumeAtRef = useRef(new Map<string, number>());
  const audioResumePollTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const audioResumePollCountsRef = useRef(new Map<string, number>());

  const scope = 'guest';

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
    audioResumePollTimersRef.current.forEach(timer => clearTimeout(timer));
    audioResumePollTimersRef.current.clear();
    audioResumePollCountsRef.current.clear();
    audioResumeRerunScopesRef.current.clear();
  }, [scope]);

  const searchMeetingContent = useCallback(async (
    query: string,
    limit = 60,
  ): Promise<readonly MeetingSearchResult[]> => {
    if (!isScopeKey(scope) || !query.trim()) return [];
    const localResults = await sqliteMeetingNoteRepository.searchMeetingContent(scope, query, limit)
      .catch(reason => {
        // Search is an enhancement over the cached list. A migration/index
        // failure must not make the meeting list unusable; the search surface
        // keeps its title/metadata fallback and logs only a diagnostic code.
        diagnosticWarn('[meeting-search] local content index unavailable', reason);
        return [] as readonly MeetingSearchResult[];
      });
    const meetingsByIdentity = new Map(
      meetingsRef.current.map(meeting => [meeting.id, meeting] as const),
    );
    const resultKey = (result: MeetingSearchResult) => {
      const meeting = meetingsByIdentity.get(result.navigationMeetingId)
        ?? meetingsByIdentity.get(result.meetingId);
      const meetingKey = meeting?.id ?? result.meetingId;
      const sourceKey = result.sourceKind === 'title' ? 'title' : result.sourceId;
      return `${meetingKey}:${result.sourceKind}:${sourceKey}`;
    };
    const merged = new Map<string, MeetingSearchResult>();
    localResults.forEach(result => merged.set(resultKey(result), result));
    return [...merged.values()]
      .sort((left, right) => left.rank - right.rank || left.resultId.localeCompare(right.resultId))
      .slice(0, limit);
  }, [scope]);
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
    const startedAtMs = Date.now();
    try {
      const { projection, canonicalRevision } = await buildStableCanonicalMeetingProjection(scope, 'full');
      diagnosticAudit('meeting_canonical_projection_read', {
        status: 'active',
        owner: 'device-local',
        network_path: 'none',
        canonical_revision: canonicalRevision,
        elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        meetings: projection.meetings.length,
      });
      return { projection, canonicalRevision };
    } catch (error) {
      diagnosticWarn('[meeting-db] canonical projection read failed', error);
      diagnosticAudit('meeting_canonical_projection_read', {
        status: 'failed',
        owner: 'device-local',
        network_path: 'none',
        error_code: error instanceof Error ? error.name : 'UnknownError',
        elapsed_ms: Math.max(0, Date.now() - startedAtMs),
      });
      throw error;
    }
  }, [scope]);

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
    transcriptCacheRef.current = simplifyTranscriptCache(owned.projection.transcripts).cache;
    summaryCacheRef.current = owned.projection.summaries;
    setMeetings(owned.projection.meetings);
    return true;
  }, [scope]);

  /** Wait for the canonical projection during the short invalidation window after a local mutation. */
  const ensureCanonicalProjectionReady = useCallback(async (
    operationGeneration: number,
  ): Promise<MeetingReadProjection> => {
    if (
      !isScopeKey(scope)
      || activeScopeRef.current !== scope
      || generationRef.current !== operationGeneration
    ) throw new Error('会议数据作用域已变化，请重试。');
    const retryDelaysMs = [0, 50, 100, 200, 400, 800, 1_200, 1_600, 2_000];
    let lastError: unknown = null;
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      if (
        activeScopeRef.current !== scope
        || generationRef.current !== operationGeneration
      ) throw new Error('会议数据作用域已变化，请重试。');

      const existing = canonicalReadProjectionRef.current;
      if (existing) return existing;

      try {
        const owned = await loadCanonicalOwnedScope();
        if (owned) {
          if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
            throw new Error('会议数据作用域已变化，请重试。');
          }
          diagnosticAudit('meeting_db_operation_projection_wait', {
            operation: 'mutation',
            scope: 'guest',
            status: 'recovered',
            canonical_revision: owned.canonicalRevision,
          });
          return owned.projection;
        }
      } catch (error) {
        lastError = error;
        diagnosticWarn('[meeting-db] canonical projection not ready for mutation', error);
      }
    }

    diagnosticAudit('meeting_db_operation_projection_wait', {
      operation: 'mutation',
      scope: 'guest',
      status: 'failed',
      error_code: lastError instanceof Error ? lastError.name : 'ProjectionUnavailable',
    });
    throw new Error('会议数据正在准备，请稍后重试。');
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const reorderMeetings = useCallback((orderedLegacyIds: readonly string[]): Promise<void> => (
    enqueueGuestMutation(async () => {
      const operationGeneration = generationRef.current;
      if (!isScopeKey(scope) || activeScopeRef.current !== scope) {
        throw new Error('当前设备无法保存会议顺序，请稍后重试。');
      }
      const projection = canonicalReadProjectionRef.current;
      if (!projection) {
        throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
      }
      const normalizedLegacyIds = orderedLegacyIds.map(id => id.trim());
      const currentLegacyIds = projection.meetings.map(meeting => meeting.id);
      if (
        normalizedLegacyIds.some(id => !id)
        || new Set(normalizedLegacyIds).size !== normalizedLegacyIds.length
        || normalizedLegacyIds.length !== currentLegacyIds.length
        || currentLegacyIds.some(id => !normalizedLegacyIds.includes(id))
      ) {
        throw new Error('会议列表已经变化，请重新拖动排序。');
      }
      const canonicalIds = normalizedLegacyIds.map(legacyId => (
        projection.canonicalIdByLegacyId[legacyId]?.trim() ?? ''
      ));
      if (canonicalIds.some(id => !id) || new Set(canonicalIds).size !== canonicalIds.length) {
        throw new Error('会议顺序缺少本机数据映射，请刷新后重试。');
      }

      canonicalStoreMutationDepthRef.current += 1;
      try {
        const applied = await sqliteMeetingNoteRepository.replaceMeetingDisplayOrder(
          scope,
          canonicalIds,
          Date.now(),
        );
        if (!applied) throw new Error('会议列表已经变化，请重新拖动排序。');
        // Manual order is local presentation state and does not mutate meeting
        // content revisions. Force the compatibility cache to adopt the same
        // order so a cold start cannot briefly render the pre-drag sequence.
        const owned = await loadCanonicalOwnedScope();
        if (!owned) throw new Error('会议顺序的本机数据状态异常，请刷新后重试。');
        const projectedLegacyIds = owned.projection.meetings.map(meeting => meeting.id);
        if (
          projectedLegacyIds.length !== normalizedLegacyIds.length
          || projectedLegacyIds.some((id, index) => id !== normalizedLegacyIds[index])
        ) {
          throw new Error('会议顺序保存后不完整，请刷新后重试。');
        }
        if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
          throw new Error('会议数据范围已变化，请刷新后重试。');
        }
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
    })
  ), [adoptCanonicalOwnedProjection, enqueueGuestMutation, loadCanonicalOwnedScope, scope]);

  const updateCanonicalGuestMeetingRoot = useCallback(async (
    legacyMeetingId: string,
    changes: UpdateMeetingNoteChanges,
    operationGeneration: number,
  ): Promise<void> => {
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const projection = await ensureCanonicalProjectionReady(operationGeneration);
    const canonicalMeetingId = projection.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    if (!canonicalMeetingId) {
      throw new Error('会议记录的本机索引暂时不可用，请稍后重试。');
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
  }, [
    adoptCanonicalOwnedProjection,
    ensureCanonicalProjectionReady,
    loadCanonicalOwnedScope,
    scope,
  ]);

  const createCanonicalGuestMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions,
    operationGeneration: number,
  ): Promise<Meeting> => {
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) throw new Error('会议数据作用域已变化，请重试。');
    const projection = canonicalReadProjectionRef.current
      ?? await ensureCanonicalProjectionReady(operationGeneration);
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
        id: options.id ?? secureClientIdFactory.create(),
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
        initialStageStatuses: options.initialProcessingStatuses,
        canonicalWrite: true,
      });
      if (created.created && created.canonicalRevision === null) {
        throw new Error('会议记录未能写入本机数据版本，请重试。');
      }
      if (options.fastLocalResult) {
        // The import shell has no transcript, summary, or recording yet. Its
        // stable ID and committed aggregate are sufficient for the first
        // detail frame; scanning and sorting every meeting here made a single
        // import feel like a full refresh. Merge only this shell into the
        // already-owned projection and let the normal post-ingest read hydrate
        // the complete canonical state.
        const shellRecordedAt = new Date(
          created.aggregate.note.recordedAtMs ?? created.aggregate.note.createdAtMs,
        );
        const shell: Meeting = {
          id: created.aggregate.note.id,
          title: created.aggregate.note.title,
          date: `${shellRecordedAt.getFullYear()}年${shellRecordedAt.getMonth() + 1}月${shellRecordedAt.getDate()}日`,
          time: `${String(shellRecordedAt.getHours()).padStart(2, '0')}:${String(shellRecordedAt.getMinutes()).padStart(2, '0')}`,
          duration: '—',
          tags: [statusTag('preparing'), { label: '本机', color: C.teal }],
          participants: [...created.aggregate.note.participants],
          hasTranscript: false,
          hasSummary: false,
          status: 'processing',
          mode: created.aggregate.note.mode ?? 'offline',
          description: created.aggregate.note.description,
          location: created.aggregate.note.location,
          createdAt: shellRecordedAt.toISOString(),
          updatedAt: new Date(created.aggregate.note.updatedAtMs).toISOString(),
          audioAvailable: false,
          audioSyncPending: false,
          audioSyncBlocked: false,
          audioLocalUri: null,
          clientRequestId: created.aggregate.note.clientRequestId ?? undefined,
          source: 'guest',
        };
        const currentProjection = canonicalReadProjectionRef.current;
        if (currentProjection && adoptCanonicalOwnedProjection({
          projection: {
            meetings: [shell, ...currentProjection.meetings.filter(meeting => meeting.id !== shell.id)],
            transcripts: currentProjection.transcripts,
            summaries: currentProjection.summaries,
            canonicalIdByLegacyId: {
              ...currentProjection.canonicalIdByLegacyId,
              [shell.id]: created.aggregate.note.id,
            },
          },
          canonicalRevision: created.canonicalRevision ?? 0,
        }, operationGeneration)) {
          return shell;
        }
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
      if (options.fastLocalResult) {
        const fastProjected = owned.projection.meetings.find(meeting => (
          owned.projection.canonicalIdByLegacyId[meeting.id] === created.aggregate.note.id
        ));
        if (fastProjected && adoptCanonicalOwnedProjection(owned, operationGeneration)) {
          return fastProjected;
        }
      }
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
  }, [adoptCanonicalOwnedProjection, ensureCanonicalProjectionReady, loadCanonicalOwnedScope, scope]);

  const updateCanonicalGuestMeetingStatus = useCallback(async (
    legacyMeetingId: string,
    status: string,
    patch: Partial<Meeting>,
    operationGeneration: number,
  ): Promise<boolean> => {
    if (
      generationRef.current !== operationGeneration
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
    preserveForRestore: boolean,
  ): Promise<void> => {
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const projection = await ensureCanonicalProjectionReady(operationGeneration);
    const canonicalMeetingId = projection.canonicalIdByLegacyId[legacyMeetingId]?.trim();
    if (!canonicalMeetingId) {
      throw new Error('会议记录的本机索引暂时不可用，请稍后重试。');
    }

    let deleted = false;
    canonicalStoreMutationDepthRef.current += 1;
    try {
      try {
        const result = await deleteCanonicalMeetingNote.execute({
          meetingId: canonicalMeetingId,
          scopeKey: 'guest',
          canonicalWrite: true,
          preserveForRestore,
        });
        deleted = result.deleted;
        if (
          !result.deleted
          || result.canonicalRevision === null
          || result.aggregate.note.lifecycle !== 'deleted'
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
        if (!deleted) throw error;
        // The tombstone is already authoritative. Continue owned-file cleanup
        // and repair the compatibility mirror after physical purge.
        diagnosticWarn('[meeting-db] guest tombstone projection failed', error);
      }
      // Local deletion is already authoritative. Queue service cleanup before
      // any optional file purge so an offline delete cannot leave the remote
      // temporary binding around indefinitely. The queue contains only the
      // meeting UUID and is drained after the next foreground/startup.
      if (deleted) {
        void enqueueDeviceMeetingDeletion(legacyMeetingId).catch(error => {
          diagnosticWarn('[device-delete] could not persist cleanup hint', error);
        });
      }
      const cleanupResults = await Promise.allSettled([
        ...(!preserveForRestore ? [
          deletePendingMeetingAudioUpload(scope, legacyMeetingId),
          deleteNativeMeetingArtifacts(scope, legacyMeetingId),
          deleteMeetingPlaybackCache(legacyMeetingId),
          deleteMeetingAttachmentFiles(legacyMeetingId),
        ] : []),
        cancelMeetingActionNotificationsForMeeting('guest', legacyMeetingId),
        ...(!preserveForRestore && target.audioLocalUri
          ? [FileSystem.deleteAsync(target.audioLocalUri, { idempotent: true })]
          : []),
      ]);
      const failures = cleanupResults.filter(result => result.status === 'rejected').length;
      if (failures > 0) throw new MeetingDeletionCleanupError(failures);
      if (preserveForRestore) return;
      try {
        const purged = await sqliteMeetingNoteRepository.purgeDeletedGuestMeeting(
          canonicalMeetingId,
          Date.now(),
        );
        if (!purged) throw new Error('guest meeting tombstone was not purged');
        const owned = await loadCanonicalOwnedScope();
        if (!owned) throw new Error('会议本机投影未能刷新');
        if (
          owned.projection.canonicalIdByLegacyId[legacyMeetingId]
          || owned.projection.meetings.some(meeting => meeting.id === legacyMeetingId)
        ) {
          throw new Error('guest meeting remained in projection after purge');
        }
        adoptCanonicalOwnedProjection(owned, operationGeneration);
      } catch (error) {
        diagnosticWarn('[meeting-db] guest physical purge failed', error);
        throw new MeetingDeletionCleanupError(1);
      }
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [
    adoptCanonicalOwnedProjection,
    enqueueDeviceMeetingDeletion,
    ensureCanonicalProjectionReady,
    loadCanonicalOwnedScope,
    scope,
  ]);

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
    const projectedCanonicalMeetingId = projection
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    const initialProjectedMeeting = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    // A detail screen can recover remote content before the provider finishes
    // rebuilding its in-memory canonical projection. SQLite is already the
    // write owner in that window, so resolve the durable identity there and
    // use the loaded compatibility meeting instead of rejecting a valid save.
    const canonicalMeetingId = projectedCanonicalMeetingId
      || await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(legacyMeetingId, scope);
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return;
    const current = initialProjectedMeeting
      ?? meetingsRef.current.find(meeting => meeting.id === legacyMeetingId);
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
      // Reopening a detail page can replay an identical cached transcript.
      // The canonical use case intentionally returns a null revision for that
      // no-op, so it must not be presented as a failed save or rewrite the list.
      if (
        result.canonicalRevision === null
        && projectedCanonicalMeetingId
        && initialProjectedMeeting
      ) return;
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
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const saveCanonicalMeetingSummary = useCallback(async (
    legacyMeetingId: string,
    summary: MeetingSummary,
    operationGeneration: number,
  ): Promise<SaveCachedSummaryResult> => {
    if (
      !isScopeKey(scope)
      || generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return { projection: 'preserved', mirrorStatus: 'stale_scope' };
    const projection = canonicalReadProjectionRef.current;
    const projectedCanonicalMeetingId = projection
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    const initialProjectedMeeting = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
    const canonicalMeetingId = projectedCanonicalMeetingId
      || await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(legacyMeetingId, scope);
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return { projection: 'preserved', mirrorStatus: 'stale_scope' };
    const current = initialProjectedMeeting
      ?? meetingsRef.current.find(meeting => meeting.id === legacyMeetingId);
    if (!canonicalMeetingId || !current) {
      throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    }

    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await persistMeetingSummaryFacts(scope, current, summary, {
        expectedCanonicalMeetingId: canonicalMeetingId,
        canonicalWrite: true,
        throwOnFailure: true,
      });
      const existingSummaryConfirmed = result.status === 'unchanged'
        || result.status === 'preserved_existing_candidate'
        || result.status === 'activated_existing';
      if (summary && result.canonicalRevision === null && !existingSummaryConfirmed) {
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
      return {
        projection: result.replaceProjection ? 'updated' : 'preserved',
        mirrorStatus: result.status,
        localVersionId: result.localVersionId ?? null,
      };
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const restoreDeletedMeeting = useCallback(async (
    canonicalMeetingId: string,
    expectedRetentionDays: number,
  ): Promise<void> => enqueueGuestMutation(async () => {
    const operationGeneration = generationRef.current;
    if (expectedRetentionDays !== 30 || activeScopeRef.current !== scope) {
      throw new Error('回收站保留期限已更新，请重试');
    }
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const result = await restoreCanonicalMeetingNote.execute({
        meetingId: canonicalMeetingId,
        scopeKey: scope,
        retentionDays: 30,
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
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }), [adoptCanonicalOwnedProjection, enqueueGuestMutation, loadCanonicalOwnedScope, scope]);

  const permanentlyDeleteDeletedMeeting = useCallback(async (
    canonicalMeetingId: string,
    expectedRetentionDays: number,
  ): Promise<void> => enqueueGuestMutation(async () => {
    const operationGeneration = generationRef.current;
    const normalizedCanonicalId = canonicalMeetingId.trim();
    if (
      !normalizedCanonicalId
      || expectedRetentionDays !== 30
      || activeScopeRef.current !== scope
    ) throw new Error('当前回收站记录不能永久删除');

    // A deleted meeting is intentionally absent from the active projection;
    // verify canonical ownership separately, then inspect the tombstone. Keep
    // the canonical mutation guard held until the mirror has been rebuilt so
    // the list observer cannot re-project a half-purged record.
    canonicalStoreMutationDepthRef.current += 1;
    try {
      await ensureCanonicalProjectionReady(operationGeneration);
      const aggregate = await sqliteMeetingNoteRepository.get(normalizedCanonicalId, 'guest');
      if (
        !aggregate
        || aggregate.note.lifecycle !== 'deleted'
        || aggregate.note.deletedAtMs === null
        || aggregate.note.deletedFromLifecycle === null
      ) throw new Error('回收站记录已变化，请刷新后重试。');

      const legacyMeetingId = aggregate.note.legacySourceId?.trim() || aggregate.note.id;
      const cleanupResults = await Promise.allSettled([
        deletePendingMeetingAudioUpload(scope, legacyMeetingId),
        clearPendingMeetingTranscriptCompletion(scope, legacyMeetingId),
        clearPendingMeetingSummaryTask(scope, legacyMeetingId),
        deleteNativeMeetingArtifacts(scope, legacyMeetingId),
        deleteMeetingPlaybackCache(legacyMeetingId),
        deleteMeetingAttachmentFiles(legacyMeetingId),
        cancelMeetingActionNotificationsForMeeting(scope, legacyMeetingId),
        ...aggregate.recordingAssets
          .map(asset => asset.localUri?.trim())
          .filter((uri): uri is string => Boolean(uri))
          .map(uri => FileSystem.deleteAsync(uri, { idempotent: true })),
      ]);
      const failures = cleanupResults.filter(result => result.status === 'rejected').length;
      if (failures > 0) throw new MeetingDeletionCleanupError(failures);

      // Keep the device-service binding cleanup durable even if the service is
      // offline. The queue also clears the polling hint for this meeting.
      void enqueueDeviceMeetingDeletion(legacyMeetingId).catch(error => {
        diagnosticWarn('[device-delete] could not persist cleanup hint', error);
      });
      const purged = await sqliteMeetingNoteRepository.purgeDeletedGuestMeeting(
        normalizedCanonicalId,
        Date.now(),
        { allowRecoverable: true },
      );
      if (!purged) throw new Error('会议记录未能永久删除，请重试。');
      const owned = await loadCanonicalOwnedScope();
      if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
        throw new Error('永久删除后的本机数据不完整，请刷新后重试。');
      }
      if (
        owned.projection.canonicalIdByLegacyId[legacyMeetingId]
        || owned.projection.meetings.some(meeting => meeting.id === legacyMeetingId)
      ) throw new Error('会议记录仍在本机索引中，请刷新后重试。');
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }), [
    adoptCanonicalOwnedProjection,
    enqueueDeviceMeetingDeletion,
    enqueueGuestMutation,
    ensureCanonicalProjectionReady,
    loadCanonicalOwnedScope,
    scope,
  ]);

  const refreshCanonicalProjection = useCallback(async (): Promise<boolean> => {
    const operationGeneration = generationRef.current;
    const owned = await loadCanonicalOwnedScope();
    if (!owned) return false;
    return adoptCanonicalOwnedProjection(owned, operationGeneration);
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope]);

  useEffect(() => {
    if (!isScopeKey(scope)) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshAfterMutation = () => {
      if (canonicalStoreMutationDepthRef.current > 0) {
        timer = setTimeout(refreshAfterMutation, 30);
        return;
      }
      timer = null;
      if (canonicalReadProjectionRef.current) return;
      void refreshCanonicalProjection().catch(error => {
        if (activeScopeRef.current === scope) {
          diagnosticWarn('[meeting-db] canonical projection refresh failed', error);
        }
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
    deactivateCanonicalRead,
    refreshCanonicalProjection,
    scope,
  ]);

  const reconcilePendingAudioUploads = useCallback(async (
    inspections: readonly PendingMeetingAudioUploadInspection[],
    operationGeneration: number,
    uploadedInspections: readonly PendingMeetingAudioUploadInspection[] = [],
  ) => {
    if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    const inspectionById = new Map(inspections.map(item => [item.pending.recordingAssetId, item]));
    const evidenceById = new Map<string, {
      pending: PendingMeetingAudioUpload;
      evidence: MeetingAudioUploadEvidence;
    }>();
    uploadedInspections.forEach(item => {
      if (!inspectionById.has(item.pending.recordingAssetId)) {
        evidenceById.set(item.pending.recordingAssetId, {
          pending: item.pending,
          evidence: audioUploadEvidence(item, 'uploaded'),
        });
      }
    });
    inspections.forEach(item => {
      evidenceById.set(item.pending.recordingAssetId, {
        pending: item.pending,
        evidence: audioUploadEvidence(item),
      });
    });
    const statusPriority: Record<MeetingAudioUploadEvidence['status'], number> = {
      not_required: 0,
      blocked: 5,
      failed_retryable: 4,
      uploading: 3,
      queued: 2,
      uploaded: 1,
    };
    const statusByMeeting = new Map<string, MeetingAudioUploadEvidence['status']>();
    evidenceById.forEach(({ pending, evidence }) => {
      const current = statusByMeeting.get(pending.meetingId);
      if (!current || statusPriority[evidence.status] > statusPriority[current]) {
        statusByMeeting.set(pending.meetingId, evidence.status);
      }
    });
    evidenceById.forEach(entry => {
      entry.evidence = {
        ...entry.evidence,
        status: statusByMeeting.get(entry.pending.meetingId) ?? entry.evidence.status,
      };
    });
    if (evidenceById.size === 0) return;
    canonicalStoreMutationDepthRef.current += 1;
    try {
      const projection = canonicalReadProjectionRef.current;
      if (!projection) throw new Error('会议上传状态尚未完成本机数据升级，请刷新后重试。');
      let changedCount = 0;
      let deferredCount = 0;
      for (const { pending, evidence } of evidenceById.values()) {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const canonicalMeetingId = pending.canonicalMeetingId?.trim()
          || projection.canonicalIdByLegacyId[pending.meetingId]?.trim();
        if (!canonicalMeetingId) continue;
        try {
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
        } catch (error) {
          // Uploads are independent durable operations. One malformed or
          // historical row must never prevent a different WorkManager result
          // from being committed and its transcript task from being resumed.
          deferredCount += 1;
          diagnosticWarn('[device-v2-upload] canonical reconciliation deferred', error);
          diagnosticAudit('meeting_audio_upload_item_deferred', {
            status: 'deferred',
            error_code: error instanceof Error ? error.name : 'unknown',
            phase: evidence.status,
          });
        }
      }
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('会议上传状态的本机数据所有权异常，请刷新后重试。');
      if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) return;
      diagnosticAudit('meeting_audio_upload_reconciled', {
        status: 'canonical',
        scope: 'guest',
        observed: evidenceById.size,
        changed: changedCount,
        deferred: deferredCount,
        canonical_revision: owned.canonicalRevision,
      });
    } finally {
      canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
    }
  }, [
    adoptCanonicalOwnedProjection,
    loadCanonicalOwnedScope,
    scope,
  ]);

  const resumePendingAudioUploads = useCallback((force = false): Promise<void> => {
    if (activeScopeRef.current !== scope) {
      diagnosticAudit('meeting_audio_upload_resume_skipped', {
        scope,
        active_scope: activeScopeRef.current,
      });
      return Promise.resolve();
    }
    const operationKey = scope;
    const existing = audioResumeOperationsRef.current.get(operationKey);
    if (existing) {
      if (force) audioResumeRerunScopesRef.current.add(operationKey);
      return existing;
    }
    const now = Date.now();
    const lastAttemptAt = lastAudioResumeAtRef.current.get(operationKey) ?? 0;
    if (!force && now - lastAttemptAt < 30_000) return Promise.resolve();
    lastAudioResumeAtRef.current.set(operationKey, now);
    const operationGeneration = generationRef.current;

    let operation: Promise<void>;
    let shouldPollPendingUploads = false;
    operation = (async () => {
      let before = await listPendingMeetingAudioUploads(scope);
      diagnosticAudit('meeting_audio_upload_queue_inspected', {
        owner: 'device-local',
        network_path: 'device-v2',
        queue_kind: 'durable-upload-operations',
        pending: before.length,
        force,
      });
      const remoteCapability = await loadDeviceV2Capabilities().catch(reason => {
        diagnosticWarn('[device-v2-upload] capability unavailable', reason);
        return null;
      });
      const deviceV2IngressReady = Boolean(
        remoteCapability?.uploadSessionsV2 && remoteCapability.importTranscriptEventsV2,
      );
      if (deviceV2IngressReady) {
          // The capability choice covers the whole request. Remove obsolete
          // device-v1 native handles without submitting their payload, then
          // bind every local source to its immutable SQLite asset generation.
          for (const pending of before) {
            if (!pending.nativeWorkId || pending.nativeProtocol === 'device-v2-r2') continue;
            await retryPendingMeetingAudioUpload(
              scope,
              pending.recordingAssetId,
              'device',
              async () => { throw new Error('v2 原生上传不可回退到旧入口'); },
              { automatic: true, requireNativeTransport: true },
            ).catch(() => undefined);
          }
          before = await listPendingMeetingAudioUploads(scope);

          for (let offset = 0; offset < before.length; offset += 2) {
            await Promise.all(before.slice(offset, offset + 2).map(async pending => {
              // A worker may have committed the remote identity before the
              // JS process lost its executor handle.  Do not enqueue a second
              // request; the recovery pass below will finalize the existing
              // operation from its canonical asset.
              if (pending.nativeWorkId || (pending.nativeOperationId && pending.remoteAssetId)) return;
              try {
                const prepared = await prepareGuestDeviceV2Upload(pending);
                if (!prepared?.assetGeneration || !prepared.sourceSha256 || !prepared.byteSize) return;
                await upsertPendingMeetingAudioUpload(scope, prepared);
                const registration = await enqueueNativeDeviceV2MeetingUpload({
                  scope,
                  meetingId: prepared.meetingId,
                  operationId: `media-upload:${prepared.recordingAssetId}:${prepared.assetGeneration}`,
                  fileUri: prepared.audioUri,
                  mimeType: prepared.mimeType,
                  recordingAssetId: prepared.recordingAssetId,
                  assetGeneration: prepared.assetGeneration,
                  expectedBytes: prepared.byteSize,
                  checksumSha256: prepared.sourceSha256,
                });
                if (!registration) return;
                const attached = await attachNativeUploadRegistration(
                  scope,
                  prepared.recordingAssetId,
                  registration,
                );
                if (!attached) await cancelNativeMeetingUpload(registration.workId).catch(() => {});
              } catch (error) {
                diagnosticWarn('[device-v2-upload] native enqueue deferred', error);
              }
            }));
          }
          before = await listPendingMeetingAudioUploads(scope);
      }
      if (!deviceV2IngressReady) {
          // Keep the phone-owned source in the durable pending registry. A
          // There is exactly one upload owner, so an unavailable service
          // delays the upload instead of submitting it to a retired endpoint.
          diagnosticAudit('meeting_audio_upload_resume_deferred', {
            owner: 'device-local',
            network_path: 'device-v2',
            reason: 'media_capability_unavailable',
            pending: before.length,
          });
          shouldPollPendingUploads = before.length > 0;
          return;
      }

      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      if (before.length === 0) {
        audioResumePollCountsRef.current.delete(operationKey);
        return;
      }

      // Observe and settle native terminal results before projecting queued or
      // running states. Previously an unrelated stale projection could throw
      // here and abort the pass before a successful WorkManager result wrote
      // its remote asset identity and transcript task into SQLite.

      const result = await retryPendingMeetingAudioUploads(
        scope,
        'device',
        () => Promise.reject(new Error('v2 原生上传不允许 JavaScript 传输')),
        2,
        { requireNativeTransport: true },
      );
      diagnosticAudit('meeting_audio_upload_queue_processed', {
        scope: 'guest',
        found: result.found,
        uploaded: result.uploadedIds.length,
        failed: result.failedIds.length,
        skipped: result.skippedIds.length,
      });
      await Promise.all(result.uploaded
        .filter(item => Boolean(item.transcriptionTaskId))
        .map(item => rememberDeviceTranscriptTaskBestEffort(item.meetingId, item.transcriptionTaskId!)));
      let guestCanonicalUploadCommitted = false;
      if (deviceV2IngressReady) {
        // A succeeded WorkManager result may be observable only once. Commit
        // the identity carried by this very observation before re-listing the
        // durable queue; waiting for a second native read stranded successful
        // uploads as local `queued` operations after executor pruning.
        await Promise.all(result.uploaded.map(async uploaded => {
          const inspection = derivePendingMeetingAudioUploadInspection(uploaded, null);
          const operationId = inspection.pending.nativeOperationId?.trim();
          if (!operationId) return;
          const committed = await commitGuestNativeUploadSuccess(inspection).catch(error => {
            diagnosticWarn('[device-v2-upload] observed success commit deferred', error);
            return false;
          });
          if (!committed) return;
          guestCanonicalUploadCommitted = true;
          await markDeviceUploadOperationSuccess(operationId);
        }));
      }
      const after = await listPendingMeetingAudioUploads(scope);
      shouldPollPendingUploads = after.some(item => (
        Boolean(item.nativeWorkId) || !item.remoteMeetingId
      ));
      if (!shouldPollPendingUploads) audioResumePollCountsRef.current.delete(operationKey);
      const afterInspections = await inspectPendingMeetingAudioUploads(after);
      if (deviceV2IngressReady) {
        await Promise.all(afterInspections.map(async inspection => {
          const operationId = inspection.pending.nativeOperationId?.trim();
          const nativeState = inspection.nativeState;
          if (!operationId) return;
          if (!nativeState) {
            if (!inspection.pending.remoteAssetId || !inspection.pending.remoteAssetRevision) return;
            // WorkManager may prune a completed executor before JavaScript next
            // observes it. The verified remote identity is sufficient to
            // finish the same operation without creating a second upload.
            const committed = await commitGuestNativeUploadSuccess(inspection).catch(error => {
              diagnosticWarn('[device-v2-upload] orphaned success commit deferred', error);
              return false;
            });
            if (committed) {
              guestCanonicalUploadCommitted = true;
              if (inspection.pending.transcriptionTaskId) {
                await rememberDeviceTranscriptTaskBestEffort(
                  inspection.pending.meetingId,
                  inspection.pending.transcriptionTaskId,
                );
              }
              await markDeviceUploadOperationSuccess(operationId);
            }
            return;
          }
          if (nativeState.state === 'running') {
            await syncDeviceUploadOperationState(operationId, 'running');
          } else if (nativeState.state === 'failed') {
            await syncDeviceUploadOperationState(
              operationId,
              'failure',
              nativeState.reason?.trim() || 'native_upload_failed',
            );
          } else if (nativeState.state === 'cancelled') {
            await syncDeviceUploadOperationState(operationId, 'cancelled', 'native_upload_cancelled');
          } else if (nativeState.state === 'succeeded' && nativeState.result === 'uploaded') {
            const committed = await commitGuestNativeUploadSuccess(inspection).catch(error => {
              diagnosticWarn('[device-v2-upload] canonical success commit deferred', error);
              return false;
            });
            if (committed) {
              guestCanonicalUploadCommitted = true;
              if (inspection.pending.transcriptionTaskId) {
                await rememberDeviceTranscriptTaskBestEffort(
                  inspection.pending.meetingId,
                  inspection.pending.transcriptionTaskId,
                );
              }
              await markDeviceUploadOperationSuccess(operationId);
            }
          }
        }));
      }
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      if (guestCanonicalUploadCommitted) {
        const owned = await loadCanonicalOwnedScope();
        if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
          throw new Error('录音上传完成，但本机会议状态未能刷新');
        }
      }
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const uploadedInspections = result.uploaded.map(item => (
        derivePendingMeetingAudioUploadInspection(item, null)
      ));
      await reconcilePendingAudioUploads(afterInspections, operationGeneration, uploadedInspections);
    })().catch(error => {
      diagnosticWarn('[device-v2-upload] background reconciliation deferred', error);
      diagnosticAudit('meeting_audio_upload_resume_deferred', {
        owner: 'device-local',
        network_path: 'device-v2',
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }).finally(() => {
      if (audioResumeOperationsRef.current.get(operationKey) === operation) {
        audioResumeOperationsRef.current.delete(operationKey);
      }
      const rerunRequested = audioResumeRerunScopesRef.current.delete(operationKey);
      if (
        rerunRequested
        && !shouldPollPendingUploads
        && generationRef.current === operationGeneration
        && activeScopeRef.current === scope
      ) {
        // A caller can append an asset after this pass took its final queue
        // snapshot. Coalesce that narrow race into one deferred rescan. When
        // this pass already observed pending native work, the normal bounded
        // poll below owns projection refresh; an immediate rerun would turn
        // every pending-registry notification into a self-sustaining loop.
        if (!audioResumePollTimersRef.current.has(operationKey)) {
          const timer = setTimeout(() => {
            audioResumePollTimersRef.current.delete(operationKey);
            void resumePendingAudioUploads(true).catch(() => {});
          }, 250);
          audioResumePollTimersRef.current.set(operationKey, timer);
        }
        return;
      }
      if (
        shouldPollPendingUploads
        && generationRef.current === operationGeneration
        && activeScopeRef.current === scope
      ) {
        const count = audioResumePollCountsRef.current.get(operationKey) ?? 0;
        if (!audioResumePollTimersRef.current.has(operationKey)) {
          const nextCount = count + 1;
          // WorkManager owns the durable upload and may legitimately wait for
          // connectivity for hours.  Keep the foreground projection alive
          // after the initial fast window so a completed native upload is
          // reflected without requiring a restart or a manual refresh.
          const delayMs = count < 24
            ? 5_000
            : count < 72
              ? 15_000
              : 60_000;
          audioResumePollCountsRef.current.set(operationKey, nextCount);
          const timer = setTimeout(() => {
            audioResumePollTimersRef.current.delete(operationKey);
            void resumePendingAudioUploads(true).catch(() => {});
          }, delayMs);
          audioResumePollTimersRef.current.set(operationKey, timer);
        }
      }
    });
    audioResumeOperationsRef.current.set(operationKey, operation);
    return operation;
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, reconcilePendingAudioUploads, scope]);

  const reconcileAudioUploads = useCallback(async (uploaded?: PendingMeetingAudioUpload) => {
    const operationGeneration = generationRef.current;
    if (uploaded) {
      if (activeScopeRef.current !== scope) return;
      if (uploaded.transcriptionTaskId) {
        await rememberDeviceTranscriptTaskBestEffort(uploaded.meetingId, uploaded.transcriptionTaskId);
      }
      await reconcilePendingAudioUploads(
        [],
        operationGeneration,
        [derivePendingMeetingAudioUploadInspection(uploaded, null)],
      );
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
    }
    await resumePendingAudioUploads(true);
  }, [reconcilePendingAudioUploads, resumePendingAudioUploads, scope]);

  const refreshMeetings = useCallback(async () => {
    const operationGeneration = generationRef.current;
    const owned = await loadCanonicalOwnedScope();
    if (owned) adoptCanonicalOwnedProjection(owned, operationGeneration);
    void resumePendingAudioUploads(true).catch(() => {});
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, resumePendingAudioUploads]);

  useEffect(() => {
    if (!loading) void resumePendingAudioUploads(true).catch(() => {});
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void resumePendingAudioUploads().catch(() => {});
    });
    return () => subscription.remove();
  }, [loading, resumePendingAudioUploads]);

  useEffect(() => {
    if (loading) return undefined;
    void drainDeviceMeetingDeletionOutbox(true);
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void drainDeviceMeetingDeletionOutbox();
    });
    return () => subscription.remove();
  }, [loading]);

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
      if (!isScopeKey(scope)) return;
      setLoading(true);
      const startedAtMs = Date.now();
      try {
        const { projection: roots, canonicalRevision } = await buildStableCanonicalMeetingProjection(scope, 'roots');
        if (!isCurrent()) return;
        if (!adoptCanonicalOwnedProjection({ projection: roots, canonicalRevision }, loadGeneration)) return;
        diagnosticAudit('meeting_start_canonical_roots', {
          status: 'active',
          owner: 'device-local',
          network_path: 'none',
          canonical_revision: canonicalRevision,
          elapsed_ms: Math.max(0, Date.now() - startedAtMs),
          meetings: roots.meetings.length,
        });
        if (!isCurrent()) return;
        void reconcileNativeMeetingRecordings(scope, { force: true });
      } catch (error) {
        if (!isCurrent()) return;
        diagnosticWarn('[meeting-db] canonical startup failed', error);
        diagnosticAudit('meeting_start_canonical_roots', {
          status: 'failed',
          owner: 'device-local',
          network_path: 'none',
          error_code: error instanceof Error ? error.name : 'UnknownError',
          elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        });
        setError('会议记录暂时无法读取，请稍后重试。');
      } finally {
        if (isCurrent()) {
          setLoading(false);
          void resumePendingAudioUploads(true).catch(error => {
            diagnosticWarn('[device-recording] startup upload drain failed', error);
          });
        }
      }
    }

    void loadForScope();
    return () => { alive = false; };
  }, [
    adoptCanonicalOwnedProjection,
    resumePendingAudioUploads,
    scope,
  ]);

  const createMeeting = useCallback(async (
    title: string,
    options: CreateMeetingOptions = {},
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
    const cleanTitle = title.trim();
    return enqueueGuestMutation(() => {
      if (activeScopeRef.current !== scope) throw new Error('meeting scope changed');
      return createCanonicalGuestMeeting(cleanTitle, options, operationGeneration);
    });
  }, [createCanonicalGuestMeeting, enqueueGuestMutation, scope]);

  const importMeetingMedia = useCallback(async (
    media: IngestedMeetingMedia,
    options: ImportMeetingMediaOptions,
  ): Promise<Meeting> => {
    const operationGeneration = generationRef.current;
    if (!isScopeKey(scope) || activeScopeRef.current !== scope) {
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
    // Recovery is allowed to run as soon as the native ingest journal is
    // available, which can be earlier than the React meeting list's first
    // hydration. Resolve the target from the canonical owner instead of the UI
    // projection. If a previous attempt already committed the lightweight
    // meeting shell, importing the same stable media identity must attach to
    // that shell rather than trying to create the meeting a second time.
    const projection = canonicalReadProjectionRef.current
      ?? await ensureCanonicalProjectionReady(operationGeneration);
    const explicitTargetMeetingId = options.targetMeetingId?.trim() || null;
    const recoveredShellMeetingId = (
      projection.canonicalIdByLegacyId[media.meetingId]?.trim()
      && projection.meetings.some(item => item.id === media.meetingId)
    ) ? media.meetingId : null;
    const targetLegacyMeetingId = explicitTargetMeetingId ?? recoveredShellMeetingId;
    if (targetLegacyMeetingId) {
      const canonicalTargetMeetingId = projection
        .canonicalIdByLegacyId[targetLegacyMeetingId]
        ?.trim();
      const target = projection.meetings.find(item => item.id === targetLegacyMeetingId) ?? null;
      if (!canonicalTargetMeetingId || !target) {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE',
          'existing meeting import target is missing',
        );
      }
      canonicalStoreMutationDepthRef.current += 1;
      try {
        const result = await attachCanonicalImportedMeetingMedia.execute({
          targetMeetingId: canonicalTargetMeetingId,
          scopeKey: scope,
          media,
          canonicalWrite: true,
        });
        if (result.attached && result.canonicalRevision === null) {
          throw new Error('会议录音未能写入本机数据版本，请重试。');
        }
        const owned = await loadCanonicalOwnedScope();
        if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
        const projectedCanonicalId = owned.projection.canonicalIdByLegacyId[targetLegacyMeetingId];
        const projected = owned.projection.meetings.find(item => item.id === targetLegacyMeetingId);
        if (projectedCanonicalId !== canonicalTargetMeetingId || !projected) {
          throw new Error('会议录音加入后的数据不完整，请刷新后重试。');
        }
        if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
          throw new Error('会议数据作用域已变化，请重试。');
        }
        await clearPendingMeetingSummaryTask(scope, targetLegacyMeetingId).catch(error => {
          diagnosticWarn('[meeting-import] stale summary task cleanup failed', error);
        });
        const attachedAsset = result.aggregate.recordingAssets.find(asset => asset.id === media.assetId);
        if (!attachedAsset?.localUri || attachedAsset.localState !== 'local_ready') {
          throw new Error('会议录音已加入，但本机文件状态不完整。');
        }
        await upsertPendingMeetingAudioUpload(scope, {
          meetingId: targetLegacyMeetingId,
          canonicalMeetingId: canonicalTargetMeetingId,
          recordingAssetId: attachedAsset.id,
          role: attachedAsset.role,
          origin: attachedAsset.origin,
          nativeSessionId: attachedAsset.nativeSessionId ?? undefined,
          audioUri: attachedAsset.localUri,
          fileName: attachedAsset.fileName ?? media.fileName,
          mimeType: attachedAsset.mimeType?.trim() || media.mimeType,
          byteSize: attachedAsset.byteSize ?? media.byteSize,
          durationMs: attachedAsset.durationMs ?? media.durationMs,
          checksumSha256: attachedAsset.checksumSha256 ?? media.checksumSha256,
          createdAt: new Date(attachedAsset.createdAtMs).toISOString(),
          lastAttemptAt: new Date(0).toISOString(),
          attemptCount: 0,
          uploadState: 'pending',
        });
        void resumePendingAudioUploads(true).catch(error => {
          diagnosticWarn('[meeting-import] device upload resume failed', error);
        });
        return projected;
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
    }
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
      canonicalWrite: true,
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
    await upsertPendingMeetingAudioUpload(scope, {
      meetingId: media.meetingId,
      canonicalMeetingId: created.aggregate.note.id,
      recordingAssetId: primary.id,
      role: 'primary',
      origin: 'imported',
      audioUri: primary.localUri,
      fileName: primary.fileName ?? media.fileName,
      mimeType: primary.mimeType ?? media.mimeType,
      byteSize: primary.byteSize ?? media.byteSize,
      durationMs: primary.durationMs ?? media.durationMs,
      checksumSha256: primary.checksumSha256 ?? media.checksumSha256,
      createdAt: new Date(nowMs).toISOString(),
      lastAttemptAt: new Date(0).toISOString(),
      attemptCount: 0,
      uploadState: 'pending',
    });
    void resumePendingAudioUploads(true).catch(error => {
      diagnosticWarn('[meeting-import] device upload resume failed', error);
    });
    const owned = await loadCanonicalOwnedScope();
    if (!owned) throw new Error('会议本机数据状态异常，请刷新后重试。');
    const projected = owned.projection.meetings.find(meeting => meeting.id === media.meetingId);
    if (!projected) throw new Error('会议导入后的数据不完整，请刷新后重试。');
    if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
      throw new Error('会议数据作用域已变化，请重试。');
    }
    return projected;
  }, [
    adoptCanonicalOwnedProjection,
    ensureCanonicalProjectionReady,
    loadCanonicalOwnedScope,
    resumePendingAudioUploads,
    scope,
  ]);

  const deleteMeeting = useCallback(async (id: string, options: DeleteMeetingOptions = {}) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    return enqueueGuestMutation(async () => {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const target = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
      if (!target) return;
      assertMeetingDeletionAllowed(target);
      return deleteCanonicalGuestMeeting(id, target, operationGeneration, options.recoverable === true);
    });
  }, [deleteCanonicalGuestMeeting, enqueueGuestMutation, scope]);

  const updateMeetingTitle = useCallback(async (id: string, title: string) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    const cleanTitle = title.trim();
    return enqueueGuestMutation(async () => {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      return updateCanonicalGuestMeetingRoot(id, { title: cleanTitle }, operationGeneration);
    });
  }, [enqueueGuestMutation, scope, updateCanonicalGuestMeetingRoot]);

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

    return enqueueGuestMutation(async () => {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      return updateCanonicalGuestMeetingRoot(id, normalized, operationGeneration);
    });
  }, [enqueueGuestMutation, scope, updateCanonicalGuestMeetingRoot]);

  const updateMeetingStatus = useCallback(async (
    id: string,
    status: string,
    patch: Partial<Meeting> = {},
  ) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return false;
    return enqueueGuestMutation(async () => {
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return false;
      return updateCanonicalGuestMeetingStatus(id, status, patch, operationGeneration);
    });
  }, [enqueueGuestMutation, scope, updateCanonicalGuestMeetingStatus]);

  const getCachedTranscript = useCallback((id: string) => {
    const canonical = canonicalReadProjectionRef.current;
    const cached = canonical ? canonical.transcripts[id] ?? [] : transcriptCacheRef.current[id] ?? [];
    return simplifyTranscriptLines(cached);
  }, []);
  const saveCachedTranscript = useCallback(async (
    id: string,
    transcript: TranscriptLine[],
    options: SaveCachedTranscriptOptions = {},
  ) => {
    const simplifiedTranscript = simplifyTranscriptLines(transcript);
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) {
      throw new Error('会议数据范围已变化，文字记录将在重新打开会议后继续保存。');
    }
    const contentMeeting = meetingsRef.current.find(meeting => meeting.id === id);
    if (!contentMeeting) throw new Error('会议记录已不存在，无法继续保存文字记录。');
    return enqueueGuestMutation(() => saveCanonicalMeetingTranscript(
      id,
      simplifiedTranscript,
      options,
      operationGeneration,
    ));
  }, [enqueueGuestMutation, saveCanonicalMeetingTranscript, scope]);

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
    if (!usableSummary) {
      return { projection: 'preserved' as const, mirrorStatus: 'empty_or_invalid' };
    }
    return enqueueGuestMutation(() => saveCanonicalMeetingSummary(
      id,
      usableSummary,
      operationGeneration,
    ));
  }, [enqueueGuestMutation, saveCanonicalMeetingSummary, scope]);

  const confirmCachedSummaryCurrent = useCallback(async (
    id: string,
    expected: Pick<MeetingSummaryDocument,
      'templateId' | 'templateRevision' | 'manualNoteRevision' | 'completedAtMs'>,
  ): Promise<boolean> => {
    const operationGeneration = generationRef.current;
    if (!isScopeKey(scope) || activeScopeRef.current !== scope) return false;
    const projectedCanonicalId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[id]
      ?.trim();
    const aggregate = projectedCanonicalId
      ? await sqliteMeetingNoteRepository.get(projectedCanonicalId, scope)
      : await sqliteMeetingNoteRepository.findByNativeSessionId(id, scope);
    if (aggregate && aggregate.note.lifecycle !== 'deleted') {
      let confirmed = false;
      canonicalStoreMutationDepthRef.current += 1;
      try {
        await sqliteMeetingNoteRepository.transaction(async transaction => {
          const [current, activeTranscript, manualNote, stage, note] = await Promise.all([
            transaction.getCurrentSummaryVersion(aggregate.note.id, scope),
            transaction.getActiveTranscriptRevision(aggregate.note.id, scope),
            transaction.getManualNote(aggregate.note.id, scope),
            transaction.getStage(aggregate.note.id, scope, 'summary'),
            transaction.getMeeting(aggregate.note.id, scope),
          ]);
          if (
            !current
            || !activeTranscript
            || !manualNote
            || !stage
            || !note
            || note.lifecycle === 'deleted'
            || current.templateId !== expected.templateId
            || current.templateRevision !== expected.templateRevision
            || current.manualNoteRevision !== expected.manualNoteRevision
            || manualNote.revision !== expected.manualNoteRevision
            || current.completedAtMs !== expected.completedAtMs
            || current.transcriptRevisionId !== activeTranscript.id
          ) return;
          if (current.status === 'stale') {
            const restored = await transaction.restoreCurrentSummaryReady(
              aggregate.note.id,
              scope,
              current.id,
            );
            if (!restored) return;
          } else if (current.status !== 'ready') {
            return;
          }
          const updatedAtMs = Math.max(Date.now(), note.updatedAtMs, stage.updatedAtMs);
          await transaction.upsertStage(transitionProcessingStage(stage, {
            stage: 'summary',
            status: 'ready',
            progress: 1,
            jobId: null,
            inputFingerprint: current.inputFingerprint,
          }, updatedAtMs), scope);
          await transaction.updateMeeting(note.id, scope, { updatedAtMs });
          await transaction.advanceCanonicalWrite(scope, updatedAtMs);
          confirmed = true;
        });
        if (!confirmed || generationRef.current !== operationGeneration) return confirmed;
        const owned = await loadCanonicalOwnedScope();
        if (owned) adoptCanonicalOwnedProjection(owned, operationGeneration);
        return true;
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
    }

    return false;
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  return (
    <MeetingsContext.Provider
      value={{
        meetings,
        loading,
        error,
        reorderMeetings,
        createMeeting,
        importMeetingMedia,
        deleteMeeting,
        restoreDeletedMeeting,
        permanentlyDeleteDeletedMeeting,
        updateMeetingTitle,
        updateMeetingDetails,
        updateMeetingStatus,
        refreshMeetings,
        searchMeetingContent,
        reconcileAudioUploads,
        getCachedTranscript,
        saveCachedTranscript,
        getCachedSummary,
        saveCachedSummary,
        confirmCachedSummaryCurrent,
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
