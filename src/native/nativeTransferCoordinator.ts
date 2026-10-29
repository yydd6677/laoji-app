import {
  hasNativeTransfer,
  nativeTransfer,
  type NativeUploadState,
} from 'laoji-native-platform';
import { getApiConfig } from '../services/config';
import { ensureRemoteMeetingServiceBinding } from '../services/deviceAuthority';
import { ensureDeviceV2Session, type DeviceV2Session } from '../services/deviceV2Api';
import {
  attachDeviceOperationExecutor,
  bindDeviceUploadOperationToAsset,
  ensureDeviceUploadOperation,
} from '../services/deviceUploadOperations';
import { diagnosticAudit } from '../services/diagnostics';

export interface NativeTransferLease {
  scope: string;
  generation: number;
}

export interface NativeMeetingUploadRegistration extends NativeTransferLease {
  workId: string;
  operationId: string;
  protocol: 'device-v2-r2';
}

interface LeaseRecord extends NativeTransferLease {
  apiBaseUrl: string;
  accessToken: string;
  ready: Promise<void>;
}

export interface NativeDeviceV2MeetingUploadRequest {
  scope: string;
  meetingId: string;
  operationId: string;
  fileUri: string;
  mimeType: string;
  recordingAssetId: string;
  assetGeneration: string;
  expectedBytes: number;
  checksumSha256: string;
}

const leases = new Map<string, LeaseRecord>();
let lastGeneration = Date.now();

function nextGeneration(): number {
  lastGeneration = Math.max(Date.now(), lastGeneration + 1);
  return lastGeneration;
}

function transferAvailable(): boolean {
  return hasNativeTransfer() && nativeTransfer !== null;
}

export async function ensureNativeDeviceV2TransferLease(
  session: DeviceV2Session,
): Promise<NativeTransferLease | null> {
  diagnosticAudit('device_v2_lease_start', {});
  if (!transferAvailable()) return null;
  const scope = `device-v2:${session.epochId}`;
  const apiBaseUrl = getApiConfig().apiBase.trim().replace(/\/+$/, '');
  const existing = leases.get(scope);
  if (
    existing
    && existing.accessToken === session.token
    && existing.apiBaseUrl === apiBaseUrl
  ) {
    await existing.ready;
    return { scope, generation: existing.generation };
  }
  const generation = nextGeneration();
  const ready = nativeTransfer!.setDeviceV2CredentialLease(
    scope,
    generation,
    apiBaseUrl,
    session.token,
    session.deviceId,
    session.epochId,
    session.keyVersion,
    session.expiresAt,
  );
  const record: LeaseRecord = {
    scope,
    generation,
    apiBaseUrl,
    accessToken: session.token,
    ready,
  };
  leases.set(scope, record);
  try {
    await ready;
    diagnosticAudit('device_v2_lease_ready', { generation });
    return { scope, generation };
  } catch (error) {
    diagnosticAudit('device_v2_lease_error', { error_code: error instanceof Error ? error.name : 'unknown' });
    if (leases.get(scope) === record) leases.delete(scope);
    throw error;
  }
}

export async function clearNativeTransferLease(scope: string): Promise<void> {
  const normalizedScope = scope.trim();
  if (!normalizedScope) return;
  leases.delete(normalizedScope);
  if (transferAvailable()) await nativeTransfer!.clearCredentialLease(normalizedScope);
}

/** Durable device-scoped upload; credentials never enter WorkManager input. */
export async function enqueueNativeDeviceV2MeetingUpload(
  request: NativeDeviceV2MeetingUploadRequest,
): Promise<NativeMeetingUploadRegistration | null> {
  if (!transferAvailable() || !nativeTransfer) return null;
  const binding = await ensureRemoteMeetingServiceBinding(request.meetingId);
  const session = await ensureDeviceV2Session();
  if (session.epochId !== binding.deviceEpochId) {
    throw new Error('设备上传 epoch 与会议连接不一致');
  }
  const lease = await ensureNativeDeviceV2TransferLease(session);
  if (!lease) return null;
  const operation = await ensureDeviceUploadOperation({
    meetingId: binding.meetingId,
    operationId: request.operationId,
    recordingAssetId: request.recordingAssetId,
    assetGeneration: request.assetGeneration,
    sourceSha256: request.checksumSha256,
  });
  const bound = await bindDeviceUploadOperationToAsset(
    binding.meetingId,
    request.recordingAssetId,
    operation.operationId,
  );
  if (!bound) throw new Error('录音资产未能绑定上传 operation');
  const workId = await nativeTransfer.enqueueMeetingUpload({
    scope: request.scope,
    credentialScope: lease.scope,
    generation: lease.generation,
    meetingId: binding.meetingId,
    operationId: operation.operationId,
    fileUri: request.fileUri,
    mimeType: request.mimeType,
    recordingAssetId: request.recordingAssetId,
    expectedBytes: request.expectedBytes,
    checksumSha256: request.checksumSha256,
    deviceId: session.deviceId,
    deviceEpochId: session.epochId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    cancelRevision: binding.cancelRevision,
    assetGeneration: request.assetGeneration,
  });
  const attached = await attachDeviceOperationExecutor(
    operation.operationId,
    'workmanager',
    workId,
  );
  if (!attached) throw new Error('上传 WorkManager 执行句柄未能持久化');
  return {
    ...lease,
    workId,
    operationId: operation.operationId,
    protocol: 'device-v2-r2',
  };
}

export async function getNativeMeetingUploadState(workId: string): Promise<NativeUploadState | null> {
  if (!transferAvailable()) return null;
  return nativeTransfer!.getUploadState(workId);
}

export async function cancelNativeMeetingUpload(workId: string): Promise<void> {
  if (!transferAvailable()) return;
  await nativeTransfer!.cancelUpload(workId);
}

export async function deleteNativeMeetingArtifacts(scope: 'guest', meetingId: string): Promise<void> {
  const normalizedScope = scope;
  const normalizedMeetingId = meetingId.trim();
  if (!normalizedScope || !normalizedMeetingId || !transferAvailable()) return;
  await nativeTransfer!.deleteMeetingArtifacts(normalizedScope, normalizedMeetingId);
}

export function resetNativeTransferCoordinatorForTests(): void {
  leases.clear();
  lastGeneration = Date.now();
}
