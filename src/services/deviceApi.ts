import { getApiConfig } from './config';
import { fetchWithTimeout, readJsonWithTimeout } from './http';
import { getOrCreateDeviceIdentity, type DeviceIdentity } from './deviceIdentity';
import { diagnosticAudit } from './diagnostics';
import * as FileSystem from 'expo-file-system/legacy';

export interface DeviceApiErrorShape {
  code?: string;
  message?: string;
}

export class DeviceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DeviceApiError';
  }
}

export interface DeviceRealtimeAuth {
  /** Full device bearer value, without the ``Bearer `` scheme prefix. */
  deviceToken: string;
  dataEpoch: string;
}

export interface DeviceMediaImportCapabilities {
  mimeTypes: readonly string[];
  maxBytes: number;
}

export interface DeviceServiceCapabilities {
  schemaVersion: number;
  deviceApi: boolean;
  dataEpoch: boolean;
  meetingBindings: boolean;
  resumableUploads: boolean;
  chunkBytes: number;
  r2Upload: boolean;
  r2PartSize: number | null;
  maxAssetBytes: number;
  mediaImport: DeviceMediaImportCapabilities | null;
  summaryAttachmentsText: boolean;
}

let identityPromise: Promise<DeviceIdentity> | null = null;
let deviceReadyPromise: Promise<DeviceIdentity> | null = null;
let deviceReadyKey: string | null = null;
let deviceReadyUntil = 0;
let deviceCapabilitiesPromise: Promise<DeviceServiceCapabilities> | null = null;
let deviceCapabilitiesKey: string | null = null;
let deviceCapabilitiesUntil = 0;
let deviceCapabilitiesValue: DeviceServiceCapabilities | null = null;

// Registration and capability discovery are idempotent, but doing both for
// every recording start adds an avoidable tunnel round trip.  Keep the
// readiness proof briefly in memory; the device secret and epoch remain the
// source of truth and a new epoch automatically invalidates this cache.
const DEVICE_READY_CACHE_MS = 60_000;

async function identity(): Promise<DeviceIdentity> {
  if (!identityPromise) identityPromise = getOrCreateDeviceIdentity();
  try {
    return await identityPromise;
  } catch (error) {
    identityPromise = null;
    throw error;
  }
}

function identityKey(current: DeviceIdentity): string {
  return `${current.deviceId}:${current.epochId}`;
}

/** Drop a readiness proof after an auth/epoch error or explicit epoch close. */
function invalidateDeviceReady(): void {
  deviceReadyPromise = null;
  deviceReadyKey = null;
  deviceReadyUntil = 0;
  deviceCapabilitiesPromise = null;
  deviceCapabilitiesKey = null;
  deviceCapabilitiesUntil = 0;
  deviceCapabilitiesValue = null;
}

function url(path: string): string {
  return `${getApiConfig().apiBase}/api/device/v1${path}`;
}

function jsonHeaders(current: DeviceIdentity, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer dv1.${current.deviceId}.${current.deviceSecret}`,
    'X-Laoji-Data-Epoch': current.epochId,
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

function parseError(value: any, fallback: string): { message: string; code?: string } {
  const detail = value?.detail ?? value?.error ?? value;
  if (typeof detail === 'string') return { message: detail };
  return {
    message: String(detail?.message || value?.message || fallback),
    code: typeof detail?.code === 'string' ? detail.code : undefined,
  };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  fallback = '设备服务暂时不可用',
): Promise<T> {
  const route = path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'root';
  diagnosticAudit('device_v1_http_start', { route });
  let response: Response;
  try {
    const current = await identity();
    response = await fetchWithTimeout(url(path), {
      ...init,
      headers: { ...jsonHeaders(current), ...(init.headers ?? {}) },
    });
  } catch (error) {
    diagnosticAudit('device_v1_http_error', {
      route,
      error_code: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
  diagnosticAudit('device_v1_http_response', { route, status: response.status });
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 15_000); } catch { data = null; }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) invalidateDeviceReady();
    const parsed = parseError(data, fallback);
    diagnosticAudit('device_v1_http_rejected', {
      route,
      status: response.status,
      error_code: parsed.code ?? 'http_error',
    });
    throw new DeviceApiError(parsed.message, response.status, parsed.code);
  }
  return data as T;
}

export async function registerDevice(): Promise<DeviceIdentity> {
  const current = await identity();
  const bootstrap = getApiConfig().deviceBootstrapKey
    || (globalThis as any)?.__EXPO_DEVICE_BOOTSTRAP_KEY;
  const response = await fetchWithTimeout(`${getApiConfig().apiBase}/api/device/v1/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bootstrap ? { 'X-Laoji-Device-Bootstrap': String(bootstrap) } : {}),
    },
    // The wire contract is intentionally snake_case even though the local
    // SecureStore-facing identity uses idiomatic TypeScript camelCase.  Do
    // not spread the local object here: FastAPI rejects unknown fields and a
    // release build would silently remain unregistered with a 422 response.
    body: JSON.stringify({
      schema_version: 1,
      device_id: current.deviceId,
      device_secret: current.deviceSecret,
      epoch_id: current.epochId,
    }),
  });
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 15_000); } catch { data = null; }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) invalidateDeviceReady();
    const parsed = parseError(data, '设备服务连接失败');
    throw new DeviceApiError(parsed.message, response.status, parsed.code);
  }
  return current;
}

