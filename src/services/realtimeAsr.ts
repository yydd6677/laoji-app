import * as FileSystem from 'expo-file-system/legacy';
import { getApiConfig } from './config';
import { diagnosticInfo, diagnosticWarn } from './diagnostics';

declare const require: (moduleName: string) => unknown;

const DEFAULT_PORT = 18020;
const DEFAULT_PROVIDER: RealtimeAsrProvider = 'funasr';
const DEFAULT_BUFFER_SIZE = 3200;
const VOICE_RECOGNITION_AUDIO_SOURCE = 6;
const VOICE_COMMUNICATION_AUDIO_SOURCE = 7;
const INITIAL_SILENCE_FRAMES = 3;
const TARGET_PCM_PEAK = 8000;
const MAX_AUTO_GAIN = 20;
const SCHEDULE_MAX_AUTO_GAIN = 40;
const SCHEDULE_NOISE_GATE_PEAK = 64;
const SCHEDULE_NOISE_GATE_RMS = 32;
const SCHEDULE_GATE_LOOKAHEAD_FRAMES = 3;
const SCHEDULE_GATE_HANGOVER_FRAMES = 5;

let activeAudioOwner: symbol | null = null;

export type RealtimeAsrProvider = 'funasr' | 'whisper' | 'qwen';
export type RealtimeAsrPurpose = 'meeting' | 'schedule';
export type RealtimeAsrStatus = 'connecting' | 'connected' | 'recording' | 'stopping' | 'closed';

export interface RealtimeAsrTranscript {
  text: string;
  speakerName?: string;
  startTime?: number;
  endTime?: number;
  raw: Record<string, unknown>;
}

export interface PcmStats {
  peak: number;
  rms: number;
}

export interface RealtimeAsrAudioStats {
  frameCount: number;
  byteCount: number;
  raw: PcmStats;
  sent: PcmStats;
  gain: number;
  gated: boolean;
}

export interface PreparedRealtimePcmFrame {
  buffer: ArrayBuffer;
  raw: PcmStats;
  sent: PcmStats;
  gain: number;
  gated: boolean;
}

export interface RealtimePcmProcessor {
  push: (buffer: ArrayBuffer) => PreparedRealtimePcmFrame[];
  flush: () => PreparedRealtimePcmFrame[];
}

export interface RealtimeAsrCompletion {
  reason: 'stopped' | 'connection-closed';
  audioUri?: string;
}

export interface RealtimeAsrSession {
  meetingId: string;
  url: string;
  completion: Promise<RealtimeAsrCompletion>;
  stop: () => Promise<string | undefined>;
}

export interface LocalWavRecordingSession {
  fileName: string;
  stop: () => Promise<string>;
}

export interface StartRealtimeAsrOptions {
  meetingId?: string;
  provider?: RealtimeAsrProvider;
  purpose?: RealtimeAsrPurpose;
  host?: string;
  port?: number;
  secure?: boolean;
  accessToken?: string | null;
  guestToken?: string | null;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  onStatus?: (status: RealtimeAsrStatus) => void;
  onTranscript?: (transcript: RealtimeAsrTranscript) => void;
  onAudioStats?: (stats: RealtimeAsrAudioStats) => void;
  onError?: (error: Error) => void;
}

interface LiveAudioStreamModule {
  init: (options: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource?: number;
    enableAutomaticGainControl?: boolean;
    enableNoiseSuppressor?: boolean;
    skipInitialBuffers?: number;
    wavFile: string;
    bufferSize?: number;
  }) => void;
  start: () => void;
  stop: () => Promise<string> | string | void;
  on: (event: 'data', callback: (base64Pcm: string) => void) => { remove?: () => void } | void;
}

interface RealtimeAsrMessage {
  type?: string;
  text?: string;
  speaker_name?: string;
  speaker_id?: string;
  start_time?: number;
  end_time?: number;
  [key: string]: unknown;
}

export function createRealtimeMeetingId(): string {
  return `laoji-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildRealtimeWavFileName(meetingId: string): string {
  const safe = meetingId.replace(/[^A-Za-z0-9_-]/g, '_') || 'laoji-realtime';
  return `${safe}.wav`;
}

export async function deleteLocalWavRecording(uri: string | undefined): Promise<void> {
  if (!uri) return;
  const normalized = uri.startsWith('file://') || uri.startsWith('content://')
    ? uri
    : `file://${uri}`;
  await FileSystem.deleteAsync(normalized, { idempotent: true });
}

