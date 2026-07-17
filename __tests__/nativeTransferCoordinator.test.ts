jest.mock('laoji-native-platform', () => ({
  hasNativeTransfer: () => true,
  nativeTransfer: {
    setCredentialLease: jest.fn(async () => undefined),
    clearCredentialLease: jest.fn(async () => undefined),
    enqueueMeetingUpload: jest.fn(async () => 'work-1'),
    getUploadState: jest.fn(async () => ({ state: 'running' })),
    cancelUpload: jest.fn(async () => undefined),
    deleteMeetingArtifacts: jest.fn(async () => ({ deletedFiles: 2 })),
  },
}));

import { nativeTransfer } from 'laoji-native-platform';
import {
  clearNativeTransferLease,
  deleteNativeMeetingArtifacts,
  enqueueNativeMeetingUpload,
  ensureNativeTransferLease,
  resetNativeTransferCoordinatorForTests,
} from '../src/native/nativeTransferCoordinator';

const transfer = nativeTransfer as NonNullable<typeof nativeTransfer> & {
  setCredentialLease: jest.Mock;
  clearCredentialLease: jest.Mock;
  enqueueMeetingUpload: jest.Mock;
  deleteMeetingArtifacts: jest.Mock;
};

describe('native transfer coordinator [MIN-UPLOAD-001]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNativeTransferCoordinatorForTests();
  });

  it('reuses one encrypted credential generation for the same session', async () => {
    const first = await ensureNativeTransferLease('user:1', 'token-1', 'https://meeting.example.com/');
    const second = await ensureNativeTransferLease('user:1', 'token-1', 'https://meeting.example.com');

    expect(second).toEqual(first);
    expect(transfer.setCredentialLease).toHaveBeenCalledTimes(1);
    expect(transfer.setCredentialLease).toHaveBeenCalledWith(
      'user:1',
      first?.generation,
      'https://meeting.example.com',
      'token-1',
    );
  });

  it('cancels the old account queue before rotating a token', async () => {
    const first = await ensureNativeTransferLease('user:1', 'token-1', 'https://meeting.example.com');
    const second = await ensureNativeTransferLease('user:1', 'token-2', 'https://meeting.example.com');

    expect(transfer.clearCredentialLease).toHaveBeenCalledWith('user:1');
    expect(second!.generation).toBeGreaterThan(first!.generation);
  });

  it('keeps the bearer token out of WorkManager input and clears work on logout', async () => {
    const registration = await enqueueNativeMeetingUpload({
      scope: 'user:7',
      accessToken: 'secret-token',
      meetingId: 'meeting-7',
      operationId: 'operation-7',
      fileUri: 'file:///data/meeting-7.wav',
      mimeType: 'audio/wav',
      fileName: 'meeting-7.wav',
      expectedBytes: 42,
    });

    expect(registration).toEqual(expect.objectContaining({
      scope: 'user:7',
      workId: 'work-1',
      operationId: 'operation-7',
    }));
    expect(transfer.enqueueMeetingUpload).toHaveBeenCalledWith(
      'user:7',
      registration?.generation,
      'meeting-7',
      'operation-7',
      'file:///data/meeting-7.wav',
      'audio/wav',
      'meeting-7.wav',
      42,
    );
    expect(transfer.enqueueMeetingUpload.mock.calls.flat()).not.toContain('secret-token');

    await clearNativeTransferLease('user:7');
    expect(transfer.clearCredentialLease).toHaveBeenCalledWith('user:7');
  });

  it('delegates meeting deletion to the native work and journal owner', async () => {
    await deleteNativeMeetingArtifacts('guest', 'meeting-delete');
    expect(transfer.deleteMeetingArtifacts).toHaveBeenCalledWith('guest', 'meeting-delete');
  });
});
