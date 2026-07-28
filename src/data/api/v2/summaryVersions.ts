import type { MeetingSummaryDocument } from '../../../domain/meeting';
import { normalizeMeetingSummaryDocument } from '../../../services/meetingSummaryDocument';
import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';

export interface RemoteSummarySectionStateV1 {
  meetingRemoteId: string;
  remoteVersionId: string;
  remoteSectionId: string;
  stableKey: string;
  ordinal: number;
  revision: number;
  userText: string | null;
  visibleCitationIds: readonly string[];
  clientUpdatedAtMs: number;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface RemoteSummaryVersionV1 {
  remoteId: string;
  meetingRemoteId: string;
  status: 'ready' | 'stale';
  templateId: string;
  templateRevision: number;
  document: MeetingSummaryDocument;
  sections: readonly RemoteSummarySectionStateV1[];
  serverCreatedAtMs: number;
  serverCompletedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface RemoteSummaryCurrentV1 {
  meetingRemoteId: string;
  remoteVersionId: string;
  revision: number;
  clientUpdatedAtMs: number;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface RemoteSummaryCatalogV1 {
  meetingRemoteId: string;
  current: RemoteSummaryCurrentV1 | null;
  versions: readonly RemoteSummaryVersionV1[];
}

export interface SummarySectionOverrideV1Mutation {
  schema_version: 1;
  user_text: string | null;
  visible_citation_ids: readonly string[];
  client_updated_at_ms: number;
}

export interface SummaryCurrentV1Mutation {
  schema_version: 1;
  version_id: string;
  client_updated_at_ms: number;
}

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

function serverTime(value: unknown, label: string): number {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  ) throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\u0000')) {
    throw new Error('整理内容人工修改无效');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function identifierList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}无效`);
  const values = value.map(item => identifier(item, label));
  if (new Set(values).size !== values.length) throw new Error(`${label}存在重复项`);
  return values;
}

function parseSectionState(
  value: unknown,
  expected: {
    meetingRemoteId: string;
    remoteVersionId: string;
    remoteSectionId: string;
    stableKey: string;
    generatedCitationIds: readonly string[];
    ordinal: number;
  },
): RemoteSummarySectionStateV1 {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error('整理内容同步响应格式无效');
  const meetingRemoteId = identifier(value.meeting_id, '整理内容会议标识', 160);
  const remoteVersionId = identifier(value.version_id, '整理结果云端标识', 160);
  const remoteSectionId = identifier(value.section_id, '整理内容云端标识');
  const stableKey = identifier(value.stable_key, '整理内容稳定标识', 160);
  const ordinal = safeInteger(value.ordinal, '整理内容顺序');
  if (
    meetingRemoteId !== expected.meetingRemoteId
    || remoteVersionId !== expected.remoteVersionId
    || remoteSectionId !== expected.remoteSectionId
    || stableKey !== expected.stableKey
    || ordinal !== expected.ordinal
  ) throw new Error('整理内容同步身份发生变化');
  const visibleCitationIds = identifierList(value.visible_citation_ids, '整理结果引用标识');
  if (visibleCitationIds.some(id => !expected.generatedCitationIds.includes(id))) {
    throw new Error('整理结果引用不属于当前内容');
  }
  return {
    meetingRemoteId,
    remoteVersionId,
    remoteSectionId,
    stableKey,
    ordinal,
    revision: safeInteger(value.revision, '整理内容云端版本', 1),
    userText: nullableText(value.user_text),
    visibleCitationIds,
    clientUpdatedAtMs: safeInteger(value.client_updated_at_ms, '整理内容更新时间'),
    serverCreatedAtMs: serverTime(value.created_at, '整理内容云端创建时间'),
    serverUpdatedAtMs: serverTime(value.updated_at, '整理内容云端更新时间'),
  };
}

function parseVersion(value: unknown, expectedMeetingRemoteId: string): RemoteSummaryVersionV1 {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.sections)) {
    throw new Error('整理结果版本响应格式无效');
  }
  const remoteId = identifier(value.id, '整理结果云端标识', 160);
  const meetingRemoteId = identifier(value.meeting_id, '整理结果会议标识', 160);
  if (meetingRemoteId !== expectedMeetingRemoteId) throw new Error('整理结果版本不属于当前会议');
  const status = value.status;
  if (status !== 'ready' && status !== 'stale') throw new Error('整理结果云端状态无效');
  const document = normalizeMeetingSummaryDocument(meetingRemoteId, value.document);
  if (!document || document.remoteVersionId !== remoteId) throw new Error('整理结果生成内容无效');
  const sections = value.sections.map((item, ordinal) => {
    const generated = document.sections[ordinal];
    if (!generated) throw new Error('整理结果 section 数量不一致');
    return parseSectionState(item, {
      meetingRemoteId,
      remoteVersionId: remoteId,
      remoteSectionId: generated.id,
      stableKey: generated.stableKey,
      generatedCitationIds: generated.citations.map(citation => citation.id),
      ordinal,
    });
  });
  if (sections.length !== document.sections.length) throw new Error('整理结果 section 数量不一致');
  if (new Set(sections.map(section => section.remoteSectionId)).size !== sections.length) {
    throw new Error('整理结果 section 身份重复');
  }
  const templateId = identifier(value.template_id, '整理模板标识', 80);
  const templateRevision = safeInteger(value.template_revision, '整理模板版本', 1);
  if (templateId !== document.templateId || templateRevision !== document.templateRevision) {
    throw new Error('整理结果模板身份不一致');
  }
  return {
    remoteId,
    meetingRemoteId,
    status,
    templateId,
    templateRevision,
    document: { ...document, status },
    sections,
    serverCreatedAtMs: serverTime(value.created_at, '整理结果创建时间'),
    serverCompletedAtMs: serverTime(value.completed_at, '整理结果完成时间'),
    serverUpdatedAtMs: serverTime(value.updated_at, '整理结果更新时间'),
  };
}

export function parseRemoteSummaryCurrentV1(
  value: unknown,
  expectedMeetingRemoteId: string,
): RemoteSummaryCurrentV1 {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error('当前整理结果响应格式无效');
  const meetingRemoteId = identifier(value.meeting_id, '当前整理结果会议标识', 160);
  if (meetingRemoteId !== expectedMeetingRemoteId) throw new Error('当前整理结果不属于当前会议');
  return {
    meetingRemoteId,
    remoteVersionId: identifier(value.version_id, '当前整理结果云端标识', 160),
    revision: safeInteger(value.revision, '当前整理结果云端版本', 1),
    clientUpdatedAtMs: safeInteger(value.client_updated_at_ms, '当前整理结果更新时间'),
    serverCreatedAtMs: serverTime(value.created_at, '当前整理结果创建时间'),
    serverUpdatedAtMs: serverTime(value.updated_at, '当前整理结果云端更新时间'),
  };
}

export function parseRemoteSummaryCatalogV1(
  value: unknown,
  expectedMeetingRemoteId: string,
): RemoteSummaryCatalogV1 {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.items)) {
    throw new Error('整理结果版本目录响应格式无效');
  }
  const meetingRemoteId = identifier(value.meeting_id, '整理结果目录会议标识', 160);
  if (meetingRemoteId !== expectedMeetingRemoteId) throw new Error('整理结果目录不属于当前会议');
  const versions = value.items.map(item => parseVersion(item, meetingRemoteId));
  if (new Set(versions.map(version => version.remoteId)).size !== versions.length) {
    throw new Error('整理结果版本目录存在重复版本');
  }
  const current = value.current === null
    ? null
    : parseRemoteSummaryCurrentV1(value.current, meetingRemoteId);
  if (current && !versions.some(version => version.remoteId === current.remoteVersionId)) {
    throw new Error('当前整理结果不在版本目录中');
  }
  return { meetingRemoteId, current, versions };
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

export class SummarySyncConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('整理结果云端版本已变化', status);
    this.name = 'SummarySyncConflictResponseError';
  }
}

async function readMutationResponse(
  response: Response,
  accessToken: string,
): Promise<unknown> {
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new SummarySyncConflictResponseError(
      response.status,
      responseRevision(data, response),
      isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'current') ? data.current : data,
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('整理结果同步失败', response, { unauthorizedToken: accessToken });
  }
  return readResponseData(response);
}

export async function getMeetingSummaryCatalogV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  signal?: AbortSignal;
}): Promise<RemoteSummaryCatalogV1> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/summary-versions`,
    {
      signal: input.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!response.ok) {
    throw await readResponseError('整理结果版本同步失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  return parseRemoteSummaryCatalogV1(await readResponseData(response), meetingRemoteId);
}

export async function updateMeetingSummarySectionV1(input: {
  accessToken: string;
  remoteVersionId: string;
  remoteSectionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  mutation: SummarySectionOverrideV1Mutation;
  expectedMeetingRemoteId: string;
  expectedStableKey: string;
  expectedOrdinal: number;
  generatedCitationIds: readonly string[];
  signal?: AbortSignal;
}): Promise<RemoteSummarySectionStateV1> {
  const remoteVersionId = identifier(input.remoteVersionId, '整理结果云端标识', 160);
  const remoteSectionId = identifier(input.remoteSectionId, '整理内容云端标识');
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-summary-versions/${encodeURIComponent(remoteVersionId)}/sections/${encodeURIComponent(remoteSectionId)}`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '整理结果请求标识'),
        'If-Match': `"${safeInteger(input.expectedRevision, '整理内容云端版本', 1)}"`,
      },
      body: JSON.stringify(input.mutation),
    },
  );
  return parseSectionState(await readMutationResponse(response, input.accessToken), {
    meetingRemoteId: input.expectedMeetingRemoteId,
    remoteVersionId,
    remoteSectionId,
    stableKey: input.expectedStableKey,
    generatedCitationIds: input.generatedCitationIds,
    ordinal: input.expectedOrdinal,
  });
}

export async function selectMeetingSummaryCurrentV1(input: {
  accessToken: string;
  meetingRemoteId: string;
  expectedRevision: number;
  idempotencyKey: string;
  mutation: SummaryCurrentV1Mutation;
  signal?: AbortSignal;
}): Promise<RemoteSummaryCurrentV1> {
  const meetingRemoteId = identifier(input.meetingRemoteId, '会议云端标识', 160);
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v1/meeting-notes/${encodeURIComponent(meetingRemoteId)}/summary-current`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': identifier(input.idempotencyKey, '整理结果请求标识'),
        'If-Match': `"${safeInteger(input.expectedRevision, '当前整理结果云端版本', 1)}"`,
      },
      body: JSON.stringify(input.mutation),
    },
  );
  return parseRemoteSummaryCurrentV1(
    await readMutationResponse(response, input.accessToken),
    meetingRemoteId,
  );
}
