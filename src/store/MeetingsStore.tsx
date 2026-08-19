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
import { getAppStorageItem, writeAppStorageJson } from '../services/appStorage';
import { HttpResponseError, readableErrorMessage } from '../services/errors';
import { meetingSummaryToText } from '../services/meetingSummary';
import {
  cancelNativeMeetingUpload,
  deleteNativeMeetingArtifacts,
  enqueueNativeDeviceV2MeetingUpload,
  enqueueNativeMeetingUpload,
} from '../native/nativeTransferCoordinator';
import { deleteMeetingPlaybackCache } from '../services/meetingPlaybackCache';
import { deleteMeetingAttachmentFiles } from '../services/meetingAttachmentStorage';
import {
  clearPendingMeetingSummaryTask,
  listPendingMeetingSummaryTasks,
} from '../services/meetingSummaryTasks';
import { clearPendingMeetingTranscriptCompletion } from '../services/meetingTranscriptCompletionTasks';
import {
  runLegacyMeetingShadowImport,
} from '../data/db/legacyImport';
import {
  MEETING_PRESENTATION_LABELS,
  isScopeKey,
  secureClientIdFactory,
  transitionProcessingStage,
  type MeetingEntryPoint,
  type MeetingProcessingStatuses,
  type MeetingSummaryDocument,
  type ProcessingStageTransition,
  type ScopeKey,
  scopeTelemetry,
} from '../domain/meeting';
import { diagnosticAudit, diagnosticInfo, diagnosticWarn } from '../services/diagnostics';
import {
  isMeetingDeletionBlocked,
  isMeetingEligibleForRecycleBin,
} from '../services/meetingDeletionPresentation';
import { requireFreshMeetingRecycleCapability } from '../services/meetingRecycleCapability';
import { getFeatureFlags } from '../config/featureFlags';
import {
  canonicalRecordingSourceSha256,
  MeetingRepositoryFacade,
  sqliteMeetingNoteRepository,
  type MeetingSearchResult,
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
  buildCanonicalMeetingListProjection,
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
import { requestMeetingTranscriptCompletion } from '../application/meeting/transcriptCompletionTrigger';
import { requestImportedMeetingTranscriptDiscovery } from '../application/meeting/importTranscriptDiscovery';
import { CreateMeetingNoteUseCase } from '../application/meeting/createMeetingNote';
import { simplifyTranscriptLines } from '../utils/simplifiedChinese';
import {
  AttachImportedMeetingMediaError,
  AttachImportedMeetingMediaUseCase,
} from '../application/meeting/attachImportedMeetingMedia';
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
import {
  pullMeetingRootsV2,
  refreshMeetingRootIdentityV2,
} from '../services/meetingRootPull';
import {
  loadMeetingCapabilities,
  searchMeetingContentV1,
  uploadRecordingAssetV2,
} from '../data/api/v2';
import { uploadMeetingRecordingToDeviceService } from '../services/deviceMeetingService';
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
import {
  recordVNextLegacySubmit,
  selectClosedVNextCapability,
} from '../services/vnextCapabilityBarrier';
import { sha256NativeFile, type IngestedMeetingMedia } from 'laoji-native-platform';

async function rememberDeviceTranscriptTaskBestEffort(
  meetingId: string,
  taskId: string,
): Promise<void> {
  try {
    await rememberDeviceTranscriptTask(meetingId, taskId);
  } catch (error) {
    // The upload and server-side transcription submission already succeeded.
    // AsyncStorage is only a local polling hint, so a transient storage error
    // must not turn a completed upload into a failed/retryable upload.  The
    // completion provider can still discover the result from the canonical
    // local revision and the device transcript endpoint on its next pass.
    diagnosticWarn('[device-transcript] task hint write deferred', error);
  }
}

const AUTOMATIC_MEETING_REFRESH_INTERVAL_MS = 30_000;
const MEETINGS_CACHE_KEY = '@laoji:meetings:v2';
// The canonical SQLite mirror can take several seconds on its first open.
// Keep a roots-only projection separately so the list surface never depends
// on transcript/summary hydration or a database migration completing first.
const MEETING_ROOTS_CACHE_KEY = '@laoji:meetingRoots:v1';
const TRANSCRIPT_CACHE_KEY = '@laoji:meetingTranscripts:v1';
const SUMMARY_CACHE_KEY = '@laoji:meetingSummaries:v1';

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

function canonicalWritesEnabledForScope(
  flags: ReturnType<typeof getFeatureFlags>,
  scope: string,
): boolean {
  return flags.localMeetingDbCanonicalWriteV1
    && (scope === 'guest' || flags.localMeetingDbAccountRootWriteV1);
}

const meetingRepositoryFacade = new MeetingRepositoryFacade(sqliteMeetingNoteRepository);
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
  if (status === 'preparing') return { label: '正在准备录音', color: C.blue };
  if (status === 'recording') return { label: '录音中', color: C.red };
  if (status === 'paused') return { label: '录音已暂停', color: C.orange };
  if (status === 'processing') return { label: '处理中', color: C.orange };
  if (status === 'failed') return { label: '失败', color: C.red };
  if (isFinishedStatus(status)) return { label: '已完成', color: C.green };
  return { label: '未开始', color: C.purple };
}

