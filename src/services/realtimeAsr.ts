import * as FileSystem from 'expo-file-system/legacy';
import {
  addNativeRecorderErrorListener,
  addNativeRecorderLevelListener,
  addNativeRecorderStateListener,
  addNativeRecorderTranscriptListener,
  assertNativeRecorderDeploymentPolicy,
  hasNativeRecorder,
  pauseNativeRecorder,
  resolveNativeRecorderInsecureDevelopment,
  resumeNativeRecorder,
  startLocalNativeRecorder,
  startNativeRecorder,
  stopLocalNativeRecorder,
  stopNativeRecorder,
  type NativeRecorderStopResult,
} from 'laoji-native-platform';
import { getApiConfig } from './config';
import type { RealtimeAsrProvider } from './config';

const DEFAULT_PORT = 18020;
const DEFAULT_PROVIDER: RealtimeAsrProvider = 'qwen';

export type { RealtimeAsrProvider } from './config';
export type RealtimeAsrPurpose = 'meeting' | 'schedule';
export type RealtimeAsrStatus = 'connecting' | 'connected' | 'recording' | 'paused' | 'stopping' | 'closed';

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

export interface RealtimeAsrCompletion {
  reason: 'stopped' | 'connection-closed';
  audioUri?: string;
}

export interface RealtimeAsrSession {
  meetingId: string;
  url: string;
  completion: Promise<RealtimeAsrCompletion>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<string | undefined>;
}

export interface LocalWavRecordingSession {
  fileName: string;
  stop: () => Promise<string>;
}

export interface StartRealtimeAsrOptions {
  meetingId?: string;
  storageScope?: string;
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

function toError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason;
  const message = String(reason ?? '').trim();
  return new Error(message || fallback);
}

function resultFromStopError(reason: unknown): NativeRecorderStopResult | null {
  return (reason as { result?: NativeRecorderStopResult } | null)?.result ?? null;
}

