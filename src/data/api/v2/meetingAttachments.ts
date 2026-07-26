import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  MeetingAttachmentV1Registration,
  RemoteMeetingAttachmentV1,
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

function nullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || /\u0000/.test(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function checksum(value: unknown, required: boolean): string | null {
  if (value === null && !required) return null;
  const normalized = identifier(value, '附件校验值', 71).toLocaleLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error('附件校验值无效');
  return normalized;
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

function nullableServerTime(value: unknown, label: string): number | null {
  return value === null ? null : serverTime(value, label);
}

function absoluteContentUrl(value: unknown, remoteId: string): string | null {
  if (value === null) return null;
  const raw = identifier(value, '附件下载地址', 4_096);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  let configured: URL;
  let resolved: URL;
  try {
    configured = new URL(base);
    resolved = new URL(raw, `${base}/`);
  } catch {
    throw new Error('附件下载地址无效');
  }
  const expectedPath = `/api/laoji/v1/meeting-attachments/${encodeURIComponent(remoteId)}/content`;
  if (
    resolved.origin !== configured.origin
    || resolved.username
    || resolved.password
    || resolved.pathname !== expectedPath
    || resolved.hash
  ) throw new Error('附件下载地址无效');
  return resolved.toString();
}

export function parseRemoteMeetingAttachmentV1(
  value: unknown,
  expected: { meetingRemoteId?: string; clientAttachmentId?: string; remoteId?: string } = {},
): RemoteMeetingAttachmentV1 {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error('附件同步响应格式无效');
  const remoteId = identifier(value.id, '附件云端标识', 160);
  const meetingRemoteId = identifier(value.meeting_id, '附件会议标识', 160);
  const clientAttachmentId = identifier(value.client_attachment_id, '附件本机标识');
  if (expected.remoteId && expected.remoteId !== remoteId) throw new Error('附件云端标识发生变化');
  if (expected.meetingRemoteId && expected.meetingRemoteId !== meetingRemoteId) {
    throw new Error('附件不属于当前会议');
  }
  if (expected.clientAttachmentId && expected.clientAttachmentId !== clientAttachmentId) {
    throw new Error('附件本机标识发生变化');
  }
  const revision = safeInteger(value.revision, '附件版本', 1);
  const lifecycle = value.lifecycle;
  if (lifecycle !== 'registered' && lifecycle !== 'ready' && lifecycle !== 'deleted') {
    throw new Error('附件云端状态无效');
  }
  const kind = value.kind;
  if (kind !== 'text' && kind !== 'image') throw new Error('附件类型无效');
  if (value.requires_auth !== true) throw new Error('附件下载鉴权状态无效');
  const textContent = nullableText(value.text_content, '附件文字', 500);
  const mimeType = value.mime_type === null ? null : identifier(value.mime_type, '附件格式', 160).toLocaleLowerCase();
  const fileName = value.file_name === null ? null : identifier(value.file_name, '附件文件名', 255);
  const byteSize = nullableInteger(value.byte_size, '附件文件大小');
  const checksumSha256 = checksum(value.checksum_sha256, kind === 'image' && lifecycle === 'ready');
  const contentUrl = absoluteContentUrl(value.content_url, remoteId);
  if (kind === 'text') {
    if (!textContent?.trim() || mimeType !== null || fileName !== null || byteSize !== null || checksumSha256 !== null || contentUrl !== null || lifecycle === 'registered') {
      throw new Error('文字附件云端内容无效');
    }
  } else if (
    textContent !== null
    || !mimeType?.startsWith('image/')
    || !fileName
    || byteSize === null
    || byteSize < 1
    || ((lifecycle === 'ready') !== (contentUrl !== null))
    || (lifecycle === 'deleted' && contentUrl !== null)
  ) throw new Error('照片附件云端内容无效');
  const clientCreatedAtMs = safeInteger(value.client_created_at_ms, '附件本机创建时间');
  const clientUpdatedAtMs = safeInteger(value.client_updated_at_ms, '附件本机更新时间');
  const serverCreatedAtMs = serverTime(value.created_at, '附件创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '附件更新时间');
  const serverDeletedAtMs = nullableServerTime(value.deleted_at, '附件删除时间');
  if ((lifecycle === 'deleted') !== (serverDeletedAtMs !== null)) throw new Error('附件删除状态无效');
  return {
    remoteId,
    meetingRemoteId,
    clientAttachmentId,
    revision,
    lifecycle,
    positionMs: safeInteger(value.position_ms, '附件时间点'),
    kind,
    textContent,
    mimeType,
    fileName,
    byteSize,
    checksumSha256,
    contentUrl,
    requiresAuth: true,
    clientCreatedAtMs,
    clientUpdatedAtMs,
    serverCreatedAtMs,
    serverUpdatedAtMs,
    serverDeletedAtMs,
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

export class MeetingAttachmentConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('附件云端状态已变化', status);
    this.name = 'MeetingAttachmentConflictResponseError';
  }
}

async function readAttachmentResponse(
  response: Response,
  accessToken: string,
  expected: { meetingRemoteId?: string; clientAttachmentId?: string; remoteId?: string },
): Promise<RemoteMeetingAttachmentV1> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new MeetingAttachmentConflictResponseError(
      response.status,
      responseRevision(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current') ? data.current : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('附件同步失败', response, { unauthorizedToken: accessToken });
  }
  return parseRemoteMeetingAttachmentV1(await readResponseData(response), expected);
}

export async function registerMeetingAttachmentV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  registration: MeetingAttachmentV1Registration;
  signal?: AbortSignal;
}): Promise<RemoteMeetingAttachmentV1> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/attachments`,
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '附件请求标识'),
      },
      body: JSON.stringify(input.registration),
    },
  );
  return readAttachmentResponse(response, input.accessToken, {
    meetingRemoteId,
    clientAttachmentId: input.registration.client_attachment_id,
  });
}

export async function uploadMeetingAttachmentContentV1(input: {
  accessToken: string;
  remoteAttachment: RemoteMeetingAttachmentV1;
  idempotencyKey: string;
  localUri: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingAttachmentV1> {
  if (input.remoteAttachment.kind !== 'image') throw new Error('文字附件不需要上传文件');
  if (input.remoteAttachment.lifecycle === 'ready') return input.remoteAttachment;
  if (input.remoteAttachment.lifecycle !== 'registered') throw new Error('照片附件当前不能上传');
  const form = new FormData();
  form.append('file', {
    uri: input.localUri,
    name: input.remoteAttachment.fileName!,
    type: input.remoteAttachment.mimeType!,
  } as any);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-attachments/${encodeURIComponent(input.remoteAttachment.remoteId)}/content`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '附件内容请求标识'),
        'If-Match': `"${input.remoteAttachment.revision}"`,
      },
      body: form,
    },
    180_000,
  );
  return readAttachmentResponse(response, input.accessToken, {
    remoteId: input.remoteAttachment.remoteId,
    meetingRemoteId: input.remoteAttachment.meetingRemoteId,
    clientAttachmentId: input.remoteAttachment.clientAttachmentId,
  });
}