const STATUS_TAG_LABELS = new Set([
  '正在准备录音',
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

function recordingUploadFileName(assetId: string, uri: string, mimeType: string | null): string {
  const raw = uri.split(/[?#]/)[0].split('/').pop() ?? '';
  const decoded = (() => {
    try { return decodeURIComponent(raw); } catch { return raw; }
  })();
  if (/\.(wav|mp3|m4a|aac|ogg|webm|flac)$/i.test(decoded)) return decoded;
  const mime = mimeType?.trim().toLowerCase() ?? '';
  const extension = mime.includes('mpeg') ? 'mp3'
    : mime.includes('mp4') || mime.includes('m4a') ? 'm4a'
      : mime.includes('aac') ? 'aac'
        : mime.includes('ogg') ? 'ogg'
          : mime.includes('webm') ? 'webm'
            : mime.includes('flac') ? 'flac'
              : 'wav';
  return `${assetId}.${extension}`;
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
  /** Optional stable local ID, used by optimistic local-first creation. */
  id?: string;
  description?: string | null;
  participants?: string[];
  mode?: ApiMeeting['mode'];
  clientRequestId?: string;
  location?: string | null;
  recordedAt?: string | null;
  calendarContext?: CalendarMeetingContext;
  entryPoint?: MeetingEntryPoint;
  supersededRemoteMeetingId?: string | null;
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
  reorderMeetings: (orderedLegacyIds: readonly string[]) => Promise<void>;
  createMeeting: (title: string, options?: CreateMeetingOptions) => Promise<Meeting>;
  ensureMeetingRemoteIdentity: (meetingId: string) => Promise<Meeting>;
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
    options?: MeetingStatusUpdateOptions,
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
  localVersionId?: string | null;
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
  const audioResumeRerunScopesRef = useRef(new Set<string>());
  const lastAudioResumeAtRef = useRef(new Map<string, number>());
  const audioResumePollTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const audioResumePollCountsRef = useRef(new Map<string, number>());
  const recordingAssetCapabilityScopesRef = useRef(new Set<string>());

  const scope = useMemo(() => {
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    if (mode === 'guest') return 'guest';
    return 'signed_out';
  }, [mode, session?.user.id]);

  const meetingsKey = `${MEETINGS_CACHE_KEY}:${scope}`;
  const meetingRootsKey = `${MEETING_ROOTS_CACHE_KEY}:${scope}`;
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
    audioResumePollTimersRef.current.forEach(timer => clearTimeout(timer));
    audioResumePollTimersRef.current.clear();
    audioResumePollCountsRef.current.clear();
    audioResumeRerunScopesRef.current.clear();
    recordingAssetCapabilityScopesRef.current.clear();
  }, [scope]);

  const legacyProjectionWritesEnabled = getFeatureFlags().localMeetingDbLegacyProjectionWriteV1;
  const persistMeetings = useCallback((next: Meeting[]) => {
    if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();
    return persistJson(meetingsKey, next);
  }, [legacyProjectionWritesEnabled, meetingsKey, scope]);
  const persistMeetingsStrict = useCallback(
    (next: Meeting[]) => {
      if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();
      return writeAppStorageJson(meetingsKey, next, { removeIfEmpty: true });
    },
    [legacyProjectionWritesEnabled, meetingsKey, scope],
  );
  const persistMeetingRoots = useCallback(
    (next: Meeting[]) => {
      if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();
      return writeAppStorageJson(meetingRootsKey, next, { removeIfEmpty: true, bestEffort: true });
    },
    [legacyProjectionWritesEnabled, meetingRootsKey, scope],
  );
  const persistTranscripts = useCallback(
    () => {
      if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();
      return writeAppStorageJson(transcriptKey, transcriptCacheRef.current, { removeIfEmpty: true });
    },
    [legacyProjectionWritesEnabled, scope, transcriptKey],
  );
  const persistSummaries = useCallback(
    () => {
      if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();
      return writeAppStorageJson(summaryKey, summaryCacheRef.current, { removeIfEmpty: true });
    },
    [legacyProjectionWritesEnabled, scope, summaryKey],
  );
  const searchMeetingContent = useCallback(async (
    query: string,
    limit = 60,
  ): Promise<readonly MeetingSearchResult[]> => {
    if (!isScopeKey(scope) || !query.trim()) return [];
    const flags = getFeatureFlags();
    const localPromise = sqliteMeetingNoteRepository.searchMeetingContent(scope, query, limit)
      .catch(reason => {
        // Search is an enhancement over the cached list. A migration/index
        // failure must not make the meeting list unusable; the search surface
        // keeps its title/metadata fallback and logs only a diagnostic code.
        diagnosticWarn('[meeting-search] local content index unavailable', reason);
        return [] as readonly MeetingSearchResult[];
      });
    const remotePromise = flags.meetingCrossMeetingSearchV1
      && mode === 'authenticated' && accessToken
      ? searchMeetingContentV1({ accessToken, query, limit }).catch(reason => {
        // The remote semantic path is optional during rollout. Keep local FTS
        // results and metadata fallback usable when the candidate endpoint is
        // unavailable or the session has just expired.
        diagnosticWarn('[meeting-search] remote hybrid index unavailable', reason);
        return [] as readonly MeetingSearchResult[];
      })
      : Promise.resolve([] as readonly MeetingSearchResult[]);
    const [localResults, remoteResults] = await Promise.all([localPromise, remotePromise]);
    const meetingsByIdentity = new Map(
      meetingsRef.current.flatMap(meeting => [
        [meeting.id, meeting] as const,
        ...(meeting.remoteId ? [[meeting.remoteId, meeting] as const] : []),
      ]),
    );
    const resultKey = (result: MeetingSearchResult) => {
      const meeting = meetingsByIdentity.get(result.navigationMeetingId)
        ?? meetingsByIdentity.get(result.meetingId);
      const meetingKey = meeting?.remoteId ?? meeting?.id ?? result.meetingId;
      const sourceKey = result.sourceKind === 'title' ? 'title' : result.sourceId;
      return `${meetingKey}:${result.sourceKind}:${sourceKey}`;
    };
    const merged = new Map<string, MeetingSearchResult>();
    localResults.forEach(result => merged.set(resultKey(result), result));
    remoteResults.forEach(result => {
      const meeting = meetingsByIdentity.get(result.meetingId);
      if (!meeting) return;
      const normalized = { ...result, meetingId: meeting.id, navigationMeetingId: meeting.id };
      const key = resultKey(normalized);
      if (!merged.has(key)) merged.set(key, normalized);
    });
    return [...merged.values()]
      .sort((left, right) => left.rank - right.rank || left.resultId.localeCompare(right.resultId))
      .slice(0, limit);
  }, [accessToken, mode, scope]);
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

  const loadCanonicalOwnedScope = useCallback(async (
    forceLegacyMirror = false,
  ): Promise<CanonicalOwnedScopeProjection | null> => {
    if (!isScopeKey(scope)) return null;
    const startedAtMs = Date.now();
    try {
      const flags = getFeatureFlags();
      const state = await sqliteMeetingNoteRepository.getScopeWriteState(scope);
      if (state.writeOwner !== 'canonical') return null;
      // Once the device scope is canonical, AsyncStorage is deliberately not
      // rewritten on reads.  It remains a stale, read-only compatibility cache
      // until an explicitly configured rollback disables canonical reads.
      const result = flags.localMeetingDbLegacyProjectionWriteV1
        ? await mirrorCanonicalMeetingScopeToLegacy({
          repository: sqliteMeetingNoteRepository,
          writer: canonicalLegacyWriter,
          scopeKey: scope,
          force: forceLegacyMirror,
        })
        : null;
      const projection = result?.projection
        ?? await buildCanonicalMeetingReadProjection(sqliteMeetingNoteRepository, scope);
      diagnosticAudit('meeting_canonical_legacy_mirror', {
        status: result?.status ?? 'read_only',
        ...scopeTelemetry(scope, 'none'),
        mirror_kind: 'local-sqlite-projection',
        canonical_revision: state.canonicalRevision,
        legacy_mirror_revision: state.legacyMirrorRevision,
        elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        meetings: projection.meetings.length,
      });
      return {
        projection,
        mirrorStatus: state.legacyMirrorStatus === 'failed' ? 'failed' : 'unchanged',
        canonicalRevision: state.canonicalRevision,
      };
    } catch (error) {
      const state = await sqliteMeetingNoteRepository.getScopeWriteState(scope);
      if (state.writeOwner !== 'canonical') throw error;
      const projection = await buildCanonicalMeetingReadProjection(sqliteMeetingNoteRepository, scope);
      diagnosticWarn('[meeting-db] canonical legacy mirror failed', error);
      diagnosticAudit('meeting_canonical_legacy_mirror', {
        status: 'failed',
        ...scopeTelemetry(scope, 'none'),
        mirror_kind: 'local-sqlite-projection',
        canonical_revision: state.canonicalRevision,
        legacy_mirror_revision: state.legacyMirrorRevision,
        error_code: error instanceof Error ? error.name : 'UnknownError',
        elapsed_ms: Math.max(0, Date.now() - startedAtMs),
        meetings: projection.meetings.length,
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
    transcriptCacheRef.current = simplifyTranscriptCache(owned.projection.transcripts).cache;
    summaryCacheRef.current = owned.projection.summaries;
    setMeetings(owned.projection.meetings);
    // Root cards are intentionally independent of the legacy full cache. They
    // are safe to render while the canonical content projection is still
    // hydrating and make the next cold start independent of SQLite open time.
    void persistMeetingRoots(owned.projection.meetings);
    return true;
  }, [persistMeetingRoots, scope]);

  /**
   * The roots cache is intentionally rendered before SQLite finishes opening
   * and importing the legacy cache.  A destructive action can therefore race
   * the first canonical read (or the short invalidation window after a local
   * mutation).  Never fall back to deleting only the compatibility JSON in
   * that window: a later canonical projection would resurrect the meeting.
   * Wait for/repair canonical ownership instead, then let the caller mutate
   * the same source of truth used by the rest of the device-primary flow.
   */
  const ensureCanonicalProjectionReady = useCallback(async (
    operationGeneration: number,
  ): Promise<MeetingReadProjection> => {
    if (
      !isScopeKey(scope)
      || activeScopeRef.current !== scope
      || generationRef.current !== operationGeneration
    ) throw new Error('会议数据作用域已变化，请重试。');
    const flags = getFeatureFlags();
    if (!flags.localMeetingDbCanonicalReadV1) {
      throw new Error('会议数据暂时无法使用，请稍后重试。');
    }

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
            scope: scope === 'guest' ? 'guest' : 'account',
            status: 'recovered',
            mirror_status: owned.mirrorStatus,
            canonical_revision: owned.canonicalRevision,
          });
          return owned.projection;
        }

        // A fresh guest install can still be in the legacy-shadow phase.  Do
        // the same import the startup path performs, using the latest in-memory
        // roots and content, then promote ownership atomically.  This keeps a
        // delete pressed during cold start safe and idempotent.
        if (scope === 'guest') {
          const [pendingAudioUploads, pendingSummaryTasks] = await Promise.all([
            listPendingMeetingAudioUploads(scope),
            listPendingMeetingSummaryTasks(scope),
          ]);
          await runLegacyMeetingShadowImport({
            scopeKey: scope,
            meetings: meetingsRef.current,
            transcripts: transcriptCacheRef.current,
            summaries: summaryCacheRef.current,
            pendingAudioUploads,
            pendingSummaryTasks,
          });
          const state = await sqliteMeetingNoteRepository.getScopeWriteState(scope);
          if (state.writeOwner !== 'canonical') {
            canonicalStoreMutationDepthRef.current += 1;
            try {
              await sqliteMeetingNoteRepository.transaction(transaction => (
                transaction.advanceCanonicalWrite(scope, Date.now())
              ));
            } finally {
              canonicalStoreMutationDepthRef.current = Math.max(
                0,
                canonicalStoreMutationDepthRef.current - 1,
              );
            }
          }
          const recovered = await loadCanonicalOwnedScope(true);
          if (recovered) {
            if (!adoptCanonicalOwnedProjection(recovered, operationGeneration)) {
              throw new Error('会议数据作用域已变化，请重试。');
            }
            diagnosticAudit('meeting_db_operation_projection_wait', {
              operation: 'mutation',
              scope: 'guest',
              status: 'repaired',
              mirror_status: recovered.mirrorStatus,
              canonical_revision: recovered.canonicalRevision,
            });
            return recovered.projection;
          }
        }
      } catch (error) {
        lastError = error;
        diagnosticWarn('[meeting-db] canonical projection not ready for mutation', error);
      }
    }

    diagnosticAudit('meeting_db_operation_projection_wait', {
      operation: 'mutation',
      scope: scope === 'guest' ? 'guest' : 'account',
      status: 'failed',
      error_code: lastError instanceof Error ? lastError.name : 'ProjectionUnavailable',
    });
    throw new Error('会议数据正在准备，请稍后重试。');
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, scope]);

  const reorderMeetings = useCallback((orderedLegacyIds: readonly string[]): Promise<void> => (
    enqueueGuestMutation(async () => {
      const operationGeneration = generationRef.current;
      if (!isScopeKey(scope) || activeScopeRef.current !== scope) {
        throw new Error('当前账号无法保存会议顺序，请稍后重试。');
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
        const owned = await loadCanonicalOwnedScope(true);
        if (!owned) throw new Error('会议顺序的本机数据状态异常，请刷新后重试。');
        const projectedLegacyIds = owned.projection.meetings.map(meeting => meeting.id);
        if (
          projectedLegacyIds.length !== normalizedLegacyIds.length
          || projectedLegacyIds.some((id, index) => id !== normalizedLegacyIds[index])
        ) {
          throw new Error('会议顺序保存后不完整，请刷新后重试。');
        }
        if (!adoptCanonicalOwnedProjection(owned, operationGeneration)) {
          throw new Error('会议账号已切换，请返回原账号后重试。');
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
      scope !== 'guest'
      || generationRef.current !== operationGeneration
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
        supersededRemoteMeetingId: options.supersededRemoteMeetingId ?? null,
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
          remoteId: null,
          title: created.aggregate.note.title,
          date: `${shellRecordedAt.getFullYear()}年${shellRecordedAt.getMonth() + 1}月${shellRecordedAt.getDate()}日`,
          time: `${String(shellRecordedAt.getHours()).padStart(2, '0')}:${String(shellRecordedAt.getMinutes()).padStart(2, '0')}`,
          duration: '—',
          tags: [statusTag('preparing'), { label: '本机', color: C.teal }],
          participants: [...created.aggregate.note.participants],
          hasTranscript: false,
          hasSummary: false,
          status: 'processing',
          statusSyncPending: false,
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
          mirrorStatus: 'unchanged',
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
    preserveForRestore: boolean,
  ): Promise<void> => {
    if (
      scope !== 'guest'
      || generationRef.current !== operationGeneration
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
        const owned = await loadCanonicalOwnedScope(true);
        if (!owned || owned.mirrorStatus !== 'clean') {
          throw new Error('guest meeting compatibility mirror was not rebuilt');
        }
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
      const result = await mirrorLegacySummaryContent(scope, current, summary, {
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
      if (scope !== 'guest') requestMeetingActionSync(scope);
      return {
        projection: result.replaceLegacyProjection ? 'updated' : 'preserved',
        mirrorStatus: result.status,
        localVersionId: result.localVersionId ?? null,
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
        supersededRemoteMeetingId: options.supersededRemoteMeetingId ?? null,
        initialStageStatuses: options.initialProcessingStatuses,
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

  const ensureMeetingRemoteIdentity = useCallback((legacyMeetingId: string): Promise<Meeting> => (
    enqueueGuestMutation(async () => {
      const operationGeneration = generationRef.current;
      if (
        scope === 'guest'
        || !isScopeKey(scope)
        || !accessToken
        || activeScopeRef.current !== scope
      ) throw new Error('登录会话已失效，请重新登录。');
      const projection = canonicalReadProjectionRef.current;
      const canonicalMeetingId = projection?.canonicalIdByLegacyId[legacyMeetingId]?.trim();
      let projected = projection?.meetings.find(meeting => meeting.id === legacyMeetingId);
      if (!canonicalMeetingId || !projected) {
        throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
      }
      if (projected.remoteId?.trim()) return projected;

      const isCurrent = () => (
        generationRef.current === operationGeneration
        && activeScopeRef.current === scope
      );
      const drain = async () => {
        const controller = new AbortController();
        await drainMeetingRootSync({
          scopeKey: scope,
          accessToken,
          signal: controller.signal,
          isCurrent,
        });
      };
      const reloadProjection = async (): Promise<Meeting> => {
        canonicalStoreMutationDepthRef.current += 1;
        try {
          const owned = await loadCanonicalOwnedScope();
          if (!owned || !adoptCanonicalOwnedProjection(owned, operationGeneration)) {
            throw new Error('会议账号作用域已变化，请重试。');
          }
          const refreshed = owned.projection.meetings.find(meeting => (
            owned.projection.canonicalIdByLegacyId[meeting.id] === canonicalMeetingId
          ));
          if (!refreshed) throw new Error('会议同步后的本机数据不完整，请刷新后重试。');
          return refreshed;
        } finally {
          canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
        }
      };

      // Upgrade legacy calendar roots that either omitted their occurrence or
      // were already blocked by a deleted remote root. The repair keeps the
      // same local meeting and replaces only its rejected outbox operation.
      await sqliteMeetingNoteRepository.repairLegacyCalendarMeetingRootCreate(
        canonicalMeetingId,
        scope,
        Date.now(),
      );
      await drain();
      projected = await reloadProjection();
      if (projected.remoteId?.trim()) return projected;

      // A background drain may have claimed the legacy row just before the
      // first repair attempt. Once that claim settles, repair and drain once
      // more so the user's retry succeeds without creating another meeting.
      const repairedAfterDrain = await sqliteMeetingNoteRepository
        .repairLegacyCalendarMeetingRootCreate(canonicalMeetingId, scope, Date.now());
      if (repairedAfterDrain) {
        await drain();
        projected = await reloadProjection();
        if (projected.remoteId?.trim()) return projected;
      }
      requestMeetingRootSync(scope);
      throw new Error('会议正在同步，请稍后重试。');
    })
  ), [accessToken, adoptCanonicalOwnedProjection, enqueueGuestMutation, loadCanonicalOwnedScope, scope]);

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
    const deletionAccessToken = accessToken;
    if (options.recoverable) {
      if (!deletionAccessToken || !isMeetingEligibleForRecycleBin(target)) {
        throw new Error('此会议当前不能移到回收站');
      }
      const currentRetentionDays = await requireFreshMeetingRecycleCapability(deletionAccessToken);
      if (currentRetentionDays !== options.expectedRetentionDays) {
        throw new Error('回收站保留期限已更新，请重试');
      }
    }
    const canonicalMeetingId = canonicalReadProjectionRef.current
      ?.canonicalIdByLegacyId[legacyMeetingId]
      ?.trim();
    if (!canonicalMeetingId) throw new Error('会议数据尚未完成本机升级，请刷新后重试。');
    canonicalStoreMutationDepthRef.current += 1;
    try {
      if (options.recoverable) {
        let canonicalTarget = await sqliteMeetingNoteRepository.get(canonicalMeetingId, scope);
        if (!canonicalTarget) {
          throw new Error('会议本机数据尚未同步完成，请刷新后重试。');
        }
        const meetingRemoteId = canonicalTarget.note.remoteId?.trim() ?? '';
        if (!meetingRemoteId) {
          throw new Error('会议云端标识尚未同步完成，请刷新后重试。');
        }
        if (canonicalTarget.note.remoteRevision === null) {
          const controller = new AbortController();
          let refreshOutcome: 'refreshed' | 'stale';
          try {
            const refreshed = await refreshMeetingRootIdentityV2({
              scopeKey: scope,
              accessToken: deletionAccessToken!,
              meetingRemoteId,
              signal: controller.signal,
              isCurrent: () => (
                generationRef.current === operationGeneration
                && activeScopeRef.current === scope
              ),
            });
            refreshOutcome = refreshed.outcome;
          } catch (error) {
            diagnosticWarn('[meeting-delete] root identity refresh failed', error);
            if (error instanceof HttpResponseError && error.status === 404) {
              throw new Error('此会议的云端记录暂不可用，无法移到回收站。');
            }
            throw new Error(readableErrorMessage(
              error,
              '会议云端状态同步失败，请检查网络后重试。',
            ));
          }
          if (refreshOutcome !== 'refreshed') {
            throw new Error('会议账号作用域已变化，请重试。');
          }
          canonicalTarget = await sqliteMeetingNoteRepository.get(canonicalMeetingId, scope);
        }
        if (
          !canonicalTarget?.note.remoteId
          || canonicalTarget.note.remoteRevision === null
        ) throw new Error('会议云端状态同步未完成，请稍后重试。');
      }
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
      ...(!options.recoverable ? [deleteMeetingAttachmentFiles(legacyMeetingId)] : []),
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
    if (scope === 'guest') {
      if (expectedRetentionDays !== 30 || activeScopeRef.current !== scope) {
        throw new Error('回收站保留期限已更新，请重试');
      }
      canonicalStoreMutationDepthRef.current += 1;
      try {
        const result = await restoreCanonicalMeetingNote.execute({
          meetingId: canonicalMeetingId,
          scopeKey: 'guest',
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
      return;
    }
    if (
      !isScopeKey(scope)
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

  const permanentlyDeleteDeletedMeeting = useCallback(async (
    canonicalMeetingId: string,
    expectedRetentionDays: number,
  ): Promise<void> => enqueueGuestMutation(async () => {
    const operationGeneration = generationRef.current;
    const normalizedCanonicalId = canonicalMeetingId.trim();
    if (
      scope !== 'guest'
      || !normalizedCanonicalId
      || expectedRetentionDays !== 30
      || activeScopeRef.current !== scope
      || !getFeatureFlags().localMeetingDbCanonicalWriteV1
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
        || aggregate.note.syncState !== 'deleted'
        || aggregate.note.deletedAtMs === null
        || aggregate.note.deletedFromLifecycle === null
        || aggregate.note.remoteId !== null
        || aggregate.note.remoteRevision !== null
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
      const owned = await loadCanonicalOwnedScope(true);
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
      let projection = result.projection;
      if (canonicalWritesEnabledForScope(flags, scope)) {
        const writeState = await sqliteMeetingNoteRepository.getScopeWriteState(scope);
        if (writeState.writeOwner !== 'canonical') {
          canonicalStoreMutationDepthRef.current += 1;
          try {
            await sqliteMeetingNoteRepository.transaction(transaction => (
              transaction.advanceCanonicalWrite(scope, Date.now())
            ));
            const owned = await loadCanonicalOwnedScope(true);
            if (!owned) throw new Error('meeting canonical cutover ownership was not persisted');
            projection = owned.projection;
            diagnosticAudit('meeting_db_write_cutover', {
              status: 'active',
              scope: scope === 'guest' ? 'guest' : 'account',
              canonical_revision: owned.canonicalRevision,
              mirror_status: owned.mirrorStatus,
            });
          } finally {
            canonicalStoreMutationDepthRef.current = Math.max(
              0,
              canonicalStoreMutationDepthRef.current - 1,
            );
          }
        }
      }
      if (
        generationRef.current !== operationGeneration
        || activeScopeRef.current !== scope
        || canonicalReadRequestRef.current !== readRequest
      ) return 'legacy';
      canonicalReadProjectionRef.current = projection;
      setMeetings(projection.meetings);
      return 'sqlite';
    }
    canonicalReadProjectionRef.current = null;
    setMeetings(result.projection.meetings);
    return 'legacy';
  }, [loadCanonicalOwnedScope, scope]);

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

  const refreshMeetingsFromCloud = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent === true;
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

    if (!silent) setLoading(true);
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
      if (!silent) setError(err instanceof Error ? err.message : '会议服务暂时不可用');
      else diagnosticWarn('[meeting-cloud-refresh] automatic refresh failed', err);
    } finally {
      if (!silent && generationRef.current === requestGeneration && activeScopeRef.current === scope) {
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
    const uploadedRecordingAvailable = [...evidenceById.values()]
      .some(entry => entry.evidence.status === 'uploaded');

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
        for (const { pending, evidence } of evidenceById.values()) {
          if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
          const canonicalMeetingId = pending.canonicalMeetingId?.trim()
            || projection.canonicalIdByLegacyId[pending.meetingId]?.trim();
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
        if (uploadedRecordingAvailable) {
          requestMeetingTranscriptCompletion(scope, { discoverRecordingAssets: true });
        }
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
      return;
    }

    const pendingById = new Map<string, readonly PendingMeetingAudioUploadInspection[]>();
    inspections.filter(item => item.phase !== 'uploaded').forEach(item => {
      pendingById.set(item.pending.meetingId, [
        ...(pendingById.get(item.pending.meetingId) ?? []),
        item,
      ]);
    });
    let changed = false;
    const next = meetingsRef.current.map(meeting => {
      const meetingInspections = pendingById.get(meeting.id) ?? [];
      const audioSyncPending = meetingInspections.length > 0;
      const audioSyncBlocked = meetingInspections.some(item => item.phase === 'blocked');
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
      for (const { pending, evidence } of evidenceById.values()) {
        const aggregate = pending.canonicalMeetingId
          ? await sqliteMeetingNoteRepository.get(pending.canonicalMeetingId, scope)
          : await sqliteMeetingNoteRepository.findByNativeSessionId(pending.meetingId, scope);
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
    if (uploadedRecordingAvailable && isScopeKey(scope) && scope !== 'guest') {
      requestMeetingTranscriptCompletion(scope, { discoverRecordingAssets: true });
    }
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
    if ((mode !== 'authenticated' && mode !== 'guest') || (mode === 'authenticated' && !accessToken)
      || activeScopeRef.current !== scope) {
      diagnosticAudit('meeting_audio_upload_resume_skipped', {
        mode,
        scope,
        active_scope: activeScopeRef.current,
        has_access_token: Boolean(accessToken),
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
      const flags = getFeatureFlags();
      if (mode === 'authenticated' && flags.localMeetingDbAccountUploadWriteV1 && isScopeKey(scope)) {
        const projection = canonicalReadProjectionRef.current;
        if (!projection) return;
        for (const meeting of projection.meetings) {
          const canonicalMeetingId = projection.canonicalIdByLegacyId[meeting.id]?.trim();
          if (!canonicalMeetingId) continue;
          const aggregate = await sqliteMeetingNoteRepository.get(canonicalMeetingId, scope);
          if (!aggregate || aggregate.note.lifecycle === 'deleted') continue;
          for (const asset of aggregate.recordingAssets) {
            if (
              asset.localState !== 'local_ready'
              || !asset.localUri
              || asset.remoteAssetId
            ) continue;
            await upsertPendingMeetingAudioUpload(scope, {
              meetingId: meeting.id,
              canonicalMeetingId,
              remoteMeetingId: aggregate.note.remoteId?.trim() || undefined,
              recordingAssetId: asset.id,
              role: asset.role,
              origin: asset.origin,
              nativeSessionId: asset.nativeSessionId ?? undefined,
              audioUri: asset.localUri,
              fileName: asset.fileName
                ?? recordingUploadFileName(asset.id, asset.localUri, asset.mimeType),
              mimeType: asset.mimeType?.trim() || 'audio/wav',
              byteSize: asset.byteSize ?? undefined,
              durationMs: asset.durationMs ?? undefined,
              checksumSha256: asset.checksumSha256 ?? undefined,
              createdAt: new Date(asset.createdAtMs).toISOString(),
              lastAttemptAt: new Date(0).toISOString(),
              attemptCount: 0,
              uploadState: 'pending',
            });
          }
        }
      }

      let before = await listPendingMeetingAudioUploads(scope);
      diagnosticAudit('meeting_audio_upload_queue_inspected', {
        ...scopeTelemetry(scope as ScopeKey, mode === 'guest' ? 'device-v1' : 'account-api'),
        queue_kind: 'local-pending-registry',
        mode,
        pending: before.length,
        force,
      });
      let remoteIdentityChanged = false;
      if (mode === 'authenticated' && getFeatureFlags().localMeetingDbV1 && isScopeKey(scope)) {
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

      let deviceV2IngressReady = false;
      if (mode === 'guest') {
        const remoteCapability = await loadDeviceV2Capabilities().catch(() => null);
        deviceV2IngressReady = await selectClosedVNextCapability(
          'media.upload',
          Boolean(remoteCapability?.uploadSessionsV2 && remoteCapability.importTranscriptEventsV2),
        );
        if (deviceV2IngressReady) {
          // A capability choice covers the whole request. Remove obsolete
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
                  fileName: prepared.fileName,
                  recordingAssetId: prepared.recordingAssetId,
                  assetGeneration: prepared.assetGeneration,
                  expectedBytes: prepared.byteSize,
                  checksumSha256: prepared.sourceSha256,
                  recordingRole: prepared.role,
                  recordingOrigin: prepared.origin,
                  durationMs: prepared.durationMs ?? null,
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
      }

      if (mode === 'authenticated' && flags.localMeetingDbAccountUploadWriteV1) {
        let recordingAssetsV2Ready = recordingAssetCapabilityScopesRef.current.has(scope);
        if (!recordingAssetsV2Ready) {
          const capability = await loadMeetingCapabilities({
            accessToken,
            forceRefresh: true,
            allowStaleOnError: false,
          }).catch(() => null);
          recordingAssetsV2Ready = capability?.source === 'remote'
            && capability.capabilities.recordingAssetsV2;
          if (recordingAssetsV2Ready) recordingAssetCapabilityScopesRef.current.add(scope);
        }
        if (!recordingAssetsV2Ready) {
          const unavailableInspections = await inspectPendingMeetingAudioUploads(before);
          if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
          await reconcilePendingAudioUploads(unavailableInspections, operationGeneration);
          return;
        }

        for (const pending of before) {
          if (pending.nativeWorkId || !pending.remoteMeetingId) continue;
          try {
            const registration = await enqueueNativeMeetingUpload({
              scope,
              accessToken: accessToken!,
              meetingId: pending.meetingId,
              remoteMeetingId: pending.remoteMeetingId,
              operationId: `recording-asset:${pending.recordingAssetId}:${pending.createdAt}`,
              fileUri: pending.audioUri,
              mimeType: pending.mimeType,
              fileName: pending.fileName,
              protocol: 'recording-assets-v2',
              recordingAssetId: pending.recordingAssetId,
              recordingRole: pending.role,
              recordingOrigin: pending.origin,
              expectedBytes: pending.byteSize ?? null,
              durationMs: pending.durationMs ?? null,
              checksumSha256: pending.checksumSha256 ?? null,
            });
            if (registration) {
              const attached = await attachNativeUploadRegistration(
                scope,
                pending.recordingAssetId,
                registration,
              );
              if (!attached) await cancelNativeMeetingUpload(registration.workId).catch(() => {});
            }
          } catch (reason) {
            diagnosticWarn('[recording-assets-v2] native upload enqueue failed', reason);
          }
        }
        before = await listPendingMeetingAudioUploads(scope);
      }

      const beforeInspections = mode === 'guest' && !deviceV2IngressReady
        ? before.map(item => derivePendingMeetingAudioUploadInspection(item, null))
        : await inspectPendingMeetingAudioUploads(before);
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      if (mode !== 'guest') {
        await reconcilePendingAudioUploads(beforeInspections, operationGeneration);
      }
      if (before.length === 0) {
        audioResumePollCountsRef.current.delete(operationKey);
        return;
      }

      const result = await retryPendingMeetingAudioUploads(
        scope,
        accessToken ?? 'device',
        (pending, token) => mode === 'guest'
          ? deviceV2IngressReady
            ? Promise.reject(new Error('v2 原生上传不可回退到旧入口'))
            : recordVNextLegacySubmit('media.upload')
              .then(() => uploadMeetingRecordingToDeviceService(pending))
          : flags.localMeetingDbAccountUploadWriteV1
          ? uploadRecordingAssetV2({
              accessToken: token,
              meetingRemoteId: pending.remoteMeetingId!,
              registerIdempotencyKey: `recording-asset-register:${pending.recordingAssetId}`,
              contentIdempotencyKey: `recording-asset-content:${pending.recordingAssetId}`,
              registration: {
                schema_version: 2,
                client_asset_id: pending.recordingAssetId,
                role: pending.role,
                origin: pending.origin,
                mime_type: pending.mimeType,
                file_name: pending.fileName,
                byte_size: pending.byteSize ?? null,
                duration_ms: pending.durationMs ?? null,
                checksum_sha256: pending.checksumSha256 ?? null,
              },
              audioUri: pending.audioUri,
            })
          : uploadMeetingAudio(
              pending.remoteMeetingId ?? pending.meetingId,
              pending.audioUri,
              token,
              { fileName: pending.fileName, mimeType: pending.mimeType },
            ),
        2,
        deviceV2IngressReady ? { requireNativeTransport: true } : {},
      );
      diagnosticAudit('meeting_audio_upload_queue_processed', {
        scope: scope === 'guest' ? 'guest' : 'account',
        mode,
        found: result.found,
        uploaded: result.uploadedIds.length,
        failed: result.failedIds.length,
        skipped: result.skippedIds.length,
      });
      if (mode === 'guest') {
        await Promise.all(result.uploaded
          .filter(item => Boolean(item.transcriptionTaskId))
          .map(item => rememberDeviceTranscriptTaskBestEffort(item.meetingId, item.transcriptionTaskId!)));
      }
      const after = await listPendingMeetingAudioUploads(scope);
      shouldPollPendingUploads = after.some(item => (
        Boolean(item.nativeWorkId) || !item.remoteMeetingId
      ));
      if (!shouldPollPendingUploads) audioResumePollCountsRef.current.delete(operationKey);
      const afterInspections = mode === 'guest' && !deviceV2IngressReady
        ? after.map(item => derivePendingMeetingAudioUploadInspection(item, null))
        : await inspectPendingMeetingAudioUploads(after);
      let guestCanonicalUploadCommitted = false;
      if (mode === 'guest' && deviceV2IngressReady) {
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
      if (
        mode !== 'guest'
        &&
        (result.uploadedIds.length > 0 || after.length < before.length)
        && !getFeatureFlags().localMeetingDbAccountUploadWriteV1
      ) {
        await refreshMeetingsFromCloud();
      }
      if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
      const uploadedInspections = result.uploaded.map(item => (
        derivePendingMeetingAudioUploadInspection(item, null)
      ));
      if (mode !== 'guest') {
        await reconcilePendingAudioUploads(afterInspections, operationGeneration, uploadedInspections);
      }
    })().finally(() => {
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
  }, [accessToken, adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, mode, reconcilePendingAudioUploads, refreshMeetingsFromCloud, scope]);

  const reconcileAudioUploads = useCallback(async (uploaded?: PendingMeetingAudioUpload) => {
    const operationGeneration = generationRef.current;
    if (uploaded) {
      if (activeScopeRef.current !== scope) return;
      if (scope === 'guest' && uploaded.transcriptionTaskId) {
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
    if (mode === 'authenticated' && isScopeKey(scope)) {
      requestMeetingRootSync(scope);
      requestMeetingActionSync(scope);
    }
    await refreshMeetingsFromCloud();
    void resumePendingAudioUploads(true).catch(() => {});
  }, [mode, refreshMeetingsFromCloud, resumePendingAudioUploads, scope]);

  useEffect(() => {
    if (mode !== 'authenticated' || !accessToken || !isScopeKey(scope)) return undefined;
    let active = true;
    let running = false;
    let requested = false;

    const requestCloudRefresh = () => {
      if (!active) return;
      requested = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            await refreshMeetingsFromCloud({ silent: true });
          }
        } finally {
          running = false;
          if (active && requested) requestCloudRefresh();
        }
      })();
    };

    const interval = setInterval(requestCloudRefresh, AUTOMATIC_MEETING_REFRESH_INTERVAL_MS);
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestCloudRefresh();
    });
    return () => {
      active = false;
      requested = false;
      clearInterval(interval);
      appStateSubscription.remove();
    };
  }, [accessToken, mode, refreshMeetingsFromCloud, scope]);

  useEffect(() => {
    if (mode !== 'authenticated' && mode !== 'guest') return undefined;
    if (!loading) void resumePendingAudioUploads(true).catch(() => {});
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void resumePendingAudioUploads().catch(() => {});
    });
    return () => subscription.remove();
  }, [accessToken, loading, mode, resumePendingAudioUploads]);

  useEffect(() => {
    if (mode !== 'guest' || loading) return undefined;
    void drainDeviceMeetingDeletionOutbox(true);
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') void drainDeviceMeetingDeletionOutbox();
    });
    return () => subscription.remove();
  }, [loading, mode]);

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
        // The meeting roots are tiny compared with transcript and summary
        // caches. Render them first so a cold start never waits for full-text
        // JSON parsing, pending-task inspection, or the cloud refresh before
        // showing the user's existing list.
        const rootsStartedAtMs = Date.now();
        const [cachedMeetings, cachedRootMeetings] = await Promise.all([
          loadJson<Meeting[]>(meetingsKey, []),
          loadJson<Meeting[]>(meetingRootsKey, []),
        ]);
        if (!isCurrent()) return;
        const cachedRootSource = cachedMeetings.length > 0 ? 'legacy' : cachedRootMeetings.length > 0 ? 'roots' : 'none';
        const initialRoots = cachedMeetings.length > 0 ? cachedMeetings : cachedRootMeetings;
        meetingsRef.current = initialRoots;
        setMeetings(initialRoots);
        if (initialRoots.length > 0) setLoading(false);
        diagnosticAudit('meeting_start_roots_cache', {
          elapsed_ms: Math.max(0, Date.now() - rootsStartedAtMs),
          legacy_meetings: cachedMeetings.length,
          cached_roots: cachedRootMeetings.length,
          source: cachedRootSource,
        });

        const flags = getFeatureFlags();
        if (
          initialRoots.length === 0
          && flags.localMeetingDbV1
          && isScopeKey(scope)
        ) {
          // Canonical installs may intentionally leave the old JSON root cache
          // empty. Read only meeting roots/stages for the first frame; the
          // transcript and summary bodies are filled by the normal projection
          // pass below.
          const fastProjectionPromise = buildCanonicalMeetingListProjection(
            sqliteMeetingNoteRepository,
            scope,
          ).catch(() => null);
          // Do not make the first render wait for SQLite open/migrations. The
          // canonical list is adopted as soon as it is ready, while the rest
          // of the scope continues through the normal hydration path.
          void fastProjectionPromise.then(fastProjection => {
            if (!isCurrent() || canonicalReadProjectionRef.current) return;
            if (fastProjection && fastProjection.meetings.length > 0) {
              meetingsRef.current = fastProjection.meetings;
              setMeetings(fastProjection.meetings);
              setLoading(false);
              void persistMeetingRoots(fastProjection.meetings);
              diagnosticAudit('meeting_start_fast_projection', {
                elapsed_ms: Math.max(0, Date.now() - rootsStartedAtMs),
                meetings: fastProjection.meetings.length,
              });
            }
          });
        }

        const [
          cachedTranscripts,
          cachedSummaries,
          pendingAudioUploads,
          pendingSummaryTasks,
        ] = await Promise.all([
          loadJson<Record<string, TranscriptLine[]>>(transcriptKey, {}),
          loadJson<Record<string, MeetingSummary | null>>(summaryKey, {}),
          mode === 'authenticated'
            ? listPendingMeetingAudioUploads(scope).catch(() => [])
            : Promise.resolve([]),
          listPendingMeetingSummaryTasks(scope).catch(() => []),
        ]);
        if (!isCurrent()) return;
        const normalizedTranscriptCache = simplifyTranscriptCache(cachedTranscripts);
        transcriptCacheRef.current = normalizedTranscriptCache.cache;
        if (normalizedTranscriptCache.changed) {
          void writeAppStorageJson(transcriptKey, normalizedTranscriptCache.cache, { removeIfEmpty: true }).catch(() => {});
        }
        summaryCacheRef.current = cachedSummaries;
        const pendingAudioById = new Map(pendingAudioUploads.map(item => [item.meetingId, item]));
        const rootMeetings = initialRoots.length > 0 ? initialRoots : meetingsRef.current;
        const hydratedMeetings = rootMeetings.map(meeting => {
          const pendingAudio = pendingAudioById.get(meeting.id);
          const audioSyncPending = Boolean(pendingAudio);
          const audioSyncBlocked = pendingAudio?.uploadState === 'blocked';
          return {
            ...meeting,
            hasTranscript: meeting.hasTranscript || (normalizedTranscriptCache.cache[meeting.id]?.length ?? 0) > 0,
            hasSummary: meeting.hasSummary || Boolean(cachedSummaries[meeting.id]),
            audioSyncPending,
            audioSyncBlocked,
            tags: tagsForAudioSync(meeting.tags, audioSyncPending, audioSyncBlocked),
          };
        });
        meetingsRef.current = hydratedMeetings;
        setMeetings(hydratedMeetings);
        void persistMeetingRoots(hydratedMeetings);
        if (canonicalWritesEnabledForScope(flags, scope) && isScopeKey(scope)) {
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
            // Canonical ownership only changes the local source of truth. An
            // authenticated cold start must still pull newer account roots;
            // otherwise a second device remains frozen at its last local
            // projection and downstream content (including markers) has no
            // meeting identity to attach to.
            if (mode === 'authenticated' && isCurrent()) await refreshMeetings();
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
        if (isCurrent()) {
          setLoading(false);
          // The initial roots cache can make loading transition from true to
          // false in one React commit. In that case the separate loading
          // effect is not guaranteed to observe a change, so explicitly drain
          // the durable device upload queue after the scope is hydrated.
          if (mode === 'guest' || (mode === 'authenticated' && accessToken)) {
            void resumePendingAudioUploads(true).catch(error => {
              diagnosticWarn('[device-recording] startup upload drain failed', error);
            });
          }
        }
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
    meetingRootsKey,
    mode,
    persistMeetingRoots,
    refreshMeetings,
    resumePendingAudioUploads,
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
    const canonicalImportWrite = canonicalWritesEnabledForScope(flags, scope);
    const targetLegacyMeetingId = options.targetMeetingId?.trim() || null;
    if (targetLegacyMeetingId) {
      if (!flags.meetingMediaImportExistingV1 || !canonicalImportWrite) {
        throw new AttachImportedMeetingMediaError(
          'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE',
          'existing meeting import is unavailable',
        );
      }
      const projection = canonicalReadProjectionRef.current;
      const canonicalTargetMeetingId = projection
        ?.canonicalIdByLegacyId[targetLegacyMeetingId]
        ?.trim();
      const target = projection?.meetings.find(item => item.id === targetLegacyMeetingId) ?? null;
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
        if (scope === 'guest') {
          const attachedAsset = result.aggregate.recordingAssets.find(asset => asset.id === media.assetId);
          if (!attachedAsset?.localUri || attachedAsset.localState !== 'local_ready') {
            throw new Error('会议录音已加入，但本机文件状态不完整。');
          }
          // Import shells reach this existing-meeting branch after the media
          // copy/extraction finishes. Guest uploads have no account queue
          // hydrator, so register the attached asset explicitly just as the
          // direct-create path does; otherwise the fast navigation would leave
          // a playable local file that never reaches transcription.
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
        } else {
          requestImportedMeetingTranscriptDiscovery(scope);
          void resumePendingAudioUploads(true).catch(error => {
            diagnosticWarn('[meeting-import] upload resume failed', error);
          });
        }
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
      canonicalWrite: canonicalImportWrite,
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
    if (scope === 'guest') {
      // Canonical guest imports do not pass through the account-only queue
      // hydrator. Register the local asset explicitly so the device service
      // receives the same bounded input as a live recording.
      await upsertPendingMeetingAudioUpload(scope, {
        meetingId: media.meetingId,
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
    }
    if (canonicalImportWrite) {
      const owned = await loadCanonicalOwnedScope();
      if (!owned) throw new Error('meeting canonical ownership was not established');
      const projected = owned.projection.meetings.find(meeting => meeting.id === media.meetingId);
      if (!projected) throw new Error('meeting canonical projection lost imported media');
      adoptCanonicalOwnedProjection(owned, operationGeneration);
      if (scope !== 'guest') {
        requestImportedMeetingTranscriptDiscovery(scope);
        if (flags.localMeetingDbAccountRootWriteV1) {
          requestMeetingRootSync(scope);
          void resumePendingAudioUploads(true).catch(error => {
            diagnosticWarn('[meeting-import] upload resume failed', error);
          });
        }
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
    // Signal after the legacy write is committed, before optional read-cutover
    // work can fail or become stale. The coordinator still waits for a remote
    // identity before creating an account transcription task.
    if (scope !== 'guest') {
      requestImportedMeetingTranscriptDiscovery(scope);
    }
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
    resumePendingAudioUploads,
    scope,
  ]);

  const deleteMeeting = useCallback(async (id: string, options: DeleteMeetingOptions = {}) => {
    const operationGeneration = generationRef.current;
    if (activeScopeRef.current !== scope) return;
    if (mode !== 'guest' && !accessToken) throw new Error('not authenticated');

    if (mode === 'guest') {
      return enqueueGuestMutation(async () => {
        if (generationRef.current !== operationGeneration || activeScopeRef.current !== scope) return;
        const target = meetingsRef.current.find(meeting => meeting.id === id) ?? null;
        if (!target) return;
        assertMeetingDeletionAllowed(target);
        if (getFeatureFlags().localMeetingDbCanonicalWriteV1) {
          return deleteCanonicalGuestMeeting(id, target, operationGeneration, options.recoverable === true);
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
        void enqueueDeviceMeetingDeletion(id).catch(error => {
          diagnosticWarn('[device-delete] could not persist cleanup hint', error);
        });
        const cleanupResults = await Promise.allSettled([
          persistTranscripts(),
          persistSummaries(),
          deletePendingMeetingAudioUpload(scope, id),
          deleteNativeMeetingArtifacts(scope, id),
          deleteMeetingPlaybackCache(id),
          deleteMeetingAttachmentFiles(id),
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
      deleteMeetingAttachmentFiles(id),
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
        simplifiedTranscript,
        options,
        operationGeneration,
      ));
    }
    deactivateCanonicalRead();
    const previous = transcriptCacheRef.current;
    const baseline = simplifyTranscriptLines(previous[id] ?? []);
    const derivedKind: TranscriptCandidateKind = contentMeeting?.status === 'recording'
      || contentMeeting?.status === 'paused'
      ? 'realtime_draft'
      : 'final';
    const requestedKind = options.candidateKind ?? derivedKind;
    const candidateKind: TranscriptCandidateKind = options.serverCompleteness === 'incomplete'
      && requestedKind === 'final'
      ? 'realtime_draft'
      : requestedKind;
    const decision = evaluateTranscriptLineCandidate(baseline, simplifiedTranscript, {
      candidateKind,
      serverCompleteness: options.serverCompleteness,
    });
    const effectiveTranscript = decision.useCandidate ? transcript : baseline;
    let next = previous;
    if (decision.useCandidate) {
      next = { ...previous, [id]: simplifiedTranscript };
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
      await mirrorLegacyTranscriptContent(scope, latestMeeting, simplifiedTranscript, {
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
        const owned = await loadCanonicalOwnedScope(true);
        if (owned) adoptCanonicalOwnedProjection(owned, operationGeneration);
        return true;
      } finally {
        canonicalStoreMutationDepthRef.current = Math.max(0, canonicalStoreMutationDepthRef.current - 1);
      }
    }

    // Some pre-accountless records can remain readable only through the old
    // compatibility cache. Repair that projection only after the caller has
    // verified a completed trace for the exact current input; do not invent a
    // canonical identity or revive a deleted aggregate here.
    const cached = summaryCacheRef.current[id];
    const document = cached?.structured_document;
    if (
      !cached
      || !document
      || document.status !== 'stale'
      || document.templateId !== expected.templateId
      || document.templateRevision !== expected.templateRevision
      || document.manualNoteRevision !== expected.manualNoteRevision
      || document.completedAtMs !== expected.completedAtMs
    ) return false;
    const nextSummary: MeetingSummary = {
      ...cached,
      structured_document: { ...document, status: 'ready' },
    };
    const previousSummaries = summaryCacheRef.current;
    const nextSummaries = { ...previousSummaries, [id]: nextSummary };
    const previousMeetings = meetingsRef.current;
    const nextMeetings = previousMeetings.map(meeting => {
      if (meeting.id !== id) return meeting;
      const terminal = meeting.hasTranscript
        && meeting.hasSummary
        && !meeting.audioSyncPending
        && !meeting.audioSyncBlocked;
      const status = terminal && meeting.status === 'processing'
        ? 'completed'
        : meeting.status ?? 'created';
      return { ...meeting, status, tags: tagsForStatus(meeting, status) };
    });
    try {
      await Promise.all([
        writeAppStorageJson(summaryKey, nextSummaries, { removeIfEmpty: true }),
        persistMeetingsStrict(nextMeetings),
      ]);
    } catch (error) {
      summaryCacheRef.current = previousSummaries;
      meetingsRef.current = previousMeetings;
      throw error;
    }
    if (
      generationRef.current !== operationGeneration
      || activeScopeRef.current !== scope
    ) return false;
    summaryCacheRef.current = nextSummaries;
    meetingsRef.current = nextMeetings;
    setMeetings(nextMeetings);
    void persistMeetingRoots(nextMeetings);
    return true;
  }, [adoptCanonicalOwnedProjection, loadCanonicalOwnedScope, persistMeetingRoots, persistMeetingsStrict, scope, summaryKey]);

  return (
    <MeetingsContext.Provider
      value={{
        meetings,
        loading,
        error,
        reorderMeetings,
        createMeeting,
        ensureMeetingRemoteIdentity,
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