export async function ensureDeviceReady(): Promise<DeviceIdentity> {
  const current = await identity();
  const key = identityKey(current);
  if (deviceReadyPromise && deviceReadyKey === key) return deviceReadyPromise;
  if (deviceReadyKey === key && deviceReadyUntil > Date.now()) return current;

  const proof = (async () => {
    try {
      await registerDevice();
    } catch (error) {
      // A device that was registered by an earlier build already has a
      // durable device secret and epoch.  Capability discovery must remain
      // usable on that device even when the one-time bootstrap key is not
      // embedded in a later APK; the authenticated capabilities request below
      // still verifies the device secret and epoch.  Other registration
      // failures (invalid identity, network, server error) remain fatal.
      if (!(error instanceof DeviceApiError) || error.code !== 'DEVICE_BOOTSTRAP_INVALID') {
        throw error;
      }
    }
    const capabilities = normalizeDeviceCapabilities(
      await request('/capabilities', {}, '读取设备服务能力失败'),
    );
    deviceCapabilitiesKey = key;
    deviceCapabilitiesValue = capabilities;
    deviceCapabilitiesUntil = Date.now() + DEVICE_READY_CACHE_MS;
    deviceReadyUntil = Date.now() + DEVICE_READY_CACHE_MS;
    return current;
  })();
  deviceReadyPromise = proof;
  deviceReadyKey = key;
  try {
    return await proof;
  } catch (error) {
    if (deviceReadyPromise === proof) invalidateDeviceReady();
    throw error;
  } finally {
    if (deviceReadyPromise === proof) deviceReadyPromise = null;
  }
}

function normalizeDeviceCapabilities(value: any): DeviceServiceCapabilities {
  const media = value?.media_import;
  const mimeTypes = Array.isArray(media?.mime_types)
    ? media.mime_types.filter((item: unknown): item is string => (
      typeof item === 'string' && item.trim().length > 0
    ))
    : [];
  const maxBytes = Number(media?.max_bytes ?? 0);
  const schemaVersion = Number(value?.schema_version ?? 0);
  const chunkBytes = Number(value?.chunk_bytes ?? 0);
  const r2PartSize = Number(value?.r2_part_size ?? 0);
  const maxAssetBytes = Number(value?.max_asset_bytes ?? 0);
  if (
    !Number.isSafeInteger(schemaVersion) || schemaVersion < 1
    || value?.device_api !== true
    || value?.data_epoch !== true
    || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0
    || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0
    || (media !== null && media !== undefined && (
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || mimeTypes.length === 0
    ))
  ) throw new DeviceApiError('设备服务能力响应无效', 502, 'DEVICE_CAPABILITIES_INVALID');
  return {
    schemaVersion,
    deviceApi: true,
    dataEpoch: true,
    meetingBindings: value?.meeting_bindings === true,
    resumableUploads: value?.resumable_uploads === true,
    chunkBytes,
    r2Upload: value?.r2_upload === true
      && Number.isSafeInteger(r2PartSize)
      && r2PartSize >= 5 * 1024 * 1024,
    r2PartSize: value?.r2_upload === true
      && Number.isSafeInteger(r2PartSize)
      && r2PartSize >= 5 * 1024 * 1024
      ? r2PartSize
      : null,
    maxAssetBytes,
    mediaImport: media && Number.isSafeInteger(maxBytes) && maxBytes > 0 && mimeTypes.length > 0
      ? { mimeTypes, maxBytes }
      : null,
    summaryAttachmentsText: value?.summary_attachments_text === true,
  };
}

