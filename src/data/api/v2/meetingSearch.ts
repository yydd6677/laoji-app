import { getApiConfig } from '../../../services/config';
import { readResponseData, readResponseError } from '../../../services/errors';
import { fetchWithTimeout } from '../../../services/http';
import type { MeetingSearchResult } from '../../repositories/meetingNoteRepository';
import { parseMeetingSearchQuery } from '../../../services/meetingSearchQuery';

const SOURCE_KINDS = new Set<MeetingSearchResult['sourceKind']>([
  'title', 'tag', 'manual_note', 'transcript', 'summary', 'action',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label}无效`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label}无效`);
  return normalized;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}无效`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function serverTime(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  ) throw new Error(`${label}无效`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`);
  return parsed;
}

function sourceKind(value: unknown): MeetingSearchResult['sourceKind'] {
  if (typeof value !== 'string' || !SOURCE_KINDS.has(value as MeetingSearchResult['sourceKind'])) {
    throw new Error('会议搜索来源无效');
  }
  return value as MeetingSearchResult['sourceKind'];
}

function parseResult(value: unknown): MeetingSearchResult {
  if (!isRecord(value)) throw new Error('会议搜索结果无效');
  const recordedAtMs = serverTime(value.recorded_at, '会议记录时间');
  const updatedAtMs = serverTime(value.updated_at, '会议更新时间');
  return {
    resultId: text(value.result_id, '搜索结果标识', 512),
    meetingId: text(value.meeting_id, '会议标识', 160),
    navigationMeetingId: text(value.meeting_id, '会议标识', 160),
    sourceKind: sourceKind(value.source_kind),
    sourceId: text(value.source_id, '搜索来源标识', 512),
    startMs: nullableInteger(value.start_ms, '搜索时间位置'),
    meetingTitle: text(value.title, '会议标题', 255, true),
    recordedAtMs: recordedAtMs ?? updatedAtMs ?? 0,
    snippet: text(value.snippet, '搜索摘要', 2_000, true),
    rank: safeInteger(value.rank, '搜索排序', 1),
  };
}

export async function searchMeetingContentV1(input: {
  accessToken: string;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<readonly MeetingSearchResult[]> {
  const query = input.query.normalize('NFKC').trim();
  if (!query || query.length > 200) throw new Error('搜索内容无效');
  const parsedQuery = parseMeetingSearchQuery(query);
  if (!parsedQuery) throw new Error('搜索内容无效');
  const limit = input.limit ?? 60;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('搜索数量无效');
  }
  const base = getApiConfig().meetingApiBase.replace(/\/+$/, '');
  const params = new URLSearchParams({
    q: parsedQuery.contentTokens.join(' '),
    limit: String(limit),
  });
  parsedQuery.filters.tags.forEach(tag => params.append('tag', tag));
  parsedQuery.filters.people.forEach(person => params.append('person', person));
  parsedQuery.filters.sourceKinds.forEach(kind => params.append('source_kind', kind));
  if (parsedQuery.filters.fromDate) params.set('from_date', parsedQuery.filters.fromDate);
  if (parsedQuery.filters.toDate) params.set('to_date', parsedQuery.filters.toDate);
  const response = await fetchWithTimeout(`${base}/api/laoji/v1/meeting-search?${params.toString()}`, {
    signal: input.signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
    },
  });
  if (!response.ok) {
    throw await readResponseError('会议搜索失败', response, {
      unauthorizedToken: input.accessToken,
    });
  }
  const payload = await readResponseData(response);
  if (!isRecord(payload) || payload.schema_version !== 1 || !Array.isArray(payload.items)) {
    throw new Error('会议搜索响应格式无效');
  }
  if (payload.items.length > limit) throw new Error('会议搜索响应超出数量限制');
  const results = payload.items.map(parseResult);
  if (new Set(results.map(item => item.resultId)).size !== results.length) {
    throw new Error('会议搜索响应包含重复结果');
  }
  for (let index = 1; index < results.length; index += 1) {
    if (results[index - 1].rank >= results[index].rank) {
      throw new Error('会议搜索响应顺序无效');
    }
  }
  return results;
}
