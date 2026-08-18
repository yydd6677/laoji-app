import {
  createDeviceOperation,
  getDeviceOperation,
  updateDeviceOperation,
  type DeviceOperationRecord,
} from '../data/repositories/vnext/deviceOperationsRepository';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import { ensureLocalMeetingServiceBinding } from './deviceAuthority';
import { ensureDeviceEpoch } from '../data/repositories/vnext/deviceAuthorityRepository';
import { sqliteMeetingNoteRepository } from '../data/repositories';

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

export interface EnsureDeviceUploadOperationInput {
  meetingId: string;
  operationId: string;
  recordingAssetId: string;
  assetGeneration: string;
  sourceSha256: string;
}

/** Creates the durable local upload intent before the native worker is queued. */
export async function ensureDeviceUploadOperation(
  input: EnsureDeviceUploadOperationInput,
): Promise<DeviceOperationRecord> {
  const meetingId = required(input.meetingId, '会议 ID');
  const operationId = required(input.operationId, '上传 operation ID');
  const assetId = required(input.recordingAssetId, '录音资产 ID');
  const generation = required(input.assetGeneration, '录音代际');
  const sourceSha256 = required(input.sourceSha256, '录音校验值');
  const existing = await getDeviceOperation(operationId);
  if (existing) {
    if (
      existing.capability !== 'media.upload'
      || existing.entityId !== meetingId
      || existing.generationId !== generation
      || existing.inputSha256 !== sourceSha256
    ) throw new Error('上传 operation 身份冲突');
    if (existing.remoteState !== 'failure' && existing.remoteState !== 'cancelled') return existing;
    // The asset generation is immutable and is part of the operation unique
    // key.  Do not reopen a terminal row or invent a second operation for the
    // same generation; the retry path must first create a fresh asset
    // generation in the owning repository.
    throw new Error('上传 operation 已终止，请创建新的录音代际');
  }
  const binding = await ensureLocalMeetingServiceBinding(meetingId);
  const identity = await getOrCreateDeviceIdentity();
  await ensureDeviceEpoch(identity.epochId);
  if (binding.deviceEpochId !== identity.epochId) throw new Error('上传 operation epoch 不一致');
  return createDeviceOperation({
    operationId,
    deviceEpochId: identity.epochId,
    capability: 'media.upload',
    entityId: meetingId,
    entityRevision: 1,
    inputSha256: sourceSha256,
    generationId: generation,
    creationReason: 'original',
  });
}

/** Binds the operation to the immutable local asset generation in one DB transaction. */
export async function bindDeviceUploadOperationToAsset(
  meetingId: string,
  recordingAssetId: string,
  operationId: string,
): Promise<boolean> {
  const aggregate = await sqliteMeetingNoteRepository.get(meetingId, 'guest');
  if (!aggregate || aggregate.note.lifecycle === 'deleted') return false;
  const asset = aggregate.recordingAssets.find(item => item.id === recordingAssetId);
  if (!asset) return false;
  if (asset.uploadOperationId && asset.uploadOperationId !== operationId) {
    throw new Error('录音资产已绑定其他上传 operation');
  }
  if (asset.uploadOperationId === operationId) return true;
  const nowMs = Math.max(Date.now(), asset.updatedAtMs, aggregate.note.updatedAtMs);
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const current = await transaction.getRecordingAsset(aggregate.note.id, asset.id, 'guest');
    if (!current) throw new Error('录音资产不存在');
    if (current.uploadOperationId && current.uploadOperationId !== operationId) {
      throw new Error('录音资产绑定在事务期间发生变化');
    }
    await transaction.saveRecordingAsset({ ...current, uploadOperationId: operationId, updatedAtMs: nowMs }, 'guest');
    await transaction.advanceCanonicalWrite('guest', nowMs);
  });
  return true;
}

/** Applies a terminal worker result without reopening a completed operation. */
export async function markDeviceUploadOperationSuccess(operationId: string): Promise<boolean> {
  const existing = await getDeviceOperation(operationId);
  if (!existing || existing.remoteState === 'success') return Boolean(existing);
  if (existing.remoteState === 'cancelled' || existing.remoteState === 'failure') return false;
  const updated = await updateDeviceOperation({
    operationId,
    expectedRevision: existing.operationRevision,
    state: 'success',
    progressDone: 1,
    progressTotal: 1,
  });
  return Boolean(updated);
}
