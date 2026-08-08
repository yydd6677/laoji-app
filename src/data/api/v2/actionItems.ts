import { getApiConfig } from '../../../services/config';
import {
  HttpResponseError,
  readResponseData,
  readResponseError,
} from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type {
  ActionItemV2Mutation,
  ActionItemV2Page,
  ActionItemV2Response,
  RemoteActionItemV2,
} from './contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function revisionFrom(value: unknown): number | null {
  const revision = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function revisionFromEtag(response: Response): number | null {
  const raw = response.headers?.get?.('ETag')?.trim();
  if (!raw) return null;
  return revisionFrom(raw.replace(/^W\//, '').replace(/^"|"$/g, ''));
}

function remoteRevision(data: unknown, response: Response): number | null {
  if (isRecord(data)) {
    const direct = revisionFrom(data.revision ?? data.remote_revision);
    if (direct !== null) return direct;
    const conflict = isRecord(data.conflict) ? data.conflict : null;
    const nested = revisionFrom(conflict?.remote_revision ?? conflict?.revision);
    if (nested !== null) return nested;
    const current = isRecord(data.current) ? data.current : null;
    const currentRevision = revisionFrom(current?.revision ?? current?.remote_revision);
    if (currentRevision !== null) return currentRevision;
  }
  return revisionFromEtag(response);
}

function conflictPayload(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (isRecord(data.remote_action)) return data.remote_action;
  if (isRecord(data.current)) return data.current;
  if (isRecord(data.conflict)) {
    const conflict = data.conflict;
    if (isRecord(conflict.remote)) return conflict.remote;
    if (isRecord(conflict.current)) return conflict.current;
  }
  return data;
}

function conflictCode(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.error)) return null;
  return normalizedIdentifier(data.error.code);
}

export class ActionItemConflictResponseError extends HttpResponseError {
  constructor(
    status: 409 | 412,
    public readonly remoteRevision: number | null,
    public readonly remotePayload: unknown,
    public readonly contractCode: string | null,
  ) {
    super('行动项云端版本已变化', status);
    this.name = 'ActionItemConflictResponseError';
  }
}

export interface UpsertMeetingActionV2Input {
  accessToken: string;
  meetingRemoteId: string;
  idempotencyKey: string;
  mutation: ActionItemV2Mutation;
  signal?: AbortSignal;
}

export async function upsertMeetingActionV2(
  input: UpsertMeetingActionV2Input,
): Promise<ActionItemV2Response> {
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const meetingId = encodeURIComponent(input.meetingRemoteId);
  const actionId = encodeURIComponent(input.mutation.action_id);
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${meetingId}/action-items/${actionId}`,
    {
      method: 'PUT',
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
        ...(input.mutation.expected_remote_revision === null
          ? { 'If-None-Match': '*' }
          : { 'If-Match': `"${input.mutation.expected_remote_revision}"` }),
      },
      body: JSON.stringify({
        schema_version: input.mutation.schema_version,
        client_action_id: input.mutation.action_id,
        remote_id: input.mutation.remote_id,
        client_created_at_ms: input.mutation.client_created_at_ms,
        client_updated_at_ms: input.mutation.client_updated_at_ms,
        user_edited_at_ms: input.mutation.user_edited_at_ms,
        completed_at_ms: input.mutation.completed_at_ms,
        content: input.mutation.content,
        status: input.mutation.status,
        assignee: input.mutation.assignee,
        due_at_ms: input.mutation.due_at_ms,
        reminder_at_ms: input.mutation.reminder_at_ms,
        followup_event_source_id: input.mutation.followup_event_source_id,
        source_kind: input.mutation.source_kind,
        source_summary_version_id: input.mutation.source_summary_version_id,
        source_segment_id: input.mutation.source_segment_id,
        source_start_ms: input.mutation.source_start_ms,
        generation_fingerprint: input.mutation.generation_fingerprint,
      }),
    },
  );
  if (response.status === 409 || response.status === 412) {
    const data = await readResponseData(response);
    throw new ActionItemConflictResponseError(
      response.status,
      remoteRevision(data, response),
      conflictPayload(data),
      conflictCode(data),
    );
  }
  if (!response.ok) {
    throw await readResponseError('行动项同步失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const data = await readResponseData(response);
  if (!isRecord(data)) throw new Error('行动项同步响应格式无效');
  const id = normalizedIdentifier(data.id ?? data.action_id);
  const clientActionId = normalizedIdentifier(data.client_action_id);
  const revision = remoteRevision(data, response);
  if (!id || clientActionId !== input.mutation.action_id || revision === null) {
    throw new Error('行动项同步响应缺少有效版本');
  }
  return { id, clientActionId, revision };
}

function strictIdentifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${label}无效`);
  return normalized;
}