export async function deleteMeetingAttachmentV1(input: {
  accessToken: string;
  remoteAttachmentId: string;
  meetingRemoteId: string;
  clientAttachmentId: string;
  expectedRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingAttachmentV1> {
  const remoteAttachmentId = identifier(input.remoteAttachmentId, '附件云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-attachments/${encodeURIComponent(remoteAttachmentId)}`,
    {
      method: 'DELETE',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Idempotency-Key': identifier(input.idempotencyKey, '附件删除请求标识'),
        'If-Match': `"${safeInteger(input.expectedRevision, '附件版本', 1)}"`,
      },
    },
  );
  return readAttachmentResponse(response, input.accessToken, {
    remoteId: remoteAttachmentId,
    meetingRemoteId: input.meetingRemoteId,
    clientAttachmentId: input.clientAttachmentId,
  });
}

export async function listMeetingAttachmentsV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<readonly RemoteMeetingAttachmentV1[]> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/attachments`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('附件列表同步失败', response, { unauthorizedToken: input.accessToken });
  }
  const data = await readResponseData(response);
  if (!isRecord(data) || data.schema_version !== 1 || !Array.isArray(data.items)) {
    throw new Error('附件列表同步响应格式无效');
  }
  if (identifier(data.meeting_id, '附件列表会议标识', 160) !== meetingRemoteId) {
    throw new Error('附件列表不属于当前会议');
  }
  const items = data.items.map(item => parseRemoteMeetingAttachmentV1(item, { meetingRemoteId }));
  if (
    new Set(items.map(item => item.remoteId)).size !== items.length
    || new Set(items.map(item => item.clientAttachmentId)).size !== items.length
  ) throw new Error('附件列表存在重复项目');
  return items;
}