/**
 * Capability discovery for the accountless product.  This intentionally uses
 * the device-authenticated endpoint, which is the sole capability owner for
 * deciding whether a local import is allowed.
 */
export async function loadDeviceServiceCapabilities(
  options: { forceRefresh?: boolean } = {},
): Promise<DeviceServiceCapabilities> {
  const current = await ensureDeviceReady();
  const key = identityKey(current);
  if (
    !options.forceRefresh
    && deviceCapabilitiesKey === key
    && deviceCapabilitiesValue
    && deviceCapabilitiesUntil > Date.now()
  ) return deviceCapabilitiesValue;
  if (!options.forceRefresh && deviceCapabilitiesPromise && deviceCapabilitiesKey === key) {
    return deviceCapabilitiesPromise;
  }
  const capabilitiesRequest = request<any>('/capabilities', {}, '读取设备服务能力失败')
    .then(normalizeDeviceCapabilities);
  deviceCapabilitiesPromise = capabilitiesRequest;
  deviceCapabilitiesKey = key;
  deviceCapabilitiesUntil = Date.now() + DEVICE_READY_CACHE_MS;
  try {
    const value = await capabilitiesRequest;
    if (deviceCapabilitiesKey === key) deviceCapabilitiesValue = value;
    return value;
  } finally {
    if (deviceCapabilitiesPromise === capabilitiesRequest) deviceCapabilitiesPromise = null;
  }
}

/**
 * Realtime ASR uses the same device/epoch boundary as the HTTP device API.
 * Keep construction here so callers never copy the credential format or
 * accidentally send the secret in a URL/query parameter.
 */
export async function getDeviceRealtimeAuth(): Promise<DeviceRealtimeAuth> {
  diagnosticAudit('device_v1_realtime_auth_start', {});
  const current = await ensureDeviceReady();
  diagnosticAudit('device_v1_realtime_auth_ready', {});
  return {
    deviceToken: `dv1.${current.deviceId}.${current.deviceSecret}`,
    dataEpoch: current.epochId,
  };
}

/**
 * Build the realtime credential from the durable on-device identity without a
 * network readiness round trip. DeviceServiceCoordinator registers the same
 * identity in the background; realtime recording can therefore start local
 * capture immediately and let WebSocket authentication finish off the audio
 * critical path.
 */
export async function getLocalDeviceRealtimeAuth(): Promise<DeviceRealtimeAuth> {
  const current = await identity();
  return {
    deviceToken: `dv1.${current.deviceId}.${current.deviceSecret}`,
    dataEpoch: current.epochId,
  };
}

export async function createMeetingBinding(bindingId: string): Promise<any> {
  diagnosticAudit('device_v1_binding_start', {});
  const result = await request(`/meetings/${encodeURIComponent(bindingId)}`, {
    method: 'PUT',
    headers: { 'Idempotency-Key': `device-meeting-bind:${bindingId}` },
    body: JSON.stringify({ schema_version: 1 }),
  }, '建立会议服务连接失败');
  diagnosticAudit('device_v1_binding_ready', {});
  return result;
}

