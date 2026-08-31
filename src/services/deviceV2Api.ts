import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getApiConfig } from './config';
import { fetchWithTimeout, readJsonWithTimeout } from './http';
import { getDeviceIdentityRevision, getOrCreateDeviceIdentity } from './deviceIdentity';
import {
  findDeviceProofOfWork,
  getOrCreateDeviceKey,
  markPurgeCapabilityArmed,
  preparePurgeCapability,
  beginPurgeOnlyErase,
  resumePurgeOnlyJournal,
  signWithDeviceKey,
  type PurgeOnlyJournalStatus,
  type DeviceKeyInfo,
} from 'laoji-native-platform';
import { diagnosticAudit } from './diagnostics';

const TOKEN_KEY = 'laoji.device.v2.token';
const TOKEN_EXPIRES_KEY = 'laoji.device.v2.token.expires';
const KEY_VERSION_KEY = 'laoji.device.v2.key.version';
const PUBLIC_HASH_KEY = 'laoji.device.v2.key.hash';
const SESSION_KEY = 'laoji.device.v2.session';
const CAPABILITY_CACHE_MS = 60_000;

let capabilityValue: DeviceV2Capabilities | null = null;
let capabilityPromise: Promise<DeviceV2Capabilities> | null = null;
let capabilityUntil = 0;
let sessionPromise: Promise<DeviceV2Session> | null = null;
let refreshPromise: Promise<DeviceV2Session> | null = null;
let sessionValue: DeviceV2Session | null = null;
let sessionIdentityRevision = -1;

export class DeviceV2ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'DeviceV2ApiError';
  }
}

export interface DeviceV2Session {
  token: string;
  expiresAt: number;
  deviceId: string;
  epochId: string;
  keyVersion: number;
  publicKeyHash: string;
}

export interface DeviceV2Capabilities {
  schemaVersion: 2;
  uploadSessionsV2: boolean;
  importTranscriptEventsV2: boolean;
  realtimeAsrV2: boolean;
  scheduleGraphV2: boolean;
  sourceStreamV2: boolean;
  questionReaderV2: boolean;
  summaryHandlerRevision: string | null;
  summaryPromptRevision: string | null;
  summaryModelRevision: string | null;
}

function endpoint(path: string): string {
  return `${getApiConfig().apiBase}/api/device/v2${path}`;
}

function randomRequestId(prefix: string): string {
  return `${prefix}-${Crypto.randomUUID()}`;
}

function base64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Base64(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function publicKeyBytes(publicKeyDer: string): Uint8Array {
  const normalized = publicKeyDer.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

async function publicKeyHash(publicKeyDer: string): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    publicKeyBytes(publicKeyDer) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function message(kind: string, nonce: string, deviceId: string, epochId: string, requestId: string, proofNonce?: number): string {
  const parts = ['laoji-device-v2', kind, nonce, deviceId, epochId, requestId];
  if (proofNonce !== undefined) parts.push(`proof:${proofNonce}`);
  return parts.join('\n');
}

async function jsonRequest<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  const route = path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'root';
  diagnosticAudit('device_v2_http_start', { route });
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint(path), init);
  } catch (error) {
    diagnosticAudit('device_v2_http_error', {
      route,
      error_code: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
  diagnosticAudit('device_v2_http_response', { route, status: response.status });
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 15_000); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.detail ?? data?.error ?? data;
    const messageText = typeof detail === 'string'
      ? detail
      : String(detail?.message ?? fallback);
    const code = typeof detail?.code === 'string' ? detail.code : undefined;
    diagnosticAudit('device_v2_http_rejected', {
      route,
      status: response.status,
      error_code: code ?? 'http_error',
    });
    throw new DeviceV2ApiError(messageText, response.status, code);
  }
  return data as T;
}

function normalizeStoredSessionEnvelope(
  identity: { deviceId: string; epochId: string },
  input: {
    token?: unknown;
    expiresAt?: unknown;
    keyVersion?: unknown;
    publicKeyHash?: unknown;
    deviceId?: unknown;
    epochId?: unknown;
  },
  options: { allowExpired?: boolean } = {},
): DeviceV2Session | null {
  const token = typeof input.token === 'string' ? input.token : '';
  const expiresAt = Number(input.expiresAt);
  const keyVersion = Number(input.keyVersion);
  const storedHash = typeof input.publicKeyHash === 'string' ? input.publicKeyHash : '';
  if (!token || !Number.isSafeInteger(expiresAt)
    || (!options.allowExpired && expiresAt <= Date.now() + 30_000)
    || !Number.isSafeInteger(keyVersion) || keyVersion < 1
    || !/^[0-9a-f]{64}$/.test(storedHash)) return null;
  if ((typeof input.deviceId === 'string' && input.deviceId !== identity.deviceId)
    || (typeof input.epochId === 'string' && input.epochId !== identity.epochId)) return null;
  return {
    token,
    expiresAt,
    deviceId: identity.deviceId,
    epochId: identity.epochId,
    keyVersion,
    publicKeyHash: storedHash,
  };
}

