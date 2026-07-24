import { Meeting, TranscriptLine } from '../types';
import { formatDuration } from '../utils/meetingMedia';
import { getAppStorageItem, removeAppStorageItem, setAppStorageItem } from './appStorage';
import {
  classifyMeetingAudioUploadFailure,
  MeetingAudioUploadFailureCode,
} from './meetingAudioUploadFailure';
import {
  cancelNativeMeetingUpload,
  getNativeMeetingUploadState,
  type NativeMeetingUploadRegistration,
} from '../native/nativeTransferCoordinator';
import type { NativeUploadState } from 'laoji-native-platform';

const PENDING_AUDIO_UPLOADS_KEY = '@laoji:pendingMeetingAudioUploads:v2';
const LEGACY_PENDING_AUDIO_UPLOADS_KEY = '@laoji:pendingMeetingAudioUploads:v1';

export function normalizeRecordingUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
}

export interface FinalizeMeetingRecordingInput {
  meetingId: string;
  remoteMeetingId?: string | null;
  storageScope: string;
  transcriptLines: TranscriptLine[];
  isGuest: boolean;
  accessToken?: string | null;
  audioDurationSec?: number;
  audioBars?: number[];
  getAudioDurationSec?: () => number | undefined;
  getAudioBars?: () => number[] | undefined;
  stopAudio: () => Promise<string | undefined>;
  getTranscriptLines?: () => TranscriptLine[];
}

export interface FinalizeMeetingRecordingDependencies {
  saveTranscript: (meetingId: string, lines: TranscriptLine[]) => Promise<void>;
  onTranscriptSaveFailure?: (meetingId: string, reason: unknown) => Promise<void>;
  uploadAudio: (meetingId: string, uri: string, accessToken: string) => Promise<unknown>;
  enqueuePersistentUpload?: (
    pending: PendingMeetingAudioUpload,
    accessToken: string,
  ) => Promise<NativeMeetingUploadRegistration | null>;
  updateStatus: (
    meetingId: string,
    status: string,
    patch: Partial<Meeting>,
    options?: { remoteSync?: 'wait' | 'background' },
  ) => Promise<boolean>;
  refreshMeetings: () => Promise<void>;
  reconcileUploads?: (uploaded?: PendingMeetingAudioUpload) => Promise<void>;
}

export interface FinalizeMeetingRecordingResult {
  audioUri?: string;
  transcriptSaveFailed: boolean;
  transcriptCompletion?: 'ready' | 'pending' | 'failed';
  uploadFailed: boolean;
  retryQueued: boolean;
  uploadInBackground: boolean;
  statusSyncPending: boolean;
  statusSyncInBackground: boolean;
}

export interface PendingMeetingAudioUpload {
  meetingId: string;
  remoteMeetingId?: string;
  audioUri: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
  lastAttemptAt: string;
  attemptCount: number;
  uploadState: 'pending' | 'blocked';
  failureCode?: MeetingAudioUploadFailureCode;
  failureMessage?: string;
  nextAttemptAt?: string;
  nativeWorkId?: string;
  nativeOperationId?: string;
  nativeGeneration?: number;
}

export type PendingMeetingAudioUploadPhase =
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'failed_retryable'
  | 'blocked';

export interface PendingMeetingAudioUploadInspection {
  pending: PendingMeetingAudioUpload;
  phase: PendingMeetingAudioUploadPhase;
  attemptCount: number;
  operationId: string | null;
  credentialGeneration: number | null;
  errorCode: string | null;
  retryable: boolean;
  nextRetryAtMs: number | null;
  nativeState: NativeUploadState | null;
}

type PendingUploadMap = Record<string, PendingMeetingAudioUpload>;
type PendingAudioUploader = (
  pending: PendingMeetingAudioUpload,
  accessToken: string,
) => Promise<unknown>;

export interface PendingMeetingAudioUploadBatchResult {
  found: number;
  uploadedIds: string[];
  failedIds: string[];
  skippedIds: string[];
}

export interface PendingMeetingAudioRetryOptions {
  automatic?: boolean;
}

let pendingStorageMutation: Promise<void> = Promise.resolve();
const pendingAudioUploadsInFlight = new Map<string, Promise<boolean>>();
const deletedMeetingAudio = new Set<string>();

function meetingAudioOperationKey(storageScope: string, meetingId: string): string {
  return `${storageScope}\u001f${meetingId}`;
}