export function buildRealtimeAsrUrl({
  meetingId,
  provider = DEFAULT_PROVIDER,
  purpose = 'meeting',
  host,
  port = DEFAULT_PORT,
  secure = false,
}: {
  meetingId: string;
  provider?: RealtimeAsrProvider;
  purpose?: RealtimeAsrPurpose;
  host: string;
  port?: number;
  secure?: boolean;
}): string {
  const cleanHost = host.trim();
  if (!cleanHost) throw new Error('realtime ASR host is not configured');
  const protocol = secure ? 'wss' : 'ws';
  const normalizedHost = cleanHost
    .replace(/^https?:\/\//, '')
    .replace(/^wss?:\/\//, '')
    .replace(/\/+$/, '');
  const hostWithPort = normalizedHost.includes(':') ? normalizedHost : `${normalizedHost}:${port}`;
  const route = purpose === 'schedule'
    ? `/ws/laoji/schedule/${encodeURIComponent(meetingId)}/${provider}`
    : `/ws/meeting/${encodeURIComponent(meetingId)}/${provider}`;
  return `${protocol}://${hostWithPort}${route}`;
}

export function buildRealtimeAsrHeaders({
  accessToken,
  guestToken,
}: Pick<StartRealtimeAsrOptions, 'accessToken' | 'guestToken'>): Record<string, string> {
  if (accessToken) return { Authorization: `Bearer ${accessToken}` };
  if (guestToken) return { 'X-Guest-Session-Token': guestToken };
  return {};
}

export function audioSourceForRealtimePurpose(
  purpose: RealtimeAsrPurpose = 'meeting',
): number {
  return purpose === 'schedule'
    ? VOICE_RECOGNITION_AUDIO_SOURCE
    : VOICE_COMMUNICATION_AUDIO_SOURCE;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  const bytes = decodeBase64ToBytes(base64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function waitForRealtimeAsrReady(
  readyPromise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readyPromise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`realtime ASR stop timed out after ${timeoutMs} ms`));
        }, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function startRealtimeAsr(
  options: StartRealtimeAsrOptions = {},
): Promise<RealtimeAsrSession> {
  const audioStream = loadLiveAudioStream();
  const apiConfig = getApiConfig();
  const meetingId = options.meetingId ?? createRealtimeMeetingId();
  const url = buildRealtimeAsrUrl({
    meetingId,
    provider: options.provider ?? DEFAULT_PROVIDER,
    purpose: options.purpose ?? 'meeting',
    host: options.host ?? apiConfig.realtimeAsrHost,
    port: options.port ?? apiConfig.realtimeAsrPort,
    secure: options.secure ?? apiConfig.realtimeAsrSecure,
  });
  const websocketHeaders = buildRealtimeAsrHeaders(options);
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 8000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10000;
  const audioOwner = Symbol(meetingId);
  const pcmProcessor = createRealtimePcmProcessor(options.purpose ?? 'meeting');

  if (activeAudioOwner) {
    throw new Error('realtime ASR microphone is already in use');
  }
  activeAudioOwner = audioOwner;

  diagnosticInfo(`[LaoJi ASR] connecting ${maskRealtimeUrl(url)}`);
  options.onStatus?.('connecting');

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let audioStarted = false;
    let stoppedAudioUri: string | undefined;
    let audioCleanupPromise: Promise<string | undefined> | null = null;
    let frameCount = 0;
    let byteCount = 0;
    let audioSubscription: { remove?: () => void } | void;
    let resolveReady = () => {};
    const readyPromise = new Promise<void>(readyResolve => {
      resolveReady = readyResolve;
    });
    let completionSettled = false;
    let resolveCompletion = (_completion: RealtimeAsrCompletion) => {};
    const completion = new Promise<RealtimeAsrCompletion>(completionResolve => {
      resolveCompletion = completionResolve;
    });

    let ws: WebSocket;
    try {
      ws = createRealtimeWebSocket(url, websocketHeaders);
    } catch (error) {
      activeAudioOwner = null;
      reject(toError(error, 'realtime ASR websocket initialization failed'));
      return;
    }
    const timeoutId = setTimeout(() => {
      failBeforeOpen(new Error('realtime ASR connection timed out'));
      closeWebSocket(ws);
    }, connectionTimeoutMs);

    const session: RealtimeAsrSession = {
      meetingId,
      url,
      completion,
      stop: async () => {
        if (stopped) {
          return audioCleanupPromise ? await audioCleanupPromise : stoppedAudioUri;
        }
        stopped = true;
        options.onStatus?.('stopping');
        const audioUri = await cleanupOwnedAudio();
        stoppedAudioUri = audioUri;

        if (ws.readyState === WebSocket.OPEN) {
          try {
            pcmProcessor.flush().forEach(sendPreparedFrame);
            ws.send(new ArrayBuffer(0));
            await waitForRealtimeAsrReady(readyPromise, stopTimeoutMs);
          } catch (error) {
            options.onError?.(toError(error, 'realtime ASR stop failed'));
          }
        }

        closeWebSocket(ws);
        options.onStatus?.('closed');
        settleCompletion('stopped', audioUri);
        return audioUri;
      },
    };

    function settleCompletion(reason: RealtimeAsrCompletion['reason'], audioUri?: string) {
      if (completionSettled) return;
      completionSettled = true;
      resolveCompletion({ reason, audioUri });
    }

    function releaseAudioOwnership() {
      if (activeAudioOwner === audioOwner) activeAudioOwner = null;
    }

    function cleanupOwnedAudio(): Promise<string | undefined> {
      if (audioCleanupPromise) return audioCleanupPromise;
      removeAudioListener(audioSubscription);
      audioCleanupPromise = (async () => {
        try {
          return audioStarted ? await stopAudioStream(audioStream) : undefined;
        } finally {
          releaseAudioOwnership();
        }
      })();
      return audioCleanupPromise;
    }

    function sendPreparedFrame(prepared: PreparedRealtimePcmFrame) {
      frameCount += 1;
      byteCount += prepared.buffer.byteLength;
      options.onAudioStats?.({
        frameCount,
        byteCount,
        raw: prepared.raw,
        sent: prepared.sent,
        gain: prepared.gain,
        gated: prepared.gated,
      });
      if (frameCount === 1 || frameCount % 50 === 0) {
        diagnosticInfo(
          `[LaoJi ASR] sent PCM frames=${frameCount} bytes=${byteCount}`
          + ` rawPeak=${prepared.raw.peak} rawRms=${prepared.raw.rms}`
          + ` gated=${prepared.gated} gain=${prepared.gain.toFixed(1)}`
          + ` sentPeak=${prepared.sent.peak} sentRms=${prepared.sent.rms}`,
        );
      }
      ws.send(prepared.buffer);
    }

    function failBeforeOpen(error: Error) {
      if (settled) {
        options.onError?.(error);
        return;
      }
      settled = true;
      stopped = true;
      clearTimeout(timeoutId);
      removeAudioListener(audioSubscription);
      void cleanupOwnedAudio().then(
        () => reject(error),
        () => reject(error),
      );
    }

    ws.onopen = () => {
      void startAudioAfterWarmup();
    };

    async function startAudioAfterWarmup() {
      try {
        await sendInitialSilenceFrames(ws, INITIAL_SILENCE_FRAMES, DEFAULT_BUFFER_SIZE);
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error('realtime ASR connection closed before audio start');
        }
        audioStream.init({
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          audioSource: audioSourceForRealtimePurpose(options.purpose),
          enableAutomaticGainControl: true,
          // Nearby playback can be classified as background noise on some Android devices.
          // Schedule capture already has a client gate and server VAD.
          enableNoiseSuppressor: (options.purpose ?? 'meeting') !== 'schedule',
          skipInitialBuffers: 0,
          wavFile: buildRealtimeWavFileName(meetingId),
          bufferSize: DEFAULT_BUFFER_SIZE,
        });
        audioSubscription = audioStream.on('data', base64Pcm => {
          if (stopped || ws.readyState !== WebSocket.OPEN) return;
          try {
            const pcm = base64ToArrayBuffer(base64Pcm);
            pcmProcessor.push(pcm).forEach(sendPreparedFrame);
          } catch (error) {
            options.onError?.(toError(error, 'send PCM frame failed'));
          }
        });
        audioStarted = true;
        await Promise.resolve(audioStream.start());
        if (stopped || ws.readyState !== WebSocket.OPEN) {
          throw new Error('realtime ASR connection closed while audio was starting');
        }
        settled = true;
        clearTimeout(timeoutId);
        diagnosticInfo(`[LaoJi ASR] recording meetingId=${meetingId}`);
        options.onStatus?.('connected');
        options.onStatus?.('recording');
        resolve(session);
      } catch (error) {
        failBeforeOpen(toError(error, 'start realtime audio stream failed'));
        closeWebSocket(ws);
      }
    }

    ws.onmessage = event => {
      const message = parseRealtimeAsrMessage(event.data);
      if (!message) return;
      if (message.type) {
        diagnosticInfo(`[LaoJi ASR] recv ${message.type}`);
      }
      if (message.type === 'transcript.completed' && typeof message.text === 'string') {
        const text = message.text.trim();
        if (text) {
          options.onTranscript?.({
            text,
            speakerName: typeof message.speaker_name === 'string'
              ? message.speaker_name
              : typeof message.speaker_id === 'string'
                ? message.speaker_id
                : undefined,
            startTime: typeof message.start_time === 'number' ? message.start_time : undefined,
            endTime: typeof message.end_time === 'number' ? message.end_time : undefined,
            raw: message,
          });
        }
        return;
      }
      if (message.type === 'ready_to_stop') {
        diagnosticInfo(`[LaoJi ASR] ready_to_stop frames=${frameCount} bytes=${byteCount}`);
        resolveReady();
        return;
      }
      if (message.type === 'error') {
        const detail = typeof message.detail === 'string'
          ? message.detail
          : typeof message.message === 'string'
            ? message.message
            : 'realtime ASR server error';
        options.onError?.(new Error(detail));
      }
    };

    ws.onerror = event => {
      const message = (event as { message?: string }).message ?? '';
      const error = new Error(`realtime ASR websocket error: ${message}`.trim());
      diagnosticWarn('[LaoJi ASR] websocket error', error);
      if (!settled) {
        failBeforeOpen(error);
      } else {
        options.onError?.(error);
      }
    };

    ws.onclose = () => {
      clearTimeout(timeoutId);
      resolveReady();
      diagnosticInfo(`[LaoJi ASR] closed frames=${frameCount} bytes=${byteCount}`);
      if (!settled) {
        failBeforeOpen(new Error('realtime ASR connection closed'));
      } else {
        if (!stopped) {
          stopped = true;
          const cleanup = cleanupOwnedAudio();
          settleCompletion('connection-closed');
          void cleanup.then(uri => {
            stoppedAudioUri = uri;
          });
        }
        options.onStatus?.('closed');
      }
    };
  });
}