async function readStoredSessionEnvelope(
  identity: { deviceId: string; epochId: string },
  options: { allowExpired?: boolean } = {},
): Promise<DeviceV2Session | null> {
  const packed = await SecureStore.getItemAsync(SESSION_KEY);
  if (packed) {
    try {
      const stored = normalizeStoredSessionEnvelope(identity, JSON.parse(packed), options);
      if (stored) return stored;
    } catch {
      // A malformed value is treated as absent and rebuilt from the previous
      // four-key layout or the next successful authentication.
    }
  }

  const [token, expiresAt, keyVersion, publicKeyHash] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(TOKEN_EXPIRES_KEY),
    SecureStore.getItemAsync(KEY_VERSION_KEY),
    SecureStore.getItemAsync(PUBLIC_HASH_KEY),
  ]);
  const legacy = normalizeStoredSessionEnvelope(
    identity,
    { token, expiresAt, keyVersion, publicKeyHash },
    options,
  );
  if (legacy) {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({
      token: legacy.token,
      expiresAt: legacy.expiresAt,
      keyVersion: legacy.keyVersion,
      publicKeyHash: legacy.publicKeyHash,
      deviceId: legacy.deviceId,
      epochId: legacy.epochId,
    }));
  }
  return legacy;
}

async function readStoredSession(
  identity: { deviceId: string; epochId: string },
  key: DeviceKeyInfo,
  hash: string,
  options: { allowExpired?: boolean } = {},
): Promise<DeviceV2Session | null> {
  const stored = await readStoredSessionEnvelope(identity, options);
  if (!stored || stored.keyVersion !== key.keyVersion || stored.publicKeyHash !== hash) return null;
  return stored;
}

async function persistDeviceV2Token(
  token: { access_token: string; expires_at: number; key_version: number },
  hash: string,
  identity: { deviceId: string; epochId: string },
  expectedKeyVersion: number,
): Promise<DeviceV2Session> {
  const expiresAt = token.expires_at < 1_000_000_000_000
    ? token.expires_at * 1000
    : token.expires_at;
  if (!token.access_token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new DeviceV2ApiError('设备令牌响应无效', 502, 'DEVICE_V2_TOKEN_INVALID');
  }
  if (token.key_version !== expectedKeyVersion) {
    throw new DeviceV2ApiError('设备密钥版本不一致', 409, 'DEVICE_V2_KEY_VERSION_CHANGED');
  }
  const session = {
    token: token.access_token,
    expiresAt,
    deviceId: identity.deviceId,
    epochId: identity.epochId,
    keyVersion: token.key_version,
    publicKeyHash: hash,
  };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({
    token: session.token,
    expiresAt: session.expiresAt,
    keyVersion: session.keyVersion,
    publicKeyHash: session.publicKeyHash,
    deviceId: session.deviceId,
    epochId: session.epochId,
  }));
  return session;
}

async function issueDeviceV2Token(
  identity: { deviceId: string; epochId: string },
  key: DeviceKeyInfo,
  hash: string,
): Promise<DeviceV2Session> {
  const authRequestId = randomRequestId('auth');
  const authChallenge = await jsonRequest<{ challenge_id: string; nonce: string; key_version: number }>(
    '/auth/challenges',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 2,
        device_id: identity.deviceId,
        epoch_id: identity.epochId,
        key_version: key.keyVersion,
        public_key_hash: hash,
        request_id: authRequestId,
      }),
    },
    '设备认证挑战失败',
  );
  const authSignature = signWithDeviceKey(
    key.keyVersion,
    utf8Base64(message('auth', authChallenge.nonce, identity.deviceId, identity.epochId, authRequestId)),
  );
  const token = await jsonRequest<{
    access_token: string;
    expires_at: number;
    key_version: number;
  }>('/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 2,
      challenge_id: authChallenge.challenge_id,
      nonce: authChallenge.nonce,
      signature: authSignature,
      request_id: authRequestId,
    }),
  }, '设备令牌获取失败');
  return persistDeviceV2Token(token, hash, identity, key.keyVersion);
}

/** Refresh an existing epoch without re-registering the device or replacing its key. */
export async function refreshDeviceV2Session(
  previous?: DeviceV2Session,
): Promise<DeviceV2Session> {
  const identity = await getOrCreateDeviceIdentity();
  const key = await getOrCreateDeviceKey(1);
  const hash = await publicKeyHash(key.publicKeyDer);
  if (previous && (previous.deviceId !== identity.deviceId || previous.epochId !== identity.epochId)) {
    throw new DeviceV2ApiError('设备数据域已变化，请重新初始化', 409, 'DEVICE_V2_EPOCH_CHANGED');
  }
  return issueDeviceV2Token(identity, key, hash);
}

