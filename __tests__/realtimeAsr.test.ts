import * as FileSystem from 'expo-file-system/legacy';
import {
  addNativeRecorderLevelListener,
  addNativeRecorderTranscriptListener,
  pauseNativeRecorder,
  resumeNativeRecorder,
  startLocalNativeRecorder,
  startNativeRecorder,
  stopLocalNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderLevelEvent,
  type NativeRecorderTranscriptEvent,
} from 'laoji-native-platform';
import {
  buildRealtimeAsrHeaders,
  buildRealtimeAsrUrl,
  buildRealtimeWavFileName,
  deleteLocalWavRecording,
  startLocalWavRecording,
  startRealtimeAsr,
} from '../src/services/realtimeAsr';

let transcriptListener: ((event: NativeRecorderTranscriptEvent) => void) | null = null;
let levelListener: ((event: NativeRecorderLevelEvent) => void) | null = null;

jest.mock('../src/services/config', () => ({
  getApiConfig: () => ({
    appEnv: 'development',
    isProduction: false,
    realtimeAsrHost: '203.0.113.10',
    realtimeAsrPort: 18020,
    realtimeAsrSecure: false,
    realtimeAsrProvider: 'qwen',
  }),
}));
jest.mock('laoji-native-platform', () => ({
  hasNativeRecorder: jest.fn(() => true),
  resolveNativeRecorderInsecureDevelopment: jest.fn(() => true),
  assertNativeRecorderDeploymentPolicy: jest.fn(),
  startNativeRecorder: jest.fn(),
  pauseNativeRecorder: jest.fn(),
  resumeNativeRecorder: jest.fn(),
  stopNativeRecorder: jest.fn(),
  startLocalNativeRecorder: jest.fn(),
  stopLocalNativeRecorder: jest.fn(),
  addNativeRecorderStateListener: jest.fn(() => ({ remove: jest.fn() })),
  addNativeRecorderErrorListener: jest.fn(() => ({ remove: jest.fn() })),
  addNativeRecorderTranscriptListener: jest.fn((listener: (event: NativeRecorderTranscriptEvent) => void) => {
    transcriptListener = listener;
    return { remove: jest.fn() };
  }),
  addNativeRecorderLevelListener: jest.fn((listener: (event: NativeRecorderLevelEvent) => void) => {
    levelListener = listener;
    return { remove: jest.fn() };
  }),
}));

