import {
  hasNativeTransfer,
  nativeTransfer,
  type NativeUploadState,
} from 'laoji-native-platform';
import { getApiConfig } from '../services/config';

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
}

interface LeaseRecord extends NativeTransferLease {
  apiBaseUrl: string;
  accessToken: string;
  ready: Promise<void>;
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
  apiBaseUrl = getApiConfig().meetingApiBase,
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
  return { ...lease, workId, operationId: request.operationId };
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
