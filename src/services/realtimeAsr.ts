import { getApiConfig } from './config';

declare const require: (moduleName: string) => unknown;

const DEFAULT_HOST = '183.36.243.124';
const DEFAULT_PORT = 8020;
const DEFAULT_PROVIDER: RealtimeAsrProvider = 'funasr';
const DEFAULT_BUFFER_SIZE = 3200;
const INITIAL_SILENCE_FRAMES = 3;
const TARGET_PCM_PEAK = 8000;
const MAX_AUTO_GAIN = 20;

export type RealtimeAsrProvider = 'funasr' | 'whisper' | 'qwen';
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
}

export interface RealtimeAsrSession {
  meetingId: string;
  url: string;
  stop: () => Promise<void>;
}

export interface StartRealtimeAsrOptions {
  meetingId?: string;
  provider?: RealtimeAsrProvider;
  host?: string;
  port?: number;
  secure?: boolean;
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

export function buildRealtimeAsrUrl({
  meetingId,
  provider = DEFAULT_PROVIDER,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  secure = false,
}: {
  meetingId: string;
  provider?: RealtimeAsrProvider;
  host?: string;
  port?: number;
  secure?: boolean;
}): string {
  const protocol = secure ? 'wss' : 'ws';
  const normalizedHost = host
    .replace(/^https?:\/\//, '')
    .replace(/^wss?:\/\//, '')
    .replace(/\/+$/, '');
  const hostWithPort = normalizedHost.includes(':') ? normalizedHost : `${normalizedHost}:${port}`;
  return `${protocol}://${hostWithPort}/ws/meeting/${encodeURIComponent(meetingId)}/${provider}`;
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

export async function startRealtimeAsr(
  options: StartRealtimeAsrOptions = {},
): Promise<RealtimeAsrSession> {
  const audioStream = loadLiveAudioStream();
  const apiConfig = getApiConfig();
  const meetingId = options.meetingId ?? createRealtimeMeetingId();
  const url = buildRealtimeAsrUrl({
    meetingId,
    provider: options.provider ?? DEFAULT_PROVIDER,
    host: options.host ?? apiConfig.realtimeAsrHost,
    port: options.port ?? apiConfig.realtimeAsrPort,
    secure: options.secure ?? apiConfig.realtimeAsrSecure,
  });
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 8000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10000;

  console.info(`[LaoJi ASR] connecting ${url}`);
  options.onStatus?.('connecting');

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let frameCount = 0;
    let byteCount = 0;
    let audioSubscription: { remove?: () => void } | void;
    let resolveReady = () => {};
    const readyPromise = new Promise<void>(readyResolve => {
      resolveReady = readyResolve;
    });

    const ws = new WebSocket(url);
    const timeoutId = setTimeout(() => {
      failBeforeOpen(new Error('realtime ASR connection timed out'));
      closeWebSocket(ws);
    }, connectionTimeoutMs);

    const session: RealtimeAsrSession = {
      meetingId,
      url,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        options.onStatus?.('stopping');
        removeAudioListener(audioSubscription);
        await stopAudioStream(audioStream);

        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(new ArrayBuffer(0));
            await Promise.race([readyPromise, delay(stopTimeoutMs)]);
          } catch (error) {
            options.onError?.(toError(error, 'realtime ASR stop failed'));
          }
        }

        closeWebSocket(ws);
        options.onStatus?.('closed');
      },
    };

    function failBeforeOpen(error: Error) {
      if (settled) {
        options.onError?.(error);
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      removeAudioListener(audioSubscription);
      void stopAudioStream(audioStream);
      reject(error);
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
          audioSource: 7,
          enableAutomaticGainControl: true,
          enableNoiseSuppressor: true,
          skipInitialBuffers: 0,
          wavFile: 'laoji-realtime.wav',
          bufferSize: DEFAULT_BUFFER_SIZE,
        });
        audioSubscription = audioStream.on('data', base64Pcm => {
          if (stopped || ws.readyState !== WebSocket.OPEN) return;
          try {
            const pcm = base64ToArrayBuffer(base64Pcm);
            const prepared = applyPcmAutoGain(pcm);
            frameCount += 1;
            byteCount += prepared.buffer.byteLength;
            options.onAudioStats?.({
              frameCount,
              byteCount,
              raw: prepared.raw,
              sent: prepared.sent,
              gain: prepared.gain,
            });
            if (frameCount === 1 || frameCount % 50 === 0) {
              console.info(
                `[LaoJi ASR] sent PCM frames=${frameCount} bytes=${byteCount}`
                + ` rawPeak=${prepared.raw.peak} rawRms=${prepared.raw.rms}`
                + ` gain=${prepared.gain.toFixed(1)} sentPeak=${prepared.sent.peak} sentRms=${prepared.sent.rms}`,
              );
            }
            ws.send(prepared.buffer);
          } catch (error) {
            options.onError?.(toError(error, 'send PCM frame failed'));
          }
        });
        audioStream.start();
        settled = true;
        clearTimeout(timeoutId);
        console.info(`[LaoJi ASR] recording meetingId=${meetingId}`);
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
        console.info(`[LaoJi ASR] recv ${message.type}`);
      }
      if (message.type === 'transcript.completed' && typeof message.text === 'string') {
        const text = message.text.trim();
        if (text) {
          console.info(`[LaoJi ASR] transcript ${text}`);
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
        console.info(`[LaoJi ASR] ready_to_stop frames=${frameCount} bytes=${byteCount}`);
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
      console.warn('[LaoJi ASR] websocket error', error);
      if (!settled) {
        failBeforeOpen(error);
      } else {
        options.onError?.(error);
      }
    };

    ws.onclose = () => {
      clearTimeout(timeoutId);
      resolveReady();
      console.info(`[LaoJi ASR] closed frames=${frameCount} bytes=${byteCount}`);
      if (!settled) {
        failBeforeOpen(new Error('realtime ASR connection closed'));
      } else {
        options.onStatus?.('closed');
      }
    };
  });
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

export function selectRealtimeScheduleText(chunks: string[]): string {
  const candidates = chunks
    .map(normalizeTranscriptChunk)
    .filter((text): text is string => !!text)
    .filter((text, index, items) => items.indexOf(text) === index);

  if (candidates.length === 0) return '';

  const scored = candidates
    .map(text => ({ text, score: scoreScheduleTranscript(text) }))
    .sort((left, right) => right.score - left.score || right.text.length - left.text.length);
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

async function stopAudioStream(audioStream: LiveAudioStreamModule): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(audioStream.stop()),
      delay(500),
    ]);
  } catch {
    // Some native implementations throw when stop is called after the recorder has already ended.
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
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
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
  console.info(`[LaoJi ASR] sent initial silence frames=${frameCount}`);
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