/** MIN-AUDIO-001: compatibility facade over the native recorder; no PCM frame crosses JS. */
export async function startRealtimeAsr(
  options: StartRealtimeAsrOptions = {},
): Promise<RealtimeAsrSession> {
  if (!hasNativeRecorder()) {
    throw new Error('LaoJi native recorder is unavailable in this build');
  }
  const config = getApiConfig();
  const meetingId = options.meetingId ?? createRealtimeMeetingId();
  const purpose = options.purpose ?? 'meeting';
  const secure = options.secure ?? config.realtimeAsrSecure;
  const url = buildRealtimeAsrUrl({
    meetingId,
    provider: options.provider ?? config.realtimeAsrProvider,
    purpose,
    host: options.host ?? config.realtimeAsrHost,
    port: options.port ?? config.realtimeAsrPort,
    secure,
  });
  const accessToken = options.accessToken?.trim() || undefined;
  const guestToken = options.guestToken?.trim() || undefined;
  if ((accessToken === undefined) === (guestToken === undefined)) {
    throw new Error('realtime ASR requires exactly one account or guest token');
  }
  const allowInsecureDevelopment = resolveNativeRecorderInsecureDevelopment(config.isProduction, secure);
  assertNativeRecorderDeploymentPolicy(config.isProduction, allowInsecureDevelopment);

  let frameCount = 0;
  let settled = false;
  let stopPromise: Promise<string | undefined> | null = null;
  let resolveCompletion!: (completion: RealtimeAsrCompletion) => void;
  const completion = new Promise<RealtimeAsrCompletion>(resolve => { resolveCompletion = resolve; });
  const settleCompletion = (value: RealtimeAsrCompletion) => {
    if (settled) return;
    settled = true;
    resolveCompletion(value);
  };
  const subscriptions = [
    addNativeRecorderStateListener(event => {
      if (event.sessionId !== meetingId) return;
      if (event.state === 'preparing') options.onStatus?.('connecting');
      else if (event.state === 'recording') options.onStatus?.('recording');
      else if (event.state === 'paused') options.onStatus?.('paused');
      else if (event.state === 'stopping') options.onStatus?.('stopping');
      else if (event.state === 'localSaved') settleCompletion({
        reason: 'stopped',
        audioUri: event.localUri ?? undefined,
      });
      else if (event.state === 'failed') {
        options.onError?.(new Error(event.errorMessage || 'native recorder failed'));
        settleCompletion({ reason: 'connection-closed', audioUri: event.localUri ?? undefined });
      }
    }),
    addNativeRecorderTranscriptListener(event => {
      if (event.sessionId !== meetingId || !event.text.trim()) return;
      options.onTranscript?.({
        text: event.text.trim(),
        speakerName: event.speakerName ?? undefined,
        startTime: event.startMs == null ? undefined : event.startMs / 1000,
        endTime: event.endMs == null ? undefined : event.endMs / 1000,
        raw: { ...event },
      });
    }),
    addNativeRecorderLevelListener(event => {
      if (event.sessionId !== meetingId) return;
      frameCount += 1;
      const stats = { peak: event.peak, rms: event.rms };
      options.onAudioStats?.({
        frameCount,
        byteCount: event.bytesRecorded,
        raw: stats,
        sent: stats,
        gain: 1,
        gated: false,
      });
    }),
    addNativeRecorderErrorListener(event => {
      if (event.sessionId && event.sessionId !== meetingId) return;
      options.onError?.(new Error(event.errorMessage || 'native recorder failed'));
    }),
  ];
  const releaseListeners = () => subscriptions.splice(0).forEach(subscription => subscription.remove());

  options.onStatus?.('connecting');
  try {
    await startNativeRecorder({
      sessionId: meetingId,
      purpose,
      storageScope: options.storageScope,
      websocketUrl: url,
      ...(accessToken ? { accessToken } : { guestToken: guestToken! }),
      allowInsecureDevelopment,
      connectionTimeoutMs: options.connectionTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
    });
    options.onStatus?.('connected');
    options.onStatus?.('recording');
  } catch (reason) {
    releaseListeners();
    const error = toError(reason, 'native recorder failed to start');
    options.onError?.(error);
    throw error;
  }

  return {
    meetingId,
    url,
    completion,
    pause: async () => {
      await pauseNativeRecorder(meetingId);
      options.onStatus?.('paused');
    },
    resume: async () => {
      await resumeNativeRecorder(meetingId);
      options.onStatus?.('recording');
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      options.onStatus?.('stopping');
      stopPromise = (async () => {
        try {
          const result = await stopNativeRecorder(meetingId);
          settleCompletion({ reason: 'stopped', audioUri: result.localUri ?? undefined });
          return result.localUri ?? undefined;
        } catch (reason) {
          const recovered = resultFromStopError(reason);
          if (recovered?.localSaved) {
            settleCompletion({ reason: 'connection-closed', audioUri: recovered.localUri ?? undefined });
            options.onError?.(toError(reason, 'realtime ASR stop confirmation failed'));
            return recovered.localUri ?? undefined;
          }
          const error = toError(reason, 'native recorder failed to stop');
          options.onError?.(error);
          settleCompletion({ reason: 'connection-closed' });
          throw error;
        } finally {
          releaseListeners();
          options.onStatus?.('closed');
        }
      })();
      return stopPromise;
    },
  };
}

/** MIN-SPEAKER-001: local WAV uses the same native AudioRecord owner without ASR. */
export async function startLocalWavRecording(
  recordingId: string,
  onAudioStats?: (stats: RealtimeAsrAudioStats) => void,
): Promise<LocalWavRecordingSession> {
  if (!hasNativeRecorder()) throw new Error('LaoJi native recorder is unavailable in this build');
  let frameCount = 0;
  const levelSubscription = addNativeRecorderLevelListener(event => {
    if (event.sessionId !== recordingId) return;
    frameCount += 1;
    const stats = { peak: event.peak, rms: event.rms };
    onAudioStats?.({
      frameCount,
      byteCount: event.bytesRecorded,
      raw: stats,
      sent: stats,
      gain: 1,
      gated: false,
    });
  });
  const errorSubscription = addNativeRecorderErrorListener(() => undefined);
  try {
    await startLocalNativeRecorder(recordingId, { levelIntervalMs: 120 });
  } catch (reason) {
    levelSubscription.remove();
    errorSubscription.remove();
    throw reason;
  }
  let stopping: Promise<string> | null = null;
  return {
    fileName: buildRealtimeWavFileName(recordingId),
    stop: () => {
      if (stopping) return stopping;
      stopping = stopLocalNativeRecorder(recordingId)
        .then(result => {
          if (!result.localUri) throw new Error('native recorder did not return a local WAV file');
          return result.localUri;
        })
        .finally(() => {
          levelSubscription.remove();
          errorSubscription.remove();
        });
      return stopping;
    },
  };
}
