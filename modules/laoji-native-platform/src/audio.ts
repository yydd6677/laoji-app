import {
  NativeModule,
  requireOptionalNativeModule,
  type EventSubscription,
} from 'expo-modules-core';

export const NATIVE_AUDIO_SAMPLE_RATE_HZ = 16_000 as const;
export const NATIVE_AUDIO_CHANNEL_COUNT = 1 as const;
export const NATIVE_AUDIO_BITS_PER_SAMPLE = 16 as const;
export const NATIVE_AUDIO_FRAME_BYTES = 3_200 as const;

export type NativeRealtimeRecorderPurpose = 'schedule' | 'meeting';

export type NativeRecorderPurpose = NativeRealtimeRecorderPurpose | 'speaker';

export type NativeRecorderMode = 'realtime' | 'localOnly';

export type NativeRecorderState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'localSaved'
  | 'failed';

export type NativeRecorderErrorCode =
  | 'invalid_options'
  | 'session_busy'
  | 'session_mismatch'
  | 'permission_denied'
  | 'service_unavailable'
  | 'audio_unavailable'
  | 'audio_read_failed'
  | 'storage_failed'
  | 'storage_limit'
  | 'websocket_connect_failed'
  | 'websocket_disconnected'
  | 'websocket_send_failed'
  | 'server_error'
  | 'ready_to_stop_timeout'
  | 'recovery_failed';

interface NativeRecorderStartBase {
  sessionId: string;
  purpose: NativeRealtimeRecorderPurpose;
  websocketUrl: string;
  allowInsecureDevelopment?: boolean;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  levelIntervalMs?: number;
}

export type NativeRecorderStartOptions = NativeRecorderStartBase & (
  | { accessToken: string; guestToken?: never }
  | { accessToken?: never; guestToken: string }
);

export interface NativeLocalRecorderOptions {
  levelIntervalMs?: number;
}

export interface NativeLocalRecorderStartOptions extends NativeLocalRecorderOptions {
  sessionId: string;
}

export interface NativeRecorderSnapshot {
  sessionId: string;
  purpose: NativeRecorderPurpose;
  mode?: NativeRecorderMode;
  state: NativeRecorderState;
  startedAtMs: number;
  updatedAtMs: number;
  bytesRecorded: number;
  durationMs: number;
  localUri: string | null;
  asrConnected: boolean;
  asrRequired?: boolean;
  readyToStop: boolean;
  transcriptRecoveryRequired: boolean;
  errorCode: NativeRecorderErrorCode | null;
  errorMessage: string | null;
}

export interface NativeRealtimeRecorderSnapshot extends NativeRecorderSnapshot {
  purpose: NativeRealtimeRecorderPurpose;
  mode: 'realtime';
  asrRequired: true;
}

export interface NativeLocalRecorderSnapshot extends NativeRecorderSnapshot {
  purpose: 'speaker';
  mode: 'localOnly';
  asrRequired: false;
}

export interface NativeRecorderLevelEvent {
  sessionId: string;
  peak: number;
  rms: number;
  normalized: number;
  bytesRecorded: number;
  durationMs: number;
}

export interface NativeRecorderTranscriptEvent {
  sessionId: string;
  segmentId: string;
  kind: 'partial' | 'final';
  isFinal: boolean;
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  source: string | null;
  purpose: NativeRealtimeRecorderPurpose;
  receivedAtMs: number;
}

export interface NativeRecorderErrorEvent {
  sessionId: string | null;
  errorCode: NativeRecorderErrorCode;
  errorMessage: string;
  recoverable: boolean;
  localUri: string | null;
  transcriptRecoveryRequired: boolean;
  fileName?: string;
}

export interface NativeRecoveredRecording {
  sessionId: string;
  purpose: NativeRecorderPurpose;
  mode: NativeRecorderMode;
  localUri: string;
  bytesRecorded: number;
  durationMs: number;
  recovered: boolean;
}

export interface NativeRecorderRecoveryFailure {
  fileName: string;
  errorCode: 'recovery_failed';
  errorMessage: string;
}

export interface NativeRecorderRecoveryReport {
  recordings: NativeRecoveredRecording[];
  failures: NativeRecorderRecoveryFailure[];
}

export interface NativeRecorderStopResult {
  status: 'completed' | 'failed';
  localSaved: boolean;
  readyToStop: boolean;
  localUri: string | null;
  errorCode: NativeRecorderErrorCode | null;
  errorMessage: string | null;
  audioBars: number[];
  snapshot: NativeRecorderSnapshot;
}