export function createMeetingRecordingFinalizer<
  Result extends FinalizeMeetingRecordingResult = FinalizeMeetingRecordingResult,
>(finalize: () => Promise<Result>): () => Promise<Result> {
  let inFlightOrCompleted: Promise<Result> | null = null;
  return () => {
    if (inFlightOrCompleted) return inFlightOrCompleted;
    const operation = Promise.resolve().then(finalize);
    inFlightOrCompleted = operation;
    void operation.catch(() => {
      if (inFlightOrCompleted === operation) inFlightOrCompleted = null;
    });
    return operation;
  };
}

export async function getPendingMeetingAudioUpload(
  storageScope: string,
  meetingId: string,
): Promise<PendingMeetingAudioUpload | null> {
  await pendingStorageMutation.catch(() => {});
  return (await readPendingUploads(storageScope))[meetingId] ?? null;
}

export async function listPendingMeetingAudioUploads(
  storageScope: string,
): Promise<PendingMeetingAudioUpload[]> {
  await pendingStorageMutation.catch(() => {});
  return Object.values(await readPendingUploads(storageScope)).sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.meetingId.localeCompare(right.meetingId)
  ));
}

function nativeFailureIsBlocked(reason: string | undefined): boolean {
  const normalized = reason?.trim().toLowerCase() ?? '';
  return normalized === 'invalid-input'
    || normalized === 'invalid-endpoint'
    || normalized === 'meeting-deleted'
    || /^http-(?:400|404|409|413|415|422)$/.test(normalized);
}

function uploadAttemptCount(
  pending: PendingMeetingAudioUpload,
  nativeState: NativeUploadState | null,
): number {
  const nativeAttempts = Number.isSafeInteger(nativeState?.runAttemptCount)
    ? Math.max(0, Number(nativeState?.runAttemptCount))
      + (nativeState?.state === 'running'
        || nativeState?.state === 'succeeded'
        || nativeState?.state === 'failed'
        ? 1
        : 0)
    : 0;
  return Math.max(0, pending.attemptCount, nativeAttempts);
}

function parsedRetryAt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

export function derivePendingMeetingAudioUploadInspection(
  pending: PendingMeetingAudioUpload,
  nativeState: NativeUploadState | null,
): PendingMeetingAudioUploadInspection {
  let phase: PendingMeetingAudioUploadPhase;
  let errorCode: string | null = pending.failureCode ?? null;
  if (pending.uploadState === 'blocked') {
    phase = 'blocked';
  } else if (nativeState?.state === 'succeeded' && nativeState.result === 'uploaded') {
    phase = 'uploaded';
    errorCode = null;
  } else if (nativeState?.state === 'running') {
    phase = 'uploading';
    errorCode = null;
  } else if (nativeState?.state === 'enqueued' || nativeState?.state === 'blocked') {
    const retryScheduled = Number.isSafeInteger(nativeState.runAttemptCount)
      && Number(nativeState.runAttemptCount) > 0;
    phase = retryScheduled ? 'failed_retryable' : 'queued';
    errorCode = retryScheduled ? 'native_upload_retry_scheduled' : null;
  } else if (nativeState?.state === 'failed') {
    phase = nativeFailureIsBlocked(nativeState.reason) ? 'blocked' : 'failed_retryable';
    errorCode = nativeState.reason?.trim() || 'native_upload_failed';
  } else if (nativeState?.state === 'cancelled' || nativeState?.state === 'missing') {
    phase = 'failed_retryable';
    errorCode = `native_upload_${nativeState.state}`;
  } else if (pending.failureCode) {
    phase = 'failed_retryable';
  } else {
    phase = 'queued';
  }
  return {
    pending,
    phase,
    attemptCount: uploadAttemptCount(pending, nativeState),
    operationId: pending.nativeOperationId?.trim() || null,
    credentialGeneration: Number.isSafeInteger(pending.nativeGeneration)
      ? Number(pending.nativeGeneration)
      : null,
    errorCode,
    retryable: phase === 'failed_retryable',
    nextRetryAtMs: phase === 'failed_retryable' ? parsedRetryAt(pending.nextAttemptAt) : null,
    nativeState,
  };
}

export async function inspectPendingMeetingAudioUpload(
  pending: PendingMeetingAudioUpload,
): Promise<PendingMeetingAudioUploadInspection> {
  const nativeState = pending.nativeWorkId
    ? await getNativeMeetingUploadState(pending.nativeWorkId).catch(() => null)
    : null;
  return derivePendingMeetingAudioUploadInspection(pending, nativeState);
}

