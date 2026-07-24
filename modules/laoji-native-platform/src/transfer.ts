import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeUploadState = {
  state: 'enqueued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'missing';
  operationId?: string;
  result?: string;
  reason?: string;
  runAttemptCount?: number;
};

interface NativeTransferModule {
  setCredentialLease(scope: string, generation: number, apiBaseUrl: string, accessToken: string): Promise<void>;
  clearCredentialLease(scope: string): Promise<void>;
  enqueueMeetingUpload(
    scope: string,
    generation: number,
    meetingId: string,
    remoteMeetingId: string,
    operationId: string,
    fileUri: string,
    mimeType: string,
    fileName: string,
  ): Promise<string>;
  getUploadState(workId: string): Promise<NativeUploadState>;
  cancelUpload(workId: string): Promise<void>;
  deleteMeetingArtifacts(scope: string, meetingId: string): Promise<{ deletedFiles: number }>;
}

const transfer = requireOptionalNativeModule<NativeTransferModule>('LaojiTransfer');

export function hasNativeTransfer(): boolean {
  return transfer !== null;
}

export const nativeTransfer = transfer;