export async function deleteMeetingBinding(bindingId: string): Promise<any> {
  return request(`/meetings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': `device-meeting-delete:${bindingId}` },
  }, '删除会议服务连接失败');
}

export async function closeDeviceDataEpoch(): Promise<any> {
  const current = await identity();
  const result = await request(`/epochs/${encodeURIComponent(current.epochId)}`, {
    method: 'DELETE',
    headers: {
      'X-Laoji-Data-Epoch': current.epochId,
      'Idempotency-Key': `device-epoch-close:${current.epochId}`,
    },
  }, '删除本机服务数据失败');
  invalidateDeviceReady();
  return result;
}

export async function parseScheduleRemotely(
  text: string,
  referenceDatetime?: string,
  timezone?: string,
  options: {
    clientRuleMiss?: boolean;
    clientIntent?: 'create' | 'clarify' | 'query' | 'delete' | 'reject';
  } = {},
): Promise<any> {
  return request('/schedule/parse', {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 1,
      text,
      reference_datetime: referenceDatetime ?? null,
      timezone: timezone ?? null,
      client_rule_status: options.clientRuleMiss ? 'unresolved' : 'not_run',
      client_intent: options.clientIntent ?? 'create',
    }),
  }, '日程解析服务暂时不可用');
}

export async function parseScheduleAudioRemotely(
  audioUri: string,
  filename = 'recording.wav',
  referenceDatetime?: string,
  timezone?: string,
): Promise<any> {
  const separator = audioUri.indexOf(',');
  const audioBase64 = audioUri.startsWith('data:') && separator >= 0
    ? audioUri.slice(separator + 1)
    : await FileSystem.readAsStringAsync(audioUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  if (!audioBase64.trim()) throw new DeviceApiError('录音内容为空，请重新录音。', 422, 'AUDIO_EMPTY');
  if (audioBase64.length > 14 * 1024 * 1024) {
    throw new DeviceApiError('录音文件不能超过 10 MB。', 413, 'AUDIO_TOO_LARGE');
  }
  const result = await request<{ result?: unknown }>('/schedule/parse-audio', {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 1,
      audio_base64: audioBase64,
      filename: filename || 'recording.wav',
      reference_datetime: referenceDatetime ?? null,
      timezone: timezone ?? null,
    }),
  }, '日程语音解析服务暂时不可用');
  return result?.result ?? result;
}

export async function createDeviceTranscription(
  assetId: string,
  input: { clientRequestId: string; language?: 'zh' | 'en' | 'auto' },
  requestId: string,
): Promise<any> {
  const current = await identity();
  return request(`/assets/${encodeURIComponent(assetId)}/transcription`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId, 'X-Laoji-Data-Epoch': current.epochId },
    body: JSON.stringify({ schema_version: 1, client_request_id: input.clientRequestId, language: input.language ?? 'zh' }),
  }, '提交转写任务失败');
}

export async function getDeviceTranscript(meetingId: string, signal?: AbortSignal): Promise<any> {
  return request(`/meetings/${encodeURIComponent(meetingId)}/transcript`, { signal }, '读取文字记录失败');
}

export async function getDeviceTask(taskId: string, waitMs = 0, signal?: AbortSignal): Promise<any> {
  return request(`/tasks/${encodeURIComponent(taskId)}?wait_ms=${Math.max(0, Math.min(waitMs, 5000))}`, { signal }, '读取处理进度失败');
}

export async function listDeviceSpeakers(): Promise<any> {
  return request('/speakers', {}, '读取讲话人资料失败');
}

async function uploadDeviceSpeakerAudio(
  path: string,
  audioUri: string,
  fileName: string,
  fields: Record<string, string>,
  fallback: string,
): Promise<any> {
  const current = await identity();
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  form.append('audio', { uri: audioUri, name: fileName || 'voice.wav', type: 'audio/wav' } as any);
  const response = await fetchWithTimeout(url(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer dv1.${current.deviceId}.${current.deviceSecret}`,
      'X-Laoji-Data-Epoch': current.epochId,
    },
    body: form,
  }, 120_000);
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 20_000); } catch { data = null; }
  if (!response.ok) {
    const parsed = parseError(data, fallback);
    throw new DeviceApiError(parsed.message, response.status, parsed.code);
  }
  return data;
}

export async function registerDeviceSpeakerAudio(
  name: string,
  audioUri: string,
  fileName = 'voice.wav',
): Promise<any> {
  // `name` is intentionally not sent.  It is a local display label; the
  // device service receives only the temporary sample and an anonymous
  // profile id generated on the server.
  void name;
  return uploadDeviceSpeakerAudio(
    '/speakers/audio',
    audioUri,
    fileName,
    {
      capture_profile: 'android-voice-communication-v1',
      voiceprint_consent_accepted: 'true',
      voiceprint_consent_version: 'voiceprint-v1',
    },
    '新建讲话人失败',
  );
}

export async function supplementDeviceSpeakerAudio(
  speakerId: string,
  audioUri: string,
  fileName = 'voice.wav',
): Promise<any> {
  return uploadDeviceSpeakerAudio(
    `/speakers/${encodeURIComponent(speakerId)}/samples`,
    audioUri,
    fileName,
    {
      capture_profile: 'android-voice-communication-v1',
      voiceprint_consent_accepted: 'true',
      voiceprint_consent_version: 'voiceprint-v1',
    },
    '补录音色失败',
  );
}

export async function deleteDeviceSpeaker(speakerId: string): Promise<any> {
  return request(`/speakers/${encodeURIComponent(speakerId)}`, { method: 'DELETE' }, '删除讲话人资料失败');
}
