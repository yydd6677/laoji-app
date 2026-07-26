import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  RecordingAssetTranscriptionJobV2,
  RecordingAssetV2Registration,
  RemoteRecordingAssetV2,
} from './contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function nullableIdentifier(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : identifier(value, label, maximum);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function serverTime(value: unknown, label: string): number {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  ) throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function checksum(value: unknown): string | null {
  if (value === null) return null;
  const normalized = identifier(value, '录音校验值', 71).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error('录音校验值无效');
  return normalized;
}

function absoluteContentUrl(value: unknown, remoteId: string): string | null {
  if (value === null) return null;
  const raw = identifier(value, '录音下载地址', 4_096);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  let resolved: URL;
  let configured: URL;
  try {
    configured = new URL(base);
    resolved = new URL(raw, `${base}/`);
  } catch {
    throw new Error('录音下载地址无效');
  }
  const expectedPath = `/api/laoji/v2/recording-assets/${encodeURIComponent(remoteId)}/content`;
  if (
    resolved.origin !== configured.origin
    || resolved.username
    || resolved.password
    || resolved.pathname !== expectedPath
    || resolved.hash
  ) throw new Error('录音下载地址无效');
  return resolved.toString();
}

export function parseRemoteRecordingAssetV2(
  value: unknown,
  expected: { meetingRemoteId?: string; clientAssetId?: string; remoteId?: string } = {},
): RemoteRecordingAssetV2 {
  if (!isRecord(value) || value.schema_version !== 2) throw new Error('录音资产同步响应格式无效');
  const remoteId = identifier(value.id, '录音资产云端标识', 160);
  const meetingRemoteId = identifier(value.meeting_id, '录音资产会议标识', 160);
  const clientAssetId = identifier(value.client_asset_id, '录音资产本机标识');
  if (expected.remoteId && remoteId !== expected.remoteId) throw new Error('录音资产云端标识发生变化');
  if (expected.meetingRemoteId && meetingRemoteId !== expected.meetingRemoteId) {
    throw new Error('录音资产不属于当前会议');
  }
  if (expected.clientAssetId && clientAssetId !== expected.clientAssetId) {
    throw new Error('录音资产本机标识发生变化');
  }
  const role = value.role;
  if (role !== 'primary' && role !== 'secondary') throw new Error('录音资产角色无效');
  const origin = value.origin;
  if (origin !== 'captured' && origin !== 'imported' && origin !== 'recovered') {
    throw new Error('录音资产来源无效');
  }
  const uploadState = value.upload_state;
  if (uploadState !== 'registered' && uploadState !== 'uploaded') throw new Error('录音上传状态无效');
  if (typeof value.requires_auth !== 'boolean' || value.requires_auth !== true) {
    throw new Error('录音下载鉴权状态无效');
  }
  const revision = safeInteger(value.revision, '录音资产版本', 1);
  const contentUrl = absoluteContentUrl(value.content_url, remoteId);
  if ((uploadState === 'uploaded') !== (contentUrl !== null)) throw new Error('录音内容状态不完整');
  const serverCreatedAtMs = serverTime(value.created_at, '录音资产创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '录音资产更新时间');
  if (serverCreatedAtMs > serverUpdatedAtMs) throw new Error('录音资产时间顺序无效');
  return {
    remoteId,
    meetingRemoteId,
    clientAssetId,
    revision,
    role,
    origin,
    uploadState,
    mimeType: identifier(value.mime_type, '录音格式', 160).toLowerCase(),
    fileName: identifier(value.file_name, '录音文件名', 255),
    byteSize: nullableInteger(value.byte_size, '录音文件大小'),
    durationMs: nullableInteger(value.duration_ms, '录音时长'),
    checksumSha256: checksum(value.checksum_sha256),
    contentUrl,
    requiresAuth: true,
    serverCreatedAtMs,
    serverUpdatedAtMs,
  };
}

function responseRevision(value: unknown, response: Response): number | null {
  if (isRecord(value) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1) {
    return Number(value.revision);
  }
  if (isRecord(value) && isRecord(value.current) && Number.isSafeInteger(value.current.revision)) {
    return Number(value.current.revision);
  }
  const raw = response.headers?.get?.('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function conflictCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string') return null;
  const normalized = value.error.code.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export class RecordingAssetConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('录音资产云端状态已变化', status);
    this.name = 'RecordingAssetConflictResponseError';
  }
}