export async function startLocalWavRecording(
  recordingId: string,
  onAudioStats?: (stats: RealtimeAsrAudioStats) => void,
): Promise<LocalWavRecordingSession> {
  const audioStream = loadLiveAudioStream();
  const audioOwner = Symbol(recordingId);
  const fileName = buildRealtimeWavFileName(recordingId);
  if (activeAudioOwner) throw new Error('麦克风正在被其他录音使用');
  activeAudioOwner = audioOwner;

  let stopped = false;
  let stopPromise: Promise<string> | null = null;
  let frameCount = 0;
  let byteCount = 0;
  let subscription: { remove?: () => void } | void = undefined;

  const stop = (): Promise<string> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    removeAudioListener(subscription);
    stopPromise = (async () => {
      try {
        const uri = await stopAudioStream(audioStream);
        if (!uri) throw new Error('录音文件没有正确保存，请重新录制');
        return uri;
      } finally {
        if (activeAudioOwner === audioOwner) activeAudioOwner = null;
      }
    })();
    return stopPromise;
  };

  try {
    audioStream.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: VOICE_RECOGNITION_AUDIO_SOURCE,
      enableAutomaticGainControl: true,
      enableNoiseSuppressor: true,
      skipInitialBuffers: 0,
      wavFile: fileName,
      bufferSize: DEFAULT_BUFFER_SIZE,
    });
    subscription = audioStream.on('data', base64Pcm => {
      if (stopped) return;
      try {
        const buffer = base64ToArrayBuffer(base64Pcm);
        const raw = pcmStats(buffer);
        frameCount += 1;
        byteCount += buffer.byteLength;
        onAudioStats?.({
          frameCount,
          byteCount,
          raw,
          sent: raw,
          gain: 1,
          gated: false,
        });
      } catch (error) {
        diagnosticWarn('[LaoJi speaker] audio frame inspection failed', error);
      }
    });
    await Promise.resolve(audioStream.start());
    return { fileName, stop };
  } catch (error) {
    removeAudioListener(subscription);
    try {
      await stopAudioStream(audioStream);
    } finally {
      if (activeAudioOwner === audioOwner) activeAudioOwner = null;
    }
    throw toError(error, '启动音色录制失败');
  }
}

