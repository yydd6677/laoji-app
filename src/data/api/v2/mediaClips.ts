import { getApiConfig } from '../../../services/config';
import { readResponseData, readResponseError } from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type { RemoteMediaClipJobV1 } from './contracts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function serverTime(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function contentUrl(value: unknown, jobId: string): string | null {
  if (value === null) return null;
  const path = identifier(value, '片段下载地址', 2_048);
  const expected = `/api/laoji/v2/media-clip-jobs/${encodeURIComponent(jobId)}/content`;
  if (path !== expected) throw new Error('片段下载地址无效');
  return `${getApiConfig().apiBase.replace(/\/+$/, '')}${path}`;
}

export function parseRemoteMediaClipJobV1(
  value: unknown,
  expected: { jobId?: string; remoteAssetId?: string; clientClipId?: string } = {},
): RemoteMediaClipJobV1 {
  const data = record(value);
  if (!data || data.schema_version !== 1 || data.stage !== 'media_clip' || data.requires_auth !== true) {
    throw new Error('音频片段任务响应格式无效');
  }
  const jobId = identifier(data.job_id, '片段任务标识', 160);
  const recordingAssetRemoteId = identifier(data.recording_asset_id, '录音资产云端标识', 160);
  const clientClipId = identifier(data.client_clip_id, '本机片段标识');
  if (expected.jobId && jobId !== expected.jobId) throw new Error('片段任务标识发生变化');
  if (expected.remoteAssetId && recordingAssetRemoteId !== expected.remoteAssetId) {
    throw new Error('片段任务录音身份发生变化');
  }
  if (expected.clientClipId && clientClipId !== expected.clientClipId) {
    throw new Error('片段任务本机身份发生变化');
  }
  const status = data.status;
  if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed') {
    throw new Error('音频片段任务状态无效');
  }
  const progress = data.progress === null ? null : Number(data.progress);
  if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1)) {
    throw new Error('音频片段任务进度无效');
  }
  if (typeof data.retryable !== 'boolean') throw new Error('音频片段重试状态无效');
  const mimeType = data.mime_type === null ? null : data.mime_type;
  if (mimeType !== null && mimeType !== 'audio/wav') throw new Error('音频片段格式无效');
  const fileName = nullableIdentifier(data.file_name, '音频片段文件名', 255);
  const byteSize = data.byte_size === null ? null : integer(data.byte_size, '音频片段大小', 45);
  const checksumSha256 = nullableIdentifier(data.checksum_sha256, '音频片段校验值', 71)?.toLowerCase() ?? null;
  if (checksumSha256 !== null && !/^sha256:[0-9a-f]{64}$/.test(checksumSha256)) {
    throw new Error('音频片段校验值无效');
  }
  const resolvedContentUrl = contentUrl(data.content_url, jobId);
  const completed = status === 'completed';
  if (completed !== Boolean(mimeType && fileName && byteSize && checksumSha256 && resolvedContentUrl)) {
    throw new Error('音频片段任务结果不完整');
  }
  if (status !== 'failed' && data.retryable) throw new Error('音频片段重试状态无效');
  const startMs = integer(data.start_ms, '片段开始时间');
  const endMs = integer(data.end_ms, '片段结束时间', 1);
  if (endMs <= startMs) throw new Error('音频片段时间范围无效');
  return {
    jobId,
    meetingRemoteId: identifier(data.meeting_id, '片段会议标识', 160),
    recordingAssetRemoteId,
    clientClipId,
    revision: integer(data.revision, '片段任务版本', 1),
    stage: 'media_clip',
    status,
    attempt: integer(data.attempt, '片段任务次数'),
    progress,
    startMs,
    endMs,
    errorCode: nullableIdentifier(data.error_code, '片段任务错误', 160),
    retryable: data.retryable,
    mimeType: mimeType as 'audio/wav' | null,
    fileName,
    byteSize,
    checksumSha256,
    contentUrl: resolvedContentUrl,
    requiresAuth: true,
    serverCreatedAtMs: serverTime(data.created_at, '片段任务创建时间'),
    serverUpdatedAtMs: serverTime(data.updated_at, '片段任务更新时间'),
  };
}

async function readJobResponse(
  response: Response,
  accessToken: string,
  expected: Parameters<typeof parseRemoteMediaClipJobV1>[1],
): Promise<RemoteMediaClipJobV1> {
  if (!response.ok) {
    throw await readResponseError('音频片段任务请求失败', response, { unauthorizedToken: accessToken });
  }
  return parseRemoteMediaClipJobV1(await readResponseData(response), expected);
}

export async function createRemoteMediaClipJobV1(input: {
  accessToken: string;
  remoteAssetId: string;
  clientClipId: string;
  idempotencyKey: string;
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
}): Promise<RemoteMediaClipJobV1> {
  const remoteAssetId = identifier(input.remoteAssetId, '录音资产云端标识', 160);
  const clientClipId = identifier(input.clientClipId, '本机片段标识');
  const response = await fetchWithTimeout(
    `${getApiConfig().apiBase.replace(/\/+$/, '')}/api/laoji/v2/recording-assets/${encodeURIComponent(remoteAssetId)}/media-clips`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '片段请求标识'),
      },
      body: JSON.stringify({
        schema_version: 1,
        client_clip_id: clientClipId,
        start_ms: integer(input.startMs, '片段开始时间'),
        end_ms: integer(input.endMs, '片段结束时间', 1),
      }),
    },
  );
  return readJobResponse(response, input.accessToken, { remoteAssetId, clientClipId });
}

export async function getRemoteMediaClipJobV1(input: {
  accessToken: string;
  jobId: string;
  waitMs?: number;
  signal?: AbortSignal;
}): Promise<RemoteMediaClipJobV1> {
  const jobId = identifier(input.jobId, '片段任务标识', 160);
  const waitMs = Math.max(0, Math.min(5_000, Math.trunc(input.waitMs ?? 0)));
  const response = await fetchWithTimeout(
    `${getApiConfig().apiBase.replace(/\/+$/, '')}/api/laoji/v2/media-clip-jobs/${encodeURIComponent(jobId)}?wait_ms=${waitMs}`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  return readJobResponse(response, input.accessToken, { jobId });
}

export async function retryRemoteMediaClipJobV1(input: {
  accessToken: string;
  jobId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMediaClipJobV1> {
  const jobId = identifier(input.jobId, '片段任务标识', 160);
  const response = await fetchWithTimeout(
    `${getApiConfig().apiBase.replace(/\/+$/, '')}/api/laoji/v2/media-clip-jobs/${encodeURIComponent(jobId)}/retry`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '片段重试标识'),
      },
    },
  );
  return readJobResponse(response, input.accessToken, { jobId });
}

export async function deleteRemoteMediaClipJobV1(input: {
  accessToken: string;
  jobId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const jobId = identifier(input.jobId, '片段任务标识', 160);
  const response = await fetchWithTimeout(
    `${getApiConfig().apiBase.replace(/\/+$/, '')}/api/laoji/v2/media-clip-jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'DELETE',
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (response.status === 404) return;
  if (!response.ok) {
    throw await readResponseError('音频片段删除失败', response, { unauthorizedToken: input.accessToken });
  }
}
