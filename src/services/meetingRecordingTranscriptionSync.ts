import {
  createRecordingAssetTranscriptionV2,
  getRecordingProcessingJobV2,
  listRecordingAssetsV2,
  parseRecordingAssetTranscriptionJobV2,
  RecordingAssetConflictResponseError,
  retryRecordingProcessingJobV2,
  type RemoteRecordingAssetV2,
  type RecordingAssetTranscriptionJobV2,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type RecordingAssetTranscriptionTaskRecord,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';
import { HttpResponseError } from './errors';

const MAX_TASKS_PER_DRAIN = 4;
const ACTIVE_JOB_RECHECK_MS = 1_000;
const AUTH_RECHECK_MS = 60_000;

export interface RecordingTranscriptionDiscoveryMeeting {
  meetingId: string;
  remoteMeetingId: string;
}

export interface DrainMeetingRecordingTranscriptionInput {
  scopeKey: Exclude<ScopeKey, 'guest'>;
  accessToken: string;
  discoveryMeetings: readonly RecordingTranscriptionDiscoveryMeeting[];
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DrainMeetingRecordingTranscriptionResult {
  processedCount: number;
  discoveredCount: number;
  readyContents: readonly import('../data/repositories').ReadyRecordingAssetTranscriptContent[];
  retryAfterMs: number | null;
}

export interface DiscoverMeetingRecordingTranscriptionResult {
  changedCount: number;
  uploadedAssets: readonly RemoteRecordingAssetV2[];
}

function taskId(scopeKey: ScopeKey, remoteAssetId: string): string {
  return `recording-transcription:${scopeKey}:${remoteAssetId}`;
}

function clientRequestId(remoteAssetId: string): string {
  return `laoji-recording-transcription:${remoteAssetId}:v1`;
}

function idempotencyKey(remoteAssetId: string): string {
  return `recording-transcription-create:${remoteAssetId}:v1`;
}

function retryIdempotencyKey(task: RecordingAssetTranscriptionTaskRecord): string {
  return `recording-transcription-retry:${task.remoteJobId}:${task.remoteAttempt + 1}`;
}

function deterministicJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function transportRetryDelayMs(task: RecordingAssetTranscriptionTaskRecord): number {
  const exponent = Math.max(0, Math.min(10, task.requestAttemptCount));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(task.idempotencyKey));
}

function remoteRetryDelayMs(
  task: RecordingAssetTranscriptionTaskRecord,
  remoteAttempt: number,
): number {
  const exponent = Math.max(0, Math.min(10, remoteAttempt));
  const base = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** exponent));
  return Math.round(base * deterministicJitter(task.remoteJobId ?? task.idempotencyKey));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function responseLooksInvalid(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /响应.*(?:格式|版本|标识|身份)|结果版本不完整/.test(message);
}

function transportErrorCode(error: unknown): string {
  if (error instanceof HttpResponseError) return `http_${error.status}`;
  if ((error as Error)?.name === 'RequestTimeoutError') return 'request_timeout';
  return 'network_or_timeout';
}

function nextAttemptForJob(
  task: RecordingAssetTranscriptionTaskRecord,
  job: RecordingAssetTranscriptionJobV2,
  nowMs: number,
): number | null {
  if (job.status === 'queued' || job.status === 'running') return nowMs + ACTIVE_JOB_RECHECK_MS;
  if (job.status === 'failed' && job.retryable && job.errorCode !== 'no_speech') {
    return nowMs + remoteRetryDelayMs(task, job.attempt);
  }
  return null;
}

async function applyJob(
  task: RecordingAssetTranscriptionTaskRecord,
  job: RecordingAssetTranscriptionJobV2,
  nowMs: number,
): Promise<void> {
  if (
    job.meetingRemoteId !== task.remoteMeetingId
    || job.recordingAssetRemoteId !== task.remoteRecordingAssetId
  ) throw new Error('录音转写任务不属于当前录音');
  const noSpeech = job.status === 'failed' && job.errorCode === 'no_speech';
  await sqliteMeetingNoteRepository.applyRecordingAssetTranscriptionJob({
    taskId: task.id,
    scopeKey: task.scopeKey,
    remoteMeetingId: task.remoteMeetingId,
    remoteRecordingAssetId: task.remoteRecordingAssetId,
    remoteJobId: job.jobId,
    status: job.status,
    remoteAttempt: job.attempt,
    progress: job.progress,
    errorCode: job.errorCode,
    retryable: noSpeech ? false : job.retryable,
    resultRevisionId: job.resultRevisionId,
    nextAttemptAtMs: nextAttemptForJob(task, job, nowMs),
    remoteUpdatedAtMs: job.serverUpdatedAtMs,
    receivedAtMs: nowMs,
  });
}