type NativeRecorderEvents = {
  onRecorderStateChanged: (event: NativeRecorderSnapshot) => void;
  onRecorderLevel: (event: NativeRecorderLevelEvent) => void;
  onRecorderTranscript: (event: NativeRecorderTranscriptEvent) => void;
  onRecorderError: (event: NativeRecorderErrorEvent) => void;
  onRecorderRecovered: (event: NativeRecoveredRecording) => void;
};

declare class LaojiRecorderNativeModule extends NativeModule<NativeRecorderEvents> {
  audioFormat: {
    sampleRateHz: typeof NATIVE_AUDIO_SAMPLE_RATE_HZ;
    channelCount: typeof NATIVE_AUDIO_CHANNEL_COUNT;
    bitsPerSample: typeof NATIVE_AUDIO_BITS_PER_SAMPLE;
    frameBytes: typeof NATIVE_AUDIO_FRAME_BYTES;
  };
  start(options: NativeRecorderStartOptions): Promise<NativeRealtimeRecorderSnapshot>;
  startLocal(sessionId: string, levelIntervalMs: number | null): Promise<NativeLocalRecorderSnapshot>;
  pause(sessionId: string): Promise<NativeRecorderSnapshot>;
  resume(sessionId: string): Promise<NativeRecorderSnapshot>;
  stop(sessionId: string): Promise<NativeRecorderStopResult>;
  recover(): Promise<NativeRecorderRecoveryReport>;
  getState(sessionId: string | null): Promise<NativeRecorderSnapshot | null>;
}

const nativeRecorder = requireOptionalNativeModule<LaojiRecorderNativeModule>('LaojiRecorder');

export class NativeRecorderUnavailableError extends Error {
  readonly code = 'ERR_LAOJI_RECORDER_UNAVAILABLE';

  constructor() {
    super('Laoji native recorder is unavailable in this build');
    this.name = 'NativeRecorderUnavailableError';
  }
}

export class NativeRecorderStopError extends Error {
  readonly code: NativeRecorderErrorCode;
  readonly result: NativeRecorderStopResult;

  constructor(result: NativeRecorderStopResult) {
    super(result.errorMessage ?? 'Native recorder stopped without required completion');
    this.name = 'NativeRecorderStopError';
    this.code = result.errorCode ?? 'server_error';
    this.result = result;
  }
}

export function hasNativeRecorder(): boolean {
  return nativeRecorder !== null;
}

export function normalizeNativeRecorderStartOptions(
  options: NativeRecorderStartOptions,
): NativeRecorderStartOptions {
  const sessionId = validateSessionId(options.sessionId);
  if (options.purpose !== 'schedule' && options.purpose !== 'meeting') {
    throw new TypeError('purpose must be schedule or meeting');
  }
  if (
    options.allowInsecureDevelopment !== undefined &&
    typeof options.allowInsecureDevelopment !== 'boolean'
  ) {
    throw new TypeError('allowInsecureDevelopment must be a boolean');
  }
  const allowInsecureDevelopment = options.allowInsecureDevelopment === true;
  const websocketUrl = validateNativeRecorderWebSocketUrl(
    options.websocketUrl,
    allowInsecureDevelopment,
  );
  const accessToken = normalizeToken(options.accessToken);
  const guestToken = normalizeToken(options.guestToken);
  if ((accessToken === undefined) === (guestToken === undefined)) {
    throw new TypeError('exactly one of accessToken or guestToken is required');
  }

  const normalizedBase: NativeRecorderStartBase = {
    sessionId,
    purpose: options.purpose,
    websocketUrl,
    allowInsecureDevelopment,
    connectionTimeoutMs: boundedInteger(
      options.connectionTimeoutMs,
      1_000,
      60_000,
      'connectionTimeoutMs',
    ),
    stopTimeoutMs: boundedInteger(options.stopTimeoutMs, 1_000, 120_000, 'stopTimeoutMs'),
    levelIntervalMs: boundedInteger(options.levelIntervalMs, 50, 1_000, 'levelIntervalMs'),
  };

  return accessToken !== undefined
    ? { ...normalizedBase, accessToken }
    : { ...normalizedBase, guestToken: guestToken! };
}

export async function startNativeRecorder(
  options: NativeRecorderStartOptions,
): Promise<NativeRealtimeRecorderSnapshot> {
  return requireNativeRecorder().start(normalizeNativeRecorderStartOptions(options));
}