export function parseRealtimeAsrMessage(data: unknown): RealtimeAsrMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const message = JSON.parse(data);
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}

export function applyPcmAutoGain(
  buffer: ArrayBuffer,
  targetPeak = TARGET_PCM_PEAK,
  maxGain = MAX_AUTO_GAIN,
): { buffer: ArrayBuffer; raw: PcmStats; sent: PcmStats; gain: number } {
  const raw = pcmStats(buffer);
  if (raw.peak <= 0 || targetPeak <= 0 || maxGain <= 1) {
    return { buffer, raw, sent: raw, gain: 1 };
  }

  const gain = Math.max(1, Math.min(maxGain, targetPeak / raw.peak));
  return applyPcmGain(buffer, raw, gain);
}

function applyPcmGain(
  buffer: ArrayBuffer,
  raw: PcmStats,
  gain: number,
): { buffer: ArrayBuffer; raw: PcmStats; sent: PcmStats; gain: number } {
  if (gain <= 1.05) {
    return { buffer, raw, sent: raw, gain: 1 };
  }

  const source = new DataView(buffer);
  const amplified = new ArrayBuffer(buffer.byteLength);
  const output = new DataView(amplified);

  for (let offset = 0; offset + 1 < source.byteLength; offset += 2) {
    const sample = source.getInt16(offset, true);
    output.setInt16(offset, clampInt16(Math.round(sample * gain)), true);
  }

  if (source.byteLength % 2 === 1) {
    output.setUint8(source.byteLength - 1, source.getUint8(source.byteLength - 1));
  }

  return {
    buffer: amplified,
    raw,
    sent: pcmStats(amplified),
    gain,
  };
}