function recoverConflictJob(
  error: RecordingAssetConflictResponseError,
  task: RecordingAssetTranscriptionTaskRecord,
): RecordingAssetTranscriptionJobV2 | null {
  const recoverable = task.status === 'pending'
    ? error.contractCode === 'transcription_already_running'
    : task.status === 'failed_retryable'
      ? error.contractCode === 'job_not_retryable'
      : false;
  if (!recoverable) return null;
  try {
    return parseRecordingAssetTranscriptionJobV2(error.remotePayload, {
      jobId: task.remoteJobId ?? undefined,
      remoteAssetId: task.remoteRecordingAssetId,
    });
  } catch {
    return null;
  }
}

async function processTask(
  task: RecordingAssetTranscriptionTaskRecord,
  input: DrainMeetingRecordingTranscriptionInput,
): Promise<{ completedRemoteMeetingId: string | null; processed: boolean }> {
  if (task.status === 'completed') {
    return { completedRemoteMeetingId: task.remoteMeetingId, processed: false };
  }
  try {
    let job: RecordingAssetTranscriptionJobV2;
    if (task.status === 'pending') {
      job = await createRecordingAssetTranscriptionV2({
        accessToken: input.accessToken,
        remoteAssetId: task.remoteRecordingAssetId,
        clientRequestId: task.clientRequestId,
        idempotencyKey: task.idempotencyKey,
        language: task.language,
        signal: input.signal,
      });
    } else if (task.status === 'failed_retryable') {
      if (!task.remoteJobId) throw new Error('录音转写重试缺少云端任务标识');
      job = await retryRecordingProcessingJobV2({
        accessToken: input.accessToken,
        jobId: task.remoteJobId,
        idempotencyKey: retryIdempotencyKey(task),
        signal: input.signal,
      });
    } else {
      if (!task.remoteJobId) throw new Error('录音转写轮询缺少云端任务标识');
      job = await getRecordingProcessingJobV2({
        accessToken: input.accessToken,
        jobId: task.remoteJobId,
        waitMs: 5_000,
        signal: input.signal,
      });
    }
    if (!input.isCurrent() || input.signal.aborted) return { completedRemoteMeetingId: null, processed: false };
    await applyJob(task, job, Date.now());
    return {
      completedRemoteMeetingId: job.status === 'completed' ? task.remoteMeetingId : null,
      processed: true,
    };
  } catch (error) {
    if (!input.isCurrent() || input.signal.aborted || (error as Error)?.name === 'AbortError') {
      return { completedRemoteMeetingId: null, processed: false };
    }
    if (error instanceof RecordingAssetConflictResponseError) {
      const recovered = recoverConflictJob(error, task);
      if (recovered) {
        await applyJob(task, recovered, Date.now());
        return {
          completedRemoteMeetingId: recovered.status === 'completed' ? task.remoteMeetingId : null,
          processed: true,
        };
      }
    }
    const nowMs = Date.now();
    const permanentHttp = error instanceof HttpResponseError
      && error.status !== 401
      && !transientHttpStatus(error.status);
    const blocked = permanentHttp
      || error instanceof RecordingAssetConflictResponseError
      || responseLooksInvalid(error)
      || /缺少云端任务标识/.test(error instanceof Error ? error.message : '');
    const delayMs = error instanceof HttpResponseError && error.status === 401
      ? AUTH_RECHECK_MS
      : transportRetryDelayMs(task);
    await sqliteMeetingNoteRepository.recordRecordingAssetTranscriptionTransportFailure({
      taskId: task.id,
      scopeKey: task.scopeKey,
      disposition: blocked ? 'blocked' : 'retry',
      errorCode: blocked ? 'recording_transcription_contract_rejected' : transportErrorCode(error),
      nextAttemptAtMs: blocked ? null : nowMs + delayMs,
      failedAtMs: nowMs,
    });
    diagnosticWarn('[recording-transcription] task request failed', error);
    return { completedRemoteMeetingId: null, processed: true };
  }
}

