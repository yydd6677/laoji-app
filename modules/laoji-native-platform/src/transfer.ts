import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeUploadState = {
  state: 'enqueued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'missing';
  operationId?: string;
  result?: string;
  reason?: string;
  remoteAssetId?: string;
  remoteRevision?: number;
  runAttemptCount?: number;
};

interface NativeTransferModule {
  setCredentialLease(scope: string, generation: number, apiBaseUrl: string, accessToken: string): Promise<void>;
  clearCredentialLease(scope: string): Promise<void>;
  enqueueMeetingUpload(input: {
    scope: string;
    generation: number;
    meetingId: string;
    remoteMeetingId: string;
    operationId: string;
    fileUri: string;
    mimeType: string;
    fileName: string;
    protocol: 'legacy' | 'recording-assets-v2';
    recordingAssetId: string;
    recordingRole: 'primary' | 'secondary';
    recordingOrigin: 'captured' | 'imported' | 'recovered';
    expectedBytes: number;
    durationMs: number;
    checksumSha256: string;
  }): Promise<string>;
  getUploadState(workId: string): Promise<NativeUploadState>;
  cancelUpload(workId: string): Promise<void>;
  deleteMeetingArtifacts(scope: string, meetingId: string): Promise<{ deletedFiles: number }>;
}

const transfer = requireOptionalNativeModule<NativeTransferModule>('LaojiTransfer');

export function hasNativeTransfer(): boolean {
  return transfer !== null;
}

export const nativeTransfer = transfer;