export function prepareRealtimePcmFrame(
  buffer: ArrayBuffer,
  purpose: RealtimeAsrPurpose = 'meeting',
): PreparedRealtimePcmFrame {
  const raw = pcmStats(buffer);
  if (
    purpose === 'schedule'
    && raw.peak < SCHEDULE_NOISE_GATE_PEAK
    && raw.rms < SCHEDULE_NOISE_GATE_RMS
  ) {
    return {
      buffer: new ArrayBuffer(buffer.byteLength),
      raw,
      sent: { peak: 0, rms: 0 },
      gain: 0,
      gated: true,
    };
  }
  return { ...applyPcmAutoGain(buffer), gated: false };
}

export function createRealtimePcmProcessor(
  purpose: RealtimeAsrPurpose = 'meeting',
): RealtimePcmProcessor {
  if (purpose !== 'schedule') {
    return {
      push: buffer => [prepareRealtimePcmFrame(buffer, purpose)],
      flush: () => [],
    };
  }

  const pending: Array<{ buffer: ArrayBuffer; raw: PcmStats; active: boolean }> = [];
  let postActiveFrames = 0;
  let previousKept = false;
  let segmentPeak = 0;
  let segmentGain = 1;

  const processOldest = (): PreparedRealtimePcmFrame => {
    const current = pending[0];
    const visible = pending.slice(0, SCHEDULE_GATE_LOOKAHEAD_FRAMES + 1);
    const activePeaks = visible
      .filter(frame => frame.active)
      .map(frame => frame.raw.peak);
    const hasUpcomingSpeech = activePeaks.length > 0;
    const keep = hasUpcomingSpeech || postActiveFrames > 0;

    if (keep && !previousKept) {
      segmentPeak = Math.max(1, ...activePeaks);
      segmentGain = scheduleSegmentGain(segmentPeak);
    } else if (keep && activePeaks.length > 0) {
      const nextPeak = Math.max(segmentPeak, ...activePeaks);
      if (nextPeak > segmentPeak) {
        segmentPeak = nextPeak;
        segmentGain = Math.min(segmentGain, scheduleSegmentGain(segmentPeak));
      }
    }

    if (current.active) {
      postActiveFrames = SCHEDULE_GATE_HANGOVER_FRAMES;
    } else if (postActiveFrames > 0) {
      postActiveFrames -= 1;
    }
    previousKept = keep;
    pending.shift();

    if (!keep) {
      segmentPeak = 0;
      segmentGain = 1;
      return {
        buffer: new ArrayBuffer(current.buffer.byteLength),
        raw: current.raw,
        sent: { peak: 0, rms: 0 },
        gain: 0,
        gated: true,
      };
    }

    return { ...applyPcmGain(current.buffer, current.raw, segmentGain), gated: false };
  };

  return {
    push: buffer => {
      const raw = pcmStats(buffer);
      pending.push({
        buffer,
        raw,
        active: isScheduleSpeechFrame(raw),
      });
      return pending.length > SCHEDULE_GATE_LOOKAHEAD_FRAMES
        ? [processOldest()]
        : [];
    },
    flush: () => {
      const frames: PreparedRealtimePcmFrame[] = [];
      while (pending.length > 0) frames.push(processOldest());
      return frames;
    },
  };
}