export async function inspectPendingMeetingAudioUploads(
  pending: readonly PendingMeetingAudioUpload[],
  concurrency = 4,
): Promise<PendingMeetingAudioUploadInspection[]> {
  const inspections = new Array<PendingMeetingAudioUploadInspection>(pending.length);
  let cursor = 0;
  const workerCount = Math.min(
    pending.length,
    Math.max(1, Math.min(8, Math.floor(concurrency) || 1)),
  );
  const worker = async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      inspections[index] = await inspectPendingMeetingAudioUpload(pending[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return inspections;
}

export async function retryPendingMeetingAudioUpload(
  storageScope: string,
  meetingId: string,
  accessToken: string,
  uploadAudio: PendingAudioUploader,
  options: PendingMeetingAudioRetryOptions = {},
): Promise<boolean> {
  const operationKey = meetingAudioOperationKey(storageScope, meetingId);
  const existing = pendingAudioUploadsInFlight.get(operationKey);
  if (existing) return existing;

  const operation = (async () => {
    let pending = await getPendingMeetingAudioUpload(storageScope, meetingId);
    if (!pending) return false;
    if (deletedMeetingAudio.has(operationKey)) return false;
    if (options.automatic && !canAutomaticallyRetryPendingMeetingAudioUpload(pending)) return false;
    if (pending.nativeWorkId) {
      const nativeState = await getNativeMeetingUploadState(pending.nativeWorkId).catch(() => null);
      if (nativeState?.state === 'succeeded' && nativeState.result === 'uploaded') {
        await clearPendingMeetingAudioUpload(storageScope, meetingId);
        return true;
      }
      if (
        nativeState === null
        || nativeState.state === 'enqueued'
        || nativeState.state === 'running'
        || nativeState.state === 'blocked'
      ) return false;
      await clearNativeUploadRegistration(storageScope, meetingId);
      pending = { ...pending };
      delete pending.nativeWorkId;
      delete pending.nativeOperationId;
      delete pending.nativeGeneration;
    }
    try {
      if (deletedMeetingAudio.has(operationKey)) return false;
      await uploadAudio(pending, accessToken);
      await clearPendingMeetingAudioUpload(storageScope, meetingId);
      return true;
    } catch (error) {
      await markPendingMeetingAudioUploadFailure(storageScope, pending, error).catch(() => {});
      throw error;
    }
  })();
  pendingAudioUploadsInFlight.set(operationKey, operation);
  void operation.then(
    () => {
      if (pendingAudioUploadsInFlight.get(operationKey) === operation) {
        pendingAudioUploadsInFlight.delete(operationKey);
      }
    },
    () => {
      if (pendingAudioUploadsInFlight.get(operationKey) === operation) {
        pendingAudioUploadsInFlight.delete(operationKey);
      }
    },
  );
  return operation;
}

export async function retryPendingMeetingAudioUploads(
  storageScope: string,
  accessToken: string,
  uploadAudio: PendingAudioUploader,
  concurrency = 2,
): Promise<PendingMeetingAudioUploadBatchResult> {
  const pending = await listPendingMeetingAudioUploads(storageScope);
  const outcomes: Array<'uploaded' | 'failed' | 'skipped'> = new Array(pending.length);
  let cursor = 0;
  const workerCount = Math.min(pending.length, Math.max(1, Math.min(3, Math.floor(concurrency) || 1)));

  const worker = async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      try {
        const uploaded = await retryPendingMeetingAudioUpload(
          storageScope,
          pending[index].meetingId,
          accessToken,
          uploadAudio,
          { automatic: true },
        );
        outcomes[index] = uploaded ? 'uploaded' : 'skipped';
      } catch {
        outcomes[index] = 'failed';
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    found: pending.length,
    uploadedIds: pending.filter((_, index) => outcomes[index] === 'uploaded').map(item => item.meetingId),
    failedIds: pending.filter((_, index) => outcomes[index] === 'failed').map(item => item.meetingId),
    skippedIds: pending.filter((_, index) => outcomes[index] === 'skipped').map(item => item.meetingId),
  };
}

export async function finalizeMeetingRecording(
  input: FinalizeMeetingRecordingInput,
  dependencies: FinalizeMeetingRecordingDependencies,
): Promise<FinalizeMeetingRecordingResult> {
  const audioResult = await Promise.resolve()
    .then(input.stopAudio)
    .then(value => ({ status: 'fulfilled' as const, value }))
    .catch(reason => ({ status: 'rejected' as const, reason }));
  const transcriptLines = input.getTranscriptLines?.() ?? input.transcriptLines;
  const transcriptResult = await Promise.resolve()
    .then(() => dependencies.saveTranscript(input.meetingId, transcriptLines))
    .then(value => ({ status: 'fulfilled' as const, value }))
    .catch(reason => ({ status: 'rejected' as const, reason }));
  if (audioResult.status === 'rejected') {
    throw audioResult.reason instanceof Error
      ? audioResult.reason
      : new Error('录音文件停止失败，请重试');
  }
  const audioUri = normalizeRecordingUri(audioResult.value);
  if (transcriptResult.status === 'rejected') {
    if (!audioUri) {
      await dependencies.onTranscriptSaveFailure?.(input.meetingId, transcriptResult.reason).catch(() => {});
      throw new Error('转写暂时无法保存，且未能确认本机录音文件。请重试');
    }
  }
  const transcriptSaveFailed = transcriptResult.status === 'rejected';

  let uploadFailed = false;
  let retryQueued = false;
  let uploadInBackground = false;
  let pendingAudio: PendingMeetingAudioUpload | null = null;
  if (!input.isGuest && audioUri) {
    pendingAudio = {
      meetingId: input.meetingId,
      remoteMeetingId: input.remoteMeetingId?.trim() || undefined,
      audioUri,
      fileName: `${input.meetingId}.wav`,
      mimeType: 'audio/wav',
      createdAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      attemptCount: 0,
      uploadState: 'pending',
    };
    try {
      await savePendingMeetingAudioUpload(input.storageScope, pendingAudio);
      retryQueued = true;
    } catch {
      retryQueued = false;
    }
    if (!input.accessToken) uploadFailed = true;
  }

  const meetingPatch: Partial<Meeting> = {
    audioAvailable: Boolean(audioUri),
    audioLocalUri: audioUri ?? null,
    audioSyncPending: retryQueued,
    audioSyncBlocked: false,
  };
  if (!transcriptSaveFailed) meetingPatch.hasTranscript = transcriptLines.length > 0;
  const audioDurationSec = input.getAudioDurationSec?.() ?? input.audioDurationSec;
  const audioBars = input.getAudioBars?.() ?? input.audioBars;
  if (audioDurationSec) {
    meetingPatch.audioDurationSec = audioDurationSec;
    meetingPatch.duration = formatDuration(audioDurationSec);
  }
  if (audioBars?.length) meetingPatch.audioBars = audioBars;
  const statusSyncInBackground = !input.isGuest;
  const statusSynced = await dependencies.updateStatus(
    input.meetingId,
    'ended',
    meetingPatch,
    { remoteSync: statusSyncInBackground ? 'background' : 'wait' },
  );
  if (transcriptResult.status === 'rejected') {
    await dependencies.onTranscriptSaveFailure?.(input.meetingId, transcriptResult.reason).catch(() => {});
  }

  let persistentUploadQueued = false;
  if (
    pendingAudio
    && input.accessToken
    && retryQueued
    && dependencies.enqueuePersistentUpload
  ) {
    try {
      const registration = await dependencies.enqueuePersistentUpload(pendingAudio, input.accessToken);
      if (registration) {
        const attached = await attachNativeUploadRegistration(input.storageScope, input.meetingId, registration)
          .catch(() => false);
        if (attached) {
          persistentUploadQueued = true;
          uploadInBackground = true;
        } else {
          await cancelNativeMeetingUpload(registration.workId).catch(() => {});
        }
      }
    } catch {
      // Keep the existing JS retry path as a compatibility fallback.
    }
  }

  if (pendingAudio && input.accessToken && retryQueued && !persistentUploadQueued) {
    uploadInBackground = true;
    void retryPendingMeetingAudioUpload(
      input.storageScope,
      input.meetingId,
      input.accessToken,
      (pending, token) => dependencies.uploadAudio(
        pending.remoteMeetingId ?? pending.meetingId,
        pending.audioUri,
        token,
      ),
      { automatic: true },
    ).then(uploaded => {
      if (uploaded && dependencies.reconcileUploads) {
        return dependencies.reconcileUploads(pendingAudio!);
      }
      if (uploaded) return dependencies.refreshMeetings();
      return undefined;
    }).catch(() => {});
  } else if (pendingAudio && input.accessToken && !retryQueued) {
    // The local capture is already committed, but the durable JS registry is
    // unavailable. Make one best-effort upload without holding the recorder
    // controller open; a failure remains visible as an untracked local asset.
    uploadFailed = true;
    uploadInBackground = true;
    const accessToken = input.accessToken;
    void Promise.resolve().then(() => dependencies.uploadAudio(
        input.remoteMeetingId?.trim() || input.meetingId,
        audioUri!,
        accessToken,
      ))
      .then(() => {
        if (dependencies.reconcileUploads) {
          return dependencies.reconcileUploads(pendingAudio);
        }
        return dependencies.refreshMeetings();
      })
      .catch(() => {});
  }

  if (pendingAudio && retryQueued && dependencies.reconcileUploads) {
    void dependencies.reconcileUploads().catch(() => {});
  }

  return {
    audioUri,
    transcriptSaveFailed,
    uploadFailed,
    retryQueued,
    uploadInBackground,
    statusSyncPending: !input.isGuest && !statusSynced,
    statusSyncInBackground,
  };
}

async function savePendingMeetingAudioUpload(
  storageScope: string,
  pending: PendingMeetingAudioUpload,
): Promise<void> {
  if (deletedMeetingAudio.has(meetingAudioOperationKey(storageScope, pending.meetingId))) {
    throw new Error('meeting was deleted while audio was finalizing');
  }
  const attemptedAt = new Date().toISOString();
  await mutatePendingUploads(storageScope, records => {
    const existing = records[pending.meetingId];
    records[pending.meetingId] = {
      ...pending,
      remoteMeetingId: pending.remoteMeetingId ?? existing?.remoteMeetingId,
      createdAt: existing?.createdAt ?? pending.createdAt ?? attemptedAt,
      lastAttemptAt: attemptedAt,
      attemptCount: (existing?.attemptCount ?? pending.attemptCount) + 1,
    };
  });
}

export function meetingAudioRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(attemptCount) - 1));
  return Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** exponent));
}