async function readAssetResponse(
  response: Response,
  accessToken: string,
  expected: { meetingRemoteId?: string; clientAssetId?: string; remoteId?: string },
): Promise<RemoteRecordingAssetV2> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new RecordingAssetConflictResponseError(
      response.status,
      responseRevision(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current') ? data.current : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('录音资产同步失败', response, { unauthorizedToken: accessToken });
  }
  return parseRemoteRecordingAssetV2(await readResponseData(response), expected);
}

export async function registerRecordingAssetV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  registration: RecordingAssetV2Registration;
  signal?: AbortSignal;
}): Promise<RemoteRecordingAssetV2> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/recording-assets`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '录音资产请求标识'),
      },
      body: JSON.stringify(input.registration),
    },
  );
  return readAssetResponse(response, input.accessToken, {
    meetingRemoteId,
    clientAssetId: input.registration.client_asset_id,
  });
}

export async function uploadRecordingAssetContentV2(input: {
  accessToken: string;
  remoteAsset: RemoteRecordingAssetV2;
  idempotencyKey: string;
  audioUri: string;
  fileName?: string;
  mimeType?: string;
  signal?: AbortSignal;
}): Promise<RemoteRecordingAssetV2> {
  if (input.remoteAsset.uploadState === 'uploaded') return input.remoteAsset;
  const form = new FormData();
  form.append('file', {
    uri: input.audioUri,
    name: input.fileName ?? input.remoteAsset.fileName,
    type: input.mimeType ?? input.remoteAsset.mimeType,
  } as any);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/recording-assets/${encodeURIComponent(input.remoteAsset.remoteId)}/content`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '录音内容请求标识'),
        'If-Match': `"${input.remoteAsset.revision}"`,
      },
      body: form,
    },
    180_000,
  );
  return readAssetResponse(response, input.accessToken, {
    remoteId: input.remoteAsset.remoteId,
    meetingRemoteId: input.remoteAsset.meetingRemoteId,
    clientAssetId: input.remoteAsset.clientAssetId,
  });
}

export async function uploadRecordingAssetV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  registerIdempotencyKey: string;
  contentIdempotencyKey: string;
  registration: RecordingAssetV2Registration;
  audioUri: string;
  signal?: AbortSignal;
}): Promise<RemoteRecordingAssetV2> {
  const registered = await registerRecordingAssetV2({
    accessToken: input.accessToken,
    meetingRemoteId: input.meetingRemoteId,
    idempotencyKey: input.registerIdempotencyKey,
    registration: input.registration,
    signal: input.signal,
  });
  return uploadRecordingAssetContentV2({
    accessToken: input.accessToken,
    remoteAsset: registered,
    idempotencyKey: input.contentIdempotencyKey,
    audioUri: input.audioUri,
    fileName: input.registration.file_name,
    mimeType: input.registration.mime_type,
    signal: input.signal,
  });
}

