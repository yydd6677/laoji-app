import {
  hasNativeTransfer,
  nativeTransfer,
  type NativeUploadState,
} from 'laoji-native-platform';
import { getApiConfig } from '../services/config';
import { ensureRemoteMeetingServiceBinding } from '../services/deviceAuthority';
import { ensureDeviceV2Session, type DeviceV2Session } from '../services/deviceV2Api';

export interface NativeTransferLease {
  scope: string;
  generation: number;
}

export interface NativeMeetingUploadRequest {
  scope: string;
  accessToken: string;
  meetingId: string;
  remoteMeetingId?: string;
  operationId: string;
  fileUri: string;
  mimeType: string;
  fileName: string;
  protocol?: 'legacy' | 'recording-assets-v2';
  recordingAssetId?: string;
  recordingRole?: 'primary' | 'secondary';
  recordingOrigin?: 'captured' | 'imported' | 'recovered';
  expectedBytes?: number | null;
  durationMs?: number | null;
  checksumSha256?: string | null;
}

export interface NativeMeetingUploadRegistration extends NativeTransferLease {
  workId: string;
  operationId: string;
  protocol: 'legacy' | 'recording-assets-v2' | 'device-v2-r2';
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
  fileName: string;
  recordingAssetId: string;
  assetGeneration: string;
  expectedBytes: number;
  checksumSha256: string;
  recordingRole: 'primary' | 'secondary';
  recordingOrigin: 'captured' | 'imported' | 'recovered';
  durationMs?: number | null;
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

/** MIN-UPLOAD-001: establish an encrypted, generation-bound native credential lease. */
export async function ensureNativeTransferLease(
  scope: string,
  accessToken: string,
  apiBaseUrl = getApiConfig().apiBase,
): Promise<NativeTransferLease | null> {
  const normalizedScope = scope.trim();
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
  if (!transferAvailable()) return null;
  if (!normalizedScope || !accessToken || !normalizedBaseUrl) {
    throw new Error('Native transfer credentials are incomplete');
  }

  const existing = leases.get(normalizedScope);
  if (
    existing
    && existing.accessToken === accessToken
    && existing.apiBaseUrl === normalizedBaseUrl
  ) {
    await existing.ready;
    return { scope: existing.scope, generation: existing.generation };
  }

  if (existing) {
    await nativeTransfer!.clearCredentialLease(normalizedScope).catch(() => {});
  }

  const generation = nextGeneration();
  const ready = nativeTransfer!.setCredentialLease(
    normalizedScope,
    generation,
    normalizedBaseUrl,
    accessToken,
  );
  const record: LeaseRecord = {
    scope: normalizedScope,
    generation,
    apiBaseUrl: normalizedBaseUrl,
    accessToken,
    ready,
  };
  leases.set(normalizedScope, record);
  try {
    await ready;
    return { scope: normalizedScope, generation };
  } catch (error) {
    if (leases.get(normalizedScope) === record) leases.delete(normalizedScope);
    throw error;
  }
}

export async function ensureNativeDeviceV2TransferLease(
  session: DeviceV2Session,
): Promise<NativeTransferLease | null> {
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
    return { scope, generation };
  } catch (error) {
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

/** MIN-UPLOAD-001: enqueue durable audio transfer without putting the token in WorkManager input. */
export async function enqueueNativeMeetingUpload(
  request: NativeMeetingUploadRequest,
): Promise<NativeMeetingUploadRegistration | null> {
  const lease = await ensureNativeTransferLease(request.scope, request.accessToken);
  if (!lease || !nativeTransfer) return null;
  const workId = await nativeTransfer.enqueueMeetingUpload({
    scope: lease.scope,
    credentialScope: lease.scope,
    generation: lease.generation,
    meetingId: request.meetingId,
    remoteMeetingId: request.remoteMeetingId?.trim() || request.meetingId,
    operationId: request.operationId,
    fileUri: request.fileUri,
    mimeType: request.mimeType,
    fileName: request.fileName,
    protocol: request.protocol ?? 'legacy',
    recordingAssetId: request.recordingAssetId?.trim() ?? '',
    recordingRole: request.recordingRole ?? 'primary',
    recordingOrigin: request.recordingOrigin ?? 'captured',
    expectedBytes: request.expectedBytes ?? -1,
    durationMs: request.durationMs ?? -1,
    checksumSha256: request.checksumSha256?.trim() ?? '',
  });
  return {
    ...lease,
    workId,
    operationId: request.operationId,
    protocol: request.protocol ?? 'legacy',
  };
}

/**
 * Isolated Stage 2 ingress. Existing callers remain on their explicit v1
 * protocols until the device-v2 capability barrier is enabled.
 */
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
  const workId = await nativeTransfer.enqueueMeetingUpload({
    scope: request.scope,
    credentialScope: lease.scope,
    generation: lease.generation,
    meetingId: binding.meetingId,
    remoteMeetingId: binding.bindingId,
    operationId: request.operationId,
    fileUri: request.fileUri,
    mimeType: request.mimeType,
    fileName: request.fileName,
    protocol: 'device-v2-r2',
    recordingAssetId: request.recordingAssetId,
    recordingRole: request.recordingRole,
    recordingOrigin: request.recordingOrigin,
    expectedBytes: request.expectedBytes,
    durationMs: request.durationMs ?? -1,
    checksumSha256: request.checksumSha256,
    deviceId: session.deviceId,
    deviceEpochId: session.epochId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    cancelRevision: binding.cancelRevision,
    assetGeneration: request.assetGeneration,
  });
  return {
    ...lease,
    workId,
    operationId: request.operationId,
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

export async function deleteNativeMeetingArtifacts(scope: string, meetingId: string): Promise<void> {
  const normalizedScope = scope.trim();
  const normalizedMeetingId = meetingId.trim();
  if (!normalizedScope || !normalizedMeetingId || !transferAvailable()) return;
  await nativeTransfer!.deleteMeetingArtifacts(normalizedScope, normalizedMeetingId);
}

export function resetNativeTransferCoordinatorForTests(): void {
  leases.clear();
  lastGeneration = Date.now();
}