export function canAutomaticallyRetryPendingMeetingAudioUpload(
  pending: PendingMeetingAudioUpload,
  now = Date.now(),
): boolean {
  if (pending.uploadState === 'blocked') return false;
  if (!pending.nextAttemptAt) return true;
  const retryAt = Date.parse(pending.nextAttemptAt);
  return Number.isNaN(retryAt) || retryAt <= now;
}

async function markPendingMeetingAudioUploadFailure(
  storageScope: string,
  pending: PendingMeetingAudioUpload,
  error: unknown,
): Promise<void> {
  const failedAt = new Date();
  const failure = classifyMeetingAudioUploadFailure(error);
  await mutatePendingUploads(storageScope, records => {
    const existing = records[pending.meetingId] ?? pending;
    const attemptCount = existing.attemptCount + 1;
    records[pending.meetingId] = {
      ...existing,
      lastAttemptAt: failedAt.toISOString(),
      attemptCount,
      uploadState: failure.retryable ? 'pending' : 'blocked',
      failureCode: failure.code,
      failureMessage: failure.message,
      nextAttemptAt: failure.retryable
        ? new Date(failedAt.getTime() + meetingAudioRetryDelayMs(attemptCount)).toISOString()
        : undefined,
    };
  });
}

export async function clearPendingMeetingAudioUpload(storageScope: string, meetingId: string): Promise<void> {
  await mutatePendingUploads(storageScope, records => {
    delete records[meetingId];
  });
}