export async function listRecordingAssetsV2(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<readonly RemoteRecordingAssetV2[]> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/recording-assets`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('录音列表同步失败', response, { unauthorizedToken: input.accessToken });
  }
  const data = await readResponseData(response);
  if (!isRecord(data) || data.schema_version !== 2 || !Array.isArray(data.items)) {
    throw new Error('录音列表同步响应格式无效');
  }
  if (identifier(data.meeting_id, '录音列表会议标识', 160) !== meetingRemoteId) {
    throw new Error('录音列表不属于当前会议');
  }
  const items = data.items.map(item => parseRemoteRecordingAssetV2(item, { meetingRemoteId }));
  const remoteIds = new Set(items.map(item => item.remoteId));
  const clientIds = new Set(items.map(item => item.clientAssetId));
  if (remoteIds.size !== items.length || clientIds.size !== items.length) throw new Error('录音列表存在重复资产');
  return items;
}

export function parseRecordingAssetTranscriptionJobV2(
  value: unknown,
  expected: { jobId?: string; remoteAssetId?: string } = {},
): RecordingAssetTranscriptionJobV2 {
  if (!isRecord(value) || value.schema_version !== 2 || value.stage !== 'transcript') {
    throw new Error('录音转写任务响应格式无效');
  }
  const jobId = identifier(value.job_id, '录音转写任务标识', 160);
  const recordingAssetRemoteId = identifier(value.recording_asset_id, '录音资产云端标识', 160);
  if (expected.jobId && jobId !== expected.jobId) throw new Error('录音转写任务标识发生变化');
  if (expected.remoteAssetId && recordingAssetRemoteId !== expected.remoteAssetId) {
    throw new Error('录音转写任务资产标识发生变化');
  }
  const status = value.status;
  if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed') {
    throw new Error('录音转写任务状态无效');
  }
  const progress = value.progress === null ? null : Number(value.progress);
  if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1)) {
    throw new Error('录音转写任务进度无效');
  }
  if (typeof value.retryable !== 'boolean') throw new Error('录音转写任务重试状态无效');
  const resultRevisionId = nullableIdentifier(value.result_revision_id, '录音转写结果版本', 512);
  if ((status === 'completed') !== (resultRevisionId !== null)) {
    throw new Error('录音转写任务结果版本不完整');
  }
  if (status !== 'failed' && value.retryable) throw new Error('录音转写任务重试状态无效');
  return {
    jobId,
    meetingRemoteId: identifier(value.meeting_id, '录音转写会议标识', 160),
    recordingAssetRemoteId,
    stage: 'transcript',
    status,
    attempt: safeInteger(value.attempt, '录音转写次数'),
    progress,
    errorCode: nullableIdentifier(value.error_code, '录音转写错误', 160),
    retryable: value.retryable,
    resultRevisionId,
    serverCreatedAtMs: serverTime(value.created_at, '录音转写任务创建时间'),
    serverUpdatedAtMs: serverTime(value.updated_at, '录音转写任务更新时间'),
  };
}

async function readJobResponse(
  response: Response,
  accessToken: string,
  expected: { jobId?: string; remoteAssetId?: string },
): Promise<RecordingAssetTranscriptionJobV2> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new RecordingAssetConflictResponseError(
      response.status,
      responseRevision(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current') ? data.current : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('录音转写任务请求失败', response, { unauthorizedToken: accessToken });
  }
  return parseRecordingAssetTranscriptionJobV2(await readResponseData(response), expected);
}

export async function createRecordingAssetTranscriptionV2(input: {
  accessToken: string;
  remoteAssetId: string;
  clientRequestId: string;
  idempotencyKey: string;
  language?: 'zh' | 'en' | 'auto';
  signal?: AbortSignal;
}): Promise<RecordingAssetTranscriptionJobV2> {
  const remoteAssetId = identifier(input.remoteAssetId, '录音资产云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/recording-assets/${encodeURIComponent(remoteAssetId)}/transcriptions`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '录音转写请求标识'),
      },
      body: JSON.stringify({
        schema_version: 2,
        client_request_id: identifier(input.clientRequestId, '录音转写本机请求标识'),
        language: input.language ?? 'zh',
      }),
    },
  );
  return readJobResponse(response, input.accessToken, { remoteAssetId });
}

export async function getRecordingProcessingJobV2(input: {
  accessToken: string;
  jobId: string;
  waitMs?: number;
  signal?: AbortSignal;
}): Promise<RecordingAssetTranscriptionJobV2> {
  const jobId = identifier(input.jobId, '录音转写任务标识', 160);
  const waitMs = Math.max(0, Math.min(5_000, Math.trunc(input.waitMs ?? 0)));
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/processing-jobs/${encodeURIComponent(jobId)}?wait_ms=${waitMs}`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  return readJobResponse(response, input.accessToken, { jobId });
}

export async function retryRecordingProcessingJobV2(input: {
  accessToken: string;
  jobId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RecordingAssetTranscriptionJobV2> {
  const jobId = identifier(input.jobId, '录音转写任务标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/processing-jobs/${encodeURIComponent(jobId)}/retry`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '录音转写重试标识'),
      },
    },
  );
  return readJobResponse(response, input.accessToken, { jobId });
}
