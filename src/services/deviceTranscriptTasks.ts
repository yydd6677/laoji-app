import { getOrCreateDeviceIdentity } from './deviceIdentity';
import { ensureLocalMeetingServiceBinding } from './deviceAuthority';
import { ensureDeviceEpoch } from '../data/repositories/vnext/deviceAuthorityRepository';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import { createDeviceTranscription } from './deviceApi';
import { waitForBackgroundNetworkTurn } from './deviceNetworkPriority';
import {
  mirrorDeviceTranscriptTaskProgress,
  recordTranscriptProcessingFailure,
} from './meetingStageMirror';
import {
  createDeviceOperation,
  getLatestDeviceOperation,
  listPendingDeviceOperations,
  updateDeviceOperation,
  type DeviceOperationRecord,
} from '../data/repositories/vnext/deviceOperationsRepository';

export type DeviceTranscriptTaskState = 'pending' | 'failed';
export type DeviceTranscriptTaskPhase = 'queued' | 'running';

export interface DeviceTranscriptTaskRecord {
  meetingId: string;
  taskId: string;
  state: DeviceTranscriptTaskState;
  phase?: DeviceTranscriptTaskPhase;
  errorCode?: string;
  eventCursor: number;
  eventTotal: number | null;
  updatedAt: string;
}

const listeners = new Set<(meetingId: string) => void>();

function notifyChanged(meetingId: string): void {
  listeners.forEach(listener => {
    try { listener(meetingId); } catch { /* observers cannot break the durable write */ }
  });
}

export function subscribeDeviceTranscriptTaskChanged(
  listener: (meetingId: string) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function validId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizedMeetingId(value: string): string {
  const result = value.trim().toLowerCase();
  if (!validId(result)) throw new Error('本机会议标识无效');
  return result;
}

function normalizedTaskId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 160 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('设备转写任务标识无效');
  }
  return result;
}

function operationId(meetingId: string, taskId: string): string {
  return `transcript:${meetingId}:${taskId}`;
}

async function operationMeetingId(meetingId: string): Promise<string> {
  const normalized = normalizedMeetingId(meetingId);
  return await sqliteMeetingNoteRepository.resolveCanonicalMeetingId(normalized, 'guest')
    ?? normalized;
}

function toRecord(operation: DeviceOperationRecord): DeviceTranscriptTaskRecord | null {
  if (operation.remoteState === 'success' || operation.remoteState === 'cancelled') return null;
  const state: DeviceTranscriptTaskState = operation.remoteState === 'failure' ? 'failed' : 'pending';
  return {
    meetingId: operation.entityId,
    taskId: operation.generationId,
    state,
    phase: state === 'pending' && operation.remoteState === 'running' ? 'running' : state === 'pending' ? 'queued' : undefined,
    errorCode: state === 'failed' ? operation.errorCode ?? undefined : undefined,
    eventCursor: operation.progressDone ?? 0,
    eventTotal: operation.progressTotal,
    updatedAt: new Date(operation.updatedAtMs).toISOString(),
  };
}

export async function getDeviceTranscriptTask(meetingId: string): Promise<DeviceTranscriptTaskRecord | null> {
  const normalized = normalizedMeetingId(meetingId);
  const operation = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  const record = operation ? toRecord(operation) : null;
  return record ? { ...record, meetingId: normalized } : null;
}

/**
 * Returns every transcript task recoverable by this installation, including
 * tasks whose meeting card is temporarily absent from the rendered list.
 */
export async function listPendingDeviceTranscriptTasks(
  limit = 64,
): Promise<readonly DeviceTranscriptTaskRecord[]> {
  const identity = await getOrCreateDeviceIdentity();
  const operations = await listPendingDeviceOperations({
    capability: 'transcript',
    scopeKey: 'guest',
    deviceEpochId: identity.epochId,
    limit,
  });
  const records = await Promise.all(operations.map(async operation => {
    const record = toRecord(operation);
    if (record?.state !== 'pending') return null;
    const aggregate = await sqliteMeetingNoteRepository.get(operation.entityId, 'guest');
    return {
      ...record,
      meetingId: aggregate?.note.legacySourceId?.trim() || operation.entityId,
    } satisfies DeviceTranscriptTaskRecord;
  }));
  return records.filter((record): record is DeviceTranscriptTaskRecord => record !== null);
}

export async function rememberDeviceTranscriptTask(meetingId: string, taskId: string): Promise<void> {
  const normalizedMeetingIdValue = normalizedMeetingId(meetingId);
  const normalizedTaskIdValue = normalizedTaskId(taskId);
  const identity = await getOrCreateDeviceIdentity();
  await ensureDeviceEpoch(identity.epochId);
  const binding = await ensureLocalMeetingServiceBinding(normalizedMeetingIdValue);
  const entityId = binding.meetingId;
  const current = await getLatestDeviceOperation('transcript', entityId);
  if (current?.generationId === normalizedTaskIdValue) return;
  await createDeviceOperation({
    operationId: operationId(entityId, normalizedTaskIdValue),
    deviceEpochId: identity.epochId,
    capability: 'transcript',
    entityId,
    entityRevision: 1,
    input: normalizedTaskIdValue,
    generationId: normalizedTaskIdValue,
    predecessorOperationId: current?.operationId ?? null,
    creationReason: current ? 'retry' : 'original',
  });
  await mirrorDeviceTranscriptTaskProgress(
    'guest',
    normalizedMeetingIdValue,
    'queued',
    normalizedTaskIdValue,
  );
  notifyChanged(normalizedMeetingIdValue);
}