export async function attachPendingMeetingAudioUploadRemoteIdentity(
  storageScope: string,
  meetingId: string,
  remoteMeetingId: string,
): Promise<boolean> {
  const normalizedRemoteId = remoteMeetingId.trim();
  if (!normalizedRemoteId || /[\u0000-\u001f\u007f]/.test(normalizedRemoteId)) {
    throw new Error('meeting remote identity is invalid');
  }
  let changed = false;
  let nativeWorkId: string | undefined;
  await mutatePendingUploads(storageScope, records => {
    const existing = records[meetingId];
    if (!existing || existing.remoteMeetingId === normalizedRemoteId) return;
    if (existing.remoteMeetingId && existing.remoteMeetingId !== normalizedRemoteId) {
      throw new Error('meeting upload remote identity changed');
    }
    nativeWorkId = existing.nativeWorkId;
    const next = { ...existing, remoteMeetingId: normalizedRemoteId };
    delete next.nativeWorkId;
    delete next.nativeOperationId;
    delete next.nativeGeneration;
    records[meetingId] = next;
    changed = true;
  });
  if (nativeWorkId) await cancelNativeMeetingUpload(nativeWorkId).catch(() => {});
  return changed;
}

export async function deletePendingMeetingAudioUpload(storageScope: string, meetingId: string): Promise<void> {
  const operationKey = meetingAudioOperationKey(storageScope, meetingId);
  deletedMeetingAudio.add(operationKey);
  let nativeWorkId: string | undefined;
  await mutatePendingUploads(storageScope, records => {
    nativeWorkId = records[meetingId]?.nativeWorkId;
    delete records[meetingId];
  });
  if (nativeWorkId) await cancelNativeMeetingUpload(nativeWorkId);
}

