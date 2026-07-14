import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  createMeetingRecordingFinalizer,
  finalizeMeetingRecording,
  getPendingMeetingAudioUpload,
  listPendingMeetingAudioUploads,
  meetingAudioRetryDelayMs,
  normalizeRecordingUri,
  resetMeetingRecordingStateForTests,
  retryPendingMeetingAudioUpload,
  retryPendingMeetingAudioUploads,
} from '../src/services/meetingRecording';
import { TranscriptLine } from '../src/types';
import { HttpResponseError } from '../src/services/errors';

const lines: TranscriptLine[] = [{ id: '1', text: '讨论发布计划' }];

function dependencies() {
  return {
    saveTranscript: jest.fn(async () => {}),
    uploadAudio: jest.fn(async () => ({})),
    updateStatus: jest.fn(async () => true),
    refreshMeetings: jest.fn(async () => {}),
  };
}

async function flushAsyncOperations() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('meetingRecording', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    resetMeetingRecordingStateForTests();
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

  it('uses capped exponential retry delays and respects the next attempt time', () => {
    expect(meetingAudioRetryDelayMs(1)).toBe(30_000);
    expect(meetingAudioRetryDelayMs(2)).toBe(60_000);
    expect(meetingAudioRetryDelayMs(10_000)).toBe(6 * 60 * 60 * 1000);
    const pending = {
      meetingId: 'meeting-delay',
      audioUri: 'file:///data/delay.wav',
      fileName: 'delay.wav',
      mimeType: 'audio/wav',
      createdAt: '2026-07-14T00:00:00.000Z',
      lastAttemptAt: '2026-07-14T00:00:00.000Z',
      attemptCount: 2,
      uploadState: 'pending' as const,
      nextAttemptAt: '2026-07-14T00:01:00.000Z',
    };
    expect(canAutomaticallyRetryPendingMeetingAudioUpload(pending, Date.parse('2026-07-14T00:00:59.999Z'))).toBe(false);
    expect(canAutomaticallyRetryPendingMeetingAudioUpload(pending, Date.parse('2026-07-14T00:01:00.000Z'))).toBe(true);
    expect(canAutomaticallyRetryPendingMeetingAudioUpload({ ...pending, uploadState: 'blocked' })).toBe(false);
  });

  it('ends an authenticated meeting without waiting for a long audio upload', async () => {
    const deps = dependencies();
    let resolveUpload: (() => void) | undefined;
    deps.uploadAudio.mockImplementationOnce(() => new Promise<object>(resolve => {
      resolveUpload = () => resolve({});
    }));
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
      retryQueued: true,
      uploadInBackground: true,
      statusSyncPending: false,
    });
    expect(deps.saveTranscript).toHaveBeenCalledWith('meeting-1', lines);
    expect(deps.updateStatus).toHaveBeenCalledWith('meeting-1', 'ended', {
      hasTranscript: true,
      audioAvailable: true,
      audioLocalUri: 'file:///data/audio.wav',
      audioSyncPending: true,
      audioSyncBlocked: false,
      audioDurationSec: 65.4,
      audioBars: [0.2, 0.8, 0.4],
      duration: '01:05',
    });
    await flushAsyncOperations();
    expect(deps.uploadAudio).toHaveBeenCalledWith('meeting-1', 'file:///data/audio.wav', 'token-1');
    expect(deps.refreshMeetings).not.toHaveBeenCalled();
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-1')).resolves.toEqual(
      expect.objectContaining({ audioUri: 'file:///data/audio.wav' }),
    );

    resolveUpload?.();
    await flushAsyncOperations();

    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-1')).resolves.toBeNull();
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

    expect(result.uploadFailed).toBe(false);
    expect(result.retryQueued).toBe(true);
    expect(result.uploadInBackground).toBe(true);
    expect(deps.updateStatus).toHaveBeenCalledTimes(1);
    await flushAsyncOperations();
    await expect(getPendingMeetingAudioUpload('user:2', 'meeting-2')).resolves.toEqual(expect.objectContaining({
      meetingId: 'meeting-2',
      audioUri: 'file:///data/audio.wav',
      fileName: 'meeting-2.wav',
      mimeType: 'audio/wav',
      attemptCount: 2,
    }));
  });

  it('waits for native audio shutdown before reporting a transcript persistence failure', async () => {
    const deps = dependencies();
    deps.saveTranscript.mockRejectedValueOnce(new Error('storage full'));
    let resolveStop: ((uri: string) => void) | undefined;
    const stopAudio = jest.fn(() => new Promise<string>(resolve => {
      resolveStop = resolve;
    }));
    let settled = false;

    const pending = finalizeMeetingRecording({
      meetingId: 'meeting-storage-full',
      storageScope: 'guest',
      transcriptLines: lines,
      isGuest: true,
      stopAudio,
    }, deps).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveStop?.('/data/preserved.wav');

    await expect(pending).rejects.toThrow(
      '转写暂时无法保存，录音文件已保留在本机。请检查存储空间后重试',
    );
    expect(deps.uploadAudio).not.toHaveBeenCalled();
    expect(deps.updateStatus).not.toHaveBeenCalled();
  });

  it('captures a final transcript line that arrives during the ASR stop handshake', async () => {
    const deps = dependencies();
    let currentLines = lines;
    const lateLine: TranscriptLine = { id: '2', text: '最后补充下周一发布' };

    await finalizeMeetingRecording({
      meetingId: 'meeting-late-line',
      storageScope: 'guest',
      transcriptLines: currentLines,
      getTranscriptLines: () => currentLines,
      isGuest: true,
      stopAudio: async () => {
        currentLines = [...currentLines, lateLine];
        return '/data/late-line.wav';
      },
    }, deps);

    expect(deps.saveTranscript).toHaveBeenCalledWith('meeting-late-line', [
      lines[0],
      lateLine,
    ]);
    expect(deps.updateStatus).toHaveBeenCalledWith(
      'meeting-late-line',
      'ended',
      expect.objectContaining({ hasTranscript: true }),
    );
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
    await flushAsyncOperations();
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-retry')).resolves.toEqual(
      expect.objectContaining({ attemptCount: 2 }),
    );
    const uploader = jest.fn(async () => ({}));

    await expect(retryPendingMeetingAudioUpload('user:1', 'meeting-retry', 'token-2', uploader)).resolves.toBe(true);

    expect(uploader).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-retry',
      audioUri: 'file:///data/retry.wav',
    }), 'token-2');
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-retry')).resolves.toBeNull();
  });

  it('coalesces concurrent retries for the same account and meeting', async () => {
    const deps = dependencies();
    await finalizeMeetingRecording({
      meetingId: 'meeting-deduped-retry',
      storageScope: 'user:1',
      transcriptLines: lines,
      isGuest: false,
      stopAudio: async () => 'file:///data/deduped.wav',
    }, deps);
    let resolveUpload: (() => void) | undefined;
    const uploader = jest.fn(() => new Promise<object>(resolve => {
      resolveUpload = () => resolve({});
    }));

    const first = retryPendingMeetingAudioUpload('user:1', 'meeting-deduped-retry', 'token-1', uploader);
    const second = retryPendingMeetingAudioUpload('user:1', 'meeting-deduped-retry', 'token-1', uploader);
    await flushAsyncOperations();

    expect(uploader).toHaveBeenCalledTimes(1);
    resolveUpload?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(getPendingMeetingAudioUpload('user:1', 'meeting-deduped-retry')).resolves.toBeNull();
  });

  it('resumes a whole account queue with bounded concurrency and isolates failures', async () => {
    const deps = dependencies();
    for (const meetingId of ['meeting-a', 'meeting-b', 'meeting-c']) {
      await finalizeMeetingRecording({
        meetingId,
        storageScope: 'user:queue',
        transcriptLines: lines,
        isGuest: false,
        stopAudio: async () => `file:///data/${meetingId}.wav`,
      }, deps);
    }
    await expect(listPendingMeetingAudioUploads('user:queue')).resolves.toEqual([
      expect.objectContaining({ meetingId: 'meeting-a' }),
      expect.objectContaining({ meetingId: 'meeting-b' }),
      expect.objectContaining({ meetingId: 'meeting-c' }),
    ]);

    let active = 0;
    let maxActive = 0;
    const uploader = jest.fn(async (pending: { meetingId: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      try {
        if (pending.meetingId === 'meeting-b') throw new Error('one file is temporarily unavailable');
        return {};
      } finally {
        active -= 1;
      }
    });

    await expect(retryPendingMeetingAudioUploads(
      'user:queue',
      'token-queue',
      uploader,
      2,
    )).resolves.toEqual({
      found: 3,
      uploadedIds: ['meeting-a', 'meeting-c'],
      failedIds: ['meeting-b'],
      skippedIds: [],
    });
    expect(maxActive).toBe(2);
    expect(uploader).toHaveBeenCalledTimes(3);
    await expect(listPendingMeetingAudioUploads('user:queue')).resolves.toEqual([
      expect.objectContaining({
        meetingId: 'meeting-b',
        attemptCount: 2,
        uploadState: 'pending',
        failureCode: 'temporary',
        nextAttemptAt: expect.any(String),
      }),
    ]);

    uploader.mockClear();
    await expect(retryPendingMeetingAudioUploads(
      'user:queue',
      'token-queue',
      uploader,
      2,
    )).resolves.toEqual({
      found: 1,
      uploadedIds: [],
      failedIds: [],
      skippedIds: ['meeting-b'],
    });
    expect(uploader).not.toHaveBeenCalled();
  });

  it('blocks permanent upload errors from automatic retries but permits a manual retry', async () => {
    const deps = dependencies();
    await finalizeMeetingRecording({
      meetingId: 'meeting-too-large',
      storageScope: 'user:limits',
      transcriptLines: lines,
      isGuest: false,
      stopAudio: async () => 'file:///data/too-large.wav',
    }, deps);
    const rejectedUploader = jest.fn(async () => {
      throw new HttpResponseError('upload failed: 413', 413, 'too large');
    });

    await expect(retryPendingMeetingAudioUpload(
      'user:limits',
      'meeting-too-large',
      'token-limits',
      rejectedUploader,
    )).rejects.toBeInstanceOf(HttpResponseError);
    await expect(getPendingMeetingAudioUpload('user:limits', 'meeting-too-large')).resolves.toEqual(
      expect.objectContaining({
        uploadState: 'blocked',
        failureCode: 'file_too_large',
        failureMessage: '录音文件超过云端上传上限，仍保存在本机。',
      }),
    );

    rejectedUploader.mockClear();
    await expect(retryPendingMeetingAudioUploads(
      'user:limits',
      'token-limits',
      rejectedUploader,
    )).resolves.toEqual({
      found: 1,
      uploadedIds: [],
      failedIds: [],
      skippedIds: ['meeting-too-large'],
    });
    expect(rejectedUploader).not.toHaveBeenCalled();

    const recoveredUploader = jest.fn(async () => ({}));
    await expect(retryPendingMeetingAudioUpload(
      'user:limits',
      'meeting-too-large',
      'token-limits',
      recoveredUploader,
    )).resolves.toBe(true);
    expect(recoveredUploader).toHaveBeenCalledTimes(1);
    await expect(getPendingMeetingAudioUpload('user:limits', 'meeting-too-large')).resolves.toBeNull();
  });

  it('migrates existing queue records to a retryable state', async () => {
    storage.set('@laoji:pendingMeetingAudioUploads:v2:user:legacy', JSON.stringify({
      'legacy-meeting': {
        meetingId: 'legacy-meeting',
        audioUri: 'file:///data/legacy.wav',
        fileName: 'legacy.wav',
        mimeType: 'audio/wav',
        createdAt: '2026-07-01T00:00:00.000Z',
        lastAttemptAt: '2026-07-01T00:00:00.000Z',
        attemptCount: 3,
      },
    }));

    await expect(getPendingMeetingAudioUpload('user:legacy', 'legacy-meeting')).resolves.toEqual(
      expect.objectContaining({ uploadState: 'pending', failureCode: undefined, nextAttemptAt: undefined }),
    );
  });

  it('deduplicates the same recording across concurrent whole-queue resumes', async () => {
    const deps = dependencies();
    await finalizeMeetingRecording({
      meetingId: 'meeting-shared-batch',
      storageScope: 'user:batch',
      transcriptLines: lines,
      isGuest: false,
      stopAudio: async () => 'file:///data/shared-batch.wav',
    }, deps);
    let finishUpload: (() => void) | undefined;
    const uploader = jest.fn(() => new Promise<object>(resolve => {
      finishUpload = () => resolve({});
    }));

    const first = retryPendingMeetingAudioUploads('user:batch', 'token-batch', uploader);
    const second = retryPendingMeetingAudioUploads('user:batch', 'token-batch', uploader);
    await flushAsyncOperations();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(uploader).toHaveBeenCalledTimes(1);

    finishUpload?.();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.uploadedIds)).toEqual([
      ['meeting-shared-batch'],
      ['meeting-shared-batch'],
    ]);
    await expect(listPendingMeetingAudioUploads('user:batch')).resolves.toEqual([]);
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
      uploadInBackground: false,
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