export function normalizeNativeLocalRecorderStartOptions(
  sessionId: string,
  options: NativeLocalRecorderOptions = {},
): NativeLocalRecorderStartOptions {
  return {
    sessionId: validateSessionId(sessionId),
    levelIntervalMs: boundedInteger(options.levelIntervalMs, 50, 1_000, 'levelIntervalMs'),
  };
}

export async function startLocalNativeRecorder(
  sessionId: string,
  options: NativeLocalRecorderOptions = {},
): Promise<NativeLocalRecorderSnapshot> {
  const normalized = normalizeNativeLocalRecorderStartOptions(sessionId, options);
  return requireNativeRecorder().startLocal(
    normalized.sessionId,
    normalized.levelIntervalMs ?? null,
  );
}

export async function pauseNativeRecorder(sessionId: string): Promise<NativeRecorderSnapshot> {
  return requireNativeRecorder().pause(validateSessionId(sessionId));
}

export async function resumeNativeRecorder(sessionId: string): Promise<NativeRecorderSnapshot> {
  return requireNativeRecorder().resume(validateSessionId(sessionId));
}

export async function stopNativeRecorder(sessionId: string): Promise<NativeRecorderStopResult> {
  const result = await requireNativeRecorder().stop(validateSessionId(sessionId));
  if (!isNativeRecorderStopComplete(result)) {
    throw new NativeRecorderStopError(result);
  }
  return result;
}

export function isNativeRecorderStopComplete(result: NativeRecorderStopResult): boolean {
  return result.status === 'completed' &&
    result.localSaved &&
    (result.snapshot.asrRequired === false || result.readyToStop) &&
    result.errorCode === null;
}

export async function stopLocalNativeRecorder(sessionId: string): Promise<NativeRecorderStopResult> {
  return stopNativeRecorder(sessionId);
}

export async function recoverNativeRecordings(): Promise<NativeRecorderRecoveryReport> {
  return requireNativeRecorder().recover();
}

export async function getNativeRecorderState(
  sessionId?: string,
): Promise<NativeRecorderSnapshot | null> {
  return requireNativeRecorder().getState(sessionId === undefined ? null : validateSessionId(sessionId));
}

export function addNativeRecorderStateListener(
  listener: NativeRecorderEvents['onRecorderStateChanged'],
): EventSubscription {
  return requireNativeRecorder().addListener('onRecorderStateChanged', listener);
}

export function addNativeRecorderLevelListener(
  listener: NativeRecorderEvents['onRecorderLevel'],
): EventSubscription {
  return requireNativeRecorder().addListener('onRecorderLevel', listener);
}

export function addNativeRecorderTranscriptListener(
  listener: NativeRecorderEvents['onRecorderTranscript'],
): EventSubscription {
  return requireNativeRecorder().addListener('onRecorderTranscript', listener);
}

export function addNativeRecorderErrorListener(
  listener: NativeRecorderEvents['onRecorderError'],
): EventSubscription {
  return requireNativeRecorder().addListener('onRecorderError', listener);
}

export function addNativeRecorderRecoveredListener(
  listener: NativeRecorderEvents['onRecorderRecovered'],
): EventSubscription {
  return requireNativeRecorder().addListener('onRecorderRecovered', listener);
}

function requireNativeRecorder(): LaojiRecorderNativeModule {
  if (!nativeRecorder) throw new NativeRecorderUnavailableError();
  return nativeRecorder;
}

function validateSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 160 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new TypeError('invalid sessionId');
  }
  return sessionId;
}

export function validateNativeRecorderWebSocketUrl(
  value: string,
  allowInsecureDevelopment = false,
): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('invalid websocketUrl');
  }
  if (
    (url.protocol !== 'wss:' && !(allowInsecureDevelopment && url.protocol === 'ws:')) ||
    !url.hostname ||
    url.username ||
    url.password ||
    raw.includes('?') ||
    raw.includes('#') ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      allowInsecureDevelopment
        ? 'websocketUrl must be ws or wss without userinfo, query, or fragment'
        : 'websocketUrl must be wss without userinfo, query, or fragment',
    );
  }
  return url.toString();
}

export function assertNativeRecorderDeploymentPolicy(
  isProduction: boolean,
  allowInsecureDevelopment: boolean,
): void {
  if (isProduction && allowInsecureDevelopment) {
    throw new TypeError('production must not enable insecure recorder transport');
  }
}

export function resolveNativeRecorderInsecureDevelopment(
  isProduction: boolean,
  realtimeAsrSecure: boolean,
): boolean {
  return !isProduction && !realtimeAsrSecure;
}

function normalizeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value.trim();
  if (!token || /[\r\n]/.test(token)) throw new TypeError('invalid authentication token');
  return token;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
