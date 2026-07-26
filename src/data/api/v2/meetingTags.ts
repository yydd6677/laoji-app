import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  MeetingTagCatalogV1Mutation,
  RemoteMeetingTagCatalogV1,
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

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function tagName(value: unknown): { name: string; normalizedName: string } {
  if (typeof value !== 'string') throw new Error('标签名称无效');
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('标签名称无效');
  }
  return { name, normalizedName: name.toLocaleLowerCase() };
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

export function parseRemoteMeetingTagCatalogV1(value: unknown): RemoteMeetingTagCatalogV1 {
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.exists !== 'boolean') {
    throw new Error('标签同步响应格式无效');
  }
  const revision = safeInteger(value.revision, '标签云端版本');
  const clientUpdatedAtMs = safeInteger(value.client_updated_at_ms, '标签更新时间');
  if (!Array.isArray(value.tags) || value.tags.length > 100) throw new Error('标签列表无效');
  if (!Array.isArray(value.assignments) || value.assignments.length > 5_000) {
    throw new Error('标签分配列表无效');
  }
  const tagIds = new Set<string>();
  const normalizedNames = new Set<string>();
  const tags = value.tags.map(item => {
    if (!isRecord(item)) throw new Error('标签条目无效');
    const clientTagId = identifier(item.client_tag_id, '标签标识', 160);
    const normalized = tagName(item.name);
    const createdAtMs = safeInteger(item.created_at_ms, '标签创建时间');
    const updatedAtMs = safeInteger(item.updated_at_ms, '标签更新时间');
    if (updatedAtMs < createdAtMs || tagIds.has(clientTagId) || normalizedNames.has(normalized.normalizedName)) {
      throw new Error('标签条目重复或时间无效');
    }
    tagIds.add(clientTagId);
    normalizedNames.add(normalized.normalizedName);
    return { clientTagId, name: normalized.name, createdAtMs, updatedAtMs };
  }).sort((left, right) => left.clientTagId.localeCompare(right.clientTagId));
  const meetingIds = new Set<string>();
  const assignments = value.assignments.map(item => {
    if (!isRecord(item) || !Array.isArray(item.client_tag_ids) || item.client_tag_ids.length > 20) {
      throw new Error('标签分配条目无效');
    }
    const meetingRemoteId = identifier(item.meeting_remote_id, '标签会议标识', 160);
    const clientTagIds = item.client_tag_ids.map(id => identifier(id, '标签标识', 160));
    if (
      meetingIds.has(meetingRemoteId)
      || new Set(clientTagIds).size !== clientTagIds.length
      || clientTagIds.some(id => !tagIds.has(id))
    ) throw new Error('标签分配条目重复或引用无效');
    meetingIds.add(meetingRemoteId);
    return { meetingRemoteId, clientTagIds: [...clientTagIds].sort() };
  }).sort((left, right) => left.meetingRemoteId.localeCompare(right.meetingRemoteId));
  if (!value.exists) {
    if (
      revision !== 0 || clientUpdatedAtMs !== 0 || tags.length !== 0
      || assignments.length !== 0 || value.updated_at !== null
    ) throw new Error('标签云端缺失状态无效');
    return {
      exists: false,
      revision: 0,
      clientUpdatedAtMs: 0,
      tags: [],
      assignments: [],
      serverUpdatedAtMs: null,
    };
  }
  if (revision < 1) throw new Error('标签云端版本无效');
  return {
    exists: true,
    revision,
    clientUpdatedAtMs,
    tags,
    assignments,
    serverUpdatedAtMs: serverTime(value.updated_at, '标签云端更新时间'),
  };
}

function revisionFrom(value: unknown, response: Response): number | null {
  if (isRecord(value)) {
    const direct = value.revision;
    if (Number.isSafeInteger(direct) && Number(direct) >= 0) return Number(direct);
    if (isRecord(value.current) && Number.isSafeInteger(value.current.revision)) {
      return Number(value.current.revision);
    }
  }
  const raw = response.headers?.get?.('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function conflictPayload(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'current')
    ? value.current
    : value;
}

function conflictCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string') return null;
  const normalized = value.error.code.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export class MeetingTagCatalogConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('标签云端版本已变化', status);
    this.name = 'MeetingTagCatalogConflictResponseError';
  }
}

export async function getMeetingTagCatalogV1(input: {
  accessToken: string;
  signal?: AbortSignal;
}): Promise<RemoteMeetingTagCatalogV1> {
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(`${base}/api/laoji/v1/meeting-tags`, {
    signal: input.signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw await readResponseError('标签拉取失败', response, { unauthorizedToken: input.accessToken });
  }
  return parseRemoteMeetingTagCatalogV1(await readResponseData(response));
}

export async function replaceMeetingTagCatalogV1(input: {
  accessToken: string;
  idempotencyKey: string;
  mutation: MeetingTagCatalogV1Mutation;
  signal?: AbortSignal;
}): Promise<RemoteMeetingTagCatalogV1> {
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(`${base}/api/laoji/v1/meeting-tags`, {
    method: 'PUT',
    signal: input.signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': identifier(input.idempotencyKey, '请求标识'),
      ...(input.mutation.expected_remote_revision === null
        ? { 'If-None-Match': '*' }
        : { 'If-Match': `"${input.mutation.expected_remote_revision}"` }),
    },
    body: JSON.stringify({
      schema_version: 1,
      client_updated_at_ms: input.mutation.client_updated_at_ms,
      tags: input.mutation.tags,
      assignments: input.mutation.assignments,
    }),
  });
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new MeetingTagCatalogConflictResponseError(
      response.status,
      revisionFrom(data, response),
      conflictPayload(data),
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('标签同步失败', response, { unauthorizedToken: input.accessToken });
  }
  const result = parseRemoteMeetingTagCatalogV1(await readResponseData(response));
  if (!result.exists) throw new Error('标签同步响应缺少云端版本');
  return result;
}