async function attachNativeUploadRegistration(
  storageScope: string,
  meetingId: string,
  registration: NativeMeetingUploadRegistration,
): Promise<boolean> {
  const operationKey = meetingAudioOperationKey(storageScope, meetingId);
  if (deletedMeetingAudio.has(operationKey)) return false;
  let attached = false;
  await mutatePendingUploads(storageScope, records => {
    if (deletedMeetingAudio.has(operationKey)) return;
    const existing = records[meetingId];
    if (!existing) return;
    records[meetingId] = {
      ...existing,
      nativeWorkId: registration.workId,
      nativeOperationId: registration.operationId,
      nativeGeneration: registration.generation,
    };
    attached = true;
  });
  return attached;
}

async function clearNativeUploadRegistration(storageScope: string, meetingId: string): Promise<void> {
  await mutatePendingUploads(storageScope, records => {
    const existing = records[meetingId];
    if (!existing) return;
    const next = { ...existing };
    delete next.nativeWorkId;
    delete next.nativeOperationId;
    delete next.nativeGeneration;
    records[meetingId] = next;
  });
}

function mutatePendingUploads(storageScope: string, mutator: (records: PendingUploadMap) => void): Promise<void> {
  const storageKey = pendingUploadsKey(storageScope);
  const operation = pendingStorageMutation
    .catch(() => {})
    .then(async () => {
      const records = await readPendingUploads(storageScope);
      mutator(records);
      if (Object.keys(records).length === 0) {
        await removeAppStorageItem(storageKey);
      } else {
        await setAppStorageItem(storageKey, JSON.stringify(records));
      }
      await removeAppStorageItem(LEGACY_PENDING_AUDIO_UPLOADS_KEY).catch(() => {});
    });
  pendingStorageMutation = operation;
  return operation;
}

async function readPendingUploads(storageScope: string): Promise<PendingUploadMap> {
  const raw = await getAppStorageItem(pendingUploadsKey(storageScope));
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pending meeting audio upload registry is invalid');
  }

  const records: PendingUploadMap = {};
  Object.entries(parsed).forEach(([meetingId, value]) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Partial<PendingMeetingAudioUpload>;
    if (typeof item.audioUri !== 'string' || !item.audioUri) return;
    records[meetingId] = {
      meetingId,
      remoteMeetingId: typeof item.remoteMeetingId === 'string' && item.remoteMeetingId.trim()
        ? item.remoteMeetingId.trim()
        : undefined,
      audioUri: item.audioUri,
      fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : `${meetingId}.wav`,
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'audio/wav',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : new Date(0).toISOString(),
      attemptCount: typeof item.attemptCount === 'number' ? item.attemptCount : 0,
      uploadState: item.uploadState === 'blocked' ? 'blocked' : 'pending',
      failureCode: typeof item.failureCode === 'string'
        ? item.failureCode as MeetingAudioUploadFailureCode
        : undefined,
      failureMessage: typeof item.failureMessage === 'string' ? item.failureMessage : undefined,
      nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : undefined,
      nativeWorkId: typeof item.nativeWorkId === 'string' ? item.nativeWorkId : undefined,
      nativeOperationId: typeof item.nativeOperationId === 'string' ? item.nativeOperationId : undefined,
      nativeGeneration: typeof item.nativeGeneration === 'number' ? item.nativeGeneration : undefined,
    };
  });
  return records;
}

function pendingUploadsKey(storageScope: string): string {
  const normalized = storageScope.trim();
  if (!normalized) throw new Error('meeting recording storage scope is required');
  return `${PENDING_AUDIO_UPLOADS_KEY}:${normalized}`;
}

export function resetMeetingRecordingStateForTests(): void {
  pendingStorageMutation = Promise.resolve();
  pendingAudioUploadsInFlight.clear();
  deletedMeetingAudio.clear();
}