function isMissingServerRegistration(error: unknown): boolean {
  return error instanceof DeviceV2ApiError
    && error.status === 401
    && error.code === 'DEVICE_NOT_REGISTERED';
}

async function refreshOrRestoreDeviceV2Session(
  previous: DeviceV2Session,
): Promise<DeviceV2Session> {
  try {
    return await refreshDeviceV2Session(previous);
  } catch (error) {
    if (!isMissingServerRegistration(error)) throw error;
    // A restored/replaced server database can legitimately lose the remote
    // registration while the phone still owns the same device ID, epoch and
    // non-exportable P-256 key. Re-prove that existing identity instead of
    // deleting local data or rotating to a second business owner. Other 401s
    // remain terminal and never enter this recovery path.
    diagnosticAudit('device_v2_session_registration_restore', {});
    return bootstrapDeviceV2Session({ ignoreStoredSession: true });
  }
}

async function refreshDeviceV2SessionSingleFlight(
  previous: DeviceV2Session,
): Promise<DeviceV2Session> {
  if (refreshPromise) return refreshPromise;
  const operation = refreshOrRestoreDeviceV2Session(previous);
  refreshPromise = operation;
  try {
    const session = await operation;
    rememberDeviceV2Session(session);
    return session;
  } finally {
    if (refreshPromise === operation) refreshPromise = null;
  }
}

function rememberDeviceV2Session(session: DeviceV2Session): void {
  sessionValue = session;
  sessionIdentityRevision = getDeviceIdentityRevision();
}

async function bootstrapDeviceV2Session(
  options: { ignoreStoredSession?: boolean } = {},
): Promise<DeviceV2Session> {
  const identity = await getOrCreateDeviceIdentity();
  const key = await getOrCreateDeviceKey(1);
  const hash = await publicKeyHash(key.publicKeyDer);
  if (!options.ignoreStoredSession) {
    const stored = await readStoredSession(identity, key, hash);
    if (stored) return stored;
  }

  const bootstrapRequestId = randomRequestId('bootstrap');
  const purgeCapability = await preparePurgeCapability(
    'epoch',
    identity.epochId,
    randomRequestId('purge-register'),
  );
  const challenge = await jsonRequest<{
    challenge_id: string;
    nonce: string;
    proof_difficulty_bits: number;
  }>('/bootstrap/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 2,
      device_id: identity.deviceId,
      epoch_id: identity.epochId,
      public_key: key.publicKeyDer,
      request_id: bootstrapRequestId,
    }),
  }, '设备注册挑战失败');
  const proofNonce = await findDeviceProofOfWork(challenge.nonce, challenge.proof_difficulty_bits);
  const bootstrapSignature = signWithDeviceKey(
    key.keyVersion,
    utf8Base64(message('bootstrap', challenge.nonce, identity.deviceId, identity.epochId, bootstrapRequestId, proofNonce)),
  );
  await jsonRequest('/bootstrap/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 2,
      device_id: identity.deviceId,
      epoch_id: identity.epochId,
      public_key: key.publicKeyDer,
      request_id: bootstrapRequestId,
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      signature: bootstrapSignature,
      proof_nonce: proofNonce,
      purge_capability: {
        capability_id: purgeCapability.capabilityId,
        secret_sha256: purgeCapability.secretSha256,
        registration_request_id: purgeCapability.registrationRequestId,
      },
    }),
  }, '设备注册失败');
  markPurgeCapabilityArmed(purgeCapability.capabilityId);

  return issueDeviceV2Token(identity, key, hash);
}

