jest.mock('react-native-live-audio-stream', () => {
  const subscription = { remove: jest.fn() };
  let dataListener: ((data: string) => void) | null = null;
  return {
    __esModule: true,
    default: {
      init: jest.fn(),
      start: jest.fn(async () => {}),
      pause: jest.fn(async () => {}),
      resume: jest.fn(async () => {}),
      stop: jest.fn(async () => '/data/user/0/meeting-disconnect.wav'),
      on: jest.fn((_event: string, listener: (data: string) => void) => {
        dataListener = listener;
        return subscription;
      }),
      emitData: (data: string) => dataListener?.(data),
      subscription,
    },
  };
});

import {
  applyPcmAutoGain,
  audioSourceForRealtimePurpose,
  base64ToArrayBuffer,
  buildRealtimeAsrHeaders,
  buildRealtimeAsrUrl,
  buildRealtimeWavFileName,
  createRealtimePcmProcessor,
  deleteLocalWavRecording,
  parseRealtimeAsrMessage,
  prepareRealtimePcmFrame,
  selectRealtimeScheduleText,
  startRealtimeAsr,
  waitForRealtimeAsrReady,
} from '../src/services/realtimeAsr';
import * as FileSystem from 'expo-file-system/legacy';

const mockLiveAudioStream = (jest.requireMock('react-native-live-audio-stream') as {
  default: {
    init: jest.Mock;
    start: jest.Mock;
    pause: jest.Mock;
    resume: jest.Mock;
    stop: jest.Mock;
    on: jest.Mock;
    emitData: (data: string) => void;
    subscription: { remove: jest.Mock };
  };
}).default;
const mockAudioSubscription = mockLiveAudioStream.subscription;

