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
import {
  listPendingDeviceUploadOperations,
  listTerminalDeviceUploadAssetIds,
} from '../data/repositories/vnext/deviceOperationsRepository';
import { diagnosticAudit } from './diagnostics';

const PENDING_AUDIO_UPLOADS_KEY = '@laoji:pendingMeetingAudioUploads:v3';

export function normalizeRecordingUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
}

export interface FinalizeMeetingRecordingInput {
  meetingId: string;
  storageScope: string;
  transcriptLines: TranscriptLine[];
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
  updateStatus: (
    meetingId: string,
    status: string,
    patch: Partial<Meeting>,
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
}

export interface PendingMeetingAudioUpload {
  meetingId: string;
  canonicalMeetingId?: string;
  remoteMeetingId?: string;
  recordingAssetId: string;
  role: 'primary' | 'secondary';
  origin: 'captured' | 'imported' | 'recovered';
  nativeSessionId?: string;
  audioUri: string;
  fileName: string;
  mimeType: string;
  byteSize?: number;
  durationMs?: number;
  checksumSha256?: string;
  /** Immutable vNext asset generation used by the native R2 unique-work key. */
  assetGeneration?: string;
  /** Canonical source digest. Unlike legacy checksumSha256, this always includes the sha256 prefix. */
  sourceSha256?: string;
  remoteAssetId?: string;
  remoteAssetRevision?: number;
  /** Device transcription job identity retained until completion is pulled. */
  transcriptionTaskId?: string;
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
  nativeProtocol?: 'device-v2-r2';
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
export type PendingAudioUploader = (
  pending: PendingMeetingAudioUpload,
  accessToken: string,
) => Promise<unknown>;

export interface PendingMeetingAudioUploadBatchResult {
  found: number;
  uploadedIds: string[];
  uploaded: PendingMeetingAudioUpload[];
  failedIds: string[];
  skippedIds: string[];
}

export interface PendingMeetingAudioRetryOptions {
  automatic?: boolean;
  /** A v2 capability decision is request-scoped: never duplicate it through another uploader. */
  requireNativeTransport?: boolean;
}

let pendingStorageMutation: Promise<void> = Promise.resolve();
const pendingAudioUploadsInFlight = new Map<string, Promise<PendingMeetingAudioUpload | null>>();
const deletedMeetingAudio = new Set<string>();
type PendingMeetingAudioUploadListener = (meetingId: string) => void;
const pendingMeetingAudioUploadListeners = new Set<PendingMeetingAudioUploadListener>();

export function subscribePendingMeetingAudioUploadChanged(
  listener: PendingMeetingAudioUploadListener,
): () => void {
  pendingMeetingAudioUploadListeners.add(listener);
  return () => pendingMeetingAudioUploadListeners.delete(listener);
}

function notifyPendingMeetingAudioUploadsChanged(meetingIds: readonly string[]): void {
  const uniqueMeetingIds = [...new Set(meetingIds.map(value => value.trim()).filter(Boolean))];
  uniqueMeetingIds.forEach(meetingId => {
    pendingMeetingAudioUploadListeners.forEach(listener => {
      try {
        listener(meetingId);
      } catch {
        // A detached status presenter cannot invalidate a durable upload write.
      }
    });
  });
}

function meetingAudioOperationKey(storageScope: string, recordingAssetId: string): string {
  return `${storageScope}\u001f${recordingAssetId}`;
}

function deletedMeetingAudioKey(storageScope: string, meetingId: string): string {
  return `${storageScope}\u001fmeeting:${meetingId}`;
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
  recordingAssetId?: string,
): Promise<PendingMeetingAudioUpload | null> {
  // Detail pages and the background coordinator must project the same owner.
  // Reading a second registry directly here resurrected an upload
  // after its canonical Operation had already reached success, leaving an
  // open meeting on "等待上传录音" while transcript events were arriving.
  const records = await listPendingMeetingAudioUploads(storageScope);
  if (recordingAssetId) {
    return records.find(item => item.recordingAssetId === recordingAssetId) ?? null;
  }
  return records
    .filter(item => item.meetingId === meetingId)
    .sort((left, right) => (
      (left.role === 'primary' ? 0 : 1) - (right.role === 'primary' ? 0 : 1)
      || left.createdAt.localeCompare(right.createdAt)
      || left.recordingAssetId.localeCompare(right.recordingAssetId)
    ))[0] ?? null;
}

export async function listPendingMeetingAudioUploads(
  storageScope: string,
): Promise<PendingMeetingAudioUpload[]> {
  await pendingStorageMutation.catch(() => {});
  const localRegistry = Object.values(await readPendingUploads(storageScope));
  let canonical: PendingMeetingAudioUpload[] = [];
  let terminalCanonicalAssetIds: ReadonlySet<string> = new Set();
  if (storageScope === 'guest') {
    try {
      canonical = (await listPendingDeviceUploadOperations('guest')).map(snapshot => ({
        meetingId: snapshot.asset.meetingId,
        canonicalMeetingId: snapshot.asset.meetingId,
        recordingAssetId: snapshot.asset.id,
        role: snapshot.asset.role,
        origin: snapshot.asset.origin,
        nativeSessionId: snapshot.asset.nativeSessionId ?? undefined,
        audioUri: snapshot.asset.localUri,
        fileName: snapshot.asset.fileName ?? `${snapshot.asset.id}.wav`,
        mimeType: snapshot.asset.mimeType ?? 'audio/wav',
        byteSize: snapshot.asset.byteSize ?? undefined,
        durationMs: snapshot.asset.durationMs ?? undefined,
        checksumSha256: snapshot.asset.checksumSha256 ?? snapshot.asset.sourceSha256 ?? undefined,
        sourceSha256: snapshot.asset.sourceSha256 ?? undefined,
        assetGeneration: snapshot.asset.assetGeneration,
        remoteAssetId: snapshot.asset.remoteAssetId ?? undefined,
        remoteAssetRevision: snapshot.asset.remoteObjectRevision ?? undefined,
        createdAt: new Date(snapshot.operation.createdAtMs).toISOString(),
        lastAttemptAt: new Date(snapshot.operation.updatedAtMs).toISOString(),
        attemptCount: Math.max(0, snapshot.operation.operationRevision - 1),
        uploadState: 'pending',
        failureCode: snapshot.operation.remoteState === 'failure'
          ? snapshot.operation.errorCode as MeetingAudioUploadFailureCode | undefined
          : undefined,
        failureMessage: snapshot.operation.remoteState === 'failure'
          ? snapshot.operation.errorCode ?? undefined
          : undefined,
        nativeWorkId: snapshot.operation.executorKind === 'workmanager'
          ? snapshot.operation.executorId ?? undefined
          : undefined,
        nativeOperationId: snapshot.operation.operationId,
        nativeProtocol: 'device-v2-r2',
      } satisfies PendingMeetingAudioUpload));
    } catch {
      // A cold-open failure must not discard the local recovery registry; the
      // next foreground pass retries SQLite.
      canonical = [];
    }
    try {
      terminalCanonicalAssetIds = await listTerminalDeviceUploadAssetIds('guest');
    } catch {
      // A terminal-state probe is advisory.  Keep any canonical pending rows
      // already read above; a later pass can retry the suppression query.
      terminalCanonicalAssetIds = new Set();
    }
  }
  const canonicalIds = new Set(canonical.map(item => item.recordingAssetId));
  const combined = [
    ...canonical,
    ...localRegistry.filter(item => (
      !canonicalIds.has(item.recordingAssetId)
      && !terminalCanonicalAssetIds.has(item.recordingAssetId)
    )),
  ];
  return combined.sort((left, right) => (
    left.meetingId.localeCompare(right.meetingId)
    || (left.role === 'primary' ? 0 : 1) - (right.role === 'primary' ? 0 : 1)
    || left.createdAt.localeCompare(right.createdAt)
    || left.recordingAssetId.localeCompare(right.recordingAssetId)
  ));
}

function nativeFailureIsBlocked(reason: string | undefined): boolean {
  const normalized = reason?.trim().toLowerCase() ?? '';
  return normalized === 'invalid-input'
    || normalized === 'invalid-endpoint'
    || normalized === 'invalid-response'
    || normalized === 'file-missing'
    || normalized === 'meeting-deleted'
    || /^http-(?:400|404|409|412|413|415|422)$/.test(normalized);
}

/**
 * A WorkManager handle can survive an APK upgrade while the native module no
 * longer has a resolvable record for it.  Never let that stale promise block
 * the device-primary JS uploader forever; a null result deliberately enters
 * the existing idempotent fallback path below.
 */
async function readNativeUploadStateBounded(
  workId: string,
  timeoutMs = 3_000,
): Promise<NativeUploadState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getNativeMeetingUploadState(workId).catch(() => null),
      new Promise<NativeUploadState | null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelNativeUploadBounded(
  workId: string,
  timeoutMs = 3_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelNativeMeetingUpload(workId).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const nativeRemoteAssetId = nativeState?.state === 'succeeded'
    && typeof nativeState.remoteAssetId === 'string'
    && nativeState.remoteAssetId.trim()
    ? nativeState.remoteAssetId.trim()
    : null;
  const nativeRemoteRevision = Number.isSafeInteger(nativeState?.remoteRevision)
    && Number(nativeState?.remoteRevision) >= 1
    ? Number(nativeState?.remoteRevision)
    : null;
  const nativeTaskId = nativeState?.state === 'succeeded'
    && typeof nativeState.transcriptionTaskId === 'string'
    && nativeState.transcriptionTaskId.trim()
    ? nativeState.transcriptionTaskId.trim()
    : null;
  const observedPending = nativeRemoteAssetId && nativeRemoteRevision !== null
    ? {
        ...pending,
        remoteAssetId: nativeRemoteAssetId,
        remoteAssetRevision: nativeRemoteRevision,
        transcriptionTaskId: nativeTaskId ?? pending.transcriptionTaskId,
      }
    : nativeTaskId
      ? { ...pending, transcriptionTaskId: nativeTaskId }
      : pending;
  let phase: PendingMeetingAudioUploadPhase;
  let errorCode: string | null = pending.failureCode ?? null;
  if (nativeState?.state === 'succeeded' && nativeState.result === 'uploaded') {
    phase = 'uploaded';
    errorCode = null;
  } else if (pending.uploadState === 'blocked') {
    phase = 'blocked';
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
    pending: observedPending,
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
    ? await readNativeUploadStateBounded(pending.nativeWorkId)
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
  recordingAssetId: string,
  accessToken: string,
  uploadAudio: PendingAudioUploader,
  options: PendingMeetingAudioRetryOptions = {},
): Promise<PendingMeetingAudioUpload | null> {
  const operationKey = meetingAudioOperationKey(storageScope, recordingAssetId);
  const existing = pendingAudioUploadsInFlight.get(operationKey);
  if (existing) return existing;

  const operation = (async () => {
    let pending = await getPendingMeetingAudioUpload(storageScope, '', recordingAssetId);
    if (!pending) return null;
    const deletedKey = deletedMeetingAudioKey(storageScope, pending.meetingId);
    if (deletedMeetingAudio.has(deletedKey)) return null;
    if (pending.nativeWorkId) {
      const nativeState = await readNativeUploadStateBounded(pending.nativeWorkId);
      if (nativeState?.state === 'succeeded' && nativeState.result === 'uploaded') {
        const uploaded = derivePendingMeetingAudioUploadInspection(pending, nativeState).pending;
        await clearPendingMeetingAudioUpload(storageScope, recordingAssetId);
        return uploaded;
      }
      if (
        nativeState !== null
        && (
          nativeState.state === 'enqueued'
          || nativeState.state === 'running'
        )
      ) {
        await deferPendingMeetingAudioUploadPoll(storageScope, recordingAssetId).catch(() => {});
        return null;
      }
      // A WorkManager job with no prerequisites must never remain BLOCKED.
      // Older builds also leave a work id that no longer resolves after an
      // application update.  Waiting for either state forever strands the
      // local recording and forces the user to open the detail page.  Drop the
      // unusable native registration and continue through the durable JS
      // uploader; the idempotency keys keep a late native request harmless.
      if (nativeState === null || nativeState.state === 'blocked') {
        diagnosticAudit('meeting_audio_upload_native_fallback', {
          status: 'fallback_to_js',
          meeting_id: pending.meetingId,
          recording_asset_id: pending.recordingAssetId,
          reason: nativeState === null ? 'work_missing' : 'work_blocked',
        });
      }
      await clearNativeUploadRegistration(storageScope, recordingAssetId);
      pending = { ...pending };
      delete pending.nativeWorkId;
      delete pending.nativeOperationId;
      delete pending.nativeGeneration;
      delete pending.nativeProtocol;
      if (options.requireNativeTransport) {
        await deferPendingMeetingAudioUploadPoll(storageScope, recordingAssetId).catch(() => {});
        return null;
      }
    }
    if (options.requireNativeTransport && !pending.nativeWorkId) return null;
    if (options.automatic && !canAutomaticallyRetryPendingMeetingAudioUpload(pending)) return null;
    try {
      if (deletedMeetingAudio.has(deletedKey)) return null;
      const result = await uploadAudio(pending, accessToken);
      const uploaded = pendingWithRemoteUploadResult(pending, result);
      await clearPendingMeetingAudioUpload(storageScope, recordingAssetId);
      return uploaded;
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
  options: PendingMeetingAudioRetryOptions = {},
): Promise<PendingMeetingAudioUploadBatchResult> {
  const pending = await listPendingMeetingAudioUploads(storageScope);
  const outcomes: Array<'uploaded' | 'failed' | 'skipped'> = new Array(pending.length);
  const uploaded: Array<PendingMeetingAudioUpload | null> = new Array(pending.length).fill(null);
  let cursor = 0;
  const workerCount = Math.min(pending.length, Math.max(1, Math.min(3, Math.floor(concurrency) || 1)));

  const worker = async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      // Account uploads require a server meeting identity. Device-primary
      // uploads intentionally use the local meeting UUID as their binding and
      // must not wait for a separate remote-identity repair path.
      if (!pending[index].remoteMeetingId && accessToken !== 'device') {
        outcomes[index] = 'skipped';
        continue;
      }
      try {
        const completed = await retryPendingMeetingAudioUpload(
          storageScope,
          pending[index].recordingAssetId,
          accessToken,
          uploadAudio,
          { ...options, automatic: true },
        );
        uploaded[index] = completed;
        outcomes[index] = completed ? 'uploaded' : 'skipped';
      } catch (error) {
        diagnosticAudit('meeting_audio_upload_failed', {
          meeting_id: pending[index].meetingId,
          recording_asset_id: pending[index].recordingAssetId,
          reason: error instanceof Error ? error.name : 'unknown',
          status: typeof (error as any)?.status === 'number' ? (error as any).status : null,
          code: typeof (error as any)?.code === 'string' ? (error as any).code : null,
          message: error instanceof Error ? error.message.slice(0, 160) : null,
        });
        outcomes[index] = 'failed';
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    found: pending.length,
    uploadedIds: pending.filter((_, index) => outcomes[index] === 'uploaded').map(item => item.meetingId),
    uploaded: uploaded.filter((item): item is PendingMeetingAudioUpload => item !== null),
    failedIds: pending.filter((_, index) => outcomes[index] === 'failed').map(item => item.meetingId),
    skippedIds: pending.filter((_, index) => outcomes[index] === 'skipped').map(item => item.meetingId),
  };
}

function pendingWithRemoteUploadResult(
  pending: PendingMeetingAudioUpload,
  value: unknown,
): PendingMeetingAudioUpload {
  if (!value || typeof value !== 'object') return pending;
  const result = value as {
    remoteId?: unknown;
    revision?: unknown;
    transcriptionTaskId?: unknown;
    transcription_task_id?: unknown;
    task_id?: unknown;
    job_id?: unknown;
  };
  const remoteAssetId = typeof result.remoteId === 'string' ? result.remoteId.trim() : '';
  const remoteAssetRevision = Number(result.revision);
  const transcriptionTaskId = [
    result.transcriptionTaskId,
    result.transcription_task_id,
    result.task_id,
    result.job_id,
  ].map(value => typeof value === 'string' ? value.trim() : '')
    .find(value => Boolean(value) && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value));
  if (
    !remoteAssetId
    || /[\u0000-\u001f\u007f]/.test(remoteAssetId)
    || !Number.isSafeInteger(remoteAssetRevision)
    || remoteAssetRevision < 1
  ) return transcriptionTaskId ? { ...pending, transcriptionTaskId } : pending;
  return { ...pending, remoteAssetId, remoteAssetRevision, transcriptionTaskId };
}

async function deferPendingMeetingAudioUploadPoll(
  storageScope: string,
  recordingAssetId: string,
): Promise<void> {
  const nextAttemptAt = new Date(Date.now() + 3_000).toISOString();
  await mutatePendingUploads(storageScope, records => {
    const current = records[recordingAssetId];
    if (!current) return;
    records[recordingAssetId] = { ...current, nextAttemptAt };
  });
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

  const uploadFailed = false;
  let retryQueued = false;
  let uploadInBackground = false;
  let pendingAudio: PendingMeetingAudioUpload | null = null;
  // Guest meetings are local-first, but their generated transcript still
  // needs the device-scoped service.  Keep the source URI on the phone and
  // queue the durable device upload record. The local UUID is its temporary
  // service binding until the device-scoped binding is registered.
  if (audioUri) {
    pendingAudio = {
      meetingId: input.meetingId,
      remoteMeetingId: undefined,
      recordingAssetId: `captured-primary:${input.meetingId}`,
      role: 'primary',
      origin: 'captured',
      nativeSessionId: input.meetingId,
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
  await dependencies.updateStatus(
    input.meetingId,
    'ended',
    meetingPatch,
  );
  if (transcriptResult.status === 'rejected') {
    await dependencies.onTranscriptSaveFailure?.(input.meetingId, transcriptResult.reason).catch(() => {});
  }

  uploadInBackground = Boolean(pendingAudio && retryQueued);

  if (pendingAudio && retryQueued && dependencies.reconcileUploads) {
    void dependencies.reconcileUploads().catch(() => {});
  }

  return {
    audioUri,
    transcriptSaveFailed,
    uploadFailed,
    retryQueued,
    uploadInBackground,
  };
}

async function savePendingMeetingAudioUpload(
  storageScope: string,
  pending: PendingMeetingAudioUpload,
): Promise<void> {
  if (deletedMeetingAudio.has(deletedMeetingAudioKey(storageScope, pending.meetingId))) {
    throw new Error('meeting was deleted while audio was finalizing');
  }
  const attemptedAt = new Date().toISOString();
  await mutatePendingUploads(storageScope, records => {
    const existing = records[pending.recordingAssetId];
    records[pending.recordingAssetId] = {
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
    const existing = records[pending.recordingAssetId] ?? pending;
    const attemptCount = existing.attemptCount + 1;
    records[pending.recordingAssetId] = {
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

export async function clearPendingMeetingAudioUpload(
  storageScope: string,
  recordingAssetId: string,
): Promise<void> {
  await mutatePendingUploads(storageScope, records => {
    delete records[recordingAssetId];
  });
}

export async function upsertPendingMeetingAudioUpload(
  storageScope: string,
  pending: PendingMeetingAudioUpload,
): Promise<void> {
  if (deletedMeetingAudio.has(deletedMeetingAudioKey(storageScope, pending.meetingId))) return;
  const cancelled: string[] = [];
  await mutatePendingUploads(storageScope, records => {
    Object.entries(records).forEach(([assetId, existing]) => {
      if (
        assetId !== pending.recordingAssetId
        && existing.meetingId === pending.meetingId
        && existing.audioUri === pending.audioUri
      ) {
        if (existing.nativeWorkId) cancelled.push(existing.nativeWorkId);
        delete records[assetId];
      }
    });
    const existing = records[pending.recordingAssetId];
    records[pending.recordingAssetId] = {
      ...pending,
      remoteMeetingId: pending.remoteMeetingId ?? existing?.remoteMeetingId,
      remoteAssetId: pending.remoteAssetId ?? existing?.remoteAssetId,
      remoteAssetRevision: pending.remoteAssetRevision ?? existing?.remoteAssetRevision,
      assetGeneration: pending.assetGeneration ?? existing?.assetGeneration,
      sourceSha256: pending.sourceSha256 ?? existing?.sourceSha256,
      checksumSha256: pending.checksumSha256 ?? existing?.checksumSha256,
      createdAt: existing?.createdAt ?? pending.createdAt,
      lastAttemptAt: existing?.lastAttemptAt ?? pending.lastAttemptAt,
      attemptCount: existing?.attemptCount ?? pending.attemptCount,
      uploadState: existing?.uploadState ?? pending.uploadState,
      failureCode: existing?.failureCode,
      failureMessage: existing?.failureMessage,
      nextAttemptAt: existing?.nextAttemptAt,
      nativeWorkId: existing?.nativeWorkId,
      nativeOperationId: existing?.nativeOperationId,
      nativeGeneration: existing?.nativeGeneration,
      nativeProtocol: existing?.nativeProtocol,
    };
  });
  await Promise.all(cancelled.map(workId => cancelNativeUploadBounded(workId)));
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
  const nativeWorkIds: string[] = [];
  await mutatePendingUploads(storageScope, records => {
    Object.entries(records).forEach(([assetId, existing]) => {
      if (existing.meetingId !== meetingId || existing.remoteMeetingId === normalizedRemoteId) return;
      if (existing.remoteMeetingId && existing.remoteMeetingId !== normalizedRemoteId) {
        throw new Error('meeting upload remote identity changed');
      }
      if (existing.nativeWorkId) nativeWorkIds.push(existing.nativeWorkId);
      const next = { ...existing, remoteMeetingId: normalizedRemoteId };
      delete next.nativeWorkId;
      delete next.nativeOperationId;
      delete next.nativeGeneration;
      records[assetId] = next;
      changed = true;
    });
  });
  await Promise.all(nativeWorkIds.map(workId => cancelNativeUploadBounded(workId)));
  return changed;
}

export async function deletePendingMeetingAudioUpload(storageScope: string, meetingId: string): Promise<void> {
  deletedMeetingAudio.add(deletedMeetingAudioKey(storageScope, meetingId));
  const nativeWorkIds: string[] = [];
  await mutatePendingUploads(storageScope, records => {
    Object.entries(records).forEach(([assetId, existing]) => {
      if (existing.meetingId !== meetingId) return;
      if (existing.nativeWorkId) nativeWorkIds.push(existing.nativeWorkId);
      delete records[assetId];
    });
  });
  await Promise.all(nativeWorkIds.map(workId => cancelNativeUploadBounded(workId)));
}

/** Re-enables future local audio work after a recoverable root tombstone is restored. */
export function restoreDeletedMeetingAudio(storageScope: string, meetingId: string): void {
  deletedMeetingAudio.delete(deletedMeetingAudioKey(storageScope, meetingId));
}

export async function attachNativeUploadRegistration(
  storageScope: string,
  recordingAssetId: string,
  registration: NativeMeetingUploadRegistration,
): Promise<boolean> {
  let attached = false;
  await mutatePendingUploads(storageScope, records => {
    const existing = records[recordingAssetId];
    if (!existing) return;
    if (deletedMeetingAudio.has(deletedMeetingAudioKey(storageScope, existing.meetingId))) return;
    records[recordingAssetId] = {
      ...existing,
      nativeWorkId: registration.workId,
      nativeOperationId: registration.operationId,
      nativeGeneration: registration.generation,
      nativeProtocol: registration.protocol,
    };
    attached = true;
  });
  return attached;
}

async function clearNativeUploadRegistration(
  storageScope: string,
  recordingAssetId: string,
): Promise<void> {
  await mutatePendingUploads(storageScope, records => {
    const existing = records[recordingAssetId];
    if (!existing) return;
    const next = { ...existing };
    delete next.nativeWorkId;
    delete next.nativeOperationId;
    delete next.nativeGeneration;
    delete next.nativeProtocol;
    records[recordingAssetId] = next;
  });
}

function mutatePendingUploads(storageScope: string, mutator: (records: PendingUploadMap) => void): Promise<void> {
  const storageKey = pendingUploadsKey(storageScope);
  const operation = pendingStorageMutation
    .catch(() => {})
    .then(async () => {
      const records = await readPendingUploads(storageScope);
      const previousByAssetId = new Map(Object.entries(records).map(([assetId, record]) => [
        assetId,
        { meetingId: record.meetingId, serialized: JSON.stringify(record) },
      ]));
      mutator(records);
      if (Object.keys(records).length === 0) {
        await removeAppStorageItem(storageKey);
      } else {
        await setAppStorageItem(storageKey, JSON.stringify(records));
      }
      const changedMeetingIds = new Set<string>();
      const assetIds = new Set([...previousByAssetId.keys(), ...Object.keys(records)]);
      assetIds.forEach(assetId => {
        const previous = previousByAssetId.get(assetId);
        const current = records[assetId];
        if (previous?.serialized === JSON.stringify(current)) return;
        if (previous?.meetingId) changedMeetingIds.add(previous.meetingId);
        if (current?.meetingId) changedMeetingIds.add(current.meetingId);
      });
      notifyPendingMeetingAudioUploadsChanged([...changedMeetingIds]);
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
  Object.entries(parsed).forEach(([storedIdentity, value]) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Partial<PendingMeetingAudioUpload>;
    if (typeof item.audioUri !== 'string' || !item.audioUri) return;
    const meetingId = typeof item.meetingId === 'string' && item.meetingId.trim()
      ? item.meetingId.trim()
      : storedIdentity;
    const recordingAssetId = typeof item.recordingAssetId === 'string' && item.recordingAssetId.trim()
      ? item.recordingAssetId.trim()
      : `captured-primary:${meetingId}`;
    const role = item.role === 'secondary' ? 'secondary' : 'primary';
    const origin = item.origin === 'imported' || item.origin === 'recovered'
      ? item.origin
      : 'captured';
    records[recordingAssetId] = {
      meetingId,
      canonicalMeetingId: typeof item.canonicalMeetingId === 'string' && item.canonicalMeetingId.trim()
        ? item.canonicalMeetingId.trim()
        : undefined,
      remoteMeetingId: typeof item.remoteMeetingId === 'string' && item.remoteMeetingId.trim()
        ? item.remoteMeetingId.trim()
        : undefined,
      recordingAssetId,
      role,
      origin,
      nativeSessionId: typeof item.nativeSessionId === 'string' && item.nativeSessionId.trim()
        ? item.nativeSessionId.trim()
        : undefined,
      audioUri: item.audioUri,
      fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : `${meetingId}.wav`,
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'audio/wav',
      byteSize: Number.isSafeInteger(item.byteSize) && Number(item.byteSize) >= 0
        ? Number(item.byteSize)
        : undefined,
      durationMs: Number.isSafeInteger(item.durationMs) && Number(item.durationMs) >= 0
        ? Number(item.durationMs)
        : undefined,
      checksumSha256: typeof item.checksumSha256 === 'string'
        && /^(?:sha256:)?[0-9a-f]{64}$/i.test(item.checksumSha256.trim())
        ? item.checksumSha256.trim().toLowerCase()
        : undefined,
      assetGeneration: typeof item.assetGeneration === 'string'
        && /^[0-9a-f]{32}$/i.test(item.assetGeneration.trim())
        ? item.assetGeneration.trim().toLowerCase()
        : undefined,
      sourceSha256: typeof item.sourceSha256 === 'string'
        && /^sha256:[0-9a-f]{64}$/i.test(item.sourceSha256.trim())
        ? item.sourceSha256.trim().toLowerCase()
        : undefined,
      remoteAssetId: typeof item.remoteAssetId === 'string' && item.remoteAssetId.trim()
        ? item.remoteAssetId.trim()
        : undefined,
      remoteAssetRevision: Number.isSafeInteger(item.remoteAssetRevision)
        && Number(item.remoteAssetRevision) >= 1
        ? Number(item.remoteAssetRevision)
        : undefined,
      transcriptionTaskId: typeof item.transcriptionTaskId === 'string'
        && item.transcriptionTaskId.trim()
        && item.transcriptionTaskId.trim().length <= 160
        && !/[\u0000-\u001f\u007f]/.test(item.transcriptionTaskId)
        ? item.transcriptionTaskId.trim()
        : undefined,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : new Date(0).toISOString(),
      attemptCount: typeof item.attemptCount === 'number' ? item.attemptCount : 0,
      uploadState: item.uploadState === 'blocked' ? 'blocked' : 'pending',
      failureCode: typeof item.failureCode === 'string'
        ? item.failureCode as MeetingAudioUploadFailureCode
        : undefined,
      failureMessage: typeof item.failureMessage === 'string' ? item.failureMessage : undefined,
      nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : undefined,
      nativeWorkId: item.nativeProtocol === 'device-v2-r2' && typeof item.nativeWorkId === 'string'
        ? item.nativeWorkId
        : undefined,
      nativeOperationId: item.nativeProtocol === 'device-v2-r2' && typeof item.nativeOperationId === 'string'
        ? item.nativeOperationId
        : undefined,
      nativeGeneration: item.nativeProtocol === 'device-v2-r2' && typeof item.nativeGeneration === 'number'
        ? item.nativeGeneration
        : undefined,
      nativeProtocol: item.nativeProtocol === 'device-v2-r2' ? 'device-v2-r2' : undefined,
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
