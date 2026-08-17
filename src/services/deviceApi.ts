import { getApiConfig } from './config';
import { fetchWithTimeout, readJsonWithTimeout } from './http';
import { getOrCreateDeviceIdentity, type DeviceIdentity } from './deviceIdentity';
import { waitForBackgroundNetworkTurn } from './deviceNetworkPriority';
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
  summaryContractV3: boolean;
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
export function invalidateDeviceReady(): void {
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
  const current = await identity();
  const response = await fetchWithTimeout(url(path), {
    ...init,
    headers: { ...jsonHeaders(current), ...(init.headers ?? {}) },
  });
  let data: any = null;
  try { data = await readJsonWithTimeout(response, 15_000); } catch { data = null; }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) invalidateDeviceReady();
    const parsed = parseError(data, fallback);
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
    summaryContractV3: value?.summary_contract_v3 === true,
  };
}

/**
 * Capability discovery for the accountless product.  This intentionally uses
 * the device-authenticated endpoint; the legacy account capability endpoint
 * must never be used to decide whether a local import is allowed.
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
  const current = await ensureDeviceReady();
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
  return request(`/meetings/${encodeURIComponent(bindingId)}`, {
    method: 'PUT',
    headers: { 'Idempotency-Key': `device-meeting-bind:${bindingId}` },
    body: JSON.stringify({ schema_version: 1 }),
  }, '建立会议服务连接失败');
}

export interface VNextTaskProjection {
  task_id: string;
  epoch_id: string;
  binding_id: string;
  binding_generation: string;
  capability: string;
  entity_id: string;
  entity_revision: number;
  input_sha256: string;
  generation_id: string;
  state: 'active' | 'success' | 'failure' | 'cancelled';
  cancel_revision: number;
  current_attempt_id: string | null;
  result_kind: 'artifact' | 'content_outcome' | null;
  result: unknown;
  error_code: string | null;
}

export async function registerVNextMeetingBinding(input: {
  bindingId: string;
  bindingGeneration: string;
}): Promise<any> {
  return request(`/vnext/bindings/${encodeURIComponent(input.bindingId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      schema_version: 1,
      binding_generation: input.bindingGeneration,
    }),
  }, '建立新版会议服务连接失败');
}

export async function createVNextTask(input: {
  taskId: string;
  bindingId: string;
  bindingGeneration: string;
  capability: string;
  entityId: string;
  entityRevision: number;
  inputSha256: string;
  generationId: string;
  predecessorTaskId?: string | null;
  creationReason?: 'original' | 'retry' | 'regenerate';
}): Promise<{ schema_version: 1; reused: boolean; task: VNextTaskProjection }> {
  return request('/vnext/tasks', {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 1,
      task_id: input.taskId,
      binding_id: input.bindingId,
      binding_generation: input.bindingGeneration,
      capability: input.capability,
      entity_id: input.entityId,
      entity_revision: input.entityRevision,
      input_sha256: input.inputSha256,
      generation_id: input.generationId,
      predecessor_task_id: input.predecessorTaskId ?? null,
      creation_reason: input.creationReason ?? 'original',
    }),
  }, '提交新版任务失败');
}

export async function getVNextTask(taskId: string): Promise<VNextTaskProjection> {
  const response = await request<{ task: VNextTaskProjection }>(
    `/vnext/tasks/${encodeURIComponent(taskId)}`,
    {},
    '读取新版任务失败',
  );
  return response.task;
}

export async function cancelVNextTask(taskId: string): Promise<void> {
  await request(`/vnext/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  }, '取消新版任务失败');
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

export async function clarifyScheduleRemotely(
  current: Record<string, unknown>,
  answer: string,
  referenceDatetime?: string,
  timezone?: string,
): Promise<any> {
  const result = await request<{ result?: unknown }>('/schedule/clarify', {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 1,
      current,
      answer,
      reference_datetime: referenceDatetime ?? null,
      timezone: timezone ?? null,
    }),
  }, '日程补充解析服务暂时不可用');
  return result?.result ?? result;
}

export async function getDeviceMeetingList(): Promise<any> {
  return request('/meetings', {}, '读取会议记录失败');
}

export async function registerDeviceAsset(meetingId: string, registration: any, requestId: string): Promise<any> {
  const current = await identity();
  return request(`/meetings/${encodeURIComponent(meetingId)}/assets`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId, 'X-Laoji-Data-Epoch': current.epochId },
    body: JSON.stringify({ schema_version: 1, ...registration }),
  }, '建立录音资产失败');
}

interface DeviceR2UploadPart {
  part_number: number;
  url?: string;
  etag?: string;
}

interface DeviceR2UploadSession {
  upload_id: string;
  status: string;
  part_size: number;
  total_bytes: number;
  total_parts: number;
  uploaded_parts?: Array<{ part_number: number; etag: string }>;
  parts?: DeviceR2UploadPart[];
}

async function createDeviceR2Upload(
  assetId: string,
  input: { totalBytes: number; checksumSha256?: string | null; requestId: string },
): Promise<DeviceR2UploadSession> {
  return request(`/assets/${encodeURIComponent(assetId)}/r2-upload`, {
    method: 'POST',
    headers: { 'Idempotency-Key': input.requestId },
    body: JSON.stringify({
      schema_version: 1,
      client_upload_id: input.requestId,
      total_bytes: input.totalBytes,
      checksum_sha256: input.checksumSha256 ?? null,
    }),
  }, '建立直传任务失败');
}

async function getDeviceR2Upload(assetId: string, uploadId: string): Promise<DeviceR2UploadSession> {
  return request(
    `/assets/${encodeURIComponent(assetId)}/r2-upload?upload_id=${encodeURIComponent(uploadId)}`,
    {},
    '读取直传进度失败',
  );
}

async function completeDeviceR2Upload(
  assetId: string,
  session: DeviceR2UploadSession,
  parts: Array<{ part_number: number; etag: string }>,
  checksumSha256?: string | null,
): Promise<any> {
  return request(`/assets/${encodeURIComponent(assetId)}/r2-upload/complete`, {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 1,
      upload_id: session.upload_id,
      total_bytes: session.total_bytes,
      parts,
      checksum_sha256: checksumSha256 ?? null,
    }),
  }, '完成直传任务失败');
}

async function cancelDeviceR2Upload(assetId: string, uploadId: string): Promise<void> {
  await request(
    `/assets/${encodeURIComponent(assetId)}/r2-upload?upload_id=${encodeURIComponent(uploadId)}`,
    { method: 'DELETE' },
    '取消直传任务失败',
  ).catch(() => undefined);
}

function headerValue(headers: any, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function uploadDeviceAssetContentR2(input: {
  assetId: string;
  audioUri: string;
  requestId: string;
  totalBytes: number;
  partSize: number;
  checksumSha256?: string | null;
}): Promise<any> {
  const session = await createDeviceR2Upload(input.assetId, {
    totalBytes: input.totalBytes,
    checksumSha256: input.checksumSha256,
    requestId: input.requestId,
  });
  if (!session?.upload_id || !Number.isSafeInteger(session.part_size) || !Number.isSafeInteger(session.total_parts)) {
    throw new DeviceApiError('直传任务响应无效', 502, 'R2_SESSION_INVALID');
  }
  if (session.part_size !== input.partSize || session.total_bytes !== input.totalBytes) {
    throw new DeviceApiError('直传任务分片布局不一致', 502, 'R2_LAYOUT_INVALID');
  }
  const root = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!root) throw new DeviceApiError('本机临时空间不可用', 507, 'UPLOAD_CACHE_UNAVAILABLE');
  const staging = `${root}r2-upload/${encodeURIComponent(input.requestId)}/`;
  await FileSystem.makeDirectoryAsync(staging, { intermediates: true });
  const uploaded = new Map<number, string>(
    (session.uploaded_parts ?? [])
      .filter(item => Number.isSafeInteger(Number(item.part_number)) && typeof item.etag === 'string' && item.etag.trim())
      .map(item => [Number(item.part_number), item.etag.trim()]),
  );
  const urls = new Map<number, string>(
    (session.parts ?? [])
      .filter(item => Number.isSafeInteger(Number(item.part_number)) && typeof item.url === 'string' && item.url.trim())
      .map(item => [Number(item.part_number), item.url!.trim()]),
  );
  const missingParts = Array.from({ length: session.total_parts }, (_, index) => index + 1)
    .filter(partNumber => !uploaded.has(partNumber));
  const directSmallPut = input.totalBytes <= 16 * 1024 * 1024 && session.total_parts === 1;
  const maxConcurrentParts = directSmallPut
    ? 1
    : Math.min(2, Math.max(1, missingParts.length));

  const retryablePartStatus = (status: number): boolean => (
    status === 408 || status === 425 || status === 429 || status >= 500
  );

  const uploadPart = async (partNumber: number): Promise<void> => {
    const partUrl = urls.get(partNumber);
    if (!partUrl) throw new DeviceApiError('直传分片地址缺失', 502, 'R2_PART_URL_MISSING');
    const offset = (partNumber - 1) * session.part_size;
    const length = Math.min(session.part_size, input.totalBytes - offset);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      let partUri: string | null = null;
      try {
        // A single small PUT can stream the original URI directly through the
        // native uploader.  This avoids the Base64 + temporary-file roundtrip
        // that previously dominated short recordings.
        if (!directSmallPut) {
          const base64 = await FileSystem.readAsStringAsync(input.audioUri, {
            encoding: FileSystem.EncodingType.Base64,
            position: offset,
            length,
          });
          if (!base64) throw new DeviceApiError('录音分片读取失败', 422, 'R2_PART_READ_FAILED');
          partUri = `${staging}${partNumber}.${attempt}.part`;
          await FileSystem.writeAsStringAsync(partUri, base64, { encoding: FileSystem.EncodingType.Base64 });
        }
        await waitForBackgroundNetworkTurn();
        const result = await FileSystem.uploadAsync(partUrl, partUri ?? input.audioUri, {
          httpMethod: 'PUT',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        const status = Number(result?.status) || 0;
        if (status < 200 || status >= 300) {
          throw new DeviceApiError('录音分片上传失败', status, 'R2_PART_UPLOAD_FAILED');
        }
        const etag = headerValue(result?.headers, 'etag');
        if (etag) uploaded.set(partNumber, etag);
        diagnosticAudit('device_r2_part_upload', {
          part_number: partNumber,
          bytes: length,
          elapsed_ms: Math.max(0, Date.now() - startedAt),
          attempt,
          direct: directSmallPut,
          status,
        });
        return;
      } catch (error) {
        lastError = error;
        const status = error instanceof DeviceApiError ? error.status : 0;
        if (attempt >= 2 || (status !== 0 && !retryablePartStatus(status))) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 600 * (2 ** attempt)));
      } finally {
        if (partUri) await FileSystem.deleteAsync(partUri, { idempotent: true }).catch(() => undefined);
      }
    }
    throw lastError instanceof Error ? lastError : new DeviceApiError('录音分片上传失败', 0, 'R2_PART_UPLOAD_FAILED');
  };

  try {
    let cursor = 0;
    const workers = Array.from({ length: maxConcurrentParts }, async () => {
      while (cursor < missingParts.length) {
        const partNumber = missingParts[cursor];
        cursor += 1;
        await uploadPart(partNumber);
      }
    });
    await Promise.all(workers);
    diagnosticAudit('device_r2_upload_parts_complete', {
      total_parts: session.total_parts,
      uploaded_parts: uploaded.size,
      concurrency: maxConcurrentParts,
      direct_small_put: directSmallPut,
      total_bytes: input.totalBytes,
    });
    // Some Android networking stacks omit response headers from uploadAsync.
    // The authenticated API can list the R2 parts and supplies authoritative
    // ETags before completion.
    if (uploaded.size !== session.total_parts) {
      const refreshed = await getDeviceR2Upload(input.assetId, session.upload_id);
      for (const part of refreshed.uploaded_parts ?? []) {
        if (part.etag?.trim()) uploaded.set(Number(part.part_number), part.etag.trim());
      }
    }
    const completeParts = Array.from({ length: session.total_parts }, (_, index) => {
      const partNumber = index + 1;
      const etag = uploaded.get(partNumber);
      if (!etag) throw new DeviceApiError('录音仍有分片未上传', 409, 'R2_PARTS_INCOMPLETE');
      return { part_number: partNumber, etag };
    });
    return await completeDeviceR2Upload(input.assetId, session, completeParts, input.checksumSha256);
  } catch (error) {
    // An init failure is handled by the caller. Once a session has received
    // parts, do not silently send a second copy through the tunnel: completion
    // is idempotent and a retry can continue from the R2 part listing.
    if (error instanceof DeviceApiError && error.code === 'R2_UPLOAD_UNAVAILABLE') {
      await cancelDeviceR2Upload(input.assetId, session.upload_id);
    }
    throw error;
  } finally {
    await FileSystem.deleteAsync(staging, { idempotent: true }).catch(() => undefined);
  }
}

// The service accepts chunks up to 4 MiB, but the emulator/tunnel path has a
// noticeably lower native upload timeout.  512 KiB keeps each binary request
// short and still allows safe resume without holding a whole WAV in memory.
const DEVICE_CHUNK_BYTES = 512 * 1024;
// Multipart upload is unreliable on the tunnel for a few-megabyte WAV even
// when the request is otherwise healthy. Use the resumable binary path early
// enough that normal short meetings also avoid the platform's multipart
// timeout; the server still advertises a 4 MiB maximum chunk contract.
const DEVICE_CHUNKED_UPLOAD_THRESHOLD = 2 * 1024 * 1024;

function parseNativeUploadResult(result: any, fallback: string): any {
  let data: any = null;
  try { data = result?.body ? JSON.parse(result.body) : null; } catch { data = null; }
  const status = Number(result?.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const parsed = parseError(data, fallback);
    throw new DeviceApiError(parsed.message, Number.isInteger(status) ? status : 0, parsed.code);
  }
  return data;
}

async function uploadDeviceAssetContentChunked(input: {
  assetId: string;
  audioUri: string;
  expectedRevision: number;
  requestId: string;
  totalBytes: number;
  checksumSha256?: string | null;
}): Promise<any> {
  await waitForBackgroundNetworkTurn();
  const current = await identity();
  const totalChunks = Math.ceil(input.totalBytes / DEVICE_CHUNK_BYTES);
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 4096) {
    throw new DeviceApiError('录音文件大小不受支持', 422, 'CHUNK_LAYOUT_INVALID');
  }
  const root = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!root) throw new DeviceApiError('本机临时空间不可用', 507, 'UPLOAD_CACHE_UNAVAILABLE');
  const staging = `${root}device-upload/${encodeURIComponent(input.requestId)}/`;
  await FileSystem.makeDirectoryAsync(staging, { intermediates: true });
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const offset = index * DEVICE_CHUNK_BYTES;
      const length = Math.min(DEVICE_CHUNK_BYTES, input.totalBytes - offset);
      const base64 = await FileSystem.readAsStringAsync(input.audioUri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length,
      });
      if (!base64) throw new DeviceApiError('录音分片读取失败', 422, 'CHUNK_READ_FAILED');
      const partUri = `${staging}${index}.part`;
      await FileSystem.writeAsStringAsync(partUri, base64, { encoding: FileSystem.EncodingType.Base64 });
      await waitForBackgroundNetworkTurn();
      const result = await FileSystem.uploadAsync(
        url(`/assets/${encodeURIComponent(input.assetId)}/chunks/${index}?expected_revision=${input.expectedRevision}`),
        partUri,
        {
          httpMethod: 'PUT',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer dv1.${current.deviceId}.${current.deviceSecret}`,
            'X-Laoji-Data-Epoch': current.epochId,
            'X-Laoji-Upload-Id': input.requestId,
            'X-Laoji-Chunk-Offset': String(offset),
            'X-Laoji-Total-Bytes': String(input.totalBytes),
            'X-Laoji-Total-Chunks': String(totalChunks),
          },
        },
      );
      parseNativeUploadResult(result, '录音分片上传失败');
      await FileSystem.deleteAsync(partUri, { idempotent: true });
    }
    await waitForBackgroundNetworkTurn();
    return request(
      `/assets/${encodeURIComponent(input.assetId)}/chunks/complete?expected_revision=${input.expectedRevision}`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `${input.requestId}:complete` },
        body: JSON.stringify({
          schema_version: 1,
          upload_id: input.requestId,
          total_bytes: input.totalBytes,
          total_chunks: totalChunks,
          checksum_sha256: input.checksumSha256 ?? null,
        }),
      },
      '完成录音上传失败',
    );
  } finally {
    await FileSystem.deleteAsync(staging, { idempotent: true }).catch(() => undefined);
  }
}

export async function uploadDeviceAssetContent(
  assetId: string,
  audioUri: string,
  expectedRevision: number,
  requestId: string,
  fileName = 'device-recording',
  mimeType = 'application/octet-stream',
  totalBytes?: number,
  checksumSha256?: string | null,
): Promise<any> {
  let uploadUri = audioUri;
  let probeCopyUri: string | null = null;
  let resolvedTotalBytes = Number.isSafeInteger(totalBytes) && Number(totalBytes) > 0
    ? Number(totalBytes)
    : null;
  if (resolvedTotalBytes === null) {
    try {
      const info = await FileSystem.getInfoAsync(audioUri);
      const size = 'size' in info ? Number(info.size) : Number.NaN;
      resolvedTotalBytes = Number.isSafeInteger(size) && size > 0 ? size : null;
    } catch {
      resolvedTotalBytes = null;
    }
  }
  // Android content:// providers often omit the size from getInfoAsync. Make
  // one private cache copy so the resumable path can still be selected; this
  // prevents a multi-megabyte multipart request from sitting behind a tunnel
  // timeout while preserving the original URI for local playback.
  if (resolvedTotalBytes === null) {
    const root = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!root) throw new DeviceApiError('本机临时空间不可用', 507, 'UPLOAD_CACHE_UNAVAILABLE');
    probeCopyUri = `${root}device-upload-probe/${encodeURIComponent(requestId)}.source`;
    await FileSystem.makeDirectoryAsync(`${root}device-upload-probe/`, { intermediates: true });
    await FileSystem.copyAsync({ from: audioUri, to: probeCopyUri });
    const info = await FileSystem.getInfoAsync(probeCopyUri);
    const size = 'size' in info ? Number(info.size) : Number.NaN;
    resolvedTotalBytes = Number.isSafeInteger(size) && size > 0 ? size : null;
    if (resolvedTotalBytes === null) {
      await FileSystem.deleteAsync(probeCopyUri, { idempotent: true });
      probeCopyUri = null;
      throw new DeviceApiError('无法读取录音文件大小', 422, 'UPLOAD_SIZE_UNAVAILABLE');
    }
    uploadUri = probeCopyUri;
  }
  // R2 capability discovery is intentionally best-effort. A server that has
  // not yet received its bucket credentials keeps the existing authenticated
  // device upload path, so an app update can be installed before the storage
  // cutover.
  const capabilities = await loadDeviceServiceCapabilities().catch(() => null);
  if (capabilities?.r2Upload && capabilities.r2PartSize) {
    try {
      const result = await uploadDeviceAssetContentR2({
        assetId,
        audioUri: uploadUri,
        requestId,
        totalBytes: resolvedTotalBytes,
        partSize: capabilities.r2PartSize,
        checksumSha256,
      });
      if (probeCopyUri) await FileSystem.deleteAsync(probeCopyUri, { idempotent: true }).catch(() => undefined);
      return result;
    } catch (error) {
      // Only an explicit server-side disabled response is safe to fall back
      // from. A partial R2 transfer must be resumed, not duplicated through
      // the tunnel and potentially committed twice.
      if (!(error instanceof DeviceApiError) || error.code !== 'R2_UPLOAD_UNAVAILABLE') {
        if (probeCopyUri) await FileSystem.deleteAsync(probeCopyUri, { idempotent: true }).catch(() => undefined);
        throw error;
      }
    }
  }
  if (resolvedTotalBytes > DEVICE_CHUNKED_UPLOAD_THRESHOLD) {
    try {
      return await uploadDeviceAssetContentChunked({
        assetId,
        audioUri: uploadUri,
        expectedRevision,
        requestId,
        totalBytes: resolvedTotalBytes,
        checksumSha256,
      });
    } finally {
      if (probeCopyUri) await FileSystem.deleteAsync(probeCopyUri, { idempotent: true }).catch(() => undefined);
    }
  }
  await waitForBackgroundNetworkTurn();
  const current = await identity();
  const endpoint = url(`/assets/${encodeURIComponent(assetId)}/content?expected_revision=${expectedRevision}`);
  // React Native's fetch implementation buffers a FormData body backed by a
  // content:// URI.  On a slow emulator this can be cancelled before the
  // server receives the complete stream.  Expo's native upload task reads the
  // URI through Android's ContentResolver and keeps the request alive while
  // reporting progress, without changing the wire contract.
  const task = FileSystem.createUploadTask(
    endpoint,
    uploadUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'audio',
      mimeType,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer dv1.${current.deviceId}.${current.deviceSecret}`,
        'X-Laoji-Data-Epoch': current.epochId,
        'Idempotency-Key': requestId,
      },
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      task.uploadAsync(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void task.cancelAsync().catch(() => undefined);
          reject(new DeviceApiError('录音上传超时，文件仍保存在本机', 408, 'UPLOAD_TIMEOUT'));
        }, 15 * 60 * 1000);
      }),
    ]);
    if (!result) throw new DeviceApiError('录音上传已取消', 499, 'UPLOAD_CANCELLED');
    return parseNativeUploadResult(result, '录音上传失败');
  } catch (error) {
    if (timedOut) throw error;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (probeCopyUri) await FileSystem.deleteAsync(probeCopyUri, { idempotent: true }).catch(() => undefined);
  }
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

export async function createDeviceSummary(meetingId: string, input: any, requestId: string, signal?: AbortSignal): Promise<any> {
  const current = await identity();
  return request(`/meetings/${encodeURIComponent(meetingId)}/summary`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId, 'X-Laoji-Data-Epoch': current.epochId },
    body: JSON.stringify({ schema_version: 1, ...input }),
    signal,
  }, '整理服务暂时不可用');
}

export async function getDeviceSummary(meetingId: string, signal?: AbortSignal): Promise<any> {
  return request(`/meetings/${encodeURIComponent(meetingId)}/summary`, { signal }, '读取整理结果失败');
}

export async function createDeviceSummaryV3(
  meetingId: string,
  input: {
    transcript_revision: string;
    manual_note: { revision: number; content_sha256: string; content: string };
    attachments: readonly {
      attachment_id: string;
      revision: number;
      position_ms: number | null;
      content_sha256: string;
      content: string;
    }[];
    force?: boolean;
  },
  requestId: string,
  signal?: AbortSignal,
): Promise<any> {
  const current = await identity();
  return request(`/meetings/${encodeURIComponent(meetingId)}/summary-v3`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId, 'X-Laoji-Data-Epoch': current.epochId },
    body: JSON.stringify({
      schema_version: 3,
      ...input,
      idempotency_key: requestId,
    }),
    signal,
  }, '整理服务暂时不可用');
}

export async function getDeviceSummaryV3(meetingId: string, signal?: AbortSignal): Promise<any> {
  return request(`/meetings/${encodeURIComponent(meetingId)}/summary-v3`, { signal }, '读取整理结果失败');
}

export async function askDeviceQuestion(meetingId: string, input: any, signal?: AbortSignal): Promise<any> {
  return request(`/meetings/${encodeURIComponent(meetingId)}/questions`, {
    method: 'POST',
    headers: input?.client_request_id
      ? { 'Idempotency-Key': String(input.client_request_id) }
      : undefined,
    body: JSON.stringify({ schema_version: 1, ...input }),
    signal,
  }, '会议问答服务暂时不可用');
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
