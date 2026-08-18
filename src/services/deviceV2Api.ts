import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getApiConfig } from './config';
import { fetchWithTimeout, readJsonWithTimeout } from './http';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
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

const TOKEN_KEY = 'laoji.device.v2.token';
const TOKEN_EXPIRES_KEY = 'laoji.device.v2.token.expires';
const KEY_VERSION_KEY = 'laoji.device.v2.key.version';
const PUBLIC_HASH_KEY = 'laoji.device.v2.key.hash';
const CAPABILITY_CACHE_MS = 60_000;

let capabilityValue: DeviceV2Capabilities | null = null;
let capabilityPromise: Promise<DeviceV2Capabilities> | null = null;
let capabilityUntil = 0;
let sessionPromise: Promise<DeviceV2Session> | null = null;

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
  const response = await fetchWithTimeout(endpoint(path), init);
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 15_000); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.detail ?? data?.error ?? data;
    const messageText = typeof detail === 'string'
      ? detail
      : String(detail?.message ?? fallback);
    const code = typeof detail?.code === 'string' ? detail.code : undefined;
    throw new DeviceV2ApiError(messageText, response.status, code);
  }
  return data as T;
}

async function readStoredSession(
  identity: { deviceId: string; epochId: string },
  key: DeviceKeyInfo,
  hash: string,
  options: { allowExpired?: boolean } = {},
): Promise<DeviceV2Session | null> {
  const [token, expiresRaw, versionRaw, storedHash] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(TOKEN_EXPIRES_KEY),
    SecureStore.getItemAsync(KEY_VERSION_KEY),
    SecureStore.getItemAsync(PUBLIC_HASH_KEY),
  ]);
  const expiresAt = Number(expiresRaw);
  const keyVersion = Number(versionRaw);
  if (!token || !Number.isSafeInteger(expiresAt)
    || (!options.allowExpired && expiresAt <= Date.now() + 30_000)
    || keyVersion !== key.keyVersion || storedHash !== hash) return null;
  return {
    token,
    expiresAt,
    deviceId: identity.deviceId,
    epochId: identity.epochId,
    keyVersion,
    publicKeyHash: hash,
  };
}

async function persistDeviceV2Token(
  token: { access_token: string; expires_at: number; key_version: number },
  hash: string,
  identity: { deviceId: string; epochId: string },
): Promise<DeviceV2Session> {
  const expiresAt = token.expires_at < 1_000_000_000_000
    ? token.expires_at * 1000
    : token.expires_at;
  if (!token.access_token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new DeviceV2ApiError('设备令牌响应无效', 502, 'DEVICE_V2_TOKEN_INVALID');
  }
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, token.access_token),
    SecureStore.setItemAsync(TOKEN_EXPIRES_KEY, String(expiresAt)),
    SecureStore.setItemAsync(KEY_VERSION_KEY, String(token.key_version)),
    SecureStore.setItemAsync(PUBLIC_HASH_KEY, hash),
  ]);
  return {
    token: token.access_token,
    expiresAt,
    deviceId: identity.deviceId,
    epochId: identity.epochId,
    keyVersion: token.key_version,
    publicKeyHash: hash,
  };
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
  return persistDeviceV2Token(token, hash, identity);
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

async function bootstrapDeviceV2Session(): Promise<DeviceV2Session> {
  const identity = await getOrCreateDeviceIdentity();
  const key = await getOrCreateDeviceKey(1);
  const hash = await publicKeyHash(key.publicKeyDer);
  const stored = await readStoredSession(identity, key, hash);
  if (stored) return stored;

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
  if (sessionPromise) return sessionPromise;
  const operation = (async () => {
    const identity = await getOrCreateDeviceIdentity();
    const key = await getOrCreateDeviceKey(1);
    const hash = await publicKeyHash(key.publicKeyDer);
    const stored = await readStoredSession(identity, key, hash, { allowExpired: true });
    if (stored && stored.expiresAt > Date.now() + 30_000) return stored;
    if (stored) {
      return refreshDeviceV2Session(stored);
    }
    return bootstrapDeviceV2Session();
  })();
  sessionPromise = operation;
  try {
    return await operation;
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
      session = await refreshDeviceV2Session(session);
    }
  }
}

function normalizeCapabilities(value: any): DeviceV2Capabilities {
  if (!value || Number(value.schema_version) !== 2 || value.device_api !== true) {
    throw new DeviceV2ApiError('设备服务能力响应无效', 502, 'DEVICE_V2_CAPABILITIES_INVALID');
  }
  return {
    schemaVersion: 2,
    uploadSessionsV2: value.upload_sessions_v2 === true,
    importTranscriptEventsV2: value.import_transcript_events_v2 === true,
    realtimeAsrV2: value.realtime_asr_v2 === true,
    scheduleGraphV2: value.schedule_graph_v2 === true,
    sourceStreamV2: value.source_stream_v2 === true,
    questionReaderV2: value.question_reader_v2 === true,
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
  token: TOKEN_KEY,
  tokenExpires: TOKEN_EXPIRES_KEY,
  keyVersion: KEY_VERSION_KEY,
  publicHash: PUBLIC_HASH_KEY,
} as const;