export async function ensureDeviceV2Session(): Promise<DeviceV2Session> {
  if (
    sessionValue
    && sessionIdentityRevision === getDeviceIdentityRevision()
    && sessionValue.expiresAt > Date.now() + 30_000
  ) {
    diagnosticAudit('device_v2_session_memory_cached', {});
    return sessionValue;
  }
  if (sessionPromise) return sessionPromise;
  const operation = (async () => {
    diagnosticAudit('device_v2_session_start', {});
    try {
      const identity = await getOrCreateDeviceIdentity();
      diagnosticAudit('device_v2_session_identity_ready', {});
      // A still-valid bearer is already bound to this device/epoch and public
      // key hash. Reusing it avoids opening Android Keystore during every cold
      // start; the non-exportable private key is loaded only when the token
      // must be refreshed or the device must be registered again.
      const cached = await readStoredSessionEnvelope(identity);
      if (cached) {
        diagnosticAudit('device_v2_session_cached', {});
        return cached;
      }
      const key = await getOrCreateDeviceKey(1);
      diagnosticAudit('device_v2_session_key_ready', { key_version: key.keyVersion });
      const hash = await publicKeyHash(key.publicKeyDer);
      const stored = await readStoredSession(identity, key, hash, { allowExpired: true });
      if (stored && stored.expiresAt > Date.now() + 30_000) {
        diagnosticAudit('device_v2_session_cached', {});
        return stored;
      }
      if (stored) {
        diagnosticAudit('device_v2_session_refresh', {});
        return refreshDeviceV2SessionSingleFlight(stored);
      }
      diagnosticAudit('device_v2_session_bootstrap', {});
      return bootstrapDeviceV2Session();
    } catch (error) {
      diagnosticAudit('device_v2_session_error', {
        error_code: error instanceof DeviceV2ApiError ? (error.code ?? 'device_v2_error') : error instanceof Error ? error.name : 'unknown',
        status: error instanceof DeviceV2ApiError ? error.status : 0,
      });
      throw error;
    }
  })();
  sessionPromise = operation;
  try {
    const session = await operation;
    rememberDeviceV2Session(session);
    return session;
  } finally {
    if (sessionPromise === operation) sessionPromise = null;
  }
}

export async function deviceV2Request<T>(path: string, init: RequestInit = {}, fallback = '设备服务暂时不可用'): Promise<T> {
  let session = await ensureDeviceV2Session();
  let refreshed = false;
  while (true) {
    try {
      return await jsonRequest<T>(path, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${session.token}`,
          'X-Laoji-Device-Id': session.deviceId,
          'X-Laoji-Epoch-Id': session.epochId,
        },
      }, fallback);
    } catch (error) {
      if (!(error instanceof DeviceV2ApiError) || error.status !== 401 || refreshed) throw error;
      refreshed = true;
      session = await refreshDeviceV2SessionSingleFlight(session);
    }
  }
}

function normalizeCapabilities(value: any): DeviceV2Capabilities {
  if (!value || Number(value.schema_version) !== 2 || value.device_api !== true) {
    throw new DeviceV2ApiError('设备服务能力响应无效', 502, 'DEVICE_V2_CAPABILITIES_INVALID');
  }
  const revision = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null;
    const normalized = candidate.trim();
    return normalized && normalized.length <= 180 && !/[\u0000-\u001f\u007f]/.test(normalized)
      ? normalized
      : null;
  };
  return {
    schemaVersion: 2,
    uploadSessionsV2: value.upload_sessions_v2 === true,
    importTranscriptEventsV2: value.import_transcript_events_v2 === true,
    realtimeAsrV2: value.realtime_asr_v2 === true,
    scheduleGraphV2: value.schedule_graph_v2 === true,
    sourceStreamV2: value.source_stream_v2 === true,
    questionReaderV2: value.question_reader_v2 === true,
    summaryHandlerRevision: revision(value.summary_handler_revision),
    summaryPromptRevision: revision(value.summary_prompt_revision),
    summaryModelRevision: revision(value.summary_model_revision),
  };
}

export async function loadDeviceV2Capabilities(
  options: { forceRefresh?: boolean } = {},
): Promise<DeviceV2Capabilities> {
  if (!options.forceRefresh && capabilityValue && capabilityUntil > Date.now()) {
    return capabilityValue;
  }
  if (!options.forceRefresh && capabilityPromise) return capabilityPromise;
  const request = deviceV2Request<any>('/capabilities', {}, '读取 v2 设备能力失败')
    .then(normalizeCapabilities);
  capabilityPromise = request;
  try {
    const value = await request;
    capabilityValue = value;
    capabilityUntil = Date.now() + CAPABILITY_CACHE_MS;
    diagnosticAudit('device_v2_capabilities_ready', {
      upload_sessions_v2: value.uploadSessionsV2,
      import_transcript_events_v2: value.importTranscriptEventsV2,
      realtime_asr_v2: value.realtimeAsrV2,
      schedule_graph_v2: value.scheduleGraphV2,
      source_stream_v2: value.sourceStreamV2,
      question_reader_v2: value.questionReaderV2,
    });
    return value;
  } finally {
    if (capabilityPromise === request) capabilityPromise = null;
  }
}

export function beginDeviceV2PurgeOnlyErase(): PurgeOnlyJournalStatus {
  return beginPurgeOnlyErase();
}

export function resumeDeviceV2PurgeOnlyErase(): Promise<PurgeOnlyJournalStatus> {
  return resumePurgeOnlyJournal(getApiConfig().apiBase);
}

export const deviceV2StorageKeys = {
  session: SESSION_KEY,
  token: TOKEN_KEY,
  tokenExpires: TOKEN_EXPIRES_KEY,
  keyVersion: KEY_VERSION_KEY,
  publicHash: PUBLIC_HASH_KEY,
} as const;
