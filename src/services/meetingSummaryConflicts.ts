import {
  listMeetingSummarySyncConflicts,
  type SummarySyncConflictRecord,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';

export interface MeetingSummarySyncConflictView {
  id: string;
  meetingId: string;
  kind: 'section' | 'current';
  aggregateId: string;
  title: string;
  localPreview: string;
  remotePreview: string;
  localUpdatedAtMs: number | null;
  remoteUpdatedAtMs: number | null;
  canKeepLocal: boolean;
  canUseRemote: boolean;
  record: SummarySyncConflictRecord;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsed(value: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function current(root: Record<string, unknown> | null): Record<string, unknown> | null {
  return object(root?.current) ?? root;
}

function text(root: Record<string, unknown> | null, camel: string, snake: string): string | null {
  const value = root?.[camel] ?? root?.[snake];
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() || null : null;
}

function integer(root: Record<string, unknown> | null, camel: string, snake: string): number | null {
  const value = root?.[camel] ?? root?.[snake];
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function serverTime(root: Record<string, unknown> | null): number | null {
  const direct = integer(root, 'serverUpdatedAtMs', 'server_updated_at_ms');
  if (direct !== null) return direct;
  const value = root?.updated_at;
  if (typeof value !== 'string') return null;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function view(record: SummarySyncConflictRecord): MeetingSummarySyncConflictView {
  const local = parsed(record.localPayloadJson);
  const remote = current(parsed(record.remotePayloadJson));
  if (record.aggregateType === 'summary_current') {
    return {
      id: record.id,
      meetingId: record.meetingId,
      kind: 'current',
      aggregateId: record.aggregateId,
      title: '当前整理结果',
      localPreview: '保留本机选择的版本',
      remotePreview: '使用云端当前版本',
      localUpdatedAtMs: integer(local, 'clientUpdatedAtMs', 'client_updated_at_ms'),
      remoteUpdatedAtMs: integer(remote, 'clientUpdatedAtMs', 'client_updated_at_ms')
        ?? serverTime(remote),
      canKeepLocal: local !== null,
      canUseRemote: remote !== null,
      record,
    };
  }
  const generated = text(local, 'generatedText', 'generated_text') ?? '';
  return {
    id: record.id,
    meetingId: record.meetingId,
    kind: 'section',
    aggregateId: record.aggregateId,
    title: text(local, 'title', 'title') ?? '整理内容',
    localPreview: text(local, 'userText', 'user_text') ?? (generated || '生成内容'),
    remotePreview: text(remote, 'userText', 'user_text') ?? (generated || '生成内容'),
    localUpdatedAtMs: integer(local, 'clientUpdatedAtMs', 'client_updated_at_ms'),
    remoteUpdatedAtMs: integer(remote, 'clientUpdatedAtMs', 'client_updated_at_ms')
      ?? serverTime(remote),
    canKeepLocal: local !== null,
    canUseRemote: remote !== null,
    record,
  };
}

export async function loadMeetingSummarySyncConflicts(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<readonly MeetingSummarySyncConflictView[]> {
  if (scopeKey === 'guest') return [];
  return (await listMeetingSummarySyncConflicts(scopeKey, meetingId)).map(view);
}
