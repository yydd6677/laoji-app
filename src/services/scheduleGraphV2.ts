import { getApiConfig } from './config';
import { readResponseError } from './errors';
import { fetchWithTimeout, readJsonWithTimeout } from './http';

export type ScheduleGraphState = 'complete' | 'needs_clarification' | 'operation' | 'reject' | 'incomplete';
export type ScheduleGraphRoute = 'local_safe' | 'server_required' | 'preflight' | 'clarify' | 'operation' | 'reject';
export type ScheduleGraphIntent = 'create' | 'query' | 'delete' | 'clarify' | 'reject' | 'context_edit';

export interface ScheduleGraphSpanV1 {
  text: string;
  start: number;
  end: number;
}

export interface ScheduleGraphV1 {
  schema_version: 1;
  source: {
    text: string;
    content_sha256: string;
    mode: 'text' | 'audio_transcript';
    reference_datetime: string;
    timezone: string;
  };
  source_id: string;
  intent: ScheduleGraphIntent;
  route: ScheduleGraphRoute;
  slots: {
    title: string | null;
    start_date: string | null;
    end_date: string | null;
    start_time: string | null;
    end_time: string | null;
    time_period: string | null;
    event_type: string;
    location: string | null;
    recurrence: Record<string, unknown> | null;
    reminder: Record<string, unknown> | null;
  };
  state: ScheduleGraphState;
  missing: string[];
  spans: Record<string, ScheduleGraphSpanV1[]>;
  provenance: {
    engine: 'mobile-local' | 'server-model' | 'recognizers';
    engine_revision: string;
    producer_revision: string;
    draft_revision: number;
    parent_revision: number | null;
  };
}

export interface ScheduleGraphV2Input {
  text: string;
  referenceDatetime: string;
  timezone: string;
  sourceId?: string;
  clientRequestId: string;
  signal?: AbortSignal;
}

export interface ScheduleGraphClarificationV2Input {
  graph: ScheduleGraphV1;
  answer: string;
  clientRequestId: string;
  signal?: AbortSignal;
}

function graphUrl(path: string): string {
  return `${getApiConfig().apiBase}/api/laoji/v2/schedule/graph${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function normalizeGraph(value: unknown): ScheduleGraphV1 {
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.source_id !== 'string') {
    throw new Error('日程图协议版本无效');
  }
  const source = value.source;
  if (!isRecord(source) || typeof source.text !== 'string' || !isSha256(source.content_sha256)) {
    throw new Error('日程图来源无效');
  }
  const sourceText = source.text;
  const routes = new Set<ScheduleGraphRoute>(['local_safe', 'server_required', 'preflight', 'clarify', 'operation', 'reject']);
  const states = new Set<ScheduleGraphState>(['complete', 'needs_clarification', 'operation', 'reject', 'incomplete']);
  if (typeof value.route !== 'string' || !routes.has(value.route as ScheduleGraphRoute)
    || typeof value.state !== 'string' || !states.has(value.state as ScheduleGraphState)
    || !isRecord(value.spans) || !Array.isArray(value.missing) || !isRecord(value.slots)) {
    throw new Error('日程图状态无效');
  }
  const spans: Record<string, ScheduleGraphSpanV1[]> = {};
  for (const [key, raw] of Object.entries(value.spans)) {
    if (!Array.isArray(raw)) throw new Error('日程图来源片段无效');
    spans[key] = raw.map(item => {
      if (!isRecord(item) || typeof item.text !== 'string'
        || !Number.isInteger(item.start) || !Number.isInteger(item.end)) {
        throw new Error('日程图来源片段与原文不一致');
      }
      const start = Number(item.start);
      const end = Number(item.end);
      if (start < 0 || end < start || sourceText.slice(start, end) !== item.text) {
        throw new Error('日程图来源片段与原文不一致');
      }
      return { text: item.text, start, end };
    });
  }
  const provenance = value.provenance;
  if (!isRecord(provenance) || !Number.isInteger(provenance.draft_revision)
    || Number(provenance.draft_revision) < 1 || typeof provenance.producer_revision !== 'string') {
    throw new Error('日程图 revision 无效');
  }
  return value as unknown as ScheduleGraphV1;
}

async function postGraph<T>(path: string, body: unknown, signal: AbortSignal | undefined, fallback: string): Promise<T> {
  const response = await fetchWithTimeout(graphUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readResponseError(fallback, response);
  return readJsonWithTimeout<T>(response, 60_000, signal);
}

/** Candidate-only v2 client. Existing api.ts callers remain on the legacy route. */
export async function parseScheduleGraphV2(input: ScheduleGraphV2Input): Promise<ScheduleGraphV1> {
  const text = input.text.trim();
  if (!text) throw new Error('日程输入不能为空');
  const value = await postGraph<unknown>('', {
    schema_version: 1,
    text,
    reference_datetime: input.referenceDatetime,
    timezone: input.timezone,
    ...(input.sourceId ? { source_id: input.sourceId } : {}),
    client_request_id: input.clientRequestId,
  }, input.signal, '日程图服务暂时不可用');
  return normalizeGraph(value);
}

export async function clarifyScheduleGraphV2(input: ScheduleGraphClarificationV2Input): Promise<ScheduleGraphV1> {
  if (!input.answer.trim()) throw new Error('日程补充不能为空');
  const value = await postGraph<unknown>('/clarify', {
    schema_version: 1,
    graph: input.graph,
    answer: input.answer.trim(),
    client_request_id: input.clientRequestId,
  }, input.signal, '日程图补充服务暂时不可用');
  return normalizeGraph(value);
}
