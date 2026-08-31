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

export type NativeRecorderAsrPhase =
  | 'notRequired'
  | 'connecting'
  | 'connected'
  | 'recoveryRequired'
  | 'completed';

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
  | 'stop_ack_timeout'
  | 'final_drain_timeout'
  | 'recovery_failed';

interface NativeRecorderStartBase {
  sessionId: string;
  purpose: NativeRealtimeRecorderPurpose;
  storageScope?: 'guest';
  websocketUrl: string;
  allowInsecureDevelopment?: boolean;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  levelIntervalMs?: number;
}

export type NativeRecorderStartOptions = NativeRecorderStartBase & (
  | { accessToken: string; guestToken?: never; deviceToken?: never; dataEpoch?: never }
  | { accessToken?: never; guestToken: string; deviceToken?: never; dataEpoch?: never }
  | { accessToken?: never; guestToken?: never; deviceToken: string; dataEpoch: string }
);

export interface NativeDeviceV2RecorderStartOptions {
  sessionId: string;
  storageScope?: 'guest';
  websocketUrl: string;
  credentialScope: string;
  credentialGeneration: number;
  taskId: string;
  clientOperationId: string;
  bindingId: string;
  bindingGeneration: string;
  bindingRevision: number;
  cancelRevision: number;
  assetId: string;
  assetGeneration: string;
  expiresAtEpoch: number;
  allowInsecureDevelopment?: boolean;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  levelIntervalMs?: number;
}

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
  storageScope: string | null;
  state: NativeRecorderState;
  startedAtMs: number;
  /** Native AudioRecord confirmation time; absent on an older native binary. */
  captureStartedAtMs?: number | null;
  updatedAtMs: number;
  bytesRecorded: number;
  durationMs: number;
  localUri: string | null;
  asrConnected: boolean;
  /** Optional for one release so an older native binary remains readable. */
  asrPhase?: NativeRecorderAsrPhase;
  /** Monotonic diagnostics emitted by the vNext native recorder. */
  asrConnectLatencyMs?: number | null;
  firstTranscriptLatencyMs?: number | null;
  asrRequired?: boolean;
  readyToStop: boolean;
  transcriptRecoveryRequired: boolean;
  errorCode: NativeRecorderErrorCode | null;
  errorMessage: string | null;
  providerErrorCode?: string | null;
  providerErrorRetryable?: boolean | null;
}

