import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createMeetingRecordingFinalizer,
  finalizeMeetingRecording,
  getPendingMeetingAudioUpload,
  normalizeRecordingUri,
  retryPendingMeetingAudioUpload,
} from '../src/services/meetingRecording';
import { TranscriptLine } from '../src/types';

const lines: TranscriptLine[] = [{ id: '1', text: '讨论发布计划' }];

function dependencies() {
  return {
    saveTranscript: jest.fn(async () => {}),
    uploadAudio: jest.fn(async () => ({})),
    updateStatus: jest.fn(async () => true),
    refreshMeetings: jest.fn(async () => {}),
  };
}

describe('meetingRecording', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
  });

  it('normalizes native recorder paths without changing content URIs', () => {
    expect(normalizeRecordingUri('/data/user/0/audio.wav')).toBe('file:///data/user/0/audio.wav');
    expect(normalizeRecordingUri('content://media/audio/1')).toBe('content://media/audio/1');
    expect(normalizeRecordingUri(undefined)).toBeUndefined();
  });

  it('persists, uploads, ends, and refreshes an authenticated recording', async () => {
    const deps = dependencies();
    const result = await finalizeMeetingRecording({
      meetingId: 'meeting-1',
      storageScope: 'user:1',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-1',
      audioDurationSec: 65.4,
      audioBars: [0.2, 0.8, 0.4],
      stopAudio: async () => '/data/audio.wav',
    }, deps);

    expect(result).toEqual({
      audioUri: 'file:///data/audio.wav',
      uploadFailed: false,
      retryQueued: false,
      statusSyncPending: false,
    });
    expect(deps.saveTranscript).toHaveBeenCalledWith('meeting-1', lines);
    expect(deps.uploadAudio).toHaveBeenCalledWith('meeting-1', 'file:///data/audio.wav', 'token-1');
    expect(deps.updateStatus).toHaveBeenCalledWith('meeting-1', 'ended', {
      hasTranscript: true,
      audioAvailable: true,
      audioLocalUri: 'file:///data/audio.wav',
      audioDurationSec: 65.4,
      audioBars: [0.2, 0.8, 0.4],
      duration: '01:05',
    });
    expect(deps.refreshMeetings).toHaveBeenCalledTimes(1);
  });

  it('keeps the local meeting usable when cloud audio upload fails', async () => {
    const deps = dependencies();
    deps.uploadAudio.mockRejectedValueOnce(new Error('offline'));
    const result = await finalizeMeetingRecording({
      meetingId: 'meeting-2',
      storageScope: 'user:2',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-2',
      stopAudio: async () => 'file:///data/audio.wav',
    }, deps);

    expect(result.uploadFailed).toBe(true);
    expect(result.retryQueued).toBe(true);
    expect(deps.updateStatus).toHaveBeenCalledTimes(1);
    await expect(getPendingMeetingAudioUpload('user:2', 'meeting-2')).resolves.toEqual(expect.objectContaining({
      meetingId: 'meeting-2',
      audioUri: 'file:///data/audio.wav',
      fileName: 'meeting-2.wav',
      mimeType: 'audio/wav',
      attemptCount: 1,
    }));
  });

  it('retries a persisted audio upload and clears it only after success', async () => {
    const deps = dependencies();
    deps.uploadAudio.mockRejectedValueOnce(new Error('offline'));
    await finalizeMeetingRecording({
      meetingId: 'meeting-retry',
      storageScope: 'user:1',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-1',
      stopAudio: async () => 'file:///data/retry.wav',
    }, deps);
    const uploader = jest.fn(async () => ({}));

    await expect(retryPendingMeetingAudioUpload('user:1', 'meeting-retry', 'token-2', uploader)).resolves.toBe(true);

    expect(uploader).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-retry',
      audioUri: 'file:///data/retry.wav',
    }), 'token-2');
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-retry')).resolves.toBeNull();
  });

  it('keeps pending audio upload records isolated by account scope', async () => {
    const deps = dependencies();
    deps.uploadAudio.mockRejectedValueOnce(new Error('offline'));
    await finalizeMeetingRecording({
      meetingId: 'same-meeting-id',
      storageScope: 'user:A',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-A',
      stopAudio: async () => 'file:///data/account-a.wav',
    }, deps);

    await expect(getPendingMeetingAudioUpload('user:A', 'same-meeting-id')).resolves.toEqual(
      expect.objectContaining({ audioUri: 'file:///data/account-a.wav' }),
    );
    await expect(getPendingMeetingAudioUpload('user:B', 'same-meeting-id')).resolves.toBeNull();
  });

  it('reports when a failed upload could not be added to the durable retry queue', async () => {
    const deps = dependencies();
    deps.uploadAudio.mockRejectedValue(new Error('offline'));
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('storage full'));

    const result = await finalizeMeetingRecording({
      meetingId: 'meeting-no-retry',
      storageScope: 'user:1',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-1',
      stopAudio: async () => 'file:///data/no-retry.wav',
    }, deps);

    expect(result).toEqual(expect.objectContaining({
      audioUri: 'file:///data/no-retry.wav',
      uploadFailed: true,
      retryQueued: false,
      statusSyncPending: false,
    }));
    expect(deps.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('surfaces a corrupted pending upload registry instead of pretending it is empty', async () => {
    storage.set('@laoji:pendingMeetingAudioUploads:v2:user:1', '{not-json');
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-1')).rejects.toThrow();
  });

  it('keeps the final local state and skips an overwriting refresh while status sync is pending', async () => {
    const deps = dependencies();
    deps.updateStatus.mockResolvedValue(false);

    const result = await finalizeMeetingRecording({
      meetingId: 'meeting-status-pending',
      storageScope: 'user:1',
      transcriptLines: lines,
      isGuest: false,
      accessToken: 'token-1',
      stopAudio: async () => 'file:///data/status-pending.wav',
    }, deps);

    expect(result.statusSyncPending).toBe(true);
    expect(deps.refreshMeetings).not.toHaveBeenCalled();
  });

  it('runs a successful finalizer once for concurrent and repeated callers', async () => {
    const deps = dependencies();
    const stopAudio = jest.fn(async () => 'file:///data/once.wav');
    const finalize = createMeetingRecordingFinalizer(() => finalizeMeetingRecording({
      meetingId: 'meeting-once',
      storageScope: 'guest',
      transcriptLines: lines,
      isGuest: true,
      stopAudio,
    }, deps));

    const [first, second] = await Promise.all([finalize(), finalize()]);
    const third = await finalize();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(deps.saveTranscript).toHaveBeenCalledTimes(1);
    expect(deps.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps guest audio and transcript local without cloud calls', async () => {
    const deps = dependencies();
    await finalizeMeetingRecording({
      meetingId: 'guest-1',
      storageScope: 'guest',
      transcriptLines: [],
      isGuest: true,
      stopAudio: async () => '/data/guest.wav',
    }, deps);

    expect(deps.uploadAudio).not.toHaveBeenCalled();
    expect(deps.refreshMeetings).not.toHaveBeenCalled();
    expect(deps.updateStatus).toHaveBeenCalledWith('guest-1', 'ended', expect.objectContaining({
      hasTranscript: false,
      audioAvailable: true,
    }));
  });
});