function isScheduleSpeechFrame(stats: PcmStats): boolean {
  return stats.peak >= SCHEDULE_NOISE_GATE_PEAK || stats.rms >= SCHEDULE_NOISE_GATE_RMS;
}

function scheduleSegmentGain(peak: number): number {
  if (peak <= 0) return 1;
  return Math.max(1, Math.min(SCHEDULE_MAX_AUTO_GAIN, TARGET_PCM_PEAK / peak));
}

export function selectRealtimeScheduleText(chunks: string[]): string {
  const unique = new Map<string, { text: string; index: number }>();
  chunks
    .map(normalizeTranscriptChunk)
    .forEach((text, index) => {
      if (text) unique.set(text, { text, index });
    });
  const candidates = Array.from(unique.values());

  if (candidates.length === 0) return '';

  const scored = candidates
    .map(candidate => ({ ...candidate, score: scoreScheduleTranscript(candidate.text) }))
    .sort((left, right) => (
      right.score - left.score
      || right.text.length - left.text.length
      || right.index - left.index
    ));
  const best = scored[0];

  if (best.score >= 8) return best.text;

  const usable = scored
    .filter(item => item.score > -4)
    .map(item => item.text);
  return usable.join('\n');
}

function loadLiveAudioStream(): LiveAudioStreamModule {
  try {
    const imported = require('react-native-live-audio-stream');
    const stream = imported && typeof imported === 'object' && 'default' in imported
      ? (imported as { default?: unknown }).default
      : imported;
    if (!isLiveAudioStreamModule(stream)) {
      throw new Error('RNLiveAudioStream native module is unavailable');
    }
    return stream;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    throw new Error(`当前运行环境不支持实时语音流，请使用 development build 或正式包：${message}`);
  }
}

function isLiveAudioStreamModule(value: unknown): value is LiveAudioStreamModule {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LiveAudioStreamModule).init === 'function' &&
    typeof (value as LiveAudioStreamModule).start === 'function' &&
    typeof (value as LiveAudioStreamModule).stop === 'function' &&
    typeof (value as LiveAudioStreamModule).on === 'function'
  );
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const length = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  const bytes = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (char === '=') break;
    const value = chars.indexOf(char);
    if (value < 0) throw new Error('invalid base64 audio frame');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (index < bytes.length) {
        bytes[index] = (buffer >> bits) & 0xff;
        index += 1;
      }
    }
  }

  return index === bytes.length ? bytes : bytes.slice(0, index);
}

