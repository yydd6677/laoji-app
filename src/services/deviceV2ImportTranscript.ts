import * as Crypto from 'expo-crypto';
import { deviceV2Request } from './deviceV2Api';

export interface DeviceV2TranscriptEvent {
  schema_version: 2;
  contract_revision: 'transcript.stream.v2';
  session_id: string;
  event_sequence: number;
  event_kind: 'stable' | 'final';
  stable_segment_key: string | null;
  segment_revision: number;
  text_state: 'stable' | 'final';
  outcome: 'text' | 'no_speech';
  text: string;
  source_start_ms: number;
  source_end_ms: number;
  model_revision: string;
}

export interface DeviceV2ImportTranscriptSnapshot {
  schema_version: 2;
  task_id: string;
  state: 'queued' | 'running' | 'succeeded' | 'no_content' | 'failed' | 'cancelled';
  last_event_seq: number;
  last_acked_event_seq: number;
  source_sha256: string;
  model_revision: string | null;
  error_code: string | null;
  payload_expired: boolean;
  events: DeviceV2TranscriptEvent[];
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field}无效`);
  }
  return normalized;
}

function nonnegative(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field}无效`);
  return number;
}

function normalizeSnapshot(value: DeviceV2ImportTranscriptSnapshot): DeviceV2ImportTranscriptSnapshot {
  if (
    !value || value.schema_version !== 2
    || !['queued', 'running', 'succeeded', 'no_content', 'failed', 'cancelled'].includes(value.state)
    || !/^sha256:[0-9a-f]{64}$/.test(value.source_sha256)
    || typeof value.payload_expired !== 'boolean'
    || !Array.isArray(value.events)
  ) throw new Error('导入文字记录响应无效');
  const lastEvent = nonnegative(value.last_event_seq, '服务端事件序号');
  const lastAcked = nonnegative(value.last_acked_event_seq, '服务端确认序号');
  if (lastAcked > lastEvent) throw new Error('导入文字记录确认序号无效');
  let previous = -1;
  const events = value.events.map(event => {
    const sequence = nonnegative(event.event_sequence, '文字记录事件序号');
    if (
      event.schema_version !== 2
      || event.contract_revision !== 'transcript.stream.v2'
      || !['stable', 'final'].includes(event.event_kind)
      || event.text_state !== event.event_kind
      || !['text', 'no_speech'].includes(event.outcome)
      || sequence < 1 || sequence <= previous || sequence > lastEvent
      || nonnegative(event.source_end_ms, '文字记录结束时间')
        < nonnegative(event.source_start_ms, '文字记录开始时间')
      || !Number.isSafeInteger(event.segment_revision) || event.segment_revision < 1
      || typeof event.text !== 'string'
      || !identifier(event.model_revision, '转写模型版本')
      || (event.event_kind === 'stable' && !event.stable_segment_key)
      || (event.event_kind === 'final' && event.stable_segment_key !== null)
      || (event.outcome === 'no_speech' && event.text.trim())
    ) throw new Error('导入文字记录事件无效');
    previous = sequence;
    return event;
  });
  return { ...value, last_event_seq: lastEvent, last_acked_event_seq: lastAcked, events };
}

export async function getDeviceV2ImportTranscriptEvents(
  taskIdValue: string,
  afterEventSeq: number,
): Promise<DeviceV2ImportTranscriptSnapshot> {
  const taskId = identifier(taskIdValue, '转写任务');
  const cursor = nonnegative(afterEventSeq, '文字记录游标');
  const snapshot = await deviceV2Request<DeviceV2ImportTranscriptSnapshot>(
    `/tasks/${encodeURIComponent(taskId)}/transcript-events?after_event_seq=${cursor}&limit=256`,
    {},
    '文字记录暂时不可用',
  );
  const normalized = normalizeSnapshot(snapshot);
  if (normalized.task_id !== taskId || normalized.events.some(event => event.session_id !== taskId)) {
    throw new Error('导入文字记录任务身份不一致');
  }
  return normalized;
}

export async function transcriptProjectionSha256(input: {
  taskId: string;
  meetingId: string;
  throughEventSeq: number;
  outcome: 'text' | 'no_speech';
  transcriptRevisionId: string | null;
}): Promise<string> {
  const canonical = JSON.stringify({
    meeting_id: identifier(input.meetingId, '会议'),
    outcome: input.outcome,
    task_id: identifier(input.taskId, '转写任务'),
    through_event_seq: nonnegative(input.throughEventSeq, '文字记录游标'),
    transcript_revision_id: input.transcriptRevisionId
      ? identifier(input.transcriptRevisionId, '文字记录版本')
      : null,
  });
  return `sha256:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical)}`;
}

export async function ackDeviceV2ImportTranscriptEvents(
  taskIdValue: string,
  throughEventSeq: number,
  projectionSha256: string,
): Promise<void> {
  const taskId = identifier(taskIdValue, '转写任务');
  if (!/^sha256:[0-9a-f]{64}$/.test(projectionSha256)) throw new Error('文字记录投影校验值无效');
  await deviceV2Request(
    `/tasks/${encodeURIComponent(taskId)}/transcript-events/ack`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 2,
        through_event_seq: nonnegative(throughEventSeq, '文字记录游标'),
        projection_sha256: projectionSha256,
      }),
    },
    '文字记录确认失败',
  );
}