describe('realtime ASR helpers', () => {
  it('builds a realtime websocket URL from explicit build configuration', () => {
    expect(buildRealtimeAsrUrl({ meetingId: 'meeting-1', host: 'asr.example.com', port: 18020 })).toBe(
      'ws://asr.example.com:18020/ws/meeting/meeting-1/qwen',
    );
  });

  it('normalizes host protocols and preserves explicit ports', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'a/b',
      provider: 'whisper',
      host: 'https://example.com:9443/',
      secure: true,
    })).toBe('wss://example.com:9443/ws/meeting/a%2Fb/whisper');
  });

  it('uses a separate transient token for guest realtime sessions', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'guest-session-1',
      host: 'asr.example.com',
    })).toBe(
      'ws://asr.example.com:18020/ws/meeting/guest-session-1/qwen',
    );
    expect(buildRealtimeAsrHeaders({ guestToken: 'guest token' })).toEqual({
      'X-Guest-Session-Token': 'guest token',
    });
  });

  it('uses the speaker-free schedule route for one-shot schedule input', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'guest-session-schedule-1',
      host: 'asr.example.com',
      purpose: 'schedule',
    })).toBe(
      'ws://asr.example.com:18020/ws/laoji/schedule/guest-session-schedule-1/qwen',
    );
  });

  it('builds Qwen3-ASR routes for both schedule and meeting test sessions', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'meeting-qwen',
      provider: 'qwen',
      host: 'asr.example.com',
    })).toBe('ws://asr.example.com:18020/ws/meeting/meeting-qwen/qwen');
    expect(buildRealtimeAsrUrl({
      meetingId: 'schedule-qwen',
      provider: 'qwen',
      purpose: 'schedule',
      host: 'asr.example.com',
    })).toBe('ws://asr.example.com:18020/ws/laoji/schedule/schedule-qwen/qwen');
  });

  it('uses speech-recognition capture for schedules and communication capture for meetings', () => {
    expect(audioSourceForRealtimePurpose('schedule')).toBe(6);
    expect(audioSourceForRealtimePurpose('meeting')).toBe(7);
    expect(audioSourceForRealtimePurpose()).toBe(7);
  });

  it('sends authenticated realtime tokens as bearer headers', () => {
    expect(buildRealtimeAsrHeaders({ accessToken: 'account-token' })).toEqual({
      Authorization: 'Bearer account-token',
    });
  });

  it('creates a unique safe WAV file name for each meeting', () => {
    expect(buildRealtimeWavFileName('meeting/2026 07 10')).toBe('meeting_2026_07_10.wav');
    expect(buildRealtimeWavFileName('')).toBe('laoji-realtime.wav');
  });

  it('deletes native WAV recordings through an idempotent normalized file URI', async () => {
    const remove = FileSystem.deleteAsync as jest.Mock;
    remove.mockClear();

    await deleteLocalWavRecording('/data/user/0/com.laoji.app/files/speaker.wav');

    expect(remove).toHaveBeenCalledWith(
      'file:///data/user/0/com.laoji.app/files/speaker.wav',
      { idempotent: true },
    );
  });

  it('decodes base64 PCM chunks to ArrayBuffer', () => {
    const bytes = new Uint8Array(base64ToArrayBuffer('AQIDBA=='));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('parses transcript messages from the realtime ASR server', () => {
    expect(parseRealtimeAsrMessage(JSON.stringify({
      type: 'transcript.completed',
      text: '明天下午三点开会',
      speaker_name: 'speaker_1',
    }))).toEqual(expect.objectContaining({
      type: 'transcript.completed',
      text: '明天下午三点开会',
    }));
  });

  it('ignores non-JSON websocket messages', () => {
    expect(parseRealtimeAsrMessage('not-json')).toBeNull();
    expect(parseRealtimeAsrMessage(new ArrayBuffer(0))).toBeNull();
  });

  it('amplifies quiet PCM frames without clipping int16 samples', () => {
    const input = samplesToBuffer([100, -200, 300, -400]);
    const result = applyPcmAutoGain(input, 12000, 16);
    const output = bufferToSamples(result.buffer);

    expect(result.gain).toBeGreaterThan(1);
    expect(result.sent.peak).toBeGreaterThan(result.raw.peak);
    expect(Math.max(...output)).toBeLessThanOrEqual(32767);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(-32768);
  });

  it('gates low-level schedule noise before automatic gain can amplify it', () => {
    const input = samplesToBuffer([20, -30, 25, -35]);
    const result = prepareRealtimePcmFrame(input, 'schedule');

    expect(result.raw).toEqual({ peak: 35, rms: 28 });
    expect(result.sent).toEqual({ peak: 0, rms: 0 });
    expect(result.gain).toBe(0);
    expect(result.gated).toBe(true);
    expect(bufferToSamples(result.buffer)).toEqual([0, 0, 0, 0]);
  });

  it('keeps the meeting stream ungated and preserves schedule speech transients', () => {
    const quietMeeting = prepareRealtimePcmFrame(samplesToBuffer([20, -30, 25, -35]), 'meeting');
    const speechTransient = prepareRealtimePcmFrame(samplesToBuffer([0, 300, 0, -300]), 'schedule');

    expect(quietMeeting.gated).toBe(false);
    expect(quietMeeting.sent.peak).toBeGreaterThan(0);
    expect(speechTransient.gated).toBe(false);
    expect(speechTransient.sent.peak).toBeGreaterThan(speechTransient.raw.peak);
  });

  it('keeps low-level schedule speech that would otherwise be erased before auto gain', () => {
    const lowSpeech = samplesToBuffer([
      90, -90,
      ...Array.from({ length: 18 }, () => 0),
    ]);
    const result = prepareRealtimePcmFrame(lowSpeech, 'schedule');

    expect(result.raw).toEqual({ peak: 90, rms: 28 });
    expect(result.gated).toBe(false);
    expect(result.gain).toBeGreaterThan(1);
    expect(result.sent.peak).toBeGreaterThan(result.raw.peak);
  });

  it('buffers schedule PCM long enough to preserve speech onset frames', () => {
    const processor = createRealtimePcmProcessor('schedule');
    const quiet = samplesToBuffer([20, -20, 15, -15]);
    const speech = samplesToBuffer([0, 300, 0, -300]);

    expect(processor.push(quiet)).toEqual([]);
    expect(processor.push(quiet)).toEqual([]);
    expect(processor.push(quiet)).toEqual([]);
    const [preRoll] = processor.push(speech);

    expect(preRoll.gated).toBe(false);
    expect(preRoll.raw.peak).toBe(20);
    expect(preRoll.gain).toBeGreaterThan(20);
  });

  it('uses client gating without Android noise suppression for schedule capture', async () => {
    jest.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    mockLiveAudioStream.init.mockClear();
    mockLiveAudioStream.start.mockClear();
    mockLiveAudioStream.stop.mockResolvedValueOnce('/data/user/0/schedule-low-level.wav');
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    try {
      const sessionPromise = startRealtimeAsr({
        meetingId: 'schedule-low-level',
        purpose: 'schedule',
        host: 'asr.example.com',
      });
      const socket = MockWebSocket.instances[0];
      socket.open();
      await jest.advanceTimersByTimeAsync(350);
      const session = await sessionPromise;

      expect(mockLiveAudioStream.init).toHaveBeenCalledWith(expect.objectContaining({
        audioSource: 6,
        enableAutomaticGainControl: true,
        enableNoiseSuppressor: false,
      }));

      const stopping = session.stop();
      socket.message(JSON.stringify({ type: 'ready_to_stop' }));
      await expect(stopping).resolves.toBe('/data/user/0/schedule-low-level.wav');
    } finally {
      globalThis.WebSocket = originalWebSocket;
      jest.useRealTimers();
    }
  });

  it('pauses native capture and drops any buffered PCM until recording resumes', async () => {
    jest.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    mockLiveAudioStream.pause.mockClear();
    mockLiveAudioStream.resume.mockClear();
    mockLiveAudioStream.stop.mockResolvedValueOnce('/data/user/0/meeting-paused.wav');
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const statuses: string[] = [];

    try {
      const sessionPromise = startRealtimeAsr({
        meetingId: 'meeting-paused',
        host: 'asr.example.com',
        onStatus: status => statuses.push(status),
      });
      const socket = MockWebSocket.instances[0];
      socket.open();
      await jest.advanceTimersByTimeAsync(350);
      const session = await sessionPromise;

      const beforeLiveFrame = socket.sent.length;
      mockLiveAudioStream.emitData('AQIDBA==');
      expect(socket.sent).toHaveLength(beforeLiveFrame + 1);

      await session.pause();
      expect(mockLiveAudioStream.pause).toHaveBeenCalledTimes(1);
      expect(statuses.at(-1)).toBe('paused');
      const beforePausedFrame = socket.sent.length;
      mockLiveAudioStream.emitData('BQYHCA==');
      expect(socket.sent).toHaveLength(beforePausedFrame);

      await session.resume();
      expect(mockLiveAudioStream.resume).toHaveBeenCalledTimes(1);
      expect(statuses.at(-1)).toBe('recording');
      mockLiveAudioStream.emitData('CQoLDA==');
      expect(socket.sent).toHaveLength(beforePausedFrame + 1);

      const stopping = session.stop();
      socket.message(JSON.stringify({ type: 'ready_to_stop' }));
      await expect(stopping).resolves.toBe('/data/user/0/meeting-paused.wav');
    } finally {
      globalThis.WebSocket = originalWebSocket;
      jest.useRealTimers();
    }
  });

  it('keeps five schedule frames after speech and then closes the gate', () => {
    const processor = createRealtimePcmProcessor('schedule');
    const quiet = samplesToBuffer([20, -20, 15, -15]);
    const speech = samplesToBuffer([0, 300, 0, -300]);
    const inputs = [quiet, quiet, quiet, speech, ...Array.from({ length: 9 }, () => quiet)];
    const outputs = inputs.flatMap(frame => processor.push(frame)).concat(processor.flush());

    expect(outputs).toHaveLength(inputs.length);
    expect(outputs.slice(0, 9).every(frame => !frame.gated)).toBe(true);
    expect(outputs.slice(9).every(frame => frame.gated)).toBe(true);
    expect(new Set(outputs.slice(0, 9).map(frame => frame.gain)).size).toBe(1);
  });

  it('continues rejecting sustained schedule silence after the lookahead window', () => {
    const processor = createRealtimePcmProcessor('schedule');
    const quiet = samplesToBuffer([20, -20, 15, -15]);
    const inputs = Array.from({ length: 10 }, () => quiet);
    const outputs = inputs.flatMap(frame => processor.push(frame)).concat(processor.flush());

    expect(outputs).toHaveLength(inputs.length);
    expect(outputs.every(frame => frame.gated && frame.sent.peak === 0)).toBe(true);
  });

  it('does not delay or gate meeting PCM', () => {
    const processor = createRealtimePcmProcessor('meeting');
    const [output] = processor.push(samplesToBuffer([20, -20, 15, -15]));

    expect(output.gated).toBe(false);
    expect(processor.flush()).toEqual([]);
  });

  it('selects the most schedule-like realtime transcript chunk', () => {
    expect(selectRealtimeScheduleText([
      '没有没有没有没有没有证据。',
      '下午三点开会。',
      '下午三十点开会。',
    ])).toBe('下午三点开会');
  });

  it('prefers a transcript refinement that restores the date phrase', () => {
    expect(selectRealtimeScheduleText([
      '下午三点开会。',
      '明天下午三点开会。',
    ])).toBe('明天下午三点开会');
  });

  it('prefers the latest equivalent schedule candidate while recording', () => {
    expect(selectRealtimeScheduleText([
      '下午三点开会。',
      '下午四点开会。',
    ])).toBe('下午四点开会');
  });

  it('repairs common clipped temporal prefixes from realtime ASR', () => {
    expect(selectRealtimeScheduleText(['天下午三点开会。'])).toBe('明天下午三点开会');
    expect(selectRealtimeScheduleText(['午三点开会。'])).toBe('下午三点开会');
  });

  it('signals an unexpected close immediately and stops native audio exactly once', async () => {
    jest.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    MockWebSocket.instances = [];
    mockLiveAudioStream.init.mockClear();
    mockLiveAudioStream.start.mockClear();
    mockLiveAudioStream.stop.mockClear();
    mockLiveAudioStream.on.mockClear();
    mockAudioSubscription.remove.mockClear();
    let resolveAudioStop = (_uri: string) => {};
    mockLiveAudioStream.stop.mockImplementationOnce(() => new Promise<string>(resolve => {
      resolveAudioStop = resolve;
    }));
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    try {
      const sessionPromise = startRealtimeAsr({
        meetingId: 'meeting-disconnect',
        host: 'asr.example.com',
        connectionTimeoutMs: 2000,
      });
      const socket = MockWebSocket.instances[0];
      socket.open();
      await jest.advanceTimersByTimeAsync(350);
      const session = await sessionPromise;

      socket.message(JSON.stringify({ type: 'transcript.completed', text: '不应写入生产日志' }));
      socket.remoteClose();

      await expect(session.completion).resolves.toEqual({
        reason: 'connection-closed',
        audioUri: undefined,
      });
      const stoppedAudio = session.stop();
      resolveAudioStop('/data/user/0/meeting-disconnect.wav');
      await expect(stoppedAudio).resolves.toBe('/data/user/0/meeting-disconnect.wav');
      expect(mockLiveAudioStream.stop).toHaveBeenCalledTimes(1);
      expect(mockAudioSubscription.remove).toHaveBeenCalledTimes(1);
      expect(info.mock.calls.flat().join(' ')).not.toContain('不应写入生产日志');
    } finally {
      globalThis.WebSocket = originalWebSocket;
      info.mockRestore();
      jest.useRealTimers();
    }
  });

  it('waits for native recorder cleanup before rejecting startup and allowing a retry', async () => {
    jest.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    MockWebSocket.instances = [];
    let resolveFirstStop = (_uri: string) => {};
    mockLiveAudioStream.start.mockReset()
      .mockRejectedValueOnce(new Error('native start failed'))
      .mockResolvedValueOnce(undefined);
    mockLiveAudioStream.stop.mockReset()
      .mockImplementationOnce(() => new Promise<string>(resolve => {
        resolveFirstStop = resolve;
      }))
      .mockResolvedValueOnce('/data/user/0/retry.wav');
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    try {
      let firstSettled = false;
      const first = startRealtimeAsr({ meetingId: 'startup-cleanup-1', host: 'asr.example.com' });
      void first.catch(() => { firstSettled = true; });
      MockWebSocket.instances[0].open();
      await jest.advanceTimersByTimeAsync(350);

      expect(mockLiveAudioStream.stop).toHaveBeenCalledTimes(1);
      expect(firstSettled).toBe(false);

      resolveFirstStop('/data/user/0/failed-start.wav');
      await expect(first).rejects.toThrow('native start failed');

      const retry = startRealtimeAsr({ meetingId: 'startup-cleanup-2', host: 'asr.example.com' });
      const retrySocket = MockWebSocket.instances[1];
      retrySocket.open();
      await jest.advanceTimersByTimeAsync(350);
      const retrySession = await retry;
      const stopping = retrySession.stop();
      retrySocket.message(JSON.stringify({ type: 'ready_to_stop' }));
      await expect(stopping).resolves.toBe('/data/user/0/retry.wav');
    } finally {
      globalThis.WebSocket = originalWebSocket;
      mockLiveAudioStream.start.mockReset().mockResolvedValue(undefined);
      mockLiveAudioStream.stop.mockReset().mockResolvedValue('/data/user/0/meeting-disconnect.wav');
      info.mockRestore();
      jest.useRealTimers();
    }
  });

  it('rejects a stop wait when ready_to_stop misses the deadline', async () => {
    jest.useFakeTimers();
    const pending = new Promise<void>(() => {});

    try {
      const wait = waitForRealtimeAsrReady(pending, 500);
      const assertion = expect(wait).rejects.toThrow('realtime ASR stop timed out after 500 ms');
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a websocket stop timeout instead of silently treating it as ready', async () => {
    jest.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    mockLiveAudioStream.init.mockClear();
    mockLiveAudioStream.start.mockClear();
    mockLiveAudioStream.stop.mockClear();
    mockLiveAudioStream.on.mockClear();
    mockAudioSubscription.remove.mockClear();
    const onError = jest.fn();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    try {
      const sessionPromise = startRealtimeAsr({
        meetingId: 'meeting-stop-timeout',
        host: 'asr.example.com',
        connectionTimeoutMs: 2000,
        stopTimeoutMs: 500,
        onError,
      });
      const socket = MockWebSocket.instances[0];
      socket.open();
      await jest.advanceTimersByTimeAsync(350);
      const session = await sessionPromise;

      const stopping = session.stop();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(500);
      await expect(stopping).resolves.toBe('/data/user/0/meeting-disconnect.wav');
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: 'realtime ASR stop timed out after 500 ms',
      }));
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      jest.useRealTimers();
    }
  });
});

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }

  remoteClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function samplesToBuffer(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return buffer;
}

function bufferToSamples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const samples: number[] = [];
  for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}