/** Starts a new server transcription attempt for the current local recording. */
export async function retryDeviceTranscriptTask(meetingId: string): Promise<string> {
  const normalized = normalizedMeetingId(meetingId);
  const canonicalMeetingId = await operationMeetingId(normalized);
  const aggregate = await sqliteMeetingNoteRepository.get(canonicalMeetingId, 'guest');
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new Error('会议记录已不存在');
  }
  const asset = [...aggregate.recordingAssets]
    .filter(item => Boolean(item.remoteAssetId?.trim()))
    .sort((left, right) => (
      Number(right.role === 'primary') - Number(left.role === 'primary')
      || right.updatedAtMs - left.updatedAtMs
      || left.id.localeCompare(right.id)
    ))[0];
  const remoteAssetId = asset?.remoteAssetId?.trim();
  if (!asset || !remoteAssetId) {
    throw new Error('录音尚未上传完成');
  }
  await waitForBackgroundNetworkTurn();
  const attemptId = `${Date.now()}`;
  const requestKey = `device-transcript-retry:${asset.id}:${attemptId}`;
  const response = await createDeviceTranscription(
    remoteAssetId,
    { clientRequestId: requestKey, language: 'zh' },
    requestKey,
  );
  const taskId = [response?.job_id, response?.task_id, response?.transcription_task_id]
    .find(value => typeof value === 'string' && value.trim())
    ?.trim();
  if (!taskId) throw new Error('转写服务未返回任务标识');
  await rememberDeviceTranscriptTask(normalized, taskId);
  return taskId;
}

export async function markDeviceTranscriptTaskProgress(
  meetingId: string,
  phase: DeviceTranscriptTaskPhase,
): Promise<boolean> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return false;
  const alreadyProjected = (phase === 'running' && existing.remoteState === 'running')
    || (phase === 'queued' && existing.remoteState === 'queued');
  let updated: DeviceOperationRecord | null = null;
  if (!alreadyProjected) {
    updated = await updateDeviceOperation({
      operationId: existing.operationId,
      expectedRevision: existing.operationRevision,
      state: phase === 'running' ? 'running' : 'queued',
    });
  }
  const stageChanged = await mirrorDeviceTranscriptTaskProgress(
    'guest',
    normalized,
    phase,
    existing.generationId,
  );
  if (updated) notifyChanged(normalized);
  return Boolean(updated) || stageChanged;
}

export async function advanceDeviceTranscriptEventCursor(
  meetingId: string,
  taskId: string,
  expectedCursor: number,
  nextCursor: number,
  eventTotal: number,
): Promise<boolean> {
  const normalized = normalizedMeetingId(meetingId);
  const normalizedTask = normalizedTaskId(taskId);
  if (
    !Number.isSafeInteger(expectedCursor) || expectedCursor < 0
    || !Number.isSafeInteger(nextCursor) || nextCursor < expectedCursor
    || !Number.isSafeInteger(eventTotal) || eventTotal < nextCursor
  ) throw new Error('设备转写事件游标无效');
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.generationId !== normalizedTask) return false;
  const current = existing.progressDone ?? 0;
  if (current >= nextCursor) return true;
  if (current !== expectedCursor || ['success', 'failure', 'cancelled'].includes(existing.remoteState ?? '')) {
    return false;
  }
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'running',
    progressDone: nextCursor,
    progressTotal: Math.max(eventTotal, existing.progressTotal ?? 0),
  });
  if (updated) notifyChanged(normalized);
  return updated !== null;
}

export async function markDeviceTranscriptTaskFailed(meetingId: string, errorCode?: string): Promise<boolean> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return false;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'failure',
    errorCode: errorCode?.trim().slice(0, 80) || null,
  });
  if (!updated) return false;
  await recordTranscriptProcessingFailure(
    'guest',
    normalized,
    errorCode === 'no_speech' ? 'no_speech' : 'remote_processing',
    new Error(errorCode?.trim() || 'transcription_failed'),
  );
  notifyChanged(normalized);
  return true;
}

export async function cancelDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'cancelled',
  });
  if (updated) notifyChanged(normalized);
}

/** Marks the durable operation successful; it is retained for idempotent replay. */
export async function clearDeviceTranscriptTask(meetingId: string): Promise<void> {
  const normalized = normalizedMeetingId(meetingId);
  const existing = await getLatestDeviceOperation('transcript', await operationMeetingId(normalized));
  if (!existing || existing.remoteState === 'success' || existing.remoteState === 'cancelled') return;
  const updated = await updateDeviceOperation({
    operationId: existing.operationId,
    expectedRevision: existing.operationRevision,
    state: 'success',
  });
  if (updated) notifyChanged(normalized);
}