function strictNullableIdentifier(value: unknown, label: string, maximum = 512): string | null {
  if (value === null) return null;
  return strictIdentifier(value, label, maximum);
}

function strictTime(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label}无效`);
  }
  return Number(value);
}

function strictNullableTime(value: unknown, label: string): number | null {
  return value === null ? null : strictTime(value, label);
}

function strictNullableText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  return value.trim() || null;
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

function parseRemoteActionItem(
  value: unknown,
  expectedMeetingRemoteId: string,
): RemoteActionItemV2 {
  if (!isRecord(value)) throw new Error('行动项拉取响应包含无效条目');
  const remoteId = strictIdentifier(value.id, '行动项云端标识', 160);
  const meetingRemoteId = strictIdentifier(value.meeting_id, '行动项会议标识', 160);
  if (meetingRemoteId !== expectedMeetingRemoteId) {
    throw new Error('行动项不属于当前会议');
  }
  const clientActionId = strictIdentifier(value.client_action_id, '行动项本机标识');
  const revision = strictTime(value.revision, '行动项云端版本', 1);
  const clientCreatedAtMs = strictTime(value.client_created_at_ms, '行动项创建时间');
  const clientUpdatedAtMs = strictTime(value.client_updated_at_ms, '行动项更新时间');
  const userEditedAtMs = strictNullableTime(value.user_edited_at_ms, '行动项编辑时间');
  const completedAtMs = strictNullableTime(value.completed_at_ms, '行动项完成时间');
  if (clientCreatedAtMs > clientUpdatedAtMs) {
    throw new Error('行动项创建时间晚于更新时间');
  }
  if (userEditedAtMs !== null && userEditedAtMs > clientUpdatedAtMs) {
    throw new Error('行动项编辑时间晚于更新时间');
  }
  const rawContent = value.content;
  if (typeof rawContent !== 'string') throw new Error('行动项内容无效');
  const content = rawContent.trim();
  if (!content || content.length > 20_000 || content.includes('\u0000')) {
    throw new Error('行动项内容无效');
  }
  const status = value.status;
  if (status !== 'pending' && status !== 'completed' && status !== 'dismissed') {
    throw new Error('行动项状态无效');
  }
  if ((status === 'completed') !== (completedAtMs !== null)) {
    throw new Error('行动项完成状态与时间不一致');
  }
  if (
    completedAtMs !== null
    && (completedAtMs < clientCreatedAtMs || completedAtMs > clientUpdatedAtMs)
  ) throw new Error('行动项完成时间超出有效范围');
  const assignee = strictNullableText(value.assignee, '行动项负责人', 500);
  const dueAtMs = strictNullableTime(value.due_at_ms, '行动项截止时间');
  const reminderAtMs = strictNullableTime(value.reminder_at_ms, '行动项提醒时间');
  if (reminderAtMs !== null && (dueAtMs === null || status !== 'pending')) {
    throw new Error('行动项提醒与当前状态不一致');
  }
  const sourceKind = value.source_kind;
  if (sourceKind !== 'generated' && sourceKind !== 'manual' && sourceKind !== 'marker') {
    throw new Error('行动项来源无效');
  }
  const generationFingerprint = strictNullableIdentifier(
    value.generation_fingerprint,
    '行动项生成标识',
  );
  if (sourceKind !== 'generated' && generationFingerprint !== null) {
    throw new Error('手动行动项不能包含生成标识');
  }
  const serverCreatedAtMs = serverTime(value.created_at, '行动项云端创建时间');
  const serverUpdatedAtMs = serverTime(value.updated_at, '行动项云端更新时间');
  if (serverCreatedAtMs > serverUpdatedAtMs) {
    throw new Error('行动项云端时间顺序无效');
  }
  return {
    remoteId,
    meetingRemoteId,
    clientActionId,
    revision,
    clientCreatedAtMs,
    clientUpdatedAtMs,
    userEditedAtMs,
    completedAtMs,
    content,
    status,
    assignee,
    dueAtMs,
    reminderAtMs,
    followupEventSourceId: strictNullableIdentifier(
      value.followup_event_source_id,
      '行动项后续日程标识',
    ),
    sourceKind,
    sourceSummaryVersionId: strictNullableIdentifier(
      value.source_summary_version_id,
      '行动项整理结果标识',
    ),
    sourceSegmentId: strictNullableIdentifier(
      value.source_segment_id,
      '行动项文字记录片段标识',
    ),
    sourceStartMs: strictNullableTime(value.source_start_ms, '行动项来源时间'),
    generationFingerprint,
    serverCreatedAtMs,
    serverUpdatedAtMs,
  };
}

function strictCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('行动项同步游标无效');
  const normalized = value.trim();
  if (!normalized || normalized.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error('行动项同步游标无效');
  }
  return normalized;
}

export interface ListMeetingActionsV2Input {
  accessToken: string;
  meetingRemoteId: string;
  cursor: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export async function listMeetingActionsV2(
  input: ListMeetingActionsV2Input,
): Promise<ActionItemV2Page> {
  const meetingRemoteId = strictIdentifier(input.meetingRemoteId, '会议云端标识', 160);
  const cursor = strictCursor(input.cursor);
  const requestedLimit = input.limit ?? 100;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    throw new Error('行动项拉取数量无效');
  }
  const base = getApiConfig().apiBase.replace(/\/+$/, '');
  const query = [
    `limit=${requestedLimit}`,
    ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : []),
  ].join('&');
  const response = await fetchWithTimeout(
    `${base}/api/laoji/v2/meeting-notes/${encodeURIComponent(meetingRemoteId)}/action-items?${query}`,
    {
      signal: input.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
      },
    },
  );
  if (!response.ok) {
    throw await readResponseError('行动项拉取失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const data = await readResponseData(response);
  if (!isRecord(data) || data.schema_version !== 2) {
    throw new Error('行动项拉取响应格式无效');
  }
  const responseMeetingId = strictIdentifier(data.meeting_id, '行动项会议标识', 160);
  if (responseMeetingId !== meetingRemoteId || !Array.isArray(data.items)) {
    throw new Error('行动项拉取响应与当前会议不一致');
  }
  if (data.items.length > requestedLimit) throw new Error('行动项拉取响应超出数量限制');
  const items = data.items.map(item => parseRemoteActionItem(item, meetingRemoteId));
  if (
    new Set(items.map(item => item.clientActionId)).size !== items.length
    || new Set(items.map(item => item.remoteId)).size !== items.length
  ) throw new Error('行动项拉取响应包含重复标识');
  if (typeof data.has_more !== 'boolean') throw new Error('行动项拉取分页状态无效');
  const nextCursor = strictCursor(data.next_cursor);
  if (items.length > 0 && nextCursor === null) throw new Error('行动项拉取响应缺少游标');
  if (data.has_more && (items.length === 0 || nextCursor === cursor)) {
    throw new Error('行动项拉取游标未向前推进');
  }
  return {
    meetingRemoteId,
    items,
    nextCursor,
    hasMore: data.has_more,
  };
}