/** Normalize snapshots from both the vNext native module and the prior binary. */
export function nativeRecorderAsrPhase(snapshot: NativeRecorderSnapshot): NativeRecorderAsrPhase {
  if (snapshot.asrPhase) return snapshot.asrPhase;
  if (snapshot.asrRequired === false) return 'notRequired';
  if (snapshot.readyToStop && !snapshot.transcriptRecoveryRequired && !snapshot.errorCode) {
    return 'completed';
  }
  if (snapshot.asrConnected) return 'connected';
  if (snapshot.transcriptRecoveryRequired || snapshot.errorCode) return 'recoveryRequired';
  return 'connecting';
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

export interface NativeLocalMeetingRecorderSnapshot extends NativeRecorderSnapshot {
  purpose: 'meeting';
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
  speakerConfidence: number | null;
  startMs: number | null;
  endMs: number | null;
  source: string | null;
  eventSequence?: number | null;
  stableSegmentKey?: string | null;
  revisionKey?: string | null;
  purpose: NativeRealtimeRecorderPurpose;
  receivedAtMs: number;
}

export interface NativeRecorderFinalTranscriptSegment {
  segmentId: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  receivedAtMs: number;
  source: string | null;
}

export interface NativeRecorderErrorEvent {
  sessionId: string | null;
  errorCode: NativeRecorderErrorCode;
  errorMessage: string;
  recoverable: boolean;
  localUri: string | null;
  transcriptRecoveryRequired: boolean;
  /** Provider-level code, when the realtime server returned a structured error. */
  providerCode?: string | null;
  /** Whether the provider says the same audio may be retried later. */
  providerRetryable?: boolean | null;
  fileName?: string;
}

export interface NativeRecoveredRecording {
  sessionId: string;
  purpose: NativeRecorderPurpose;
  mode: NativeRecorderMode;
  storageScope: string | null;
  localUri: string;
  bytesRecorded: number;
  durationMs: number;
  recovered: boolean;
}

export interface NativeRecorderRecoveryFailure {
  sessionId: string | null;
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
  transcriptSegments?: NativeRecorderFinalTranscriptSegment[];
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
  startDeviceV2(options: NativeDeviceV2RecorderStartOptions): Promise<NativeRealtimeRecorderSnapshot>;
  attachDeviceV2(options: NativeDeviceV2RecorderStartOptions): Promise<NativeRealtimeRecorderSnapshot>;
  prewarmRealtime(options: NativeRecorderStartOptions): Promise<boolean>;
  discardRealtimePrewarm(sessionId: string): void;
  startLocal(sessionId: string, levelIntervalMs: number | null): Promise<NativeLocalRecorderSnapshot>;
  startLocalMeeting(
    sessionId: string,
    storageScope: string,
    levelIntervalMs: number | null,
  ): Promise<NativeLocalMeetingRecorderSnapshot>;
  startDeferredRealtimeMeeting(
    sessionId: string,
    storageScope: string,
    levelIntervalMs: number | null,
  ): Promise<NativeRealtimeRecorderSnapshot>;
  pause(sessionId: string): Promise<NativeRecorderSnapshot>;
  resume(sessionId: string): Promise<NativeRecorderSnapshot>;
  stop(sessionId: string): Promise<NativeRecorderStopResult>;
  acknowledgeDeviceV2Transcript(sessionId: string, throughEventSequence: number): Promise<boolean>;
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
  const deviceToken = normalizeToken(options.deviceToken);
  const dataEpoch = normalizeToken(options.dataEpoch);
  const credentialCount = [accessToken, guestToken, deviceToken].filter(Boolean).length;
  if (credentialCount !== 1) {
    throw new TypeError('exactly one of accessToken, guestToken, or deviceToken is required');
  }
  if (deviceToken !== undefined && dataEpoch === undefined) {
    throw new TypeError('dataEpoch is required with deviceToken');
  }
  if (deviceToken === undefined && dataEpoch !== undefined) {
    throw new TypeError('dataEpoch requires deviceToken');
  }

  const normalizedBase: NativeRecorderStartBase = {
    sessionId,
    purpose: options.purpose,
    storageScope: normalizeStorageScope(options.storageScope),
    websocketUrl,
    ...(dataEpoch !== undefined ? { dataEpoch } : {}),
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

  if (accessToken !== undefined) return { ...normalizedBase, accessToken };
  if (guestToken !== undefined) return { ...normalizedBase, guestToken };
  return { ...normalizedBase, deviceToken: deviceToken!, dataEpoch: dataEpoch! };
}

function normalizeStorageScope(value: string | undefined): 'guest' | undefined {
  if (value === undefined) return undefined;
  const scope = value.trim();
  if (scope !== 'guest') {
    throw new TypeError('invalid storageScope');
  }
  return scope;
}

export async function startNativeRecorder(
  options: NativeRecorderStartOptions,
): Promise<NativeRealtimeRecorderSnapshot> {
  return requireNativeRecorder().start(normalizeNativeRecorderStartOptions(options));
}

export async function startNativeDeviceV2Recorder(
  options: NativeDeviceV2RecorderStartOptions,
): Promise<NativeRealtimeRecorderSnapshot> {
  return requireNativeRecorder().startDeviceV2(normalizeNativeDeviceV2RecorderOptions(options));
}

export async function attachNativeDeviceV2Recorder(
  options: NativeDeviceV2RecorderStartOptions,
): Promise<NativeRealtimeRecorderSnapshot> {
  return requireNativeRecorder().attachDeviceV2(normalizeNativeDeviceV2RecorderOptions(options));
}

function normalizeNativeDeviceV2RecorderOptions(
  options: NativeDeviceV2RecorderStartOptions,
): NativeDeviceV2RecorderStartOptions {
  const allowInsecureDevelopment = options.allowInsecureDevelopment === true;
  const expiresAtEpoch = positiveSafeInteger(options.expiresAtEpoch, 'expiresAtEpoch');
  const nowEpoch = Math.floor(Date.now() / 1_000);
  if (expiresAtEpoch <= nowEpoch || expiresAtEpoch > nowEpoch + 24 * 60 * 60) {
    throw new TypeError('invalid expiresAtEpoch');
  }
  const normalized: NativeDeviceV2RecorderStartOptions = {
    ...options,
    sessionId: validateSessionId(options.sessionId),
    storageScope: normalizeStorageScope(options.storageScope),
    websocketUrl: validateNativeRecorderWebSocketUrl(
      options.websocketUrl,
      allowInsecureDevelopment,
    ),
    credentialScope: boundedIdentifier(options.credentialScope, 120, 'credentialScope'),
    credentialGeneration: nonNegativeSafeInteger(
      options.credentialGeneration,
      'credentialGeneration',
    ),
    taskId: boundedIdentifier(options.taskId, 180, 'taskId'),
    clientOperationId: boundedIdentifier(options.clientOperationId, 180, 'clientOperationId'),
    bindingId: boundedIdentifier(options.bindingId, 180, 'bindingId'),
    bindingGeneration: generation(options.bindingGeneration, 'bindingGeneration'),
    bindingRevision: positiveSafeInteger(options.bindingRevision, 'bindingRevision'),
    cancelRevision: nonNegativeSafeInteger(options.cancelRevision, 'cancelRevision'),
    assetId: boundedIdentifier(options.assetId, 180, 'assetId'),
    assetGeneration: generation(options.assetGeneration, 'assetGeneration'),
    expiresAtEpoch,
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
  return normalized;
}

export async function prewarmNativeRecorder(
  options: NativeRecorderStartOptions,
): Promise<boolean> {
  return requireNativeRecorder().prewarmRealtime(normalizeNativeRecorderStartOptions(options));
}

export function discardNativeRecorderPrewarm(sessionId: string): void {
  requireNativeRecorder().discardRealtimePrewarm(validateSessionId(sessionId));
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

export async function startLocalMeetingNativeRecorder(
  sessionId: string,
  storageScope: 'guest',
  options: NativeLocalRecorderOptions = {},
): Promise<NativeLocalMeetingRecorderSnapshot> {
  const normalizedSessionId = validateSessionId(sessionId);
  const normalizedStorageScope = storageScope.trim();
  if (normalizedStorageScope !== 'guest') throw new TypeError('storageScope must be guest');
  return requireNativeRecorder().startLocalMeeting(
    normalizedSessionId,
    normalizedStorageScope,
    boundedInteger(options.levelIntervalMs, 50, 1_000, 'levelIntervalMs') ?? null,
  );
}

export async function startDeferredRealtimeMeetingNativeRecorder(
  sessionId: string,
  storageScope: 'guest',
  options: NativeLocalRecorderOptions = {},
): Promise<NativeRealtimeRecorderSnapshot> {
  const normalizedSessionId = validateSessionId(sessionId);
  const normalizedStorageScope = storageScope.trim();
  if (normalizedStorageScope !== 'guest') throw new TypeError('storageScope must be guest');
  return requireNativeRecorder().startDeferredRealtimeMeeting(
    normalizedSessionId,
    normalizedStorageScope,
    boundedInteger(options.levelIntervalMs, 50, 1_000, 'levelIntervalMs') ?? null,
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

export async function acknowledgeNativeDeviceV2Transcript(
  sessionId: string,
  throughEventSequence: number,
): Promise<boolean> {
  return requireNativeRecorder().acknowledgeDeviceV2Transcript(
    validateSessionId(sessionId),
    positiveSafeInteger(throughEventSequence, 'throughEventSequence'),
  );
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

function boundedIdentifier(value: string, maximum: number, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`invalid ${fieldName}`);
  }
  return normalized;
}

function generation(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new TypeError(`invalid ${fieldName}`);
  return normalized;
}

function nonNegativeSafeInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${fieldName}`);
  return value;
}

function positiveSafeInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid ${fieldName}`);
  return value;
}