async function discoverMeeting(
  meeting: RecordingTranscriptionDiscoveryMeeting,
  input: DrainMeetingRecordingTranscriptionInput,
): Promise<number> {
  const result = await discoverMeetingRecordingTranscriptionTasks({
    scopeKey: input.scopeKey,
    accessToken: input.accessToken,
    meeting,
    signal: input.signal,
  });
  return result.changedCount;
}

export async function discoverMeetingRecordingTranscriptionTasks(input: {
  scopeKey: Exclude<ScopeKey, 'guest'>;
  accessToken: string;
  meeting: RecordingTranscriptionDiscoveryMeeting;
  signal?: AbortSignal;
}): Promise<DiscoverMeetingRecordingTranscriptionResult> {
  const canonicalMeetingId = await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(
    input.meeting.meetingId,
    input.scopeKey,
  );
  if (!canonicalMeetingId) return { changedCount: 0, uploadedAssets: [] };
  const remoteAssets = await listRecordingAssetsV2({
    accessToken: input.accessToken,
    meetingRemoteId: input.meeting.remoteMeetingId,
    signal: input.signal,
  });
  if (input.signal?.aborted) return { changedCount: 0, uploadedAssets: [] };
  const uploaded = remoteAssets.filter(asset => asset.uploadState === 'uploaded');
  const changed = await sqliteMeetingNoteRepository.discoverRecordingAssetTranscriptionTasks({
    meetingId: canonicalMeetingId,
    remoteMeetingId: input.meeting.remoteMeetingId,
    scopeKey: input.scopeKey,
    assets: uploaded.map(asset => ({
      taskId: taskId(input.scopeKey, asset.remoteId),
      clientRecordingAssetId: asset.clientAssetId,
      remoteRecordingAssetId: asset.remoteId,
      clientRequestId: clientRequestId(asset.remoteId),
      idempotencyKey: idempotencyKey(asset.remoteId),
      language: 'zh',
    })),
    discoveredAtMs: Date.now(),
  });
  diagnosticAudit('recording_asset_transcription_discovery', {
    status: 'completed',
    assets: uploaded.length,
    changed,
  });
  return { changedCount: changed, uploadedAssets: uploaded };
}

export async function drainMeetingRecordingTranscription(
  input: DrainMeetingRecordingTranscriptionInput,
): Promise<DrainMeetingRecordingTranscriptionResult> {
  let discoveredCount = 0;
  for (const meeting of input.discoveryMeetings) {
    if (!input.isCurrent() || input.signal.aborted) break;
    try {
      discoveredCount += await discoverMeeting(meeting, input);
    } catch (error) {
      if (!input.isCurrent() || input.signal.aborted || (error as Error)?.name === 'AbortError') break;
      diagnosticWarn('[recording-transcription] discovery failed', error);
    }
  }

  const nowMs = Date.now();
  const tasks = await sqliteMeetingNoteRepository.listRunnableRecordingAssetTranscriptionTasks(
    input.scopeKey,
    nowMs,
    MAX_TASKS_PER_DRAIN,
  );
  const results = await Promise.all(tasks.map(task => processTask(task, input)));
  const readyContents = await sqliteMeetingNoteRepository.listReadyRecordingAssetTranscriptContent(
    input.scopeKey,
  );
  const nextAttemptAtMs = await sqliteMeetingNoteRepository.getNextRecordingAssetTranscriptionAttemptAt(
    input.scopeKey,
    Date.now(),
  );
  return {
    processedCount: results.filter(result => result.processed).length,
    discoveredCount,
    readyContents,
    retryAfterMs: nextAttemptAtMs === null
      ? null
      : Math.max(1_000, nextAttemptAtMs - Date.now()),
  };
}