describe('MIN-AUDIO-001 native realtime ASR facade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transcriptListener = null;
    levelListener = null;
    (startNativeRecorder as jest.Mock).mockResolvedValue({ sessionId: 'meeting-1', state: 'recording' });
    (pauseNativeRecorder as jest.Mock).mockResolvedValue({ sessionId: 'meeting-1', state: 'paused' });
    (resumeNativeRecorder as jest.Mock).mockResolvedValue({ sessionId: 'meeting-1', state: 'recording' });
    (stopNativeRecorder as jest.Mock).mockResolvedValue({
      status: 'completed',
      localSaved: true,
      readyToStop: true,
      localUri: 'file:///data/meeting-1.wav',
      errorCode: null,
      errorMessage: null,
      snapshot: { sessionId: 'meeting-1', state: 'localSaved', asrRequired: true },
    });
    (startLocalNativeRecorder as jest.Mock).mockResolvedValue({ sessionId: 'speaker-1', state: 'recording' });
    (stopLocalNativeRecorder as jest.Mock).mockResolvedValue({
      status: 'completed',
      localSaved: true,
      readyToStop: true,
      localUri: 'file:///data/speaker-1.wav',
      errorCode: null,
      errorMessage: null,
      snapshot: { sessionId: 'speaker-1', state: 'localSaved', asrRequired: false },
    });
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  });

  it('builds Qwen meeting and schedule URLs without credentials in the query', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'meeting/a',
      host: 'https://asr.example.com:9443/',
      secure: true,
    })).toBe('wss://asr.example.com:9443/ws/meeting/meeting%2Fa/qwen');
    expect(buildRealtimeAsrUrl({
      meetingId: 'schedule-1',
      host: 'asr.example.com',
      purpose: 'schedule',
    })).toBe('ws://asr.example.com:18020/ws/laoji/schedule/schedule-1/qwen');
    expect(buildRealtimeAsrHeaders({ accessToken: 'account-token' })).toEqual({
      Authorization: 'Bearer account-token',
    });
    expect(buildRealtimeAsrHeaders({ guestToken: 'guest-token' })).toEqual({
      'X-Guest-Session-Token': 'guest-token',
    });
  });

  it('uses one native recorder session and maps only semantic transcript and level events', async () => {
    const statuses: string[] = [];
    const transcripts: string[] = [];
    const levels: number[] = [];
    const session = await startRealtimeAsr({
      meetingId: 'meeting-1',
      purpose: 'meeting',
      guestToken: 'guest-token',
      onStatus: status => statuses.push(status),
      onTranscript: transcript => transcripts.push(transcript.text),
      onAudioStats: stats => levels.push(stats.raw.peak),
    });

    expect(startNativeRecorder).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'meeting-1',
      purpose: 'meeting',
      websocketUrl: 'ws://203.0.113.10:18020/ws/meeting/meeting-1/qwen',
      guestToken: 'guest-token',
      allowInsecureDevelopment: true,
    }));
    transcriptListener?.({
      sessionId: 'meeting-1',
      segmentId: 'segment-1',
      kind: 'final',
      isFinal: true,
      text: '会议开始',
      speakerId: 'speaker_1',
      speakerName: '发言人 1',
      startMs: 100,
      endMs: 900,
      source: 'qwen3-asr',
      purpose: 'meeting',
      receivedAtMs: 1,
    });
    levelListener?.({
      sessionId: 'meeting-1',
      peak: 1200,
      rms: 400,
      normalized: 0.04,
      bytesRecorded: 3200,
      durationMs: 100,
    });
    expect(transcripts).toEqual(['会议开始']);
    expect(levels).toEqual([1200]);

    await session.pause();
    await session.resume();
    await expect(session.stop()).resolves.toBe('file:///data/meeting-1.wav');
    await expect(session.completion).resolves.toEqual({
      reason: 'stopped',
      audioUri: 'file:///data/meeting-1.wav',
    });
    expect(pauseNativeRecorder).toHaveBeenCalledWith('meeting-1');
    expect(resumeNativeRecorder).toHaveBeenCalledWith('meeting-1');
    expect(stopNativeRecorder).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(expect.arrayContaining(['connecting', 'connected', 'recording', 'paused', 'stopping', 'closed']));
  });

  it('returns a locally saved WAV even when ready-to-stop confirmation failed', async () => {
    const failure = new Error('ready_to_stop timeout') as Error & { result?: object };
    failure.result = {
      status: 'failed',
      localSaved: true,
      readyToStop: false,
      localUri: 'file:///data/meeting-timeout.wav',
      errorCode: 'ready_to_stop_timeout',
      errorMessage: 'ready_to_stop timeout',
      snapshot: { sessionId: 'meeting-1', state: 'localSaved', asrRequired: true },
    };
    (stopNativeRecorder as jest.Mock).mockRejectedValueOnce(failure);
    const onError = jest.fn();
    const session = await startRealtimeAsr({ meetingId: 'meeting-1', guestToken: 'guest-token', onError });

    await expect(session.stop()).resolves.toBe('file:///data/meeting-timeout.wav');
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('uses local-only native capture for voiceprint WAVs', async () => {
    const peaks: number[] = [];
    const session = await startLocalWavRecording('speaker-1', stats => peaks.push(stats.raw.peak));
    levelListener?.({
      sessionId: 'speaker-1',
      peak: 900,
      rms: 300,
      normalized: 0.03,
      bytesRecorded: 3200,
      durationMs: 100,
    });

    expect(startLocalNativeRecorder).toHaveBeenCalledWith('speaker-1', { levelIntervalMs: 120 });
    expect(session.fileName).toBe('speaker-1.wav');
    expect(peaks).toEqual([900]);
    await expect(session.stop()).resolves.toBe('file:///data/speaker-1.wav');
  });

  it('normalizes idempotent WAV deletion and safe file names', async () => {
    expect(buildRealtimeWavFileName('meeting/2026 07')).toBe('meeting_2026_07.wav');
    await deleteLocalWavRecording('/data/user/0/speaker.wav');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///data/user/0/speaker.wav',
      { idempotent: true },
    );
  });
});