async function stopAudioStream(audioStream: LiveAudioStreamModule): Promise<string | undefined> {
  try {
    const result = await Promise.race([
      Promise.resolve(audioStream.stop()),
      delay(5000),
    ]);
    return typeof result === 'string' && result ? result : undefined;
  } catch {
    // Some native implementations throw when stop is called after the recorder has already ended.
    return undefined;
  }
}

function removeAudioListener(subscription: { remove?: () => void } | void) {
  try {
    if (subscription && typeof subscription === 'object') subscription.remove?.();
  } catch {
    // Listener cleanup should not block recorder shutdown.
  }
}

function closeWebSocket(ws: WebSocket) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {
    // Native websocket teardown can race with a remote close.
  }
}

function createRealtimeWebSocket(url: string, headers: Record<string, string>): WebSocket {
  if (Object.keys(headers).length === 0) return new WebSocket(url);
  const ReactNativeWebSocket = WebSocket as unknown as new (
    targetUrl: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  return new ReactNativeWebSocket(url, null, { headers });
}

function maskRealtimeUrl(url: string): string {
  return url.replace(/([?&](?:access_token|guest_token|token)=)[^&]+/g, '$1***');
}

async function sendInitialSilenceFrames(
  ws: WebSocket,
  frameCount: number,
  frameSize: number,
): Promise<void> {
  const silence = new ArrayBuffer(frameSize);
  for (let index = 0; index < frameCount; index += 1) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(silence);
    await delay(100);
  }
  diagnosticInfo(`[LaoJi ASR] sent initial silence frames=${frameCount}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(error ? String(error) : fallback);
}

function pcmStats(buffer: ArrayBuffer): PcmStats {
  const view = new DataView(buffer);
  let peak = 0;
  let sumSquares = 0;
  let samples = 0;

  for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
    samples += 1;
  }

  return {
    peak,
    rms: samples ? Math.round(Math.sqrt(sumSquares / samples)) : 0,
  };
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function normalizeTranscriptChunk(text: string): string {
  const normalized = text
    .replace(/\s+/g, '')
    .replace(/[。！？!?,，]+$/g, '')
    .trim();
  return repairTemporalPrefix(normalized);
}

function scoreScheduleTranscript(text: string): number {
  let score = Math.min(text.length, 30) / 10;
  const hasTime = hasTimeExpression(text);
  const hasDate = /(今天|明天|后天|大后天|今晚|明早|下周|本周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[号日]?)/.test(text);
  const hasAction = /(会|会议|开会|提醒|日程|安排|上课|考试|面试|提交|汇报|周报|打电话|吃饭|聚餐|健身|出发|到达|预约|复诊|买|取|发)/.test(text);

  if (hasTime) score += 8;
  if (hasDate) score += 5;
  if (hasAction) score += 3;
  if ((hasTime || hasDate) && hasAction) score += 4;
  if (hasInvalidHour(text)) score -= 14;
  if (isLikelyAsrNoise(text)) score -= 20;

  return score;
}

function hasTimeExpression(text: string): boolean {
  return /([0-2]?\d[:：][0-5]\d|[0-2]?\d\s*[点时]|[一二两三四五六七八九十]{1,3}\s*[点时]|上午|下午|中午|晚上|今晚|明早|早上|傍晚|凌晨)/.test(text);
}

function hasInvalidHour(text: string): boolean {
  return /(?:上午|下午|晚上|早上|中午|凌晨)?(?:二十[五六七八九]|三十|[三四五六七八九]十)\s*[点时]/.test(text)
    || /(?:^|[^\d])(?:2[5-9]|[3-9]\d)\s*[点时]/.test(text);
}

function isLikelyAsrNoise(text: string): boolean {
  return /(没有没有|没有.*没有.*没有|证据|字幕|谢谢观看|请不吝点赞)/.test(text);
}

function repairTemporalPrefix(text: string): string {
  return text
    .replace(/^我?一天(?=上午|下午|中午|晚上|早上|凌晨)/, '明天')
    .replace(/^天(?=上午|下午|中午|晚上|早上|凌晨)/, '明天')
    .replace(/^午(?=(?:[0-2]?\d|[一二两三四五六七八九十]{1,3})[点时])/, '下午');
}
